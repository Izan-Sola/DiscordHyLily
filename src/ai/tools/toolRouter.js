import { Logger } from '../../utils/Logger.js'
import { ChatToolExecutor, CHAT_TOOLS, CHAT_TOOL_NAMES } from './chatTools.js'
import { MinecraftToolExecutor, MINECRAFT_TOOL_NAMES } from './minecraftTools.js'
import { VtubeToolExecutor, VTUBE_TOOL_NAMES } from './vtubeTools.js'
import { VrchatToolExecutor, VRCHAT_TOOL_NAMES } from './vrchatTools.js'
import { SttsToolExecutor, STTS_TOOL_NAMES } from './sttsTools.js'

// Only this channel ever sees the STTS tools. Discord, Minecraft, VRChat
// etc never do, even if the process was started with stts/pidev flags -
// a text message must never be able to trigger a screen capture or a
// shell-out to Pi.
const VOICE_ASSISTANT_CHANNEL = 'voiceAssistant'

class ToolRouter {

    constructor(mcSend = null, getStateController = null, vtsClient = null, sttsConfig = {}) {
        this.chat = new ChatToolExecutor()
        this.minecraft = new MinecraftToolExecutor(mcSend, getStateController)
        this.vtube = new VtubeToolExecutor(vtsClient)
        this.vrchat = new VrchatToolExecutor()
        this.stts = new SttsToolExecutor(sttsConfig.enabled, sttsConfig.pidevEnabled)

        this._byName = new Map()
        for (const executor of [this.chat, this.minecraft, this.vtube, this.vrchat, this.stts]) {
            for (const name of executor.toolNames) {
                this._byName.set(name, executor)
            }
        }
    }

    get mcSend() { return this.minecraft.mcSend }
    set mcSend(fn) { this.minecraft.setMcSend(fn) }
    setMcSend(fn) { this.minecraft.setMcSend(fn) }

    setVtsClient(vtsClient) { this.vtube.setVtsClient(vtsClient) }
    refreshExpressions() { return this.vtube.refreshExpressions() }
    get vtubeEnabled() { return this.vtube.isEnabled }

    resetTurn() { this.chat.resetTurn() }
    shouldHardStop() { return this.chat.shouldHardStop() }
    markFlawed(reason) { this.chat.markFlawed(reason) }
    recordNarration() { return this.chat.recordNarration() }
    get turnFlawless() { return this.chat.turnFlawless }

    autoInjectMemory(queryText) { return this.chat.autoInjectMemory(queryText) }
    addEpisodicMemory(payload) { return this.chat.addEpisodicMemory(payload) }

    get tools() {
        return [...this.chat.tools, ...this.minecraft.tools, ...this.vtube.tools]
    }

    get nonMinecraftTools() {
        return [...this.chat.tools, ...this.vtube.tools]
    }

    get vrchatTools() {
        return [...this.chat.tools, ...this.vtube.tools, ...this.vrchat.tools]
    }

    // Chat + VTube expressions + whichever STTS tools this process has
    // active (get_screenshot always, run_system_command only with pidev
    // too). Only ever hand this list out for the voiceAssistant channel -
    // see execute() for the matching runtime guard.
    get voiceAssistantTools() {
        return [...this.chat.tools, ...this.vtube.tools, ...this.stts.tools]
    }

    isChatTool(name) { return CHAT_TOOL_NAMES.has(name) }
    isMinecraftTool(name) { return MINECRAFT_TOOL_NAMES.has(name) }
    isVtubeTool(name) { return VTUBE_TOOL_NAMES.has(name) }
    isVrchatTool(name) { return VRCHAT_TOOL_NAMES.has(name) }
    isSttsTool(name) { return STTS_TOOL_NAMES.has(name) }

    // Drains screenshots captured since the last drain. Call after the
    // tool-execution pass, only on the voiceAssistant channel, and merge
    // the result into the images sent with the next model call.
    takePendingImages() {
        return this.stts.takePendingImages()
    }

    async execute(name, args, context = {}) {
        const executor = this._byName.get(name)
        if (!executor) {
            Logger.warning(`Unknown: ${name}`, "TOOL")
            this.chat.markFlawed('unknown_tool')
            return JSON.stringify({ status: "error", message: `Unknown tool: ${name}` })
        }

        // Defense in depth: voiceAssistantTools is the only list that
        // ever includes these, but if a call for one shows up from
        // anywhere else, refuse it here too rather than trusting the
        // tool list alone. context.channelId must be explicitly passed
        // as 'voiceAssistant' - it's fail-closed by default.
        if (this.isSttsTool(name) && context.channelId !== VOICE_ASSISTANT_CHANNEL) {
            Logger.warning(`Blocked "${name}" outside voiceAssistant channel (channelId=${context.channelId})`, "TOOL")
            this.chat.markFlawed('stts_tool_wrong_channel')
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
])

export { ToolRouter, ALL_TOOL_NAMES, VOICE_ASSISTANT_CHANNEL }