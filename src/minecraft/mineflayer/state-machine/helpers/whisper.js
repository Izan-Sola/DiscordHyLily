import { Logger } from "../../../../utils/Logger.js"
import { extractChatText } from "./chatText.js"

/**
 * WHISPER / PRIVATE MESSAGE SUPPORT
 * ─────────────────────────────────────────────────────────────────────────────
 * mineflayer does ship a built-in `whisper` event — but it's driven by a
 * hardcoded default chat pattern tuned for vanilla-style formats, and it's
 * known to be unreliable on non-vanilla plugin servers (see PrismarineJS
 * issues #769, #1583, #1934, #2478): it can simply not fire when a plugin's
 * /msg format doesn't match the built-in pattern, or the message can leak
 * through as a 'chat' event instead of 'whisper'. So it's used here as the
 * primary signal, backed by two fallbacks below.
 *
 * Plugin servers (EssentialsX, etc.) often format /msg differently, e.g.:
 *   [Player -> me] hello
 *   [Player -> You] hello
 *   Player -> Me: hello
 *   Player whispers to you: hello
 *   From Player: hello
 *   [Player -> Lily] hello        (some plugins put the recipient name)
 *
 * These extra patterns are matched against both the raw chat line (`message`
 * event) and the parsed `chat` event text, in case the built-in `whisper`
 * event doesn't fire for your server's plugin. Add more patterns to
 * WHISPER_PATTERNS if your server uses something different — check the raw
 * chat line with a quick
 * `bot.on('message', m => console.log(JSON.stringify(m.toString())))`.
 */
const WHISPER_PATTERNS = [
    /^\[(.+?)\s*(?:->|→)\s*(?:me|you|Me|You)\]\s*(.*)$/,
    /^(.+?)\s*(?:->|→)\s*(?:me|Me)\s*:\s*(.*)$/,
    /^(.+?) whispers(?: to you)?:\s*(.*)$/i,
    /^From (.+?):\s*(.*)$/i,
    /^\* (.+?) -> Me \*\s*(.*)$/i,
]

export function parseWhisperLine(rawText) {
    const text = rawText.trim()
    for (const pattern of WHISPER_PATTERNS) {
        const m = text.match(pattern)
        if (m) return { from: m[1].trim(), message: m[2].trim() }
    }
    return null
}

/**
 * Wires up whisper detection on the bot. Calls onWhisper(username, message)
 * whenever a private message comes in, from any of three sources — the
 * built-in event, the raw message line, or a leaked 'chat' event — deduped
 * so the same line never fires the callback twice.
 */
export function attachWhisperListener(bot, onWhisper) {
    let lastSeen = { key: null, at: 0 }

    const dedupeFire = (username, message) => {
        const key = `${username}:${message}`
        const now = Date.now()
        if (lastSeen.key === key && now - lastSeen.at < 500) return // same line via multiple paths
        lastSeen = { key, at: now }
        onWhisper(username, message)
    }

    // Primary: mineflayer's own whisper detection
    bot.on('whisper', (username, message) => {
        if (!username || username.toLowerCase() === bot.username.toLowerCase()) return
        dedupeFire(username, message)
    })

    // Fallback #1: raw chat line, for server/plugin-specific /msg formats
    // mineflayer's built-in pattern doesn't recognize.
    bot.on('message', (jsonMsg) => {
        const text = extractChatText(jsonMsg)
        const parsed = parseWhisperLine(text)
        if (!parsed) return
        if (parsed.from.toLowerCase() === bot.username.toLowerCase()) return
        dedupeFire(parsed.from, parsed.message)
    })

    // Fallback #2: some plugin formats cause mineflayer to emit the whisper
    // as a plain 'chat' event instead of 'whisper' (documented mineflayer
    // quirk) — catch it here too by re-testing the same patterns against
    // "username: message" reconstructed from the chat event's own args.
    bot.on('chat', (username, message) => {
        if (!username || username.toLowerCase() === bot.username.toLowerCase()) return
        const parsed = parseWhisperLine(message) ?? parseWhisperLine(`${username}: ${message}`)
        if (!parsed) return
        if (parsed.from.toLowerCase() === bot.username.toLowerCase()) return
        dedupeFire(parsed.from, parsed.message)
    })
}

/**
 * Sends a private reply the same way the person messaged in — via /msg —
 * so it doesn't spam public chat. Splits long replies into multiple /msg
 * lines the same way mcChat does for public chat.
 */
export function mcWhisper(bot, username, message, limit = 250) {
    this._splitMessage(message, limit).forEach(chunk => {
        bot.chat(`/msg ${username} ${chunk}`)
    })
    Logger.info(`→ ${username}: ${message}`, "WHISPER")
}

function _splitMessage(text, limit = 250) {
    const words = text.split(" ")
    const chunks = []
    let current = ""
    for (const word of words) {
        if ((current + " " + word).trim().length > limit) {
            if (current) chunks.push(current.trim())
            current = word
        } else {
            current = current ? current + " " + word : word
        }
    }
    if (current) chunks.push(current.trim())
    return chunks
}