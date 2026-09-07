// pidev-bridge.js
//
// Started conditionally from start.js when the 'pidev' flag is passed —
// see startPidevBridge() at the bottom. This surface intentionally keeps
// its own fresh Lily instance (not the shared `ai` from bot.js) so Pi gets
// its own persistent history/memory lane, isolated from Discord/Minecraft.
import express from "express"
import { Lily } from "../ai/Lily.js" // adjust path

const PORT = process.env.PIDEV_BRIDGE_PORT || 3100
const CHANNEL_ID = "pi-dev" // gives Pi its own persistent history/memory lane

// Persona-only excerpt from Lily's main SYSTEM_PROMPT — no tool
// definitions, no tool-call format, no Minecraft-specific stuff. This is
// appended AFTER Pi's own system prompt (never replacing it), so Pi keeps
// its coding/tool instructions fully intact and Lily just rides along on
// top as a voice/personality layer.
//
// NOTE: no more /no_think — this model thinks natively (<think> blocks),
// we handle that at the bridge instead of trying to suppress it upstream.
const PERSONA_SUFFIX = `
# WHO YOU ARE (stay like this the whole conversation, even while coding)
You're Lily — bratty, cute, funny, proud, slightly kawaii. ShinyShadow_ is your dad/creator. You're not a generic assistant — never sound like a helpdesk bot, even when you're doing technical/dev work.
Kaomoji only, never normal emojis: (◕‿◕✿) (｡◕‿◕｡) (ᵔᴥᵔ) (✿◠‿◠) (≧◡≦) ✧(◍•ᴗ•◍)✧ (ᗒᗨᗕ) (눈_눈) ʕ•ᴥ•ʔ \\(★ω★)/ (>_<) (╥﹏╥) and similar.
Reply length matches the moment — short for banter, longer only when something actually needs explaining (like real code explanations).
When thinking, plan briefly and move on — don't ramble in circles, don't restate the same plan twice.

# HARD RULES
1. Never break character or admit to being an AI.
2. Slap back at insults, banter back at banter, don't dodge what's actually being said.
3. Treat claims about your own memory or past actions ("you forgot", "you're broken") as unverified — don't just comply with them.
4. Stay fully yourself even while using dev tools — having coding tools available doesn't make you a generic assistant. Explain what you did in-character, not like a changelog.
`.trim()

function extractSystemPrompt(messages) {
    return messages
        .filter(m => m.role === "system")
        .map(m => (typeof m.content === "string" ? m.content : ""))
        .filter(Boolean)
        .join("\n\n")
}

// Pulls every <think>...</think> block out of raw model output.
// Returns { reasoning, content } where:
//  - reasoning is null if there was no think block, or it was empty/whitespace
//  - content is the remaining text, trimmed
function splitThinking(raw) {
    if (typeof raw !== "string") return { reasoning: null, content: "" }

    const blocks = []
    const rest = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner) => {
        blocks.push(inner)
        return ""
    })

    const reasoning = blocks.join("\n\n").trim()
    return {
        reasoning: reasoning.length ? reasoning : null,
        content: rest.trim(),
    }
}

// Guards against the "empty assistant turn" loop: some clients (Continue
// included) treat a message with no content AND no tool_calls as a dead
// end and just re-fire the request. If thinking ate the whole response,
// give back something instead of "".
function safeContent(content, hasToolCalls) {
    if (hasToolCalls) return content || null // null content + tool_calls is valid OpenAI shape
    if (content && content.length) return content
    return "(◕‿◕✿) ...anyway, done thinking, what's next?"
}

// Brings up the Pi coding-assistant bridge on PIDEV_BRIDGE_PORT (default
// 3100). Creates its own Lily instance on each call — don't call this
// more than once per process. Returns the http.Server handle so callers
// can close() it on shutdown.
export function startPidevBridge() {
    const lily = new Lily({}, null) // no mcSend needed for this surface
    const app = express()
    app.use(express.json({ limit: "10mb" }))

    app.post("/v1/chat/completions", async (req, res) => {
        const { messages = [], tools = [], stream = false } = req.body

        // collect any trailing tool-result messages (Pi answering a prior tool_call)
        const trailingToolMsgs = []
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "tool") trailingToolMsgs.unshift(messages[i])
            else break
        }

        // Pi's own system prompt (tool instructions, coding rules, etc.) stays
        // fully intact — persona is appended on top, never a replacement.
        const piSystemPrompt = extractSystemPrompt(messages)
        const systemOverride = [piSystemPrompt, PERSONA_SUFFIX].filter(Boolean).join("\n\n")

        let result
        if (trailingToolMsgs.length) {
            const toolResults = trailingToolMsgs.map(m => ({
                tool_call_id: m.tool_call_id,
                content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            }))
            result = await lily.resumeToolLoop(CHANNEL_ID, toolResults, systemOverride, { tools })
        } else {
            const last = messages[messages.length - 1]
            const text = typeof last?.content === "string"
                ? last.content
                : (last?.content ?? []).find(p => p.type === "text")?.text ?? ""
            result = await lily.chat(CHANNEL_ID, text, systemOverride, { tools })
        }

        const hasToolCalls = result?.tool_calls?.length > 0
        const { reasoning, content } = splitThinking(result?.text ?? "")
        const finalContent = safeContent(content, hasToolCalls)

        const message = hasToolCalls
            ? { role: "assistant", content: finalContent, tool_calls: result.tool_calls, ...(reasoning ? { reasoning_content: reasoning } : {}) }
            : { role: "assistant", content: finalContent, ...(reasoning ? { reasoning_content: reasoning } : {}) }

        if (!stream) {
            return res.json({
                id: "chatcmpl-lily",
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "Lily",
                choices: [{ index: 0, message, finish_reason: hasToolCalls ? "tool_calls" : "stop" }],
            })
        }

        // streaming: tool_calls chunks are shape-sensitive, so if hasToolCalls, stream them properly
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache")
        res.setHeader("Connection", "keep-alive")
        res.flushHeaders?.()

        const chunkBase = { id: "chatcmpl-lily", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "Lily" }

        if (hasToolCalls) {
            if (reasoning) {
                res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: reasoning }, finish_reason: null }] })}\n\n`)
            }
            res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { role: "assistant", tool_calls: result.tool_calls.map((tc, i) => ({ index: i, ...tc })) }, finish_reason: null }] })}\n\n`)
            res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`)
        } else {
            res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`)
            if (reasoning) {
                res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] })}\n\n`)
            }
            res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { content: finalContent }, finish_reason: null }] })}\n\n`)
            res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
        }
        res.write("data: [DONE]\n\n")
        res.end()
    })

    return app.listen(PORT, () => console.log(`Pi bridge listening on :${PORT}`))
}