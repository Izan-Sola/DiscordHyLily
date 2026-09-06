import { createBot, ai } from "./discord/bot.js"
import { config } from "./utils/config.js"
import { Logger } from "./utils/Logger.js"
import { parseFlags, getConfigFromFlags, describeConfig, isVtubeEnabled, isModdedEnabled, isMineflayerEnabled } from "./startUtils.js"

const flags = parseFlags()

let runConfig
try {
    runConfig = getConfigFromFlags(flags)
} catch (err) {
    Logger.error(err.message, "STARTUP")
    process.exit(1)
}

const { backend, vtube, discord: isDiscordEnabled, vrchat: isVrchatEnabled } = runConfig

if (flags.has('bending') && backend !== 'modded') {
    Logger.warning("'bending' flag has no effect without 'modded' - ignoring", "STARTUP")
}

Logger.info(`Starting with flags: ${[...flags].join(', ') || '(none)'}`, "STARTUP")
Logger.info(`  • Discord: ${isDiscordEnabled ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • VTube Studio: ${vtube ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")
Logger.info(`  • Minecraft: ${backend === 'mineflayer' ? 'Mineflayer' : backend === 'modded' ? 'Modded (NeoForge)' : 'None'}`, "STARTUP")
Logger.info(`  • VRChat: ${isVrchatEnabled ? '✅ Enabled' : '❌ Disabled'}`, "STARTUP")

if (!isDiscordEnabled && !backend && !isVrchatEnabled) {
    Logger.warning('No Discord, no Minecraft backend, and no VRChat bridge active - there is nothing for this process to do', "STARTUP")
}

let vtsClient = null
let survivalLoopHandle = null
let vrchatBotHandle = null
let ytClient = null
let ytBuffer = null

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
    if (isMineflayerEnabled()) {
        const { startSurvivalLoop } = await import('./minecraft/mineflayer/state-machine/helpers/survivalLoop.js')
    } else if (isModdedEnabled()) {
        const { startSurvivalLoop } = await import('./minecraft/neoforgemod-way/state-machine/helpers/survivalLoop.js')
    } else return
  
    return startSurvivalLoop(
        stateController,
        mcSend,
        mcChat,
        process.env.OLLAMA_URL ?? "http://localhost:11435",
        runConfig,
        vtsClient
    )
}

// Wires the VRChat avatar bridge into this same process, sharing the one
// `ai` (Lily) instance every other backend uses — same shape as
// startMinecraft() above. vrchatBot/index.js owns OSC, the web console,
// voice listening, and the VRChat auto-join pipeline; all it needs from
// here is the shared brain. Fully independent of `backend`/`vtube` — the
// vrchat flag alone is enough to bring it up.
async function startVrchat() {
    if (!isVrchatEnabled) return null
    const { startVrchatBot } = await import('./vrchatBot/index.js')
    return startVrchatBot({ ai })
}


async function initializeFeatures() {
    vtsClient = await initializeVTS()
    if (vtsClient) ai.setVtsClient(vtsClient)
    
    await initializeYoutubeChat() 
    
    const mcBot = await startMinecraft()

    if (mcBot) {
        const { stateController, mcSend, mcChat } = mcBot
        const survivalLoop = await startSurvivalLoop(mcSend, mcChat, stateController)

        if (survivalLoop) {
            survivalLoopHandle = survivalLoop
            Logger.success('Survival loop started', "SURVIVAL")
        }
    }

    vrchatBotHandle = await startVrchat()
    if (vrchatBotHandle) {
        Logger.success('VRChat bridge started', "VRCHAT")
    }
}

async function setupDiscordBot() {
    if (!isDiscordEnabled) {
        Logger.info("'discord' flag not set - skipping Discord login", "STARTUP")
        await initializeFeatures()
        return null
    }

    const client = await createBot()

    client.once("clientReady", async () => {
        Logger.success(`Logged in as ${client.user.tag}`, "CLIENT")
        await initializeFeatures()
    })

    await client.login(config.token)
    return client
}

async function main() {
    try {
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
