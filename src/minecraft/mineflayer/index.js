import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { StateController, State } from './state-machine/StateController.js'
import { startSurvivalLoop } from './state-machine/helpers/survivalLoop.js'
import { attachWhisperListener } from './state-machine/helpers/whisper.js'
import { attachAuthHandler } from './state-machine/helpers/auth.js'
import { Logger } from '../../utils/Logger.js'
import { buildMinecraftSystemPrompt } from '../../ai/prompts.js' // reuse your existing prompt builder if it takes the same ctx shape

const { pathfinder, Movements } = pathfinderPkg

let bot = null
let stateController = null
let aiInstance = null
let triggerSurvivalTick = null
let survivalLoopStarted = false

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} opts.username     any name works — cracked/offline server, no auth needed
 * @param {string} opts.followTarget e.g. "shinyshadow_" — who Lily follows/protects by default
 * @param {object} opts.ai            your existing ai instance (same one passed into startMinecraftBot before)
 * @param {string} opts.authPassword  password used for /register + /login (AuthMe-style plugins) — falls back to MC_AUTH_PASSWORD env var
 */
export function startMinecraftBot({ host, port = 25565, username = 'Lily', followTarget, ai, authPassword, runConfig, vtsClient } = {}) {
    aiInstance = ai

    bot = mineflayer.createBot({
        host,
        port,
        username,
        auth: 'offline', // cracked server — no Microsoft auth
        version: false,  // auto-detect
    })

    bot.loadPlugin(pathfinder)

    bot.once('spawn', async () => {
        Logger.info(`Spawned on ${host}:${port} as ${username}`, "MC")

        // Handle /register + /login before anything else — a lot of servers
        // won't let an unauthenticated player move, chat, or interact at all.
        attachAuthHandler(bot, authPassword ?? process.env.MC_AUTH_PASSWORD)

        const movements = new Movements(bot)
        movements.canDig = true
        movements.allowSprinting = true
        bot.pathfinder.setMovements(movements)

        stateController = new StateController(bot, {
            followTarget: followTarget ?? process.env.MC_FOLLOW_TARGET ?? null,
            followDistance: 3,
            attackRange: 4,
            lowHpThreshold: 6,
            tickMs: 150,
        })
        stateController.start()

        // ── Public chat ──────────────────────────────────────────────────
        bot.on('chat', async (username, message) => {
            if (username === bot.username) return
            await _handleIncomingMessage(username, message, 'public')
        })

        // ── Private messages (/msg) — the whole point of this feature ──────
        attachWhisperListener(bot, async (username, message) => {
            Logger.info(`${username} (whisper): ${message}`, "MC WHISPER")
            await _handleIncomingMessage(username, message, 'whisper')
        })

        if (!survivalLoopStarted) {
            const { triggerTick } = await startSurvivalLoop(
                stateController,
                (name, args) => _executeMinecraftTool(name, args),   // mcSend
                (text) => stateController.mcChat(text),               // mcChat
                process.env.OLLAMA_URL ?? "http://localhost:11435",   // ollamaUrl (must be a string!)
                runConfig,                                             // "mode" — actually the runConfig object, used for getToolConfig()
                vtsClient                                              // may be undefined for mineflayer, that's fine
            )
            triggerSurvivalTick = triggerTick
            survivalLoopStarted = true
        }
    })

    bot.on('kicked', reason => Logger.error(`Kicked: ${reason}`, "MC"))
    bot.on('error', err => Logger.error(`Bot error: ${err.message}`, "MC"))
    bot.on('end', () => {
        Logger.info("Disconnected", "MC")
        stateController?.stop()
    })

    return bot
}

async function _handleIncomingMessage(player, message, channel) {
    // Same trigger rule as the mod version: only react if her name is mentioned
    // or the message starts with "!" — EXCEPT whispers, which are always DMs
    // directed at her, so every whisper counts regardless of wording.
    const mentionsHer = message.toLowerCase().includes("lily") || message.toLowerCase().startsWith("!")
    if (channel === 'public' && !mentionsHer) return

    Logger.info(`${player}: ${message}`, `MC ${channel === 'whisper' ? 'WHISPER' : 'CHAT'}`)
    stateController?.setLastUserMessage(player, message, channel)

    try {
        const aiReply = await aiInstance.chat(
            "minecraft",
            `${player}: ${message}`,
            buildMinecraftSystemPrompt(stateController)
        )

        const text = aiReply?.text?.trim()
        if (text) {
            if (channel === 'whisper') {
                stateController.mcWhisper(player, text)
            } else {
                stateController.mcChat(text)
            }
        }
    } catch (err) {
        Logger.error(`${err.message}`, "MC CHAT ERROR")
    }
}

// ── Minimal tool executor mapping minecraft_action_* → dispatchAction ──────
// Wire this into your real ai/tools.js ToolExecutor if you'd rather share one
// implementation across Discord/VSCode/Minecraft — the action/arg names below
// match StateController.dispatchAction() exactly, same as the mod version.
async function _executeMinecraftTool(name, args) {
    if (!stateController) return 'Bot not ready.'
    const action = name.replace('minecraft_action_', '')
    const map = {
        follow: () => stateController.dispatchAction('follow', args),
        break_listed: () => stateController.dispatchAction('break', args),
        attack: () => stateController.dispatchAction('attack', args),
        retreat: () => stateController.dispatchAction('retreat', args),
        stop: () => stateController.dispatchAction('stop', args),
        move_to: () => stateController.dispatchAction('move_to', args),
        use: () => stateController.dispatchAction('use', args),
        drop: () => stateController.dispatchAction('drop', args),
    }
    const fn = map[action]
    if (!fn) return `Unknown tool: ${name}`
    const result = fn()
    return result.ok ? 'done' : (result.message ?? 'failed')
}

function buildSurvivalToolDefs() {
    // Trimmed-down tool schema — expand/replace with your existing ai/tools.js
    // TOOLS array filtered to minecraft_action_* if you already have one.
    return [
        { type: "function", function: { name: "minecraft_action_follow", description: "Follow a player.", parameters: { type: "object", properties: { player: { type: "string" } }, required: ["player"] } } },
        { type: "function", function: { name: "minecraft_action_break_listed", description: "Break a block by exact coordinates from the Blocks of Interest list.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, amount: { type: "number" } }, required: ["x", "y", "z"] } } },
        { type: "function", function: { name: "minecraft_action_attack", description: "Attack a nearby hostile entity by id.", parameters: { type: "object", properties: { entityId: { type: "number" } }, required: ["entityId"] } } },
        { type: "function", function: { name: "minecraft_action_retreat", description: "Retreat toward the follow target.", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "minecraft_action_stop", description: "Stop and go idle.", parameters: { type: "object", properties: {} } } },
    ]
}

export function stopMinecraftBot() {
    stateController?.stop()
    bot?.end()
    bot = null
    stateController = null
}

export function getStateController() { return stateController }
export { State }