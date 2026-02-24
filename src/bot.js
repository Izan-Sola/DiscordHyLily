import { Client, Collection, GatewayIntentBits } from "discord.js"
import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    EndBehaviorType,
    getVoiceConnection,
} from "@discordjs/voice"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { exec } from "child_process"
import { promisify } from "util"
import prism from "prism-media"
import { HytaleAIChat, initLogChannel } from "./ai/ollama.js"
import { config } from "./utils/config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
let isProcessingAudio = false  
const execAsync = promisify(exec)
const ai = new HytaleAIChat(config.modelName)

// ─── Voice helpers ────────────────────────────────────────────────────────────

const VOICE_SAMPLE = process.env.VOICE_SAMPLE_PATH || "./voice_sample.wav"
const PYTHON_BIN   = process.env.PYTHON_BIN || "python3"

// Shared player per guild
const guildPlayers = new Map()

export async function transcribe(audioPath) {
    const { stdout } = await execAsync(
        `${PYTHON_BIN} -c "
from faster_whisper import WhisperModel
model = WhisperModel('tiny', device='cuda', compute_type='int8')
segments, _ = model.transcribe('${audioPath}')
print(' '.join(s.text for s in segments).strip())
"`
    )
    return stdout.trim()
}

function cleanForTTS(text) {
    return text
        .replace(/[:;=8][\-o\*\']?[\)\]\(\[dDpP\/\:\}\{@\|\\]/gi, "")
        .replace(/[\)\]\(\[dDpP\/\:\}\{@\|\\][\-o\*\']?[:;=8]/gi, "")
        .replace(/[(\[{╰╯][\s\S]{0,20}?[)\]}]/g, "")
        .replace(/[✿♡♥❤★☆♪♫•·°~∿≈]/g, "")
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
        .replace(/[\u{2600}-\u{27BF}]/gu, "")
        .replace(/[\u{FE00}-\u{FEFF}]/gu, "")
        .replace(/[~\^*]{2,}/g, "")
        .replace(/\s+/g, " ")
        .replace(/\\/g, "")
        .replace(/'/g, " ")
        .trim()
}

export async function speak(text) {
    const clean   = cleanForTTS(text)
    const escaped = clean.replace(/'/g, "\\'").replace(/"/g, '\\"')
    const wavPath = "/tmp/lily_response.wav"
    const oggPath = "/tmp/lily_response.ogg"
    // await execAsync(`edge-tts --text "${escaped}" --voice en-US-AriaNeural --write-media ${wavPath}`)
    const EDGE_TTS_BIN = process.env.EDGE_TTS_BIN || "edge-tts"
    await execAsync(`${EDGE_TTS_BIN} --text "${escaped}" --voice en-US-AnaNeural --write-media ${wavPath}`)
    await execAsync(`ffmpeg -y -i ${wavPath} -c:a libopus ${oggPath}`)
    fs.unlink(wavPath, () => {})
    return oggPath
}
// export async function speak(text) {
//     const clean   = cleanForTTS(text)
//     const escaped = clean.replace(/"/g, '\\"')
//     const id      = Date.now()
//     const wavPath = `/tmp/lily_response_${id}.wav`
//     const oggPath = `/tmp/lily_response_${id}.ogg`

//     const STYLETTS2_SCRIPT = process.env.STYLETTS2_SCRIPT
//     const VOICE_REF        = process.env.VOICE_SAMPLE_PATH

//     await execAsync(
//         `${PYTHON_BIN} ${STYLETTS2_SCRIPT} --text "${escaped}" --ref "${VOICE_REF}" --out ${wavPath}`
//     )
//     await execAsync(`ffmpeg -y -i ${wavPath} -c:a libopus ${oggPath}`)
//     fs.unlink(wavPath, () => {})  // clean up wav immediately after converting to avoid corrupting the data
//     return oggPath
// }

export async function playInGuild(guildId, text) {
    const player = guildPlayers.get(guildId)
    if (!player) return
    if (isProcessingAudio) {
        console.log("🔇 [VOICE] Skipping — already processing audio")
        return
    }

    isProcessingAudio = true
    const audioPath = await speak(text)
    const resource  = createAudioResource(audioPath)
    player.play(resource)
    player.once(AudioPlayerStatus.Idle, () => {
        isProcessingAudio = false
        fs.unlink(audioPath, () => {})
    })
}

// ─── Voice listening ──────────────────────────────────────────────────────────

function listenAndTranscribe(connection, userId) {
    return new Promise((resolve, reject) => {
        const receiver    = connection.receiver
        const audioStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        })

        // Unique per session — concurrent users no longer share/overwrite files
        const sessionId  = `${userId}_${Date.now()}`
        const pcmPath    = `/tmp/lily_input_${sessionId}.pcm`
        const wavPath    = `/tmp/lily_input_${sessionId}.wav`

        // Each call gets its own decoder — sharing one across users corrupts the Opus state
        const decoder    = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 })
        const fileStream = fs.createWriteStream(pcmPath)

        // Without these, a single dropped packet crashes the entire process
        decoder.on("error", (err) => {
            console.warn(`[VOICE] Opus decode error for ${userId} (ignored):`, err.message)
        })
        audioStream.on("error", (err) => {
            console.warn(`[VOICE] Audio stream error for ${userId} (ignored):`, err.message)
        })

        audioStream.pipe(decoder).pipe(fileStream)

        audioStream.once("end", async () => {
            fileStream.end()
            try {
                await execAsync(
                    `ffmpeg -y -f s16le -ar 48000 -ac 1 -i ${pcmPath} ${wavPath}`
                )
                fs.unlink(pcmPath, () => {})
                resolve(wavPath)
            } catch (err) {
                fs.unlink(pcmPath, () => {})
                reject(err)
            }
        })
    })
}

// ─── Voice session (exported for use in slash commands) ───────────────────────

export function startVoiceSession(connection, guild) {
    const player = createAudioPlayer()
    connection.subscribe(player)
    guildPlayers.set(guild.id, player)
    console.log("🔊 [VOICE] Audio player subscribed")

    const processingUsers = new Set()
    const speakingTimers  = new Map()  // debounce timers per user

    connection.receiver.speaking.on("start", (userId) => {
        const member = guild.members.cache.get(userId)
        if (!member || member.user.bot) return
        if (processingUsers.has(userId)) return

        // If a timer is already pending for this user, just reset it
        // This collapses rapid start/stop bursts into one recording session
        if (speakingTimers.has(userId)) {
            clearTimeout(speakingTimers.get(userId))
        }

        const timer = setTimeout(async () => {
            speakingTimers.delete(userId)

            // Check again after debounce — user might have gone silent already
            if (processingUsers.has(userId)) return
            processingUsers.add(userId)

            const memberName = member.displayName || member.user.username
            console.log(`🎙️ [VOICE] Processing audio from ${memberName}...`)

            try {
                const wavPath    = await listenAndTranscribe(connection, userId)
                const transcript = await transcribe(wavPath)
                fs.unlink(wavPath, () => {})

                if (!transcript || transcript.length < 2) return

                const normalized = transcript.toLowerCase().replace(/[^a-z\s]/g, "").trim()
                console.log(`📝 [STT] ${memberName} said: "${normalized}"`)

                if (!normalized.startsWith("lily") && !normalized.startsWith("lili")
                    && !normalized.startsWith("really") && !normalized.endsWith("really")
                    && !normalized.endsWith("lily") && !normalized.endsWith("lili")) return

                const formattedMessage = `[${memberName}] says to you: ${transcript}`
                const reply = await ai.chat(formattedMessage)
                await playInGuild(guild.id, reply)
            } catch (err) {
                console.error("Voice pipeline error:", err)
            } finally {
                processingUsers.delete(userId)
            }
        }, 300)  // wait 300ms of continuous speaking before starting pipeline

        speakingTimers.set(userId, timer)
    })

    connection.on("stateChange", (_, newState) => {
        if (newState.status === "destroyed") {
            guildPlayers.delete(guild.id)
            speakingTimers.forEach(t => clearTimeout(t))
            speakingTimers.clear()
        }
    })

    return player
}

// ─── Bot setup ────────────────────────────────────────────────────────────────

export async function createBot() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildVoiceStates,
        ],
    })

    client.once("ready", async () => {
        await initLogChannel(client)
    })

    client.commands = new Collection()

    const commandsPath = path.join(__dirname, "commands")
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"))

    for (const file of commandFiles) {
        const command = await import(`./commands/${file}`)
        client.commands.set(command.data.name, command)
    }

    client.on("interactionCreate", async interaction => {
        if (!interaction.isChatInputCommand()) return
        const command = client.commands.get(interaction.commandName)
        if (!command) return
        try {
            await command.execute(interaction)
        } catch (error) {
            console.error(error)
            await interaction.reply({ content: "Error executing command", ephemeral: true })
        }
    })

 client.on("messageCreate", async message => {
        if (message.author.bot) return

        const isMentioned  = message.mentions.has(client.user)
        const isReplyToBot = message.reference?.messageId
            ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === client.user.id
            : false

        const authorName = message.author.username || message.member?.displayName
        const userInput  = message.content
            .replace(`<@${client.user.id}>`, "")
            .replace(`<@!${client.user.id}>`, "")
            .trim()

        if (!isMentioned && !isReplyToBot) {
            ai.observe(`${authorName} said ${userInput}`)
            return
        }

        // ─── Voice message reply handler ──────────────────────────────────────
        if (isReplyToBot) {
            const audioAttachment = message.attachments.find(a =>
                a.contentType?.startsWith("audio/") ||
                a.name?.endsWith(".ogg") ||
                a.name?.endsWith(".mp3") ||
                a.name?.endsWith(".wav")
            )

            if (audioAttachment) {
                await message.channel.sendTyping()
                try {
                    const res        = await fetch(audioAttachment.url)
                    const arrayBuf   = await res.arrayBuffer()
                    const tmpInPath  = `/tmp/lily_voicemsg_${message.id}.ogg`
                    const tmpWavPath = `/tmp/lily_voicemsg_${message.id}.wav`
                    fs.writeFileSync(tmpInPath, Buffer.from(arrayBuf))

                    await execAsync(`ffmpeg -y -i ${tmpInPath} ${tmpWavPath}`).catch(() => {})
                    fs.unlink(tmpInPath, () => {})

                    const transcript = await transcribe(tmpWavPath)
                    fs.unlink(tmpWavPath, () => {})

                    if (!transcript || transcript.length < 2) {
                        await message.reply("I couldn't make out what you said! 🍓")
                        return
                    }

                    console.log(`📝 [VOICE MSG] ${authorName} said: "${transcript}"`)

                    const formattedMessage = `[${authorName}] says to you in a voice message: ${transcript}`
                    const reply      = await ai.chat(formattedMessage)
                    const cleanReply = reply.replace(/\/\w+.*$/s, "").trim()

                    const oggPath = await speak(cleanReply)
                    await message.reply({
                        content: `💬 *"${cleanReply}"*`,
                        files: [{ attachment: oggPath, name: "lily_response.ogg" }]
                    })
                    fs.unlink(oggPath, () => {})

                    if (guildPlayers.has(message.guild.id)) {
                        await playInGuild(message.guild.id, cleanReply)
                    }
                } catch (err) {
                    console.error("Voice message handler error:", err)
                    await message.reply("Something went wrong processing your voice message, sowwy! 🍓")
                }
                return
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        if (!userInput) {
            await message.reply("Yes? 🍓")
            return
        }

        let formattedMessage = ""

        if (message.reference?.messageId) {
            try {
                const referenced = await message.channel.messages.fetch(message.reference.messageId)
                if (referenced) {
                    const repliedUser = referenced.member?.displayName || referenced.author.username
                    if (referenced.author.id === client.user.id) {
                        formattedMessage = `[${authorName}] says to you: ${userInput}`
                    } else {
                        const quoted = referenced.content?.replace(/\n/g, " ").slice(0, 120)
                        formattedMessage = `[${authorName}] says to you, replying to ${repliedUser} who said "${quoted}": ${userInput}`
                    }
                }
            } catch {}
        }

        if (!formattedMessage && message.mentions.users.size > 1) {
            const mentionedUsers = message.mentions.users
                .filter(u => u.id !== client.user.id)
                .map(u => message.guild.members.cache.get(u.id)?.displayName || u.username)
            if (mentionedUsers.length > 0) {
                formattedMessage = `[${authorName}] mentioned ${mentionedUsers.join(", ")}, ${authorName} says to you ${userInput}`
            }
        }

        if (!formattedMessage) {
            formattedMessage = `[${authorName}] says to you: ${userInput}`
        }

        await message.channel.sendTyping()

        try {
            const reply      = await ai.chat(formattedMessage)
            const cleanReply = reply.replace(/\/\w+.*$/s, "").trim()

            await message.reply(cleanReply)

            if (guildPlayers.has(message.guild.id)) {
                await playInGuild(message.guild.id, cleanReply)
            }
        } catch (err) {
            console.error("Ping handler error:", err)
            await message.reply("I'm having trouble thinking right now, sorry!")
        }
    })

    return client
}