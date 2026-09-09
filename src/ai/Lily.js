import axios from "axios"
import { getStateController } from '../minecraft/neoforgemod-way/bot.js'
import { sanitizeInput, ToolCallTracker } from './utils.js'
import { ConversationHistory, RawBuffer } from './history.js'
import { SYSTEM_PROMPT, SUMMARIZE_PROMPT, VTUBE_EXPRESSION_ADDENDUM } from './prompts.js'
import { ToolRouter, ALL_TOOL_NAMES, VOICE_ASSISTANT_CHANNEL as VOICE_ASSISTANT_CHANNEL_ID } from './tools/toolRouter.js'
import { Logger } from '../../src/utils/Logger.js'
import { saveFlawlessTurn } from './saveFlawlessTurns.js'
import { getConfig } from './config.js'
import { speakToStream } from '../vtubing/youtube/streamTTS.js'
const YOUTUBE_CHANNEL_ID = "youtube"
// Channel id used for the Minecraft bridge — see getToolsForChannel().
const MINECRAFT_CHANNEL_ID = "minecraft"
// Channel id used for the VRChat avatar bridge (vrchatBot/) — see
// getToolsForChannel(). Only started when this process is run with the
// 'vrchat' flag (see start.js), but the id is a plain string constant so
// there's nothing flag-dependent to wire up here.
const VRCHAT_CHANNEL_ID = "vrchat"

function isMinecraftActionTool(name) {
    return name === "minecraft_action" || name.startsWith("minecraft_action")
}

const GIF_TOOLS = new Set(["send_gif", "send_meme"])

export class Lily {
    /**
     * @param {object} options
     * @param {(type: string, params: object) => void} [mcSend] - sends a
     *   command to the Minecraft bridge (same function passed into
     *   startSurvivalLoop). Forwarded to ToolRouter so the
     *   minecraft_action_* tools can actually act in-world when someone
     *   asks Lily to do something via chat.
     * @param {object} [vtsClient] - already-authenticated VTSClient
     *   connection, forwarded to ToolRouter so trigger_expression works.
     *   Optional at construction time — wire it later with setVtsClient()
     *   if the VTS connection isn't ready yet when Lily is first built.
     */
    constructor(options = {}, mcSend = null, vtsClient = null, sttsConfig = {}) {
        // this.opts is a getter (defined below) that re-reads config.json
        // fresh on every access — there's no snapshot to go stale, so
        // editing and saving the file takes effect on the very next opts
        // access, no restart needed. `options` passed here become a
        // permanent per-instance override (Object.assign'd on top of the
        // live file values) for whichever keys it sets — use it for
        // one-off/test wiring, not values you plan to keep tuning live.
        this._optsOverride = options
        this.convoHistories = new Map()
        this.rawBuffers = new Map()
        this.channelLocks = new Map()
        this.channelMessageCounts = new Map()   // channelId -> count
        this.observeBuffers = new Map()         // channelId -> string[]
        this.observeParticipants = new Map()    // channelId -> Set<string>
        this.mcSend = mcSend
        // ChatToolExecutor (the only domain with live config-dependent
        // behavior) reads config.json fresh on its own — nothing to hand
        // it here. ToolRouter fans calls out to chat/minecraft/vtube by
        // tool name, letting all three mix freely within a single turn —
        // see toolRouter.js.
        this.tools = new ToolRouter(mcSend, getStateController, vtsClient, sttsConfig)
        this._resumedIds = new Map()
        this._replayCounts = new Map()
        // channelId -> { role: "user", content } — the single user message that
        // STARTED the current turn. Deliberately separate from convoHistories
        // (which keeps accumulating prior turns): this is what
        // maybeSaveFlawlessTurn reads so a saved training sample is scoped to
        // real turn boundaries, not the whole growing conversation.
        this.turnStartMessages = new Map()
        // channelId -> array of completed FLAWLESS turns, each entry being
        // that turn's own flat message array: [userMsg, ...scratch,
        // finalAssistantReply]. Used by maybeSaveFlawlessTurn to build
        // multi-turn samples when opts.trainingTurnWindow > 1 — see there.
        // Cleared for a channel whenever a turn comes back flawed, so a
        // multi-turn bundle never silently skips over an untrustworthy turn.
        this.turnLog = new Map()
        this.turnAutoMemoryBlocks = new Map()   // channelId -> string | undefined, recomputed each turn
    }

    // Reads config.json fresh (via getConfig()) on every access and layers
    // this instance's constructor-time overrides on top. NOTE: maxConvoMessages
    // / maxMinecraftConvoMessages are read once per channel, at the moment
    // that channel's ConversationHistory is first created (see getHistory
    // below) — a live edit to either value takes effect for any NEW channel,
    // but won't resize a history object a currently-active channel is
    // already using.
    get opts() {
        return Object.assign(getConfig(), this._optsOverride)
    }


    getObserveBuffer(channelId) {
        if (!this.observeBuffers.has(channelId)) this.observeBuffers.set(channelId, [])
        return this.observeBuffers.get(channelId)
    }

    /**
     * Wire (or replace) the Minecraft bridge sender after construction —
     * useful if mcSend isn't available yet when Lily is first built.
     */
    setMcSend(mcSend) {
        this.mcSend = mcSend
        this.tools.setMcSend(mcSend)
    }

    /**
     * Wire (or replace) the VTube Studio connection after construction —
     * call this once the VTSClient has finished authenticating. Safe to
     * call again later (e.g. after a reconnect) to swap in a fresh client.
     */
    setVtsClient(vtsClient) {
        this.tools.setVtsClient(vtsClient)
    }

    buildSystemPrompt(extraInstructions = null) {
        return extraInstructions ? `${SYSTEM_PROMPT}\n\n${extraInstructions}` : SYSTEM_PROMPT
    }

    getHistory(channelId) {
        if (!this.convoHistories.has(channelId)) {
            const cap = channelId === MINECRAFT_CHANNEL_ID
                ? this.opts.maxMinecraftConvoMessages
                : this.opts.maxConvoMessages
            this.convoHistories.set(channelId, new ConversationHistory(cap))
        }
        return this.convoHistories.get(channelId)
    }

    getRawBuffer(channelId) {
        if (!this.rawBuffers.has(channelId)) {
            this.rawBuffers.set(channelId, new RawBuffer(this.opts.maxRawMessages))
        }
        return this.rawBuffers.get(channelId)
    }

    // Only the Minecraft bridge channel gets minecraft_action_* tools —
    // every other channel (Discord, etc.) never even sees them in the tool
    // list, so the model structurally cannot call them there regardless of
    // how it interprets the system prompt's "you can't perform in-game
    // actions". Vtube tools (trigger_expression) are included either way —
    // see ToolRouter's tools/nonMinecraftTools getters — so expressions
    // mix freely with either chat tools or minecraft tools.
    getToolsForChannel(channelId) {
        if (channelId === MINECRAFT_CHANNEL_ID) return this.tools.tools
        if (channelId === VRCHAT_CHANNEL_ID) return this.tools.vrchatTools
        if (channelId === VOICE_ASSISTANT_CHANNEL_ID) return this.tools.voiceAssistantTools
        return this.tools.nonMinecraftTools
    }

    async withChannelLock(channelId, fn) {
        while (this.channelLocks.get(channelId)) await new Promise(r => setTimeout(r, 50))
        this.channelLocks.set(channelId, true)
        try { return await fn() } finally { this.channelLocks.set(channelId, false) }
    }

    async tryChannelLock(channelId, fn) {
        if (this.channelLocks.get(channelId)) {
            return { skipped: true }
        }
        this.channelLocks.set(channelId, true)
        try {
            return { skipped: false, result: await fn() }
        } finally {
            this.channelLocks.set(channelId, false)
        }
    }

    pushRawMessage(channelId, authorName, content) {
        this.getRawBuffer(channelId).push(authorName, content)
    }

    injectChannelContext(channelId, recentMessages) {
        const lines = recentMessages.map(m => `${m.authorName}: ${m.content}`)
        this.getRawBuffer(channelId).replace(lines)
        Logger.info(`Injected ${lines.length} messages into raw buffer for channel ${channelId}`, "CONTEXT")
    }

    pushToConvoHistory(channelId, message) {
        this.getHistory(channelId).push(message)
    }

    getConvoHistory(channelId) {
        return this.getHistory(channelId).get()
    }

    getRawContext(channelId) {
        return this.getRawBuffer(channelId).get()
    }

    // suppressActionReminder: once an in-world action has already been dispatched
    // this turn, we stop re-injecting the "call the matching tool now" nudge on
    // every subsequent loop iteration/completion — that reminder was previously
    // rebuilt from scratch and reattached to the same original user message on
    // every single loop, which kept pressuring the model to find *something*
    // else to call even after the requested action was already done.
    buildMessagesForOllama(channelId, systemPromptOverride = null, opts = {}) {
        const { skipHistory = false, skipRawContext = false, suppressActionReminder = false } = opts
        const messages = []

        let systemContent = systemPromptOverride ?? SYSTEM_PROMPT
        if (this.tools.vtubeEnabled) {
            systemContent += `\n\n${VTUBE_EXPRESSION_ADDENDUM}`
        }

        messages.push({ role: "system", content: systemContent })

        const history = skipHistory ? [] : [...this.getConvoHistory(channelId)]

        if (!skipRawContext) {
            const autoMemory = this.turnAutoMemoryBlocks.get(channelId)
            const rawContext = this.getRawContext(channelId)

            let block = ""
            if (autoMemory) {
                block += `[Memory — things you may already know, only relevant if they actually relate to the newest message. Ignore anything that doesn't.]\n${autoMemory}\n[End memory]\n`
            }
            if (rawContext.length) {
                const reminder = (channelId === MINECRAFT_CHANNEL_ID && !suppressActionReminder)
                    ? "\n[If the newest message asks you to do something physical, call the matching tool now — don't just reply in words.]\n"
                    : ""
                block += `[Recent chat]\n${rawContext.join("\n")}\n[End recent chat]\n${reminder}`
            }

            if (block) {
                let injected = false
                for (let i = history.length - 1; i >= 0; i--) {
                    if (history[i].role === "user" && typeof history[i].content === "string") {
                        history[i] = { ...history[i], content: block + history[i].content }
                        injected = true
                        break
                    }
                }
                if (!injected) {
                    history.push({ role: "user", content: block.trim() })
                }
            }
        }

        messages.push(...history)
        return messages
    }

    buildUserContent(text, images = []) {
        if (!images || images.length === 0) return text
        const parts = []
        for (const img of images) {
            parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })
        }
        if (text) parts.push({ type: "text", text })
        return parts
    }

    async summarizeAndStore(lines, { logPrefix, maxTokens = 300, memorySource = "conversation_batch", participants = [], emotions = [], importance = 0.5 }) {
        if (lines.length < 2) return
        Logger.info(`Summarizing ${lines.length} entries...`, "SUMMARIZE")
        try {
            const { data } = await axios.post(`${this.opts.ollamaUrl}/v1/chat/completions`, {
                model: this.opts.model,
                messages: [
                    { role: "system", content: SUMMARIZE_PROMPT },
                    { role: "user", content: lines.join("\n") }
                ],
                stream: false,
                temperature: 0.3,
                max_tokens: maxTokens,
            }, { timeout: this.opts.ollamaTimeout })

            const summary = data.choices?.[0]?.message?.content?.trim()
            if (!summary) return

            // summary drives the embedding/search; raw is what comes back on a hit
            await this.tools.addEpisodicMemory({
                summary,
                raw: lines.join("\n"),
                participants,
                emotions,
                importance,
                source: memorySource,
            })
        } catch (err) {
            Logger.error(err.message, "SUMMARIZE")
        }
    }

    async summarizeConversationAndStore(channelId) {
        const history = this.getHistory(channelId)
        const lines = history.lastN(this.opts.summarizeLastN)
            .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
            .map(m => `${m.role === "user" ? "User" : "Lily"}: ${m.content}`)

        if (lines.length < 2) return

        await this.summarizeAndStore(lines, {
            logPrefix: "SUMMARIZE",
            maxTokens: 150,
            memorySource: "conversation_batch",
            importance: 0.5,
        })
    }

    observe(channelId, rawMessage, authorName = null) {
        const clean = sanitizeInput(rawMessage)
        if (!clean) return

        const buffer = this.getObserveBuffer(channelId)
        buffer.push(clean)
        if (authorName && authorName.toLowerCase() !== "lily") {
            if (!this.observeParticipants.has(channelId)) this.observeParticipants.set(channelId, new Set())
            this.observeParticipants.get(channelId).add(authorName)
        }

        if (this.opts.observeEvery > 0 && buffer.length >= this.opts.observeEvery) {
            const batch = buffer.splice(0, this.opts.observeEvery)
            const participants = [...(this.observeParticipants.get(channelId) ?? [])]
            this.summarizeAndStore(batch, {
                logPrefix: "OBSERVE",
                maxTokens: 100,
                memorySource: "observe",
                importance: 0.3,
                participants,
            })
            this.observeParticipants.set(channelId, new Set())
        }
    }

    async sendToOllama(messages, foreignTools = [], noTools = false, baseTools = this.tools.tools, overrides = {}) {
        if (getStateController()?.currentStateName === 'DUELING') {
            return { content: "Lily is currently in a duel, she can't reply right now!" }
        }
        try {
            const payload = {
                model: this.opts.model,
                messages,
                stream: false,
                temperature: overrides.temperature ?? this.opts.temperature,
                top_p: this.opts.top_p,
                top_k: this.opts.top_k,
                presence_penalty: overrides.presence_penalty ?? this.opts.presence_penalty,
                min_p: this.opts.min_p,
                repeat_penalty: overrides.repeat_penalty ?? this.opts.repeat_penalty,
                repeat_last_n: this.opts.repeat_last_n,
                max_tokens: overrides.max_tokens ?? this.opts.max_tokens,
                stop: overrides.stop ?? ["</answer>", "<|user|>", "<|endoftext|>"],
                // CHANGE 1: this.opts.think was read from config.json but never
                // put on the payload — it did nothing. Also: Ollama's
                // /v1/chat/completions endpoint mostly ignores a bare "think"
                // field for reasoning control; the field it actually reads is
                // reasoning_effort ("none"/"low"/"medium"/"high"). Sending both
                // covers you whether your Ollama build honors think or not.
                reasoning_effort: this.opts.think === false ? "none" : (this.opts.think ?? "none"),
                think: this.opts.think ?? false,
            }
            if (!noTools) {
                payload.tools = foreignTools.length ? [...baseTools, ...foreignTools] : baseTools
            }

            const { data } = await axios.post(`${this.opts.ollamaUrl}/v1/chat/completions`, payload, { timeout: this.opts.ollamaTimeout })
            const msg = data.choices?.[0]?.message ?? null

            // CHANGE 2: on some Ollama versions/models, when reasoning is cut
            // off mid-stream or the model front-loads planning text, everything
            // ends up in `reasoning`/`reasoning_content` instead of `content` —
            // content comes back empty even though the model "said" something.
            // Falling back to that field means a completion never gets treated
            // as empty when there's actually text sitting right there.
            if (msg && !msg.content?.trim() && (msg.reasoning_content || msg.reasoning)) {
                Logger.warning(`content empty, model text landed in reasoning field instead — using it as fallback`, "OLLAMA FALLBACK")
                msg.content = msg.reasoning_content ?? msg.reasoning
            }

            if (msg?.content) {
                msg.content = msg.content
                    .replace(/<think>[\s\S]*?<\/think>/g, "")
                    .replace(/<\/?answer>/g, "")
                    .trim()
            }
            return msg
        } catch (err) {
            const detail = err.response?.data ? JSON.stringify(err.response.data) : ""
            Logger.error(`${err.message} ${detail}`, "OLLAMA")
            return null
        }
    }
    // PATCH for Lily.js — replace parseEmbeddedToolCalls with this version.
    //
    // Qwen3.5 was trained with the "qwen3_coder" tool-call format, not the
    // Hermes-JSON format Qwen3-8B used. That format looks like:
    //
    //   <tool_call>
    //   <function=tool_name>
    //   <parameter=arg_name>
    //   value
    //   </parameter>
    //   </function>
    //   </tool_call>
    //
    // ...instead of:
    //
    //   <tool_call>
    //   {"name": "tool_name", "arguments": {"arg_name": "value"}}
    //   </tool_call>
    //
    // Native msg.tool_calls (via the `tools` field on the request) will keep
    // working as before — this only matters for the embedded-text fallback path,
    // which is exactly where your "MALFORMED" logs were coming from: the model
    // falling back to its own native dialect instead of the one your regex
    // expected.
    parseEmbeddedToolCalls(content) {
        const blocks = [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)]
        const calls = []

        for (const block of blocks) {
            const inner = block[1].trim()

            // Dialect 1: old Hermes-JSON format — {"name": ..., "arguments": {...}}
            if (inner.startsWith("{")) {
                try {
                    const parsed = JSON.parse(inner)
                    let args = parsed.arguments ?? parsed.args ?? {}
                    if (typeof args === "string") try { args = JSON.parse(args) } catch { args = {} }
                    calls.push({ name: parsed.name, args })
                    continue
                } catch { /* fall through and try XML dialect below, in case of mixed output */ }
            }

            // Dialect 2: Qwen3.5 native qwen3_coder format —
            // <function=name><parameter=key>value</parameter>...</function>
            const fnMatch = inner.match(/<function=([^>]+)>([\s\S]*?)<\/function>/)
            if (fnMatch) {
                const name = fnMatch[1].trim()
                const paramSection = fnMatch[2]
                const args = {}
                const paramMatches = [...paramSection.matchAll(/<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g)]
                for (const p of paramMatches) {
                    const key = p[1].trim()
                    let value = p[2].trim()
                    // Parameters often come through as plain strings even for
                    // numbers/booleans/objects — try to recover the real type,
                    // fall back to the raw string if it isn't valid JSON.
                    try { value = JSON.parse(value) } catch { /* keep as string */ }
                    args[key] = value
                }
                calls.push({ name, args })
                continue
            }

            // Neither dialect matched — genuinely malformed/truncated, skip it
            // silently rather than crashing; caller already treats an empty
            // calls[] as "malformed" and reprompts.
        }

        return calls
    }

    // Two independent checks gate every non-minecraft_action tool call:
    //   1. toolsUsedThisTurn (Map<toolName, count>) — flat cap of
    //      opts.maxUsesPerTool calls to a given tool name per turn,
    //      regardless of arguments. Replaces the old ad-hoc special-casing
    //      of send_gif / send_meme / addto_episodic_memory with one rule,
    //      and closes the hole where a model dodged a per-tool cap by
    //      alternating between addto_memory_database / update_memory_database
    //      / remove_memory_database indefinitely.
    //   2. tracker (ToolCallTracker) — blocks calling the exact same
    //      tool+args pair more than opts.maxToolRepeats times, catching a
    //      model stuck re-issuing an identical call even if it's still
    //      within the flat count budget.
    //
    // minecraft_action tools get their OWN flat cap of 1 per distinct action
    // name per turn (not opts.maxUsesPerTool, and no tracker repeat-check —
    // repeated identical in-world actions like re-attacking the same mob
    // across turns are legitimate and are instead bounded by the early-exit
    // in runToolLoop, see didMinecraftAction there). Without this cap, a
    // model that calls e.g. break, then in a LATER loop iteration calls
    // stop, then eat, then swap, then attack, then follow — none of which
    // repeats a prior tool name — sails through unblocked, since a same-name
    // repeat check can't catch a model inventing a *different* unrequested
    // action each round. The early-exit fix in runToolLoop is what actually
    // stops those later rounds from happening at all; this cap is just a
    // backstop in case a single model response tries to call the same
    // minecraft action tool twice.
    // async runOneToolCall(channelId, name, args, tracker, toolsUsedThisTurn, pushFn) {
    //     const usesSoFar = toolsUsedThisTurn.get(name) ?? 0
    //     const cap = isMinecraftActionTool(name)
    //         ? this.opts.maxUsesPerMinecraftAction
    //         : this.opts.maxUsesPerTool

    //     if (usesSoFar >= cap) {
    //         Logger.warning(`${name} already used ${usesSoFar}x this turn (cap: ${cap})`, "BLOCKED")
    //         this.tools.markFlawed('tool_cap_exceeded')
    //         pushFn(isMinecraftActionTool(name)
    //             ? `You've already done that this turn — don't call another action tool unless the player just asked for something new. Reply in character now.`
    //             : `You've already used ${name} ${usesSoFar} time(s) this turn — that's the limit. Move on and reply in character now.`)
    //         return null
    //     }

    //     if (!isMinecraftActionTool(name)) {
    //         const repeatBlock = tracker.check(name, args)
    //         if (repeatBlock) {
    //             this.tools.markFlawed('tool_repeat_blocked')
    //             pushFn(repeatBlock)
    //             return null
    //         }
    //     }

    //     toolsUsedThisTurn.set(name, usesSoFar + 1)

    //     const result = await this.tools.execute(name, args)

    //     let gifUrl = null
    //     if (GIF_TOOLS.has(name)) {
    //         try {
    //             const parsed = JSON.parse(result)
    //             if (parsed.status === "ok") gifUrl = parsed.url
    //         } catch { }
    //     }

    //     pushFn(result)
    //     return gifUrl
    // }

    async resumeToolLoop(channelId, toolResults, systemPromptOverride = null, opts = {}, images = []) {
        return this.withChannelLock(channelId, async () => {
            const allSeen = toolResults.length > 0 && toolResults.every(tr => this._resumedIds.has(tr.tool_call_id))
            if (allSeen) {
                Logger.warning(`Already answered: ${toolResults.map(t => t.tool_call_id).join(", ")}`, "DUPLICATE RESUME")
                return this._resumedIds.get(toolResults[toolResults.length - 1].tool_call_id)
            }

            for (const tr of toolResults) {
                if (this._resumedIds.has(tr.tool_call_id)) continue

                let content = tr.content
                if (typeof content === "string" && content.startsWith("Failed to edit")) {
                    content += " The filepath you sent didn't match. Use the exact path shown in your last read_file or read_currently_open_file result — not a shortened or relative guess."
                }

                this.pushToConvoHistory(channelId, { role: "tool", tool_call_id: tr.tool_call_id, content })
            }

            // NOTE: runToolLoop below starts a fresh `scratch = []`, so a turn
            // that got paused for a foreign tool handoff (see foreignCalls in
            // runToolLoop) and is now resuming here will save WITHOUT the
            // pre-pause assistant tool_calls message / foreign tool result in
            // its flawless-turn scratch — that portion only lives in
            // convoHistories, not in what maybeSaveFlawlessTurn reads. Was
            // already the case before the single/multi-turn rework; flagging
            // it here since it's easy to miss. Only matters for channels that
            // actually use foreign tool handoff (e.g. the VS Code/Continue
            // bridge), not plain Discord/Minecraft chat.
            const result = await this.runToolLoop(channelId, systemPromptOverride, opts, images)
            for (const tr of toolResults) this._resumedIds.set(tr.tool_call_id, result)

            if (result?.text) this.pushHistoryToBlog(channelId)
            return result
        })
    }

    // Shared by the two success paths (runToolLoop and finishWithoutTools).
    // Builds a training sample scoped by opts.trainingTurnWindow:
    //
    //   trainingTurnWindow === 1 (default): single-turn sample, saved every
    //   turn — system prompt -> this turn's user message -> this turn's
    //   tool-call/tool-result scratch -> this turn's final reply.
    //
    //   trainingTurnWindow === N > 1: BATCH-AND-FLUSH, not a sliding window.
    //   Turns accumulate in turnLog un-saved until exactly N consecutive
    //   flawless turns have piled up; only then is ONE sample written
    //   (system + turn[1] + turn[2] + ... + turn[N]) and the log cleared to
    //   start the next batch from zero. This deliberately does NOT save at
    //   turn 1, then again at 1+2, then again at 1+2+3 — that was the
    //   earlier (buggy) sliding-window version and produced heavily
    //   overlapping near-duplicate samples, which is exactly the kind of
    //   redundant-save problem this whole rework exists to avoid. With N=3
    //   you get one save on turn 3 (containing turns 1-3), one save on turn
    //   6 (containing turns 4-6), etc. — no turn ever appears in more than
    //   one saved sample.
    //
    //   A flawed/empty-reply turn clears the in-progress batch entirely
    //   (partial progress is discarded, not flushed early) so a batch never
    //   stitches across a turn whose content isn't trustworthy training
    //   data.
    //
    // Deliberately does NOT call buildMessagesForOllama / getConvoHistory in
    // either mode — those pull the whole accumulated conversation, which is
    // what caused near-duplicate samples in the original version (the same
    // growing history re-saved on every single message, differing only in
    // the newest turn).
    async maybeSaveFlawlessTurn(channelId, systemPromptOverride, scratch, finalReplyText) {
        if (!this.tools.turnFlawless) {
            this.turnLog.delete(channelId)
            return
        }
        if (!finalReplyText || finalReplyText.toLowerCase() === "none") {
            this.turnLog.delete(channelId)
            return
        }

        const turnUserMessage = this.turnStartMessages.get(channelId)
        if (!turnUserMessage) return

        const turnMessages = [turnUserMessage, ...scratch, { role: "assistant", content: finalReplyText }]

        const windowSize = Math.max(1, this.opts.trainingTurnWindow)
        const log = this.turnLog.get(channelId) ?? []
        log.push(turnMessages)

        // Batch isn't full yet — buffer it and wait, don't save anything.
        if (log.length < windowSize) {
            this.turnLog.set(channelId, log)
            return
        }

        try {
            const baseMessages = [{ role: "system", content: systemPromptOverride ?? SYSTEM_PROMPT }]
            const fullConversation = [...baseMessages, ...log.flat()]
            // Not awaited on purpose — this shouldn't add latency to the user-facing reply.
            saveFlawlessTurn({ channelId, messages: fullConversation }).catch(err => {
                Logger.error(err.message, "FLAWLESS SAVE")
            })
        } catch (err) {
            Logger.error(err.message, "FLAWLESS SAVE")
        }

        // Batch flushed — start the next one from scratch.
        this.turnLog.delete(channelId)
    }

    // Final fallback used both when the tool-loop budget (maxToolLoops) runs out,
    // AND (new) immediately after a minecraft_action tool has been dispatched —
    // see didMinecraftAction in runToolLoop. Forces one last completion with
    // tools disabled so the model has to produce a normal in-character reply
    // instead of being offered another 14 rounds of "what else could I call".
    async finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl) {
        const baseMessages = this.buildMessagesForOllama(channelId, systemPromptOverride, { ...opts, suppressActionReminder: true })
        let attemptScratch = [...scratch]
        const MAX_RETRIES = 6

        // Stricter than the normal chat-turn defaults: stop the instant the model
        // starts down the <tool_call> path again (tools are already off, so any
        // attempt is wasted generation, not a valid response), and push the
        // repeat penalty harder since the context is now full of the model's own
        // recent tool-call spam that it's prone to imitating.
        const overrides = {
            stop: ["</answer>", "<|user|>", "<|endoftext|>", "<tool_call>"],
            repeat_penalty: 1.3,
        }

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const messages = [...baseMessages, ...attemptScratch]

            if (attempt > 0) {
                this.tools.markFlawed('budget_fallback_retry')
                messages.push({
                    role: "user",
                    content: `[System: You cannot tool call more in this turn. Stop attempting to call tools this turn, and naturally reply to the user with a text reply addressing his message.]`
                })
            }

            const msg = await this.sendToOllama(messages, [], true, this.tools.tools, overrides)
            const raw = (msg?.content ?? "").trim()
            const content = raw.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim()

            if (content && content.toLowerCase() !== "none") {
                this.maybeSaveFlawlessTurn(channelId, systemPromptOverride, attemptScratch, content)
                this.pushToConvoHistory(channelId, { role: "assistant", content })
                Logger.success(`${content}${pendingGifUrl ? ` + GIF` : ""}`, "LILY REPLY - BUDGET EXHAUSTED")
                if (channelId === YOUTUBE_CHANNEL_ID) speakToStream(content).catch(err => Logger.error(`TTS failed: ${err.message}`, "TTS"))
                return { text: content, gifUrl: pendingGifUrl }
                return { text: content, gifUrl: pendingGifUrl }
            }

            Logger.warning(`Tool-call-only or empty content, retrying`, `BUDGET FALLBACK RETRY ${attempt + 1}`)
            if (raw) attemptScratch = [...attemptScratch, { role: "assistant", content: raw }]
        }

        Logger.error(`Exhausted ${MAX_RETRIES} retries without a natural reply, using scripted fallback`, "BUDGET FALLBACK")
        const fallback = "... (•ᴗ•)"
        this.pushToConvoHistory(channelId, { role: "assistant", content: fallback })
        return { text: fallback, gifUrl: pendingGifUrl }
    }
    // Shared by both the native tool_calls path and the embedded <tool_call>
    // path below — runs each call, records it for the silent-effect history
    // marker if applicable, and pushes the result via the caller's pushFn
    // (which differs between the two formats: role:"tool" vs role:"user").
async runToolCalls(channelId, calls, tracker, toolsUsedThisTurn, pushFn) {
    let pendingGifUrl = null

    for (const { name, args } of calls) {
        const usesSoFar = toolsUsedThisTurn.get(name) ?? 0
        const cap = isMinecraftActionTool(name)
            ? this.opts.maxUsesPerMinecraftAction
            : this.opts.maxUsesPerTool

        if (usesSoFar >= cap) {
            Logger.warning(`${name} already used ${usesSoFar}x this turn (cap: ${cap})`, "BLOCKED")
            this.tools.markFlawed('tool_cap_exceeded')
            pushFn(name, isMinecraftActionTool(name)
                ? `You've already done that this turn — don't call another action tool unless the player just asked for something new. Reply in character now.`
                : `You've already used ${name} ${usesSoFar} time(s) this turn — that's the limit. Move on and reply in character now.`)
            if (this.tools.shouldHardStop()) break
            continue
        }

        if (!isMinecraftActionTool(name)) {
            const repeatBlock = tracker.check(name, args)
            if (repeatBlock) {
                this.tools.markFlawed('tool_repeat_blocked')
                pushFn(name, repeatBlock)
                if (this.tools.shouldHardStop()) break
                continue
            }
        }

        toolsUsedThisTurn.set(name, usesSoFar + 1)
        const result = await this.tools.execute(name, args, { channelId })

        if (GIF_TOOLS.has(name)) {
            try {
                const parsed = JSON.parse(result)
                if (parsed.status === "ok") pendingGifUrl = parsed.url
            } catch { }
        }

        pushFn(name, result)
        if (this.tools.shouldHardStop()) break
    }

    return pendingGifUrl
}
    injectPendingScreenshots(channelId, scratch) {
        if (channelId !== VOICE_ASSISTANT_CHANNEL_ID) return
        const pending = this.tools.takePendingImages()
        if (!pending.length) return
        const images = pending.map(img => ({ mimeType: img.mediaType, base64: img.base64 }))
        scratch.push({ role: "user", content: this.buildUserContent("", images) })
    }
    async runToolLoop(channelId, systemPromptOverride = null, opts = {}, images = []) {
        const tracker = new ToolCallTracker(this.opts.maxToolRepeats)
        const baseTools = this.getToolsForChannel(channelId)
        let pendingGifUrl = null
        const toolsUsedThisTurn = new Map()
        let imagesInjected = false
        const foreignTools = opts.tools ?? []
        const foreignToolNames = new Set(foreignTools.map(t => t.function?.name).filter(Boolean))
        const scratch = []

        for (let i = 0; i < this.opts.maxToolLoops; i++) {
            let messages = this.buildMessagesForOllama(channelId, systemPromptOverride, opts)
            messages.push(...scratch)

            if (!imagesInjected && images.length > 0) {
                imagesInjected = true
                for (let j = messages.length - 1; j >= 0; j--) {
                    if (messages[j].role === "user") {
                        const originalText = typeof messages[j].content === "string" ? messages[j].content : ""
                        messages[j] = { ...messages[j], content: this.buildUserContent(originalText, images) }
                        break
                    }
                }
            }

            const msg = await this.sendToOllama(messages, foreignTools, false, baseTools)
            if (!msg) return { text: "I'm having trouble thinking right now, sorry!", gifUrl: null }

            const content = (msg.content ?? "").trim()

            if (msg.tool_calls?.length) {
                const foreignCalls = msg.tool_calls.filter(tc => foreignToolNames.has(tc.function.name))

                if (foreignCalls.length) {
                    Logger.info(`${foreignCalls.map(tc => `${tc.function.name}(${tc.function.arguments})`).join(" | ")} -> Continue`, "HANDOFF")
                    if (foreignCalls.length > 1) {
                        Logger.warning(`Model tried ${foreignCalls.length} tool calls at once — only forwarding the first`, "MULTI-TOOL")
                    }
                    const single = foreignCalls[0]
                    this.pushToConvoHistory(channelId, { role: "assistant", content: msg.content ?? "", tool_calls: [single] })
                    return { text: msg.content ?? "", gifUrl: null, tool_calls: [single] }
                }

                Logger.success(`Lily called the tool: ${msg.tool_calls.map(tc => tc.function.name).join(", ")}`, "NATIVE")
                scratch.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls })

                const calls = msg.tool_calls.map(tc => {
                    let args = {}
                    try { args = JSON.parse(tc.function.arguments ?? "{}") } catch { }
                    return { id: tc.id, name: tc.function.name, args }
                })

                const gif = await this.runToolCalls(
                    channelId, calls, tracker, toolsUsedThisTurn,
                    (name, text) => {
                        const call = calls.find(c => c.name === name && !c._used)
                        if (call) call._used = true
                        scratch.push({ role: "tool", tool_call_id: call?.id, content: text })
                    }
                )
                if (gif) pendingGifUrl = gif
                this.injectPendingScreenshots(channelId, scratch) 

                if (this.tools.shouldHardStop()) {
                    Logger.warning(`Tool budget/limit exhausted this turn, forcing final reply`, "HARD STOP")
                    return this.finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl)
                }

                const didMinecraftAction = calls.some(c => isMinecraftActionTool(c.name))
                if (didMinecraftAction) {
                    Logger.info(`Ending turn, no further tool offers this turn`, "ACTION DISPATCHED")
                    return this.finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl)
                }

                continue
            }

            if (content.includes("<tool_call>")) {
                const calls = this.parseEmbeddedToolCalls(content)
                if (calls.length) {
                    scratch.push({ role: "assistant", content })

                    const gif = await this.runToolCalls(
                        channelId, calls, tracker, toolsUsedThisTurn,
                        (_name, text) => scratch.push({ role: "user", content: `<tool_response>\n${text}\n</tool_response>` })
                    )
                    
                    if (gif) pendingGifUrl = gif
                    this.injectPendingScreenshots(channelId, scratch) 

                    if (this.tools.shouldHardStop()) {
                        Logger.warning(`Tool budget/limit exhausted this turn, forcing final reply`, "HARD STOP")
                        return this.finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl)
                    }

                    const didMinecraftAction = calls.some(c => isMinecraftActionTool(c.name))
                    if (didMinecraftAction) {
                        Logger.info(`Ending turn, no further tool offers this turn`, "ACTION DISPATCHED")
                        return this.finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl)
                    }

                    continue
                }

                Logger.warning(`${content.slice(0, 200)}`, "MALFORMED")
                this.tools.markFlawed('malformed_tool_call')
                scratch.push({ role: "assistant", content })
                scratch.push({
                    role: "user",
                    content: `[System: Your <tool_call> was malformed. Use exact format:\n<tool_call>\n{"name": "tool_name", "arguments": {"arg": "value"}}\n</tool_call>]`
                })
                continue
            }

            if ([...ALL_TOOL_NAMES].some(name => content.includes(name))) {
                Logger.warning(`Model described tool instead of calling`, "NARRATE")
                scratch.push({ role: "assistant", content })

                if (this.tools.recordNarration()) {
                    Logger.warning(`Narration budget exhausted, forcing final reply`, "HARD STOP")
                    return this.finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl)
                }

                scratch.push({
                    role: "user",
                    content: `[System: You narrated a tool instead of calling it. Make proper use of the tool calls with the correct format.]`
                })
                continue
            }

            if (content && content.toLowerCase() !== "none") {
                this.maybeSaveFlawlessTurn(channelId, systemPromptOverride, scratch, content)
                this.pushToConvoHistory(channelId, { role: "assistant", content })
                Logger.success(`${content}${pendingGifUrl ? ` + GIF` : ""}`, "LILY REPLY")
                if (channelId === YOUTUBE_CHANNEL_ID) speakToStream(content).catch(err => Logger.error(`TTS failed: ${err.message}`, "TTS"))
                return { text: content, gifUrl: pendingGifUrl }
            }

            Logger.error(`No content`, "EMPTY")
            return { text: "I'm not sure about that one!", gifUrl: null }
        }

        Logger.warning(`Forcing final no-tools reply`, "LOOP BUDGET EXHAUSTED")
        this.tools.markFlawed('tool_loop_budget_exhausted')
        return this.finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl)
    }

    pushHistoryToBlog(channelId) {
        const messages = this.getHistory(channelId).get()
            .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
            .map(m => ({ role: m.role, content: m.content.trim() }))

        if (!messages.length) return

        axios.post(`${this.opts.blogUrl}/api/history`, {
            channelId,
            messages,
        }, { timeout: 3000 }).catch(err => {
            Logger.error(`Push failed (non-fatal): ${err.message}`, "BLOG HISTORY")
        })
    }

    async handleMessage(channelId, rawInput, logPrefix, systemPromptOverride = null, opts = {}, images = []) {
        const clean = sanitizeInput(rawInput)
        if (!clean && images.length === 0) return null

        if (this.channelLocks.get(channelId)) {
            Logger.warning(`Ignoring message in channel ${channelId} while Lily is still replying: ${clean.slice(0, 100)}`, "BUSY")
            return null
        }

        Logger.info(`${clean.slice(0, 200)}${images.length ? ` + ${images.length} image(s)` : ""}`, logPrefix)

        const { skipped, result } = await this.tryChannelLock(channelId, async () => {
            const userMessage = { role: "user", content: clean || "[sent an image]" }
            this.pushToConvoHistory(channelId, userMessage)
            // Snapshot of just this turn's triggering user message — see
            // maybeSaveFlawlessTurn for why this is kept separate from the
            // full convoHistories.
            this.turnStartMessages.set(channelId, userMessage)

            this.tools.resetTurn()
            // passaive memory injection
            const autoMemoryBlock = await this.tools.autoInjectMemory(clean)
            if (autoMemoryBlock) this.turnAutoMemoryBlocks.set(channelId, autoMemoryBlock)
            else this.turnAutoMemoryBlocks.delete(channelId)

            const count = (this.channelMessageCounts.get(channelId) ?? 0) + 1
            this.channelMessageCounts.set(channelId, count)
            if (this.opts.summarizeEvery > 0 && count % this.opts.summarizeEvery === 0) {
                await this.summarizeConversationAndStore(channelId)
            }

            const loopResult = await this.runToolLoop(channelId, systemPromptOverride, opts, images)

            if (loopResult?.text) {
                this.pushHistoryToBlog(channelId)
            }

            return loopResult
        })

        if (skipped) {
            Logger.warning(`Ignoring message in channel ${channelId} while Lily is still replying (race)`, "BUSY")
            return null
        }

        return result
    }

    chat(channelId, userInput, systemPromptOverride = null, opts = {}, images = []) {
        return this.handleMessage(channelId, userInput, "USER PROMPT", systemPromptOverride, opts, images)
    }

    // systemPromptOverride defaults to null (old behavior: falls back to
    // SYSTEM_PROMPT inside handleMessage/buildMessagesForOllama) so
    // existing Discord/Minecraft callers are unaffected. VRChat's ambient
    // "butt-in" commentary passes its own addendum-bearing prompt (see
    // buildVrchatSystemPrompt(true) in prompts.js) since its silence-by-
    // default framing doesn't apply to Discord's use of this same path.
    buttIn(channelId, rawMessage, systemPromptOverride = null) {
        return this.handleMessage(channelId, rawMessage, "BUTT IN", systemPromptOverride)
    }
}

export { VRCHAT_CHANNEL_ID, MINECRAFT_CHANNEL_ID, VOICE_ASSISTANT_CHANNEL_ID }