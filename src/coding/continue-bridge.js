// continue-bridge.js
//
// Started conditionally from start.js when the 'coding' flag is passed —
// see startContinueBridge() at the bottom. `ai` is no longer imported
// directly; it's handed in by the caller so this module shares the exact
// same Lily instance as every other backend (Discord, Minecraft, VRChat)
// rather than spinning up a second one.
import express from "express"
import fs from "fs"
import { fileURLToPath } from "url"
import { Logger } from "../utils/Logger.js"

const PORT = process.env.BRAIN_PORT || 8767
const CHAT_CHANNEL_ID = "vscode-continue-chat"
const CODE_CHANNEL_ID = "vscode-continue-code"

// This is the ONLY prompt the apply-role model ever sees (Continue's own
// system message, if any, rides along as an addendum via continueExtra
// below — but the hard rules live HERE, server-side, so they don't depend
// on Continue's config actually getting sent through correctly).
//
// IMPORTANT: apply-role output is written to disk directly by Continue —
// there is no tool call in between, so the catastrophic-overwrite guard
// further down CANNOT block a bad apply response the way it blocks a bad
// edit_existing_file/single_find_and_replace call. These rules are the
// only line of defense for this path; treat them as load-bearing.
import {
    CODE_SYSTEM_PROMPT,
    OVERWRITE_GUARD,
    STUB_BODY_PATTERN,
    checkShrinkRatio,
    checkStubBodies,
} from "./codeEditShared.js"
// Suffix appended to Lily's normal persona ONLY for the chat/agent model
// (the one with tool_use). Never used on the apply-role model above.
const AGENT_SUFFIX = ``

function extractUserText(messages) {
    const lastUser = [...messages].reverse().find(m => m.role === "user")
    return typeof lastUser?.content === "string"
        ? lastUser.content
        : (lastUser?.content ?? []).map(p => p.text ?? "").join("\n")
}

// Pull any trailing role:"tool" messages off the end of the array. Their
// presence means Continue already executed a tool call Lily asked for last
// turn and is reporting the result back — this is a *continuation*, not a
// fresh user prompt, and must NOT push a new user message into history.
function extractTrailingToolResults(messages) {
    const results = []
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "tool") {
            results.unshift({
                tool_call_id: messages[i].tool_call_id,
                content: typeof messages[i].content === "string"
                    ? messages[i].content
                    : JSON.stringify(messages[i].content)
            })
        } else break
    }
    return results
}

// ─── Catastrophic-overwrite guard (agent/tool-call path only) ─────────
// Two independent, code-level checks (not prompt-dependent) that run
// before any file-writing TOOL CALL is forwarded to Continue.
//
// 1) SIZE-RATIO CHECK — for tools where the argument is genuinely meant to
//    be the ENTIRE file (single_find_and_replace, create_new_file). If the
//    proposed content is drastically smaller than the real file on disk,
//    that's a classic sign of a hallucinated "simplified" rewrite.
//
// 2) STUB-BODY CHECK — for edit_existing_file, where the argument is a
//    small PATCH by design, so size comparison against the full file isn't
//    meaningful (a legit tiny patch is always "small"). Instead this scans
//    for the literal pattern `{ ... }` used as a function/method body —
//    which is never valid real code — a near-unambiguous sign she's
//    generated a skeleton of empty stubs instead of an actual patch.
//
// NOTE: this guard only runs against result.tool_calls. The apply-role
// path never produces a tool_call (see checkApplyShrink below for its
// much weaker, non-blocking equivalent).


function findFilePathArg(args) {
    for (const key of ["filepath", "path", "file", "filePath", "target_file"]) {
        if (typeof args?.[key] === "string") return args[key]
    }
    return null
}

function findLargestStringArg(args) {
    let best = ""
    for (const val of Object.values(args ?? {})) {
        if (typeof val === "string" && val.length > best.length) best = val
    }
    return best
}

function toLocalPath(filepath) {
    if (!filepath) return null
    try {
        if (filepath.startsWith("file://")) return fileURLToPath(filepath)
    } catch { /* fall through */ }
    return filepath
}

/**
 * Returns null if the tool call is fine to forward as-is, or a string
 * rejection reason if it should be blocked.
 */
function checkForCatastrophicOverwrite(toolCall) {
    const name = toolCall?.function?.name
    if (!["edit_existing_file", "single_find_and_replace", "create_new_file"].includes(name)) return null

    let args
    try { args = JSON.parse(toolCall.function.arguments ?? "{}") } catch { return null }

    const filepath = toLocalPath(findFilePathArg(args))
    if (!filepath) return null

    let originalContent
    try {
        originalContent = fs.readFileSync(filepath, "utf8")
    } catch {
        return null // file doesn't exist yet (a real create) or unreadable — not our concern here
    }

    if (name === "edit_existing_file") {
        const changes = args.changes ?? ""
        const stubReason = checkStubBodies(changes, filepath)
        if (stubReason) {
            Logger.warning(`BLOCKED stub-body patch: ${filepath}`)
            return (
                `${stubReason} The edit was NOT applied. Remember: "// ... existing ` +
                `code ..." is a comment placeholder for sections you're NOT touching — every ` +
                `function you actually include in a patch must have its complete, real body. ` +
                `Re-read the file, then retry with a precise patch containing only the lines ` +
                `that truly change, each with its full real implementation.`
            )
        }
        return null
    }

    const newContent = findLargestStringArg(args)
    const shrinkReason = checkShrinkRatio(originalContent, newContent, filepath)
    if (shrinkReason) {
        Logger.warning(`[BRIDGE] 🚫 ${shrinkReason}`)
        return (
            `${shrinkReason} The edit was NOT applied. Call the read tool on this exact ` +
            `file right now to see its real current content, then retry with a precise ` +
            `change based on what's actually there.`
        )
    }
    return null
}

// ─── Apply-path sanity check (NON-BLOCKING) ────────────────────────────
// Apply-role responses are written straight to disk by Continue — there's
// no tool call to intercept, so unlike the guard above, this can only warn
// in the console after the fact. It's a heuristic: the apply request's
// user message normally contains the original file content, so if the
// returned text is drastically shorter than that, it's worth a look.
function warnIfApplyLooksShrunk(messages, resultText) {
    if (!resultText) return
    const userText = extractUserText(messages)
    if (userText.length < 200) return // too short to be a real file-merge prompt, skip

    const ratio = resultText.length / userText.length
    if (ratio < 0.35) {
        Logger.warning(
            `[BRIDGE] ⚠️ APPLY OUTPUT LOOKS SHRUNK — this was NOT blocked (apply writes ` +
            `directly to disk, no tool call to intercept). Input context: ${userText.length} ` +
            `chars, output: ${resultText.length} chars (ratio ${ratio.toFixed(2)}). ` +
            `Check the file Continue just wrote if this looks wrong.`
        )
    }
}

function formatResponse(res, { model, stream, text, tool_calls }) {
    const message = { role: "assistant", content: text || null, tool_calls }
    const finish_reason = tool_calls ? "tool_calls" : "stop"

    if (stream) {
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache")
        res.setHeader("Connection", "keep-alive")
        const chunk = (payload) => res.write(`data: ${JSON.stringify({
            id: "chatcmpl-lily", object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, ...payload }]
        })}\n\n`)
        chunk({ delta: { role: "assistant", content: text ?? "", tool_calls }, finish_reason: null })
        chunk({ delta: {}, finish_reason })
        res.write("data: [DONE]\n\n")
        res.end()
    } else {
        res.json({
            id: "chatcmpl-lily", object: "chat.completion",
            created: Math.floor(Date.now() / 1000), model,
            choices: [{ index: 0, message, finish_reason }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        })
    }
}

// Brings up the Continue.dev bridge on BRAIN_PORT. `ai` is the shared Lily
// instance (same one Discord/Minecraft/VRChat all use), passed in by
// start.js rather than imported, so this stays a plain function you can
// choose to call — no more auto-starting just from importing the file.
// Returns the http.Server handle so callers can close() it on shutdown.
export function startContinueBridge(ai) {
    const app = express()
    app.use(express.json({ limit: "10mb" }))

    app.post("/v1/chat/completions", async (req, res) => {
        const { messages, stream, model, tools } = req.body
        const isCodeRequest = model?.includes("code")
        const hasTools = Array.isArray(tools) && tools.length > 0
        const channelId = isCodeRequest ? CODE_CHANNEL_ID : CHAT_CHANNEL_ID

        Logger.info("[BRIDGE] model:", model, "| continueTools:", hasTools ? tools.map(t => t.function?.name) : "none")

        try {
            const continueSystemMsgs = messages.filter(m => m.role === "system").map(m => m.content)
            const continueExtra = continueSystemMsgs.join("\n\n")

            let systemOverride = null
            if (isCodeRequest) {
                // Apply role. Intentionally persona-free, and intentionally NOT
                // dependent on AGENT_SUFFIX being forwarded correctly — the hard
                // rules live directly in CODE_SYSTEM_PROMPT above. This model
                // should never receive tools; if it somehow does, we still don't
                // route it into the tool-use branch below.
                systemOverride = [CODE_SYSTEM_PROMPT, continueExtra].filter(Boolean).join("\n\n")
            } else if (hasTools) {
                // Agent mode: keep Lily's persona as the base, Continue's own
                // instructions + tool-use guidance ride along as an addendum —
                // NOT a replacement. This is what keeps her in character while
                // she has tool access.
                const editTool = tools.find(t => t.function?.name === "edit_existing_file")
                if (editTool) Logger.info("[BRIDGE] edit_existing_file schema:", JSON.stringify(editTool.function.parameters, null, 2))

                systemOverride = ai.buildSystemPrompt([continueExtra, AGENT_SUFFIX].filter(Boolean).join("\n\n"))
            }
            // else: plain chat, no tools -> systemOverride stays null -> Lily's
            // normal persona is used as-is via buildMessagesForOllama's default.

            // Tool calls that write/edit files need room for a whole file's
            // content as the argument string — 200 tokens (Lily's normal chat
            // budget) truncates mid-JSON and the tool call fails to parse.
            // Apply-role responses also need this, since they return a full
            // file as plain text. Lower temperature too: high temp makes her
            // narrate a plausible "I did it" in prose instead of reliably
            // emitting the tool call (agent mode), or improvise/shrink content
            // instead of copying it exactly (apply mode).
            const opts = (hasTools || isCodeRequest) ? { tools, max_tokens: 8000, temperature: 0.15 } : {}
            const toolResults = extractTrailingToolResults(messages)

            let result
            if (toolResults.length) {
                Logger.info("[BRIDGE] resuming after tool result(s):", toolResults.map(t => ({
                    id: t.tool_call_id,
                    content: t.content?.slice(0, 300)
                })))
                result = await ai.resumeToolLoop(channelId, toolResults, systemOverride, opts, [])
            } else {
                const userText = extractUserText(messages)
                result = await ai.chat(channelId, userText, systemOverride, opts, [])
            }

            // ── Safety net #1: block bad TOOL-CALL edits before Continue
            // executes them (agent mode only — see function docblock).
            if (result?.tool_calls?.length) {
                for (const tc of result.tool_calls) {
                    const blockReason = checkForCatastrophicOverwrite(tc)
                    if (blockReason) {
                        formatResponse(res, { model, stream, text: blockReason, tool_calls: undefined })
                        return
                    }
                }
            }

            // ── Safety net #2 (weaker): apply-role output goes straight to
            // disk with no tool call to intercept, so this can only warn.
            if (isCodeRequest && !result?.tool_calls?.length) {
                warnIfApplyLooksShrunk(messages, result?.text)
            }

            Logger.info(
                "[BRIDGE] reply:", result?.text?.slice(0, 200),
                "| tool_calls:", result?.tool_calls?.map(tc => tc.function?.name)
            )

            formatResponse(res, { model, stream, text: result?.text, tool_calls: result?.tool_calls })
        } catch (err) {
            Logger.error("[BRIDGE] error:", err.response?.data ?? err.message)
            res.status(500).json({ error: err.message })
        }
    })

    return app.listen(PORT, () => Logger.info(`🧠 Lily bridge on http://localhost:${PORT}/v1`))
}