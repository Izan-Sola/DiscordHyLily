import axios from "axios"
import { Logger } from '../../utils/Logger.js'
import { tavily } from "@tavily/core"
import { getConfig } from '../config.js'
import { DONE_NOTE } from './toolHelpers.js'

// ─── Turn budget limits ─────────────────────────────────────────────────
// Only chat-context tools (memory, media, web search) spend against this.
// Minecraft and VTubing tools are intentionally exempt — see tools.js.
const LIMITS = {
    memoryQuery: 10,
    memoryWrite: 10,
    media: 10,
    webSearch: 10,
    total: 10,
    narration: 10,
    badArgs: 10,
}

// ─── Chat Tool Executor ──────────────────────────────────────────────────
//
// Turn-loop contract (unchanged from before the split — read before touching):
//   1. Call resetTurn() once at the START of handling each new incoming
//      user message.
//   2. After every tool execution, check shouldHardStop(). If true, force
//      a final generation with `tools` removed from the request.
//   3. When the model narrates a tool call in prose instead of emitting a
//      real one, call recordNarration() and check its return the same way.
//
// Flawless-turn tracking: turnFlawless starts true on resetTurn() and
// flips false the first time markFlawed() is called. lily.js checks
// this.tools.turnFlawless (via the router) before saving a turn to the
// training-data queue. markFlawed() is idempotent, only the first reason
// per turn sticks.
class ChatToolExecutor {
    constructor() {
        this.resetTurn()
    }

    get opts() {
        return getConfig()
    }

    get toolNames() {
        return CHAT_TOOL_NAMES
    }

    get tools() {
        return CHAT_TOOLS
    }

    resetTurn() {
        this.turnUsage = { memoryWrite: 0, media: 0, memoryQuery: 0, webSearch: 0, total: 0 }
        this.turnHardStop = false
        this.turnNarrationCount = 0
        this.turnBadArgs = 0
        this.turnFlawless = true
        this._flawReason = null
    }

    shouldHardStop() {
        return this.turnHardStop
    }

    markFlawed(reason) {
        if (this.turnFlawless) {
            this.turnFlawless = false
            this._flawReason = reason
            Logger.info(`Turn disqualified from flawless-save: ${reason}`, "FLAWLESS CHECK")
        }
    }

    recordNarration() {
        this.turnNarrationCount++
        this.markFlawed('narrated_tool')
        if (this.turnNarrationCount > LIMITS.narration) {
            this.turnHardStop = true
            return true
        }
        return false
    }

    // ─── Shared helpers ──────────────────────────────────────────────────
    _blocked(message) {
        this.turnHardStop = true
        this.markFlawed('blocked')
        return JSON.stringify({ status: "blocked", stop: true, message })
    }

    _err(message) {
        this.markFlawed('tool_error')
        return JSON.stringify({ status: "error", message })
    }

    _ok(message, extra = {}, { done = true } = {}) {
        return JSON.stringify({
            status: "ok",
            message,
            ...(done ? { instruction: DONE_NOTE } : {}),
            ...extra
        })
    }

    _checkLimit(key, limit, label) {
        if (this.turnUsage[key] >= limit) {
            return this._blocked(
                `STOP. You've already hit the limit for ${label} this turn (max ${limit}). Do not call it again for any reason. ` +
                `Write your visible, in-character reply now using only what you already have.`
            )
        }
        return null
    }

    _spendTotal() {
        if (this.turnUsage.total >= LIMITS.total) {
            return this._blocked(
                `STOP. You have already made ${this.turnUsage.total} tool calls this turn — that is the hard maximum for ANY tool, of any kind, combined. ` +
                `Do not call query_memory_database, addto/update/remove_memory_database, send_gif, send_meme, or web_search again — not this one, not a different one. ` +
                `Write your final, visible, in-character chat reply to the user right now, using only what you already have.`
            )
        }
        this.turnUsage.total++
        return null
    }

    _requireQuery(query, minWords, exampleHint) {
        const trimmed = (query ?? "").trim()
        if (!trimmed || trimmed.split(/\s+/).length < minWords) {
            this.turnBadArgs++
            this.markFlawed('bad_args')
            if (this.turnBadArgs > LIMITS.badArgs) {
                return this._blocked(
                    `STOP. You've now called a tool with a missing/empty/too-short argument ${this.turnBadArgs} time(s) this turn. ` +
                    `Do not call any more tools this turn, of any kind. Write your visible, in-character reply right now using only what you already have — ` +
                    `it's fine to skip whatever you were trying to do with that tool.`
                )
            }
            return this._err(
                `Missing or too-short query argument. You must pass an actual descriptive query string in the argument — ` +
                `not an empty value, not the raw user message. Example of a valid value: "${exampleHint}". ` +
                `If you don't actually have a real value to put there, don't call this tool again — drop it and reply in character instead.`
            )
        }
        return null
    }

    async wikiSearch(query) {
        Logger.info(`"${query}"`, "WIKI")
        try {
            const { data } = await axios.get(`${this.opts.vectorDbUrl}/search`, {
                params: { q: query },
                timeout: this.opts.dbTimeout
            })
            const text = typeof data === "string" ? data : JSON.stringify(data)
            if (!text?.trim() || text === "{}") return "No relevant information found in the wiki."
            return text
        } catch (err) {
            Logger.error(err.message, "WIKI")
            return "No relevant information found in the wiki right now."
        }
    }

    async memoryQuery(query, { daysAgo = null, windowDays = 2, daysBack = null } = {}) {
        const limitErr = this._checkLimit('memoryQuery', LIMITS.memoryQuery, 'memory search (query_memory_database)')
        if (limitErr) return limitErr

        if (daysBack === null) {
            const argErr = this._requireQuery(query, 2, "shinyshadow_ favorite food")
            if (argErr) return argErr
        }

        this.turnUsage.memoryQuery++

        const finish = (resultsText) => JSON.stringify({
            status: "ok",
            results: resultsText,
            instruction: "Memory lookup complete. Use these results (or their absence) to write your visible, in-character reply now — don't search again unless this genuinely didn't answer what you needed."
        })

        if (daysBack !== null) {
            Logger.info(`Queried recent memories up to ${daysBack} days back`, "MEMORY QUERY")
            try {
                const { data } = await axios.post(`${this.opts.memoryDbUrl}/recent`, {
                    limit: 10, days_back: daysBack, min_importance: 0.3
                }, { timeout: this.opts.dbTimeout })

                if (!data?.results?.length) return finish(`No memories found from the last ${daysBack} days.`)

                return finish(data.results.map(e => {
                    const date = new Date(e.timestamp * 1000).toLocaleDateString()
                    return e.type === "episodic" ? `[${date}] ${e.content}` : `[${date}] ${e.text}`
                }).join("\n"))
            } catch (err) {
                Logger.error(err.message, "MEMORY QUERY")
                return finish("No relevant information found in memory.")
            }
        }

        Logger.info(`Queried memory: "${query}" from ${daysAgo ?? "any"} days ago`, "MEMORY QUERY")
        try {
            const k = daysAgo !== null ? 25 : 10
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/search`, {
                query, k, min_score: this.opts.memoryQueryMinScore
            }, { timeout: this.opts.dbTimeout })

            if (!data?.results?.length) return finish("No relevant information found in memory.")

            let results = data.results

            if (daysAgo !== null) {
                const nowSecs = Date.now() / 1000
                const targetTs = nowSecs - daysAgo * 86400
                const windowSecs = Math.max(windowDays, 0) * 86400
                const lo = targetTs - windowSecs
                const hi = targetTs + windowSecs
                results = results.filter(e => e.timestamp >= lo && e.timestamp <= hi)
                if (!results.length) return finish(`No relevant information found from around ${daysAgo} days ago.`)
            }

            results = results.slice(0, 10)
            return finish(results.map(e => {
                if (e.type === "episodic") {
                    const date = new Date(e.timestamp * 1000).toLocaleDateString()
                    return `[${date}] ${e.content}`
                }
                return e.text
            }).join("\n"))
        } catch (err) {
            Logger.error(err.message, "MEMORY QUERY")
            return finish("No relevant information found in memory.")
        }
    }

    // Auto-injection (passive, not a tool call) — unchanged from before the split.
    async autoInjectMemory(queryText) {
        if (!this.opts.memoryAutoInjectEnabled) return null
        const trimmed = (queryText ?? "").trim()
        if (!trimmed) return null

        const parts = []

        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/search`, {
                query: trimmed,
                k: this.opts.memoryAutoInjectFactK,
                min_score: this.opts.memoryAutoInjectFactMinScore,
                types: ["fact"]
            }, { timeout: this.opts.dbTimeout })

            const hits = data?.results ?? []
            if (hits.length) {
                for (const h of hits) {
                    Logger.info(`[fact, score ${h.score}] "${h.text}"`, "MEMORY AUTOINJECT")
                }
                parts.push(...hits.map(h => h.text))
            }
        } catch (err) {
            Logger.error(err.message, "MEMORY AUTOINJECT FACT")
        }

        if (this.opts.memoryAutoInjectEpisodicEnabled) {
            try {
                const { data } = await axios.post(`${this.opts.memoryDbUrl}/search`, {
                    query: trimmed,
                    k: this.opts.memoryAutoInjectEpisodicK,
                    min_score: this.opts.memoryAutoInjectEpisodicMinScore,
                    types: ["episodic"]
                }, { timeout: this.opts.dbTimeout })

                const hits = data?.results ?? []
                if (hits.length) {
                    for (const h of hits) {
                        Logger.info(`[episodic, score ${h.score}] summary: "${h.text}"\nraw: ${h.content}`, "MEMORY AUTOINJECT")
                    }
                    parts.push(...hits.map(h => `(past conversation) ${h.content}`))
                }
            } catch (err) {
                Logger.error(err.message, "MEMORY AUTOINJECT EPISODIC")
            }
        }

        if (!parts.length) {
            Logger.info(`No hits for: "${trimmed}"`, "MEMORY AUTOINJECT")
            return null
        }
        return parts.join("\n")
    }

    async memoryAdd(factText, source = "user") {
        const limitErr = this._checkLimit('memoryWrite', LIMITS.memoryWrite, 'a memory write — add/update/remove share one slot')
        if (limitErr) return limitErr
        this._requireQuery(factText, 2, "ShinyShadow_ said their favorite color is teal")
        this.turnUsage.memoryWrite++

        Logger.info(` Added memory: "${factText}"`, "MEMORY ADD")
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_fact`, { text: factText, source }, { timeout: this.opts.dbTimeout })

            const failed = data?.status === "error" || data?.ok === false
            if (failed) {
                Logger.error(`add_fact returned failure: ${JSON.stringify(data)}`, "MEMORY ADD")
                return this._err(data.message ?? "Failed to store information.")
            }
            if (data?.status !== "ok") {
                Logger.warning(`Unexpected add_fact response shape: ${JSON.stringify(data)}`, "MEMORY ADD")
            }
            return this._ok(data?.message ?? "Stored.")
        } catch (err) {
            Logger.error(err.message, "MEMORY ADD")
            return this._err("Failed to store information.")
        }
    }

    async memoryUpdate(searchQuery, updatedText) {
        const limitErr = this._checkLimit('memoryWrite', LIMITS.memoryWrite, 'a memory write — add/update/remove share one slot')
        if (limitErr) return limitErr

        const argErr = this._requireQuery(searchQuery, 2, "shinyshadow_ favorite color") || this._requireQuery(updatedText, 2, "ShinyShadow_'s favorite color is now teal")
        if (argErr) return argErr
        if (searchQuery.trim().toLowerCase() === updatedText.trim().toLowerCase()) {
            this.markFlawed('memory_update_noop')
            return JSON.stringify({
                status: "noop",
                message: "The old and new text are identical — there's nothing to update. If you don't actually know the current value, don't call this tool at all. Write your reply now."
            })
        }
        this.turnUsage.memoryWrite++

        Logger.info(`Updated memory: "${searchQuery}" → "${updatedText}"`, "MEMORY UPDATE")
        try {
            const { data } = await axios.put(`${this.opts.memoryDbUrl}/update_fact`, { query: searchQuery, text: updatedText }, { timeout: this.opts.dbTimeout })
            if (data.status !== "ok") return this._err(data.message ?? "Failed to update entry.")
            return this._ok(data.message ?? "Updated.")
        } catch (err) {
            Logger.error(err.message, "MEMORY UPDATE")
            return this._err("Failed to update entry.")
        }
    }

    async memoryRemove(searchQuery) {
        const limitErr = this._checkLimit('memoryWrite', LIMITS.memoryWrite, 'a memory write — add/update/remove share one slot')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(searchQuery, 2, "IsGone favorite color")
        if (argErr) return argErr
        this.turnUsage.memoryWrite++

        Logger.info(`Attempted to remove memory: "${searchQuery}"`, "MEMORY REMOVE")
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/remove_by_query`, {
                query: searchQuery, k: this.opts.memoryRemoveK, min_score: this.opts.memoryRemoveMinScore, types: ["fact"]
            }, { timeout: this.opts.dbTimeout })
            if (data?.status !== "ok" || !data?.removed?.length) {
                this.markFlawed('memory_remove_not_found')
                return JSON.stringify({
                    status: "not_found",
                    message: "No matching memories found.",
                    instruction: "Nothing matched — that's a final answer, not a failure to fix by retrying. Reply now, in character."
                })
            }
            return this._ok(`Removed: ${data.removed.join(", ")}`, { removed: data.removed })
        } catch (err) {
            Logger.error(err.message, "MEMORY REMOVE")
            return this._err("Failed to remove entries.")
        }
    }

    // Not part of the live chat-turn budget — called out-of-band by a
    // batch/summarizer process, not by the model mid-conversation.
    async addEpisodicMemory({ summary, raw, participants = [], emotions = [], importance = 0.5, channel = null, source = "conversation_batch" }) {
        Logger.info(`"${summary}"`, "EPISODIC BATCH ADD")
        try {
            const { data } = await axios.post(`${this.opts.memoryDbUrl}/add_episodic`, {
                summary, raw, participants, emotions, importance, channel, source,
            }, { timeout: this.opts.dbTimeout })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            Logger.error(err.message, "EPISODIC BATCH ADD")
            return this._err("Failed to store episodic memory.")
        }
    }

    async searchGif(query) {
        const limitErr = this._checkLimit('media', LIMITS.media, 'sending a gif or meme — they share one slot')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(query, 2, "excited anime girl jumping")
        if (argErr) return argErr
        this.turnUsage.media++

        Logger.info(`Querying Klipy API: "${query}"`, "GIF")
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/gifs/search`, {
                params: { q: query, per_page: 10, page: 1, customer_id: "lily-bot" },
                timeout: this.opts.dbTimeout
            })
            const results = data?.data?.data ?? []
            if (!results.length) {
                this.markFlawed('gif_not_found')
                return JSON.stringify({ status: "not_found", message: "No GIF found — don't retry with a near-identical query, just reply without a gif." })
            }
            const pick = results[Math.floor(Math.random() * Math.min(results.length, 8))]
            const url = pick?.file?.hd?.gif?.url ?? pick?.file?.hd?.webp?.url ?? pick?.file?.gif?.url
            if (!url) {
                this.markFlawed('gif_no_url')
                return JSON.stringify({ status: "not_found", message: "No GIF URL — don't retry, just reply without a gif." })
            }
            Logger.success(`Gif found, URL: ${url}`, "GIF")
            return this._ok("Gif found and already queued to send — do NOT put the url in your text, just reply naturally to the user.", { url })
        } catch (err) {
            Logger.error(err.message, "GIF")
            return this._err("Gif not found, ignore this and reply naturally to the user. Do NOT attempt to send another gif this turn.")
        }
    }

    async searchMeme(query) {
        const limitErr = this._checkLimit('media', LIMITS.media, 'sending a gif or meme — they share one slot')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(query, 2, "drake approving")
        if (argErr) return argErr
        this.turnUsage.media++

        Logger.info(`Querying Klipy API: "${query}"`, "MEME")
        try {
            const { data } = await axios.get(`https://api.klipy.com/api/v1/${process.env.KLIPY_API_KEY}/static-memes/search`, {
                params: { q: query, per_page: 10, page: 1, customer_id: "lily-bot" },
                timeout: this.opts.dbTimeout
            })

            const results = data?.data?.data ?? []
            if (!results.length) {
                this.markFlawed('meme_not_found')
                return JSON.stringify({ status: "not_found", message: "No meme found — don't retry with a near-identical query, just reply without a meme." })
            }

            const pick = results[Math.floor(Math.random() * Math.min(results.length, 8))]
            const url = pick?.file?.hd?.gif?.url ?? pick?.file?.hd?.webp?.url ?? pick?.file?.gif?.url
            if (!url) {
                this.markFlawed('meme_no_url')
                return JSON.stringify({ status: "not_found", message: "No meme URL — don't retry, just reply without a meme." })
            }

            Logger.success(`Meme found, URL: ${url}`, "MEME")
            return this._ok("Meme found and already queued to send — do NOT put the url in your text, just reply to the user message naturally.", { url })
        } catch (err) {
            Logger.error(err.message, "MEME")
            if (err.response) Logger.error(JSON.stringify(err.response.data), "MEME RESPONSE")
            return this._err("Meme not found, ignore this and reply naturally to the user. Do NOT attempt to send another meme this turn.")
        }
    }

    async webSearch(query) {
        const limitErr = this._checkLimit('webSearch', LIMITS.webSearch, 'web_search')
        if (limitErr) return limitErr
        const argErr = this._requireQuery(query, 2, "current Minecraft version")
        if (argErr) return argErr
        this.turnUsage.webSearch++

        Logger.info(`Querying Tavily API: "${query}"`, "WEB SEARCH")
        try {
            const client = tavily({ apiKey: process.env.TAVILY_API_KEY })
            const response = await client.search(query, {
                maxResults: 5,
                searchDepth: "basic",
            })

            const results = response?.results ?? []
            if (!results.length) {
                return JSON.stringify({
                    status: "ok",
                    results: "No results found.",
                    instruction: "Search came back empty — that's your answer, don't keep rephrasing. Reply now, in character."
                })
            }

            const resultsText = results.map(r =>
                `**${r.title}**\n${r.url}\n${r.content ?? ""}`
            ).join("\n\n")

            return JSON.stringify({
                status: "ok",
                results: resultsText,
                instruction: "Search complete. Summarize this in your own words for your visible, in-character reply now — don't search again unless this truly didn't cover it, and never paste URLs or raw excerpts verbatim."
            })
        } catch (err) {
            Logger.error(err.message, "WEB SEARCH")
            return this._err("Web search failed.")
        }
    }

    async execute(name, args) {
        const totalBlock = this._spendTotal()
        if (totalBlock) return totalBlock

        switch (name) {
            case "web_search": return this.webSearch(args?.query ?? "")
            case "query_memory_database": return this.memoryQuery(args?.query ?? "", {
                daysAgo: args?.days_ago ?? null,
                windowDays: args?.window_days ?? 2,
                daysBack: args?.days_back ?? null
            })
            case "addto_memory_database": return this.memoryAdd(args?.text ?? "", args?.source ?? "user")
            case "update_memory_database": return this.memoryUpdate(args?.query ?? "", args?.text ?? "")
            case "remove_memory_database": return this.memoryRemove(args?.query ?? "")
            case "send_meme": return this.searchMeme(args?.query ?? "")
            case "send_gif": return this.searchGif(args?.query ?? "")
            default:
                Logger.warning(`Unknown: ${name}`, "TOOL")
                this.markFlawed('unknown_tool')
                return `Unknown tool: ${name}`
        }
    }
}

const CHAT_TOOLS = [
    {
        type: "function",
        function: {
            name: "query_memory_database",
            description: `Search stored facts (about people/server/yourself) and past events. One search covers both.

                        Check this before stating anything as fact you're not 100% sure of.

                        Three modes, pick ONE per call:
                        1. Fact/topic lookup — query set, days_ago/days_back unset.
                        2. A specific past event ("10 days ago") — query + days_ago.
                        3. Open-ended recent stretch, no topic — days_back set, query empty.

                        query is required (2-6 words) in modes 1 and 2. One call is normally enough.`,
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        // CHANGED: hard word cap stated as a number, not "a phrase" — small
                        // models anchor much better on an explicit number than on adjectives
                        // like "short". maxLength enforces it if your JSON schema layer checks it.
                        description: "2-6 keywords only. No full sentences, no politeness, no extra instructions to the search. Example: 'shinyshadow favorite color'. Required for modes 1 and 2.",
                        maxLength: 60
                    },
                    days_ago: { type: "number", minimum: 0, description: "Rough days back for a specific past event. Omit otherwise." },
                    window_days: { type: "number", minimum: 0, maximum: 30, description: "Only with days_ago. Default 2." },
                    days_back: { type: "number", minimum: 1, description: "Open-ended recap window, no topic needed." }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_memory_database",
            description: "Store a fact that has NEVER been queried or stored before. Never use for a fact about a real person unless they just said it this exact message. One call per message unless the user's message truly has multiple distinct new facts.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "One factual sentence. 3-20 words. Required, never empty.", maxLength: 150 },
                    source: { type: "string" }
                },
                required: ["text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "update_memory_database",
            description: `Correct one existing stored fact.

                        HARD REQUIREMENT: you must have called query_memory_database earlier in THIS turn and gotten back the exact fact you are now correcting. If you have not done that in this turn, call query_memory_database instead — do NOT call update_memory_database.

                        "query" must be the same keywords that found the original fact, not new keywords. "text" must be a correction of that SAME fact (same subject), not a different unrelated fact.`,
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Same keywords used in the query_memory_database call that found this fact this turn.", maxLength: 60 },
                    text: { type: "string", description: "The corrected version of that exact fact, same subject. 3-20 words.", maxLength: 150 }
                },
                required: ["query", "text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_memory_database",
            description: "Remove one specific stored fact someone has pointed to as wrong, named by its content. Never use for vague/joking instructions like 'forget everything' — treat those as banter, not a tool call.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "2-6 keywords naming the specific fact to remove. Never a vague phrase like 'everything'.", maxLength: 60 }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "send_gif",
            description: "Search and send ONE reaction GIF. At most one gif OR meme per message total.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "2-4 words describing the reaction/vibe, e.g. 'excited anime girl jumping'. Never the user's raw message, never a single generic word.", maxLength: 40 }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "send_meme",
            description: "Search and send ONE meme. At most one gif OR meme per message total.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "2-4 words evoking a meme format, e.g. 'drake approving'. Never the user's raw message, never a single generic word.", maxLength: 40 }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "Search the web for real-world facts outside your knowledge. One call is normally enough.",
            parameters: {
                type: "object",
                properties: {

                    query: {
                        type: "string",
                        description: "A short search-engine query, 3-8 words, like a real Google search. No questions, no politeness, no requests for sources/dates/methodology. Bad: 'please tell me detailed statistics with sources about X'. Good: 'X statistics 2026'.",
                        maxLength: 60
                    }
                },
                required: ["query"]
            }
        }
    },
]

const CHAT_TOOL_NAMES = new Set(CHAT_TOOLS.map(t => t.function.name))

export { ChatToolExecutor, CHAT_TOOLS, CHAT_TOOL_NAMES }