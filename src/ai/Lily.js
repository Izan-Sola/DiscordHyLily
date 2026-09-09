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
const MINECRAFT_CHANNEL_ID = "minecraft"
const VRCHAT_CHANNEL_ID = "vrchat"

function isMinecraftActionTool(name) {
    return name === "minecraft_action" || name.startsWith("minecraft_action")
}

const GIF_TOOLS = new Set(["send_gif", "send_meme"])

export class Lily {
    /**
     * @param {object} options
     * @param {(type: string, params: object) => void} [mcSend]
     * @param {object} [vtsClient]
     * @param {object} [sttsConfig]
     * @param {Function} [onVoiceGif] - callback (gifUrl: string) => void
     *   called when a GIF is generated via voice assistant channel.
     */
    constructor(options = {}, mcSend = null, vtsClient = null, sttsConfig = {}, onVoiceGif = null) {
        this._optsOverride = options
        this.convoHistories = new Map()
        this.rawBuffers = new Map()
        this.channelLocks = new Map()
        this.channelMessageCounts = new Map()
        this.observeBuffers = new Map()
        this.observeParticipants = new Map()
        this.mcSend = mcSend
        this.tools = new ToolRouter(mcSend, getStateController, vtsClient, sttsConfig)
        this._resumedIds = new Map()
        this._replayCounts = new Map()
        this.turnStartMessages = new Map()
        this.turnLog = new Map()
        this.turnAutoMemoryBlocks = new Map()
        this._onVoiceGif = onVoiceGif
    }

    // Helper to call the voice‑GIF callback
    _handleVoiceGif(channelId, gifUrl) {
        if (channelId === VOICE_ASSISTANT_CHANNEL_ID && gifUrl && this._onVoiceGif) {
            try {
                this._onVoiceGif(gifUrl)
            } catch (err) {
                Logger.error(`Voice GIF callback failed: ${err.message}`, "VOICE GIF")
            }
        }
    }

    get opts() {
        return Object.assign(getConfig(), this._optsOverride)
    }

    getObserveBuffer(channelId) {
        if (!this.observeBuffers.has(channelId)) this.observeBuffers.set(channelId, [])
        return this.observeBuffers.get(channelId)
    }

    setMcSend(mcSend) {
        this.mcSend = mcSend
        this.tools.setMcSend(mcSend)
    }

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
                reasoning_effort: this.opts.think === false ? "none" : (this.opts.think ?? "none"),
                think: this.opts.think ?? false,
            }
            if (!noTools) {
                payload.tools = foreignTools.length ? [...baseTools, ...foreignTools] : baseTools
            }

            const { data } = await axios.post(`${this.opts.ollamaUrl}/v1/chat/completions`, payload, { timeout: this.opts.ollamaTimeout })
            const msg = data.choices?.[0]?.message ?? null

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

    parseEmbeddedToolCalls(content) {
        const blocks = [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)]
        const calls = []

        for (const block of blocks) {
            const inner = block[1].trim()

            if (inner.startsWith("{")) {
                try {
                    const parsed = JSON.parse(inner)
                    let args = parsed.arguments ?? parsed.args ?? {}
                    if (typeof args === "string") try { args = JSON.parse(args) } catch { args = {} }
                    calls.push({ name: parsed.name, args })
                    continue
                } catch { /* fall through */ }
            }

            const fnMatch = inner.match(/<function=([^>]+)>([\s\S]*?)<\/function>/)
            if (fnMatch) {
                const name = fnMatch[1].trim()
                const paramSection = fnMatch[2]
                const args = {}
                const paramMatches = [...paramSection.matchAll(/<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g)]
                for (const p of paramMatches) {
                    const key = p[1].trim()
                    let value = p[2].trim()
                    try { value = JSON.parse(value) } catch { /* keep as string */ }
                    args[key] = value
                }
                calls.push({ name, args })
                continue
            }
        }

        return calls
    }

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

            const result = await this.runToolLoop(channelId, systemPromptOverride, opts, images)
            for (const tr of toolResults) this._resumedIds.set(tr.tool_call_id, result)

            if (result?.text) this.pushHistoryToBlog(channelId)
            return result
        })
    }

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

        if (log.length < windowSize) {
            this.turnLog.set(channelId, log)
            return
        }

        try {
            const baseMessages = [{ role: "system", content: systemPromptOverride ?? SYSTEM_PROMPT }]
            const fullConversation = [...baseMessages, ...log.flat()]
            saveFlawlessTurn({ channelId, messages: fullConversation }).catch(err => {
                Logger.error(err.message, "FLAWLESS SAVE")
            })
        } catch (err) {
            Logger.error(err.message, "FLAWLESS SAVE")
        }

        this.turnLog.delete(channelId)
    }

    async finishWithoutTools(channelId, systemPromptOverride, opts, scratch, pendingGifUrl) {
        const baseMessages = this.buildMessagesForOllama(channelId, systemPromptOverride, { ...opts, suppressActionReminder: true })
        let attemptScratch = [...scratch]
        const MAX_RETRIES = 6

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
                this._handleVoiceGif(channelId, pendingGifUrl)
                return { text: content, gifUrl: pendingGifUrl }
            }

            Logger.warning(`Tool-call-only or empty content, retrying`, `BUDGET FALLBACK RETRY ${attempt + 1}`)
            if (raw) attemptScratch = [...attemptScratch, { role: "assistant", content: raw }]
        }

        Logger.error(`Exhausted ${MAX_RETRIES} retries without a natural reply, using scripted fallback`, "BUDGET FALLBACK")
        const fallback = "... (•ᴗ•)"
        this.pushToConvoHistory(channelId, { role: "assistant", content: fallback })
        this._handleVoiceGif(channelId, pendingGifUrl)
        return { text: fallback, gifUrl: pendingGifUrl }
    }

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
            if (!msg) {
                this._handleVoiceGif(channelId, pendingGifUrl)
                return { text: "I'm having trouble thinking right now, sorry!", gifUrl: null }
            }

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
                    this._handleVoiceGif(channelId, pendingGifUrl)
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
                this._handleVoiceGif(channelId, pendingGifUrl)
                return { text: content, gifUrl: pendingGifUrl }
            }

            Logger.error(`No content`, "EMPTY")
            this._handleVoiceGif(channelId, pendingGifUrl)
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
            this.turnStartMessages.set(channelId, userMessage)

            this.tools.resetTurn()
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

    buttIn(channelId, rawMessage, systemPromptOverride = null) {
        return this.handleMessage(channelId, rawMessage, "BUTT IN", systemPromptOverride)
    }
}

export { VRCHAT_CHANNEL_ID, MINECRAFT_CHANNEL_ID, VOICE_ASSISTANT_CHANNEL_ID }