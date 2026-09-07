import { Client, Collection, GatewayIntentBits, Partials } from "discord.js"
import {
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    EndBehaviorType,
    getVoiceConnection,
} from "@discordjs/voice"
import fs from "fs"
import { randomUUID } from "crypto"
import { tmpdir } from "os"
import { join } from "path"
import path from "path"
import { fileURLToPath } from "url"
import { exec, spawn } from "child_process"
import { promisify } from "util"
import prism from "prism-media"
import sharp from "sharp"
import { Lily } from "../ai/index.js"
import { initLogChannel } from "../utils/Logger.js"
import { config } from "../utils/config.js"
import { getPrefs } from "../utils/userPreferences.js"
import { Logger } from "../utils/Logger.js"
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const execAsync = promisify(exec)
import { VTSClient } from "../vtubing/VTSClient.js"
import { isVtubeEnabled } from "../startUtils.js"
export const ai = new Lily({ model: config.modelName })

// ─── Voice helpers ────────────────────────────────────────────────────────────

const PYTHON_BIN = process.env.PYTHON_BIN || "python3"
const EDGE_TTS_BIN = process.env.EDGE_TTS_BIN || "edge-tts"

const guildPlayers = new Map()  // guildId → { player, isProcessing }

// ─── Media helpers ────────────────────────────────────────────────────────────

const IMAGE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"]
const VIDEO_MIME = ["video/mp4", "video/webm", "video/mov", "video/quicktime"]
const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp)$/i
const VIDEO_EXT = /\.(mp4|webm|mov)$/i
const GIF_EXT = /\.gif$/i

/**
 * Extracts the first frame of any image buffer (static or animated —
 * webp/gif/png/etc) as a JPEG buffer, using sharp/libvips.
 *
 * This deliberately replaces ffmpeg for image formats: the system ffmpeg
 * build on this box lacks --enable-libwebp, so its native WebP decoder
 * can't parse the ANIM/ANMF chunks used by animated WebP (the format
 * Tenor/Giphy/Klipy stickers are frequently served as), and silently
 * produces an empty output. sharp ships its own libvips/libwebp via
 * prebuilt binaries, so it doesn't depend on how the system ffmpeg was
 * compiled, and it works directly on in-memory buffers — no temp files.
 */
async function extractFirstFrameJpeg(buffer) {
    return sharp(buffer, { animated: false, pages: 1 })
        .jpeg({ quality: 90 })
        .toBuffer()
}

/**
 * Given a Discord attachment, returns { base64, mimeType } (always JPEG for
 * videos/GIFs/images after frame extraction) or null if not a supported
 * media type.
 */
async function attachmentToBase64(attachment) {
    const { contentType = "", url, name = "" } = attachment

    const isGif = contentType.includes("gif") || GIF_EXT.test(name)
    const isImage = !isGif && (IMAGE_MIME.some(t => contentType.startsWith(t)) || IMAGE_EXT.test(name))
    const isVideo = VIDEO_MIME.some(t => contentType.startsWith(t)) || VIDEO_EXT.test(name)

    if (!isImage && !isVideo && !isGif) return null

    const tmpId = randomUUID()
    const tmpIn = join(tmpdir(), `lily_media_${tmpId}_in`)
    const tmpOut = join(tmpdir(), `lily_media_${tmpId}.jpg`)

    try {
        // Download
        const res = await fetch(url)
        const downloaded = Buffer.from(await res.arrayBuffer())
        fs.writeFileSync(tmpIn, downloaded)

        if (isVideo) {
            // Real video (mp4/webm/mov) — sharp can't touch this, still needs ffmpeg
            let duration = 0
            try {
                const { stdout } = await execAsync(
                    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${tmpIn}"`
                )
                duration = parseFloat(stdout.trim()) || 0
            } catch { /* fallback to 0 */ }

            const seekTo = duration > 2 ? (duration / 2).toFixed(2) : "0"
            await execAsync(`ffmpeg -y -ss ${seekTo} -i "${tmpIn}" -frames:v 1 -q:v 2 "${tmpOut}"`)
            fs.unlink(tmpIn, () => { })
            const b64 = fs.readFileSync(tmpOut).toString("base64")
            fs.unlink(tmpOut, () => { })
            return { base64: b64, mimeType: "image/jpeg" }
        }

        // Image or GIF (static or animated, including webp) — use sharp/libvips
        try {
            fs.unlink(tmpIn, () => { })
            const jpegBuf = await extractFirstFrameJpeg(downloaded)
            return { base64: jpegBuf.toString("base64"), mimeType: "image/jpeg" }
        } catch (err) {
            Logger.error("sharp failed on attachment: " + err.message, "MEDIA")
            return null
        }
    } catch (err) {
        Logger.error("Failed to process attachment: " + err.message, "MEDIA")
        try { fs.unlink(tmpIn, () => { }) } catch { }
        try { fs.unlink(tmpOut, () => { }) } catch { }
        return null
    }
}

/**
 * Extracts all supported media attachments from a Discord message's embeds
 * (Tenor, Giphy, Klipy, etc). Tries sharp first (handles static + animated
 * webp/gif/png directly from the buffer); falls back to ffmpeg only for
 * genuine video embeds that sharp can't decode.
 */
async function extractImagesFromEmbeds(message) {
    const results = []

    for (const embed of message.embeds) {
        const mediaUrl = embed.thumbnail?.url || embed.image?.url || embed.video?.url
        if (!mediaUrl) continue

        try {
            const res = await fetch(mediaUrl)
            const buf = Buffer.from(await res.arrayBuffer())

            try {
                // Fast path — covers static/animated webp, gif, png, jpeg
                const jpegBuf = await extractFirstFrameJpeg(buf)
                results.push({ base64: jpegBuf.toString("base64"), mimeType: "image/jpeg" })
                Logger.success("Extracted frame from embed media (sharp)", "MEDIA")
            } catch {
                // Fallback — actual video (webm/mp4), sharp can't decode it
                const tmpId = randomUUID()
                const tmpIn = join(tmpdir(), `lily_embed_${tmpId}_in`)
                const tmpOut = join(tmpdir(), `lily_embed_${tmpId}.jpg`)
                fs.writeFileSync(tmpIn, buf)
                await execAsync(`ffmpeg -y -i "${tmpIn}" -frames:v 1 -q:v 2 "${tmpOut}"`)
                fs.unlink(tmpIn, () => { })
                const b64 = fs.readFileSync(tmpOut).toString("base64")
                fs.unlink(tmpOut, () => { })
                results.push({ base64: b64, mimeType: "image/jpeg" })
                Logger.success("Extracted frame from embed video (ffmpeg fallback)", "MEDIA")
            }
        } catch (err) {
            Logger.error("Failed to process embed: " + err.message, "MEDIA")
        }
    }

    return results
}

async function extractImagesFromMessage(message) {
    const results = []
    for (const attachment of message.attachments.values()) {
        const data = await attachmentToBase64(attachment)
        if (data) results.push(data)
    }

    // Embeds (Tenor, Giphy, etc.)
    const embedImages = await extractImagesFromEmbeds(message)
    results.push(...embedImages)

    // If nothing but there's a tenor/giphy link, wait and re-fetch
    if (results.length === 0 && /tenor\.com|giphy\.com/i.test(message.content)) {
        await new Promise(r => setTimeout(r, 1500))
        try {
            const refetched = await message.channel.messages.fetch(message.id)
            const lateEmbeds = await extractImagesFromEmbeds(refetched)
            results.push(...lateEmbeds)
        } catch (err) {
            Logger.error("Failed to re-fetch message for embeds: " + err.message, "MEDIA")
        }
    }

    return results
}

// ─── Transcribe / Speak ───────────────────────────────────────────────────────

export async function transcribe(audioPath) {
    return new Promise((resolve, reject) => {
        const script = `
from faster_whisper import WhisperModel
import sys
try:
    model = WhisperModel('base', device='cuda', compute_type='int8')
    segments, _ = model.transcribe(r'${audioPath}', beam_size=3, language='en')
    text = ' '.join(s.text for s in segments).strip()
    print(text if text else '')
except Exception as e:
    print('', file=sys.stderr)
    sys.exit(1)
`
        const py = spawn(PYTHON_BIN, ["-c", script])
        let out = "", err = ""
        py.stdout.on("data", d => out += d)
        py.stderr.on("data", d => err += d)
        py.on("close", code => {
            if (code !== 0) return reject(new Error(`Whisper failed: ${err.trim()}`))
            resolve(out.trim())
        })
    })
}

let busy = false

export async function speak(text) {
    if (busy) return null // already synthesizing — drop this request

    busy = true
    const outPath = join(tmpdir(), `lily_${randomUUID()}.wav`)

    try {
        return await new Promise((resolve, reject) => {
            const py = spawn(PYTHON_BIN, [
                process.env.STYLETTS2_SCRIPT,
                "--text", text,
                "--ref", process.env.VOICE_SAMPLE_PATH,
                "--out", outPath,
                "--model_dir", process.env.STYLETTS2_MODEL_DIR ?? "./models",
                "--max_chars", "220",
                "--vram_budget_mb", "1600",
            ])
            let err = ""
            py.stderr.on("data", d => err += d)
            py.on("close", code => {
                if (code !== 0) return reject(new Error(`StyleTTS2 failed: ${err.trim()}`))
                resolve(outPath)
            })
        })
    } finally {
        busy = false
    }
}

function sanitizeInput(text) {
    return text
        .replace(/[:;=8][\-o\*\']?[\)\]\(\[dDpP\/\:\}\{@\|\\]/gi, "")
        .replace(/[\)\]\(\[dDpP\/\:\}\{@\|\\][\-o\*\']?[:;=8]/gi, "")
        .replace(/[(\[{╰╯][\s\S]{0,20}?[)\]}]/g, "")
        .replace(/[✿♡♥❤★☆♪♫•·°∿≈]/g, "")
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
        .replace(/[\u{2600}-\u{27BF}]/gu, "")
        .replace(/[\u{FE00}-\u{FEFF}]/gu, "")
        .replace(/[~\^*]{2,}/g, "")
        .replace(/\s+/g, " ")
        .replace(/\\/g, "")
        .replace(/'/g, " ")
        .trim()
}

// Strips a leading slash-command (e.g. "/attack zombie") that the model
// might accidentally emit — but ONLY when the "/" is the very first
// non-whitespace character of the message. This deliberately does NOT
// touch a "/" that shows up mid-sentence or mid-word (e.g.
// "stoicism/buddhism", "and/or", a URL) — a prior version used
// /\/\w+.*$/s which matched a "/" ANYWHERE in the text and deleted
// everything from that point to the end, silently truncating replies
// that happened to contain a slash partway through.
function stripLeadingSlashCommand(text) {
    return text.replace(/^\s*\/\S+\s*/, "").trim()
}

export async function speakedge(text) {
    const clean = sanitizeInput(text)
    const escaped = clean.replace(/'/g, "\\'").replace(/"/g, '\\"')
    const wavPath = "/tmp/lily_response.wav"
    const oggPath = "/tmp/lily_response.ogg"
    await execAsync(`${EDGE_TTS_BIN} --text "${escaped}" --voice en-US-AnaNeural --write-media ${wavPath}`)
    await execAsync(`ffmpeg -y -i ${wavPath} -c:a libopus ${oggPath}`)
    fs.unlink(wavPath, () => { })
    return oggPath
}

export async function playInGuild(guildId, text) {
    const state = guildPlayers.get(guildId)
    if (!state) return
    if (state.isProcessing) {
        Logger.warning("Skipping — already processing audio", "VOICE")
        return
    }
    state.isProcessing = true
    const audioPath = await speakedge(text)
    const resource = createAudioResource(audioPath)
    state.player.play(resource)

    const onIdle = () => {
        state.isProcessing = false
        state.player.off(AudioPlayerStatus.Idle, onIdle)
        fs.unlink(audioPath, () => { })
    }
    state.player.once(AudioPlayerStatus.Idle, onIdle)
}

// ─── Shared reply helpers ─────────────────────────────────────────────────────

function parseReply(reply) {
    if (typeof reply === "object" && reply !== null) return reply
    return { text: reply ?? "", gifUrl: null }
}

async function sendReply(message, reply) {
    if (!reply) return
    const { text, gifUrl } = parseReply(reply)
    const clean = stripLeadingSlashCommand(text)
    if (!clean && !gifUrl) return
    await message.reply({
        content: clean || undefined,
        files: gifUrl ? [{ attachment: gifUrl, name: "lily.gif" }] : []
    })
    if (message.guild && guildPlayers.has(message.guild.id) && clean) {
        await playInGuild(message.guild.id, clean)
    }
}

async function sendNoReply(message, reply) {
    if (!reply) return
    const { text, gifUrl } = parseReply(reply)
    const clean = stripLeadingSlashCommand(text)
    if (!clean && !gifUrl) return
    await message.channel.send({
        content: clean || undefined,
        files: gifUrl ? [{ attachment: gifUrl, name: "lily.gif" }] : []
    })
    if (message.guild && guildPlayers.has(message.guild.id) && clean) {
        await playInGuild(message.guild.id, clean)
    }
}

// ─── Voice Session ────────────────────────────────────────────────────────────

class VoiceSession {
    constructor(guild, connection, channelId) {
        this.guild = guild
        this.connection = connection
        this.channelId = channelId
        this.player = createAudioPlayer()
        this.isProcessing = false
        this.activeSpeakers = new Map()
        this.userLastInteraction = new Map()
        this.silenceThreshold = 800
        this.minSpeechDuration = 500
        this.maxSpeechDuration = 30000

        connection.subscribe(this.player)
        guildPlayers.set(guild.id, { player: this.player, isProcessing: false })

        this.setupSpeakingHandler()
    }

    setupSpeakingHandler() {
        const receiver = this.connection.receiver

        receiver.speaking.on("start", (userId) => {
            const member = this.guild.members.cache.get(userId)
            if (!member || member.user.bot) return
            if (this.activeSpeakers.has(userId)) return

            Logger.info(`${member.displayName} started speaking`, "VOICE")

            const audioStream = receiver.subscribe(userId, {
                end: { behavior: EndBehaviorType.AfterSilence, duration: this.silenceThreshold }
            })

            const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 })
            const chunks = []
            let streamEnded = false

            const onData = (chunk) => { chunks.push(chunk) }

            const onEnd = async () => {
                if (streamEnded) return
                streamEnded = true

                decoder.off("data", onData)
                decoder.off("end", onEnd)
                decoder.destroy()

                const speaker = this.activeSpeakers.get(userId)
                if (!speaker) return

                const duration = Date.now() - speaker.startTime

                if (duration >= this.minSpeechDuration && chunks.length > 0) {
                    await this.processAudio(userId, member.displayName, chunks, duration)
                } else {
                    Logger.warning(`${member.displayName} speech too short (${duration}ms), ignoring`, "VOICE")
                }

                this.activeSpeakers.delete(userId)
            }

            decoder.on("data", onData)
            decoder.on("end", onEnd)
            decoder.on("error", (err) => {
                Logger.error("Decoder error for " + userId + ": " + err.message, "VOICE")
                onEnd()
            })

            audioStream.on("error", (err) => {
                Logger.error("Stream error for " + userId + ": " + err.message, "VOICE")
                onEnd()
            })

            audioStream.pipe(decoder)

            this.activeSpeakers.set(userId, {
                chunks, decoder, audioStream,
                startTime: Date.now(),
                timer: null
            })
        })

        this.connection.on("stateChange", (_, newState) => {
            if (newState.status === "destroyed") this.cleanup()
        })
    }

    async processAudio(userId, displayName, chunks, duration) {
        const prefs = getPrefs(userId)
        if (!prefs.voiceProcess) {
            Logger.warning(`${displayName} has voice processing disabled`, "VOICE")
            return
        }

        Logger.info(`Processing ${displayName}: ${duration}ms, ${chunks.length} chunks`, "VOICE")

        try {
            const sessionId = `${userId}_${Date.now()}`
            const pcmPath = `/tmp/lily_input_${sessionId}.pcm`
            const wavPath = `/tmp/lily_input_${sessionId}.wav`

            const pcmBuffer = Buffer.concat(chunks)
            fs.writeFileSync(pcmPath, pcmBuffer)

            await execAsync(`ffmpeg -y -f s16le -ar 48000 -ac 1 -i ${pcmPath} -ar 16000 ${wavPath}`)
            fs.unlink(pcmPath, () => { })

            const transcript = await transcribe(wavPath)
            fs.unlink(wavPath, () => { })

            if (!transcript || transcript.length < 5) {
                Logger.warning(`${displayName} said nothing intelligible`, "VOICE")
                return
            }

            Logger.info(`${displayName}: "${transcript}"`, "STT")

            ai.pushRawMessage(this.channelId, displayName, transcript)
            ai.observe(`${displayName} said (voice): ${transcript}`)

            const lowerTranscript = transcript.toLowerCase()
            const wakeWords = ["lily", "lili", "lillie", "hey lily", "hi lily"]
            const hasWakeWord = wakeWords.some(ww => lowerTranscript.includes(ww))

            if (!this.userLastInteraction) this.userLastInteraction = new Map()
            const lastInteraction = this.userLastInteraction.get(userId) || 0
            const isRecentInteraction = (Date.now() - lastInteraction) < 30000
            this.userLastInteraction.set(userId, Date.now())

            let shouldRespond = false
            if (hasWakeWord) shouldRespond = true
            else if (isRecentInteraction) shouldRespond = true
            else if (!prefs.wakeWordRequired) shouldRespond = Math.random() < 0.15

            if (!shouldRespond) return

            const formattedMessage = hasWakeWord || isRecentInteraction
                ? `[${displayName}] says to you (Lily): ${transcript}`
                : `[${displayName}] said nearby: ${transcript}`

            const reply = await ai.chat(this.channelId, formattedMessage)
            const { text } = parseReply(reply)
            const clean = stripLeadingSlashCommand(text)

            if (clean && clean !== "none" && clean !== "None" && clean.length > 0) {
                Logger.success(`Lily responding: "${clean}"`, "VOICE")
                await playInGuild(this.guild.id, clean)
            }

        } catch (err) {
            Logger.error("Error processing " + displayName + ": " + err.message, "VOICE")
        }
    }

    cleanup() {
        for (const [userId, speaker] of this.activeSpeakers) {
            if (speaker.timer) clearTimeout(speaker.timer)
            if (speaker.decoder) speaker.decoder.destroy()
            if (speaker.audioStream) speaker.audioStream.destroy()
        }
        this.activeSpeakers.clear()
        guildPlayers.delete(this.guild.id)
    }
}

export function startVoiceSession(connection, guild, channelId) {
    const session = new VoiceSession(guild, connection, channelId)
    Logger.success("Voice session started with improved handling", "VOICE")
    return session.player
}

// ─── Bot setup ────────────────────────────────────────────────────────────────

export async function createBot() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildVoiceStates,
        ],
        // Needed so DM channel/message events reliably fire even when the
        // DM channel isn't already in the client's cache.
        partials: [Partials.Channel],
    })

    client.once("clientReady", async () => {
        await initLogChannel(client)

        const vts = new VTSClient()
        connectVts(vts)
    })

    async function connectVts(vts, retryMs = 5000) {
        if (!isVtubeEnabled()) return
        try {
            await vts.connect()
            ai.setVtsClient(vts)
            await ai.tools.refreshExpressions()
            Logger.success("VTube Studio connected, expressions loaded", "VTUBE")

            // Pick up hotkeys added/renamed in VTS without a reconnect
            setInterval(() => ai.tools.refreshExpressions(), 60_000)

            // If VTS closes (app restarted, etc.), null out the client so
            // trigger_expression fails cleanly instead of hanging on a dead
            // socket, and keep retrying in the background.
            vts.ws?.once("close", () => {
                Logger.warning("VTube Studio disconnected, retrying...", "VTUBE")
                ai.setVtsClient(null)
                setTimeout(() => connectVts(new VTSClient(), retryMs), retryMs)
            })
        } catch (err) {
            Logger.warning(`VTube Studio not available yet (${err.message}), retrying in ${retryMs}ms`, "VTUBE")
            setTimeout(() => connectVts(vts, retryMs), retryMs)
        }
    }

    client.commands = new Collection()

    const commandsPath = path.join(__dirname, "commands")
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"))
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
            Logger.error("Error executing command: " + error.message, "COMMAND")
            await interaction.reply({ content: "Error executing command", ephemeral: true })
        }
    })

    client.on("messageCreate", async message => {
        let authorName = ""

        // Whether this message came in over DM rather than a guild channel.
        const isDM = !message.guild

        if (message.author.bot) {
            if (message.author.displayName === "Coolade") {
                if (config.bannedUsers.some(user => message.content.includes(user))) return
                const match = message.content.match(/](.*)»/m)
                if (match?.[1]) authorName = sanitizeInput(match[1].trim())
            } else return
        } else {
            // message.member is only populated for guild messages — fall back
            // to message.author.username in DMs.
            authorName = sanitizeInput(message.member?.username || message.author.username)
        }

        const bannedUsers = config.bannedUsers
        if (!authorName || bannedUsers.includes(authorName) || bannedUsers.includes(message.author.displayName)) return

        const channelId = message.channel.id
        // In DMs there's no one to @-mention, so treat every DM as if it
        // were a direct ping — Lily always responds, no wake-word needed.
        const isMentioned = isDM || message.mentions.has(client.user) || message.content.includes("<@&1473317878785773684>")
        const isReplyToBot = message.reference?.messageId
            ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === client.user.id
            : false

        const userInput = message.content
            .replace(`<@${client.user.id}>`, "")
            .replace(`<@!${client.user.id}>`, "")
            .trim()

        // ── Passive: always push to rolling raw buffer ──
        if (userInput) ai.pushRawMessage(channelId, authorName, userInput)

        // ─── Spontaneous butt-in ──────────────────────────────────────────────
        // isMentioned is always true for DMs, so this branch (and its random
        // chance of ignoring the message) is never reached there.
        if (!isMentioned && !isReplyToBot) {
            ai.observe(channelId, `${authorName} said ${userInput}`)

            if (Math.random() < 0.005) {
                const prefs = getPrefs(message.author.id)
                if (prefs.spontaneousReplies) {
                    try {
                        await message.channel.sendTyping()
                        const reply = await ai.buttIn(channelId, `${authorName} said: ${userInput}`)
                        if (reply) {
                            if (prefs.pingOnSpontaneous) {
                                await sendReply(message, reply)
                            } else {
                                await sendNoReply(message, reply)
                            }
                        }
                    } catch (err) {
                        Logger.error("Butt in handler error: " + err.message, "BUTT IN")
                    }
                }
            }
            return
        }

        // ─── Fetch the 5 messages before this ping/reply and inject as context ──
        try {
            const fetched = await message.channel.messages.fetch({
                limit: 5,
                before: message.id,
            })
            const prior = [...fetched.values()]
                .reverse()                              // oldest → newest
                .filter(m => m.content?.trim())         // skip empty/attachment-only
                .map(m => ({
                    authorName: m.author.bot ? m.author.displayName : (m.member?.displayName || m.author.username),
                    content: m.content,
                }))
            ai.injectChannelContext(channelId, prior)
        } catch (err) {
            Logger.error("Failed to fetch prior messages: " + err.message, "CONTEXT")
        }

        // ─── Voice message handler (reply to bot with audio) ──────────────────
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
                    const res = await fetch(audioAttachment.url)
                    const tmpInPath = `/tmp/lily_voicemsg_${message.id}.ogg`
                    const tmpWavPath = `/tmp/lily_voicemsg_${message.id}.wav`
                    fs.writeFileSync(tmpInPath, Buffer.from(await res.arrayBuffer()))

                    await execAsync(`ffmpeg -y -i ${tmpInPath} ${tmpWavPath}`).catch(() => { })
                    fs.unlink(tmpInPath, () => { })

                    const transcript = await transcribe(tmpWavPath)
                    fs.unlink(tmpWavPath, () => { })

                    if (!transcript || transcript.length < 2) {
                        await message.reply("I couldn't make out what you said! 🍓")
                        return
                    }

                    Logger.info(`${authorName} said: "${transcript}"`, "VOICE MESSAGE")
                    const reply = await ai.chat(channelId, `[${authorName}] says to you in a voice message: ${transcript}`)
                    const { text } = parseReply(reply)
                    const cleanReply = stripLeadingSlashCommand(text)

                    const oggPath = await speakedge(cleanReply)
                    await message.reply({
                        content: `💬 *"${cleanReply}"*`,
                        files: [{ attachment: oggPath, name: "lily_response.ogg" }]
                    })
                    fs.unlink(oggPath, () => { })

                    if (message.guild && guildPlayers.has(message.guild.id)) {
                        await playInGuild(message.guild.id, cleanReply)
                    }
                } catch (err) {
                    Logger.error("Voice message handler error: " + err.message, "VOICE_MESSAGE")
                    await message.reply("Something went wrong processing your voice message, sowwy! 🍓")
                }
                return
            }
        }

        // ─── Direct mention / reply handler ───────────────────────────────────
        if (!userInput && message.attachments.size === 0) {
            await message.reply("Yes? 🍓")
            return
        }

        // Extract images/videos/GIFs from the message
        let images = await extractImagesFromMessage(message)
        if (images.length > 0) {
            Logger.info(`Extracted ${images.length} image(s) from message`, "MEDIA")
        }

        let formattedMessage = ""

        if (message.reference?.messageId) {
            try {
                const referenced = await message.channel.messages.fetch(message.reference.messageId)
                if (referenced) {
                    // Extract images from the referenced message too
                    const referencedImages = await extractImagesFromMessage(referenced)
                    if (referencedImages.length > 0) {
                        Logger.info(`Extracted ${referencedImages.length} image(s) from referenced message`, "MEDIA")
                        images.push(...referencedImages)
                    }

                    if (referenced.author.id === client.user.id) {
                        formattedMessage = `[${authorName}] says to you: ${userInput}`
                    } else {
                        const repliedUser = referenced.member?.displayName || referenced.author.username
                        const quoted = referenced.content?.replace(/\n/g, " ").slice(0, 120)
                        formattedMessage = `[${authorName}] says to you, mentioning ${repliedUser} who said "${quoted}"${referencedImages.length ? " (with an image)" : ""}: ${userInput}`
                    }
                }
            } catch (err) {
                Logger.error("Error processing message reference: " + err.message, "MESSAGE")
            }
        }

        if (!formattedMessage && message.mentions.users.size > 1) {
            const mentionedUsers = message.mentions.users
                .filter(u => u.id !== client.user.id)
                .map(u => message.guild.members.cache.get(u.id)?.displayName || u.username)
            if (mentionedUsers.length > 0) {
                formattedMessage = `[${authorName}] mentioned ${mentionedUsers.join(", ")}, ${authorName} says to you: ${userInput}`
            }
        }

        if (!formattedMessage) {
            formattedMessage = userInput
                ? `[${authorName}] says to you: ${userInput}`
                : `[${authorName}] sent you an image`
        }

        await message.channel.sendTyping()
        try {
            const reply = await ai.chat(channelId, formattedMessage, null, {}, images)
            await sendReply(message, reply)   // now a no-op if reply is null
        } catch (err) {
            Logger.error("Ping handler error: " + err.message, "MESSAGE")
            await message.reply("I'm having trouble thinking right now, sorry!")
        }
    })

    return client
}