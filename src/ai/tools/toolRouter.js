// toolRouter.js
import { Logger } from '../../utils/Logger.js'
import { ChatToolExecutor, CHAT_TOOLS, CHAT_TOOL_NAMES } from './chatTools.js'
import { MinecraftToolExecutor, MINECRAFT_TOOL_NAMES } from './minecraftTools.js'
import { VtubeToolExecutor, VTUBE_TOOL_NAMES } from './vtubeTools.js'
import { VrchatToolExecutor, VRCHAT_TOOL_NAMES } from './vrchatTools.js'
import { SttsToolExecutor, STTS_TOOL_NAMES } from './sttsTools.js'
import { BrowserToolExecutor, BROWSER_TOOL_NAMES } from './browserTools.js'

const VOICE_ASSISTANT_CHANNEL = 'voiceAssistant'

class ToolRouter {
    /**
     * @param {object} deps - external dependencies
     * @param {Function} deps.mcSend - Minecraft send function (optional)
     * @param {Function} deps.getStateController - Minecraft state controller getter
     * @param {object} deps.vtsClient - VTube Studio client (optional)
     * @param {object} deps.sttsConfig - { enabled, pidevEnabled }
     * @param {object} deps.flags - tool enablement flags from runConfig
     *   { minecraft: boolean, vtube: boolean, vrchat: boolean, stts: boolean, browser: boolean }
     */
    constructor({ mcSend = null, getStateController = null, vtsClient = null, sttsConfig = {}, flags = {} }) {
        // Destructure flags with defaults
        const {
            minecraft = false,
            vtube = false,
            vrchat = false,
            stts = false,
            browser = false,
        } = flags

        // Always create chat (core)
        this.chat = new ChatToolExecutor()

        // Conditionally create executors
        this.minecraft = minecraft ? new MinecraftToolExecutor(mcSend, getStateController) : null
        this.vtube = vtube ? new VtubeToolExecutor(vtsClient) : null
        this.vrchat = vrchat ? new VrchatToolExecutor() : null
        this.stts = stts ? new SttsToolExecutor(
            sttsConfig.enabled,
            sttsConfig.pidevEnabled,
            sttsConfig.codingEnabled,
            sttsConfig.editCallback,
        ) : null
        this.browser = browser ? new BrowserToolExecutor() : null

        // Build name→executor map only for enabled executors
        this._byName = new Map()
        const executors = [this.chat]
        if (this.minecraft) executors.push(this.minecraft)
        if (this.vtube) executors.push(this.vtube)
        if (this.vrchat) executors.push(this.vrchat)
        if (this.stts) executors.push(this.stts)
        if (this.browser) executors.push(this.browser)

        for (const executor of executors) {
            for (const name of executor.toolNames) {
                this._byName.set(name, executor)
            }
        }
    }

    // ---- setters (preserved) ----
    get mcSend() { return this.minecraft?.mcSend ?? null }
    set mcSend(fn) { if (this.minecraft) this.minecraft.setMcSend(fn) }
    setMcSend(fn) { this.mcSend = fn }

    setVtsClient(vtsClient) { if (this.vtube) this.vtube.setVtsClient(vtsClient) }
    setBrowserClient(client) { if (this.browser) this.browser.setClient(client) }
    refreshExpressions() { return this.vtube ? this.vtube.refreshExpressions() : Promise.resolve() }
    get vtubeEnabled() { return !!this.vtube }

    // ---- core methods (delegated) ----
    resetTurn() { this.chat.resetTurn() }
    shouldHardStop() { return this.chat.shouldHardStop() }
    markFlawed(reason) { this.chat.markFlawed(reason) }
    recordNarration() { return this.chat.recordNarration() }
    get turnFlawless() { return this.chat.turnFlawless }
    autoInjectMemory(queryText) { return this.chat.autoInjectMemory(queryText) }
    addEpisodicMemory(payload) { return this.chat.addEpisodicMemory(payload) }

    // ---- Tool lists – only include enabled executors ----
    get tools() {
        const base = [...this.chat.tools]
        if (this.minecraft) base.push(...this.minecraft.tools)
        if (this.vtube) base.push(...this.vtube.tools)
        return base
    }

    get nonMinecraftTools() {
        const base = [...this.chat.tools]
        if (this.vtube) base.push(...this.vtube.tools)
        return base
    }

    get vrchatTools() {
        const base = [...this.chat.tools]
        if (this.vtube) base.push(...this.vtube.tools)
        if (this.vrchat) base.push(...this.vrchat.tools)
        return base
    }

    get voiceAssistantTools() {
        const base = [...this.chat.tools]
        if (this.vtube) base.push(...this.vtube.tools)
        if (this.stts) base.push(...this.stts.tools)
        if (this.browser) base.push(...this.browser.tools)
        return base
    }

    // ---- tool name checks (safe) ----
    isChatTool(name) { return CHAT_TOOL_NAMES.has(name) }
    isMinecraftTool(name) { return this.minecraft && MINECRAFT_TOOL_NAMES.has(name) }
    isVtubeTool(name) { return this.vtube && VTUBE_TOOL_NAMES.has(name) }
    isVrchatTool(name) { return this.vrchat && VRCHAT_TOOL_NAMES.has(name) }
    isSttsTool(name) { return this.stts && STTS_TOOL_NAMES.has(name) }
    isBrowserTool(name) { return this.browser && BROWSER_TOOL_NAMES.has(name) }

    // ---- screenshot drain (only if stts enabled) ----
    takePendingImages() {
        return this.stts ? this.stts.takePendingImages() : []
    }

    // ---- execute – only if executor exists ----
    async execute(name, args, context = {}) {
        const executor = this._byName.get(name)
        if (!executor) {
            Logger.warning(`Unknown: ${name}`, "TOOL")
            this.chat.markFlawed('unknown_tool')
            return JSON.stringify({ status: "error", message: `Unknown tool: ${name}` })
        }

        // Guard STTS and browser tools to voice channel
        const isStts = this.stts && this.isSttsTool(name)
        const isBrowser = this.browser && this.isBrowserTool(name)
        if ((isStts || isBrowser) && context.channelId !== VOICE_ASSISTANT_CHANNEL) {
            Logger.warning(`Blocked "${name}" outside voiceAssistant channel (channelId=${context.channelId})`, "TOOL")
            this.chat.markFlawed(isStts ? 'stts_tool_wrong_channel' : 'browser_tool_wrong_channel')
            return JSON.stringify({ status: "error", message: `${name} is only available in voice conversations.` })
        }

        return executor.execute(name, args)
    }
}

const ALL_TOOL_NAMES = new Set([
    ...CHAT_TOOL_NAMES,
    ...MINECRAFT_TOOL_NAMES,
    ...VTUBE_TOOL_NAMES,
    ...VRCHAT_TOOL_NAMES,
    ...STTS_TOOL_NAMES,
    ...BROWSER_TOOL_NAMES,
])

export { ToolRouter, ALL_TOOL_NAMES, VOICE_ASSISTANT_CHANNEL }