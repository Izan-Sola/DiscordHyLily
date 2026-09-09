// start.js
import 'dotenv/config'
import { createBot } from "./discord/bot.js"
import { config } from "./utils/config.js"
import { Logger } from "./utils/Logger.js"
import { parseFlags, getConfigFromFlags, describeConfig, isVtubeEnabled, isModdedEnabled, isMineflayerEnabled } from "./startUtils.js"
import * as stts from './STTS/index.js'
import { startVoiceAssistant, stopVoiceAssistant } from './voiceAssistant/index.js'
import { Lily } from './ai/Lily.js'

// ---------- 1. Parse flags & build config ----------
const flags = parseFlags()
let runConfig
try {
    runConfig = getConfigFromFlags(flags)
} catch (err) {
    Logger.error(err.message, "STARTUP")
    process.exit(1)
}

const { backend, vtube, discord: isDiscordEnabled, vrchat: isVrchatEnabled, coding: isCodingEnabled, pidev: isPidevEnabled, browser: isBrowserEnabled } = runConfig

if (flags.has('bending') && backend !== 'modded') {
    Logger.warning("'bending' flag has no effect without 'modded' - ignoring", "STARTUP")
}

Logger.info(`Starting with flags: ${[...flags].join(', ') || '(none)'}`, "STARTUP")
Logger.info(`  • Discord: ${isDiscordEnabled ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • VTube Studio: ${vtube ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • Minecraft: ${backend === 'mineflayer' ? 'Mineflayer' : backend === 'modded' ? 'Modded (NeoForge)' : 'None'}`, "STARTUP")
Logger.info(`  • VRChat: ${isVrchatEnabled ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • Continue.dev coding bridge: ${isCodingEnabled ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • Tavily MCP server: ${isCodingEnabled ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • Pi-dev bridge: ${isPidevEnabled ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • Speech-to-Text (STT) + Voice Assistant: ${runConfig.stts ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • Browser control bridge: ${isBrowserEnabled ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")

if (!isDiscordEnabled && !backend && !isVrchatEnabled && !runConfig.stts) {
    Logger.warning('No Discord, no Minecraft, no VRChat bridge, and no STTS active - there is nothing for this process to do', "STARTUP")
}

// ---------- 2. Instantiate Lily ----------
const sttsConfig = {
    enabled: runConfig.stts,
    pidevEnabled: runConfig.stts && isPidevEnabled,
}

export const ai = new Lily(
    {},                                     // options (will use config defaults)
    null,                                   // mcSend – set later via ai.setMcSend()
    null,                                   // vtsClient – set later via ai.setVtsClient()
    sttsConfig,
    null,                                   // onVoiceGif – optional, can be added later
    {
        modded: backend === 'modded',
        mineflayer: backend === 'mineflayer',
        vtube: runConfig.vtube,
        vrchat: runConfig.vrchat,
        stts: runConfig.stts,
        browser: runConfig.browser,
    }
)

// ---------- 3. Variables for services ----------
let vtsClient = null
let survivalLoopHandle = null
let vrchatBotHandle = null
let ytClient = null
let ytBuffer = null
let continueBridgeHandle = null
let pidevBridgeHandle = null
let tavilyServerHandle = null
let browserBridgeHandle = null // { process, client }

// ---------- 4. Service initializers ----------
async function startBrowserBridge() {
    if (!isBrowserEnabled) return null
    const { startBrowserBridge } = await import('./browser/bridge.js')
    try {
        const handle = await startBrowserBridge()
        if (handle?.client) ai.setBrowserClient(handle.client)
        return handle
    } catch (err) {
        Logger.error(`Browser control bridge failed to start: ${err.message}`, "BROWSER")
        return null
    }
}

async function initializeVTS() {
    if (!vtube) return null

    try {
        const { VTSClient } = await import('./vtubing/VTSClient.js')
        const client = new VTSClient({
            host: process.env.VTS_HOST || 'localhost',
            port: parseInt(process.env.VTS_PORT || '8001'),
            pluginName: process.env.VTS_PLUGIN_NAME || 'LilyVTS',
            pluginDev: process.env.VTS_PLUGIN_DEV || 'Izan'
        })

        await client.connect()
        Logger.success('VTube Studio connected', "VTUBE")
        ai.setVtsClient(client)
        return client
    } catch (err) {
        Logger.error(`VTube Studio failed: ${err.message}`, "VTUBE")
        return null
    }
}

async function initializeYoutubeChat() {
    if (!vtube) return

    try {
        const { YouTubeLiveChatClient } =
            await import('./vtubing/youtube/liveClient.js')

        const { YouTubeChatBuffer } =
            await import('./vtubing/youtube/chatBuffer.js')

        ytBuffer = new YouTubeChatBuffer(ai)

        ytClient = new YouTubeLiveChatClient({
            onMessage: (author, text) => ytBuffer.push(author, text)
        })

        await ytClient.start()

        Logger.success('YouTube live chat connected', "YOUTUBE")

    } catch (err) {
        const status = err.response?.status
        const data = err.response?.data

        Logger.error(
            `YouTube chat failed: HTTP ${status ?? 'unknown'} | ` +
            `${data?.error?.errors?.[0]?.reason ?? 'unknown'} | ` +
            `${data?.error?.message ?? err.message}`,
            "YOUTUBE"
        )

        console.error('[YOUTUBE FULL ERROR]', data)
    }
}

async function startMinecraft() {
    if (backend === 'mineflayer') {
        const { startMinecraftBot } = await import('./minecraft/mineflayer/index.js')
        return startMinecraftBot({
            host: process.env.MC_SERVER_HOST ?? "localhost",
            port: parseInt(process.env.MC_SERVER_PORT ?? "25565"),
            username: process.env.MC_BOT_USERNAME ?? "SillyLily_",
            followTarget: process.env.MC_FOLLOW_TARGET ?? "shinyshadow_",
            ai,
            vtsClient,
            runConfig
        })
    } else if (backend === 'modded') {
        const { startMinecraftBot } = await import('./minecraft/neoforgemod-way/bot.js')
        return startMinecraftBot({
            host: process.env.MC_BRIDGE_HOST ?? "localhost",
            port: parseInt(process.env.MC_BRIDGE_PORT ?? "8766"),
            ai,
            vtsClient,
            runConfig
        })
    }
    return null
}

async function startSurvivalLoop(mcSend, mcChat, stateController) {
    let loopFn
    if (isMineflayerEnabled()) {
        return null
    } else if (isModdedEnabled()) {
        ; ({ startSurvivalLoop: loopFn } = await import('./minecraft/neoforgemod-way/state-machine/helpers/survivalLoop.js'))
    } else {
        return null
    }

    return loopFn(
        stateController,
        mcSend,
        mcChat,
        process.env.OLLAMA_URL ?? "http://localhost:11435",
        runConfig,
        vtsClient
    )
}

async function startTavilyServer() {
    if (!isCodingEnabled) return null
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['./src/coding/tavily-mcp-server.js'], {
        stdio: 'pipe',
        env: process.env,
    })

    child.on('exit', (code, signal) => {
        Logger.warning(`Tavily MCP server exited (code ${code}, signal ${signal})`, "TAVILY")
    })
    child.on('error', (err) => {
        Logger.error(`Tavily MCP server failed to spawn: ${err.message}`, "TAVILY")
    })

    child.stderr?.on('data', (data) => {
        Logger.error(`Tavily MCP stderr: ${data.toString()}`, "TAVILY")
    })

    return child
}

async function startVrchat() {
    if (!isVrchatEnabled) return null
    const { startVrchatBot } = await import('./vrchatBot/index.js')
    return startVrchatBot({ ai })
}

async function startCodingBridge() {
    if (!isCodingEnabled) return null
    const { startContinueBridge } = await import('./coding/continue-bridge.js')
    return startContinueBridge(ai)
}

async function startPidevBridge() {
    if (!isPidevEnabled) return null
    const { startPidevBridge: start } = await import('./pidev-bridge/pidev-bridge.js')
    return start()
}

// ---------- 5. Initialize all features ----------
async function initializeFeatures() {
    vtsClient = await initializeVTS()
    // vtsClient is already set in ai via setVtsClient inside initializeVTS

    await initializeYoutubeChat()

    const mcBot = await startMinecraft()

    if (mcBot && backend === 'modded') {
        const { stateController, mcSend, mcChat } = mcBot
        if (mcSend) ai.setMcSend(mcSend)

        const survivalLoop = await startSurvivalLoop(mcSend, mcChat, stateController)

        if (survivalLoop) {
            survivalLoopHandle = survivalLoop
            Logger.success('Survival loop started', "SURVIVAL")
        }
    } else if (mcBot && backend === 'mineflayer') {
        // Mineflayer bot might expose mcSend – adjust as needed
        if (mcBot.mcSend) ai.setMcSend(mcBot.mcSend)
    }

    vrchatBotHandle = await startVrchat()
    if (vrchatBotHandle) {
        Logger.success('VRChat bridge started', "VRCHAT")
    }

    continueBridgeHandle = await startCodingBridge()
    if (continueBridgeHandle) {
        Logger.success('Continue.dev coding bridge started', "CODING")
    }

    tavilyServerHandle = await startTavilyServer()
    if (tavilyServerHandle) {
        Logger.success('Tavily MCP server started', "TAVILY")
    }

    browserBridgeHandle = await startBrowserBridge()
    if (browserBridgeHandle) {
        Logger.success('Browser control bridge started', "BROWSER")
    }

    pidevBridgeHandle = await startPidevBridge()
    if (pidevBridgeHandle) {
        Logger.success('Pi-dev bridge started', "PIDEV")
    }
}

// ---------- 6. Discord setup ----------
async function setupDiscordBot() {
    if (!isDiscordEnabled) {
        Logger.info("'discord' flag not set - skipping Discord login", "STARTUP")
        await initializeFeatures()
        return null
    }

    const client = await createBot()

    client.once("clientReady", async () => {
        Logger.success(`Logged in as ${client.user.tag}`, "CLIENT")
        try {
            await initializeFeatures()
        } catch (err) {
            Logger.error(`initializeFeatures failed: ${err.stack ?? err.message}`, "STARTUP")
        }
    })

    await client.login(config.token)
    return client
}

// ---------- 7. Main ----------
async function main() {
    try {
        if (runConfig.stts) {
            try {
                await stts.start()
                Logger.success('Transcription service started', 'STTS')
                startVoiceAssistant()
                Logger.success('Voice assistant started', 'VOICE')
            } catch (err) {
                Logger.error(`Failed to start STT/voice assistant: ${err.message}`, 'STTS')
            }
        }

        const client = await setupDiscordBot()

        const shutdown = async (signal) => {
            Logger.info(`Shutting down (${signal})...`, "SHUTDOWN")

            if (vtsClient) {
                await vtsClient.disconnect().catch(() => { })
            }
            if (ytClient) ytClient.stop()
            if (ytBuffer) ytBuffer.stop()

            if (survivalLoopHandle?._interval) {
                clearInterval(survivalLoopHandle._interval)
            }

            if (survivalLoopHandle?.stop) {
                survivalLoopHandle.stop()
            }

            if (vrchatBotHandle?.stop) {
                await vrchatBotHandle.stop()
            }

            if (continueBridgeHandle?.close) {
                await new Promise(resolve => continueBridgeHandle.close(resolve))
            }
            if (pidevBridgeHandle?.close) {
                await new Promise(resolve => pidevBridgeHandle.close(resolve))
            }
            if (tavilyServerHandle?.kill) {
                tavilyServerHandle.kill()
            }
            if (browserBridgeHandle?.client) {
                browserBridgeHandle.client.close()
            }
            if (browserBridgeHandle?.process?.kill) {
                browserBridgeHandle.process.kill()
            }
            if (pidevBridgeHandle?.close) {
                await new Promise(resolve => pidevBridgeHandle.close(resolve))
            }

            if (runConfig.stts) {
                stopVoiceAssistant()
                stts.stop()
                Logger.info('Transcription and voice assistant stopped', 'STTS')
            }

            if (client) {
                await client.destroy()
            }
            process.exit(0)
        }

        process.on('SIGINT', () => shutdown('SIGINT'))
        process.on('SIGTERM', () => shutdown('SIGTERM'))

        Logger.success('Bot started!', "MAIN")
    } catch (err) {
        Logger.error(`Failed to start: ${err.message}`, "MAIN")
        process.exit(1)
    }
}

main()