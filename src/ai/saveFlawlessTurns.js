import fs from "fs"
import path from "path"
import { Logger } from '../../src/utils/Logger.js'
import { getConfig } from '../../src/ai/config.js'

const OUTPUT_DIR = path.resolve("./data/flawless_turns")
const OUTPUT_FILE = path.join(OUTPUT_DIR, "pending_review.jsonl")

// Simple write queue so concurrent saves (e.g. Discord and Minecraft turns
// finishing around the same moment) can't interleave partial writes to
// the same file.
let writeQueue = Promise.resolve()

// ─── Tool-call rendering ────────────────────────────────────────────────
// Different model families render a native tool_calls entry as different
// literal text, and that text is what training data needs to match (see
// messageToConversationEntries below). Keyed by config.toolCallFormat so
// swapping the target model is a config change, not a code change.
//
// Add a new model family by adding a renderer here - each one takes
// (name, args) for ONE call and returns the full <tool_call>...</tool_call>
// block as it would actually appear in that model's rendered output.
const TOOL_CALL_RENDERERS = {
    // Hermes-style: JSON object inside the tag. Used natively by Hermes
    // models, Qwen2/2.5/3, and most other models fine-tuned on Hermes-
    // style function-calling data (this is vLLM's "hermes" tool parser).
    // <tool_call>
    // {"name": "...", "arguments": {...}}
    // </tool_call>
    hermes(name, args) {
        return `<tool_call>\n${JSON.stringify({ name, arguments: args ?? {} })}\n</tool_call>`
    },

    // XML-tag style: one <parameter> per arg instead of a JSON blob. Used
    // natively by Qwen3-Coder, Qwen3.5/3.6, Nemotron v3, and Step-3.5-Flash.
    // <tool_call>
    // <function=name>
    // <parameter=key>
    // value
    // </parameter>
    // </function>
    // </tool_call>
    // String args are written as-is; anything else (numbers, booleans,
    // objects, arrays) is JSON-serialized, matching how these models'
    // templates stringify non-string values. Worth spot-checking against
    // your actual model's chat_template.jinja if training loss looks off -
    // fine-tunes of this family have shipped with small template variants.
    xml_tags(name, args) {
        const params = Object.entries(args ?? {}).map(([key, value]) => {
            const rendered = typeof value === "string" ? value : JSON.stringify(value)
            return `<parameter=${key}>\n${rendered}\n</parameter>`
        }).join("\n")
        return `<tool_call>\n<function=${name}>\n${params}\n</function>\n</tool_call>`
    }
}

function getToolCallRenderer() {
    const { toolCallFormat = "hermes" } = getConfig()
    const renderer = TOOL_CALL_RENDERERS[toolCallFormat]
    if (!renderer) {
        throw new Error(
            `Unknown toolCallFormat "${toolCallFormat}" in config.json - expected one of: ${Object.keys(TOOL_CALL_RENDERERS).join(", ")}`
        )
    }
    return renderer
}

// A turn message counts as content-bearing if it has text or made a tool
// call - shared by every output formatter so "which messages survive" stays
// consistent regardless of which format they get written out as.
function hasTurnContent(m) {
    return m.content !== undefined || m.tool_calls?.length > 0
}

// ─── ShareGPT output format ─────────────────────────────────────────────
// {"conversations": [{"from": ..., "value": ...}]}
// system/human/gpt, plus "tool" for actual tool RESULTS. A model tool CALL
// is not its own from-role — it's rendered as a "gpt" turn whose value
// contains an embedded <tool_call>...</tool_call> block, same as what the
// model actually emits at inference time in the embedded-tool-call path.
function toShareGptRole(role) {
    switch (role) {
        case "system": return "system"
        case "user": return "human"
        case "assistant": return "gpt"
        case "tool": return "tool"
        default: return role
    }
}

// Native tool_calls (OpenAI-style, msg.tool_calls array with JSON-string
// arguments) get flattened into a "gpt" turn per call, rendered via
// getToolCallRenderer() so the text matches config.toolCallFormat.
// arguments is parsed back into a real object first so the renderer sees
// the same shape regardless of which model produced the JSON string.
//
// The embedded-<tool_call> path (non-native — scratch already pushes
// { role: "assistant", content } where content is the raw text containing
// the tag) needs no special-casing here: it falls through to the default
// branch below and comes out as a normal "gpt" turn, tag and all, which is
// already the desired shape - and is inherently correct regardless of
// toolCallFormat, since it's the literal text the model already produced.
function messageToShareGptEntries(msg, renderToolCall) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
        return msg.tool_calls.map(tc => {
            let args
            try { args = JSON.parse(tc.function.arguments ?? "{}") } catch { args = tc.function.arguments }
            return { from: "gpt", value: renderToolCall(tc.function.name, args) }
        })
    }
    return [{
        from: toShareGptRole(msg.role),
        value: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "")
    }]
}

function toShareGptSample(messages) {
    const renderToolCall = getToolCallRenderer()
    const conversations = messages
        .filter(hasTurnContent)
        .flatMap(m => messageToShareGptEntries(m, renderToolCall))
        .filter(entry => entry.value !== "" && entry.value !== undefined)

    return { conversations }
}

// ─── OpenAI output format ───────────────────────────────────────────────
// {"messages": [...]} - the messages are already in OpenAI-message-array
// form (that's the input shape per saveFlawlessTurn's contract), so this
// is a passthrough + filter rather than a rebuild. tool_calls stays
// structured JSON here rather than being rendered to text, so
// config.toolCallFormat has no effect on this format - it only matters
// for formats that embed the call as literal model-output text.
function toOpenAiSample(messages) {
    return { messages: messages.filter(hasTurnContent) }
}

const OUTPUT_FORMATTERS = {
    sharegpt: toShareGptSample,
    openai: toOpenAiSample
}

function getOutputFormatter() {
    const { trainingOutputFormat = "sharegpt" } = getConfig()
    const formatter = OUTPUT_FORMATTERS[trainingOutputFormat]
    if (!formatter) {
        throw new Error(
            `Unknown trainingOutputFormat "${trainingOutputFormat}" in config.json - expected one of: ${Object.keys(OUTPUT_FORMATTERS).join(", ")}`
        )
    }
    return formatter
}

// A sample is empty if every recognized turn-array key on it is empty -
// covers whichever formatter produced it without the caller needing to
// know its shape.
function isEmptySample(sample) {
    return !Object.values(sample).some(v => Array.isArray(v) && v.length > 0)
}

/**
 * Saves one flawless turn to the pending-review queue. Never throws —
 * failures are logged and swallowed so a disk/write issue can't affect
 * the live chat turn that triggered the save.
 *
 * Output shape is controlled by config.trainingOutputFormat ("sharegpt" |
 * "openai"); tool-call text rendering (for formats that embed it as text)
 * is controlled by config.toolCallFormat ("hermes" | "xml_tags").
 *
 * @param {object} params
 * @param {string} params.channelId
 * @param {Array}  params.messages - the messages for THIS TURN ONLY, in
 *        OpenAI-message-array form: system, the single user message that
 *        started the turn, any tool-call/tool-result scratch messages from
 *        this turn's loop (assistant with tool_calls, or role:"tool"/
 *        embedded <tool_call> pairs), ending in the final assistant reply.
 *        Callers must NOT pass the full accumulated conversation history —
 *        see maybeSaveFlawlessTurn in lily.js, which is the only caller.
 */
export async function saveFlawlessTurn({ channelId, messages }) {
    let sample
    try {
        sample = getOutputFormatter()(messages)
    } catch (err) {
        Logger.error(err.message, "FLAWLESS SAVE")
        return
    }
    if (isEmptySample(sample)) return

    const record = {
        ...sample,
        // _meta: {
        //     channelId,
        //     savedAt: new Date().toISOString(),
        // }
    }

    writeQueue = writeQueue.then(async () => {
        try {
            await fs.promises.mkdir(OUTPUT_DIR, { recursive: true })
            await fs.promises.appendFile(OUTPUT_FILE, JSON.stringify(record) + "\n", "utf8")
            Logger.info(`Saved flawless turn (${channelId})`, "FLAWLESS SAVE")
        } catch (err) {
            Logger.error(err.message, "FLAWLESS SAVE")
        }
    })

    return writeQueue
}