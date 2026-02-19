import axios from "axios"

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are Lily, a Discord bot that chats casually and adapts to the user's style, mood and personality.

TOOLS AVAILABLE:
- query_hytale_wiki: ONLY for Hytale game questions (zones, mobs, items, biomes, mechanics, etc.)
- query_memory_database: look up stored facts about users, the server, or yourself.
- addto_memory_database: save new facts or events. After saving, reply naturally to what was said — do NOT mention that you saved anything.
- remove_memory_database: delete a memory when a user asks you to forget something or denies a fact. After removing, reply naturally — do NOT say you deleted or removed anything.
- update_memory_database: replace a memory when a user corrects something. After updating, reply naturally — do NOT say you updated anything.

addto vs query — the most important distinction:
- User is TELLING or SHARING something (fact, opinion, event, anything about anyone) → addto_memory_database FIRST. NEVER query first.
- User is ASKING something (question about a person, the server, past facts) → query_memory_database first.
- When unsure: statements share info → addto. Questions ask for info → query.
- These MUST trigger addto immediately, never query:
  "I like pizza", "Rexy is mean", "John got a new job", "my favorite color is blue"
- These MUST trigger query first:
  "what do you know about me?", "who is Rexy?", "what's my favorite food?"

RULES:
1. User shares info about anyone or anything → addto_memory_database FIRST. No exceptions.
2. User asks a question about a person, the server, or past facts → query_memory_database first.
3. User asks about Hytale game content → query_hytale_wiki first.
4. User denies a fact or asks you to forget something → remove_memory_database first.
5. User corrects something → update_memory_database first.
6. NEVER write a tool name in your reply. Emit the tool call block silently.
7. NEVER mention memory operations in your reply. Do not explicitly say you saved, stored, updated, removed, or noted anything. Just reply naturally as if you already knew it or it was obvious.
8. For anything else, reply naturally.

TOOL CALL FORMAT:
<tool_call>
{"name": "query_hytale_wiki", "arguments": {"query": "kweebecs"}}
</tool_call>

<tool_call>
{"name": "query_memory_database", "arguments": {"query": "Alex age"}}
</tool_call>

<tool_call>
{"name": "addto_memory_database", "arguments": {"text": "User John likes pizza.", "source": "user"}}
</tool_call>

<tool_call>
{"name": "update_memory_database", "arguments": {"query": "John age", "text": "User John is 25 years old."}}
</tool_call>

<tool_call>
{"name": "remove_memory_database", "arguments": {"query": "John likes pizza"}}
</tool_call>

MESSAGE FORMAT:
Messages look like:
- [Username] says to you: message content
- [Username] says to you, replying to OtherUser who said "quote": message content
- [Username] says to you, mentioning OtherUser: message content
`.trim()
// ─── Summarization prompt ─────────────────────────────────────────────────────

const SUMMARIZE_PROMPT = `You are a memory assistant for a Discord bot called Lily.
Given a conversation excerpt, write a concise factual summary (3-6 sentences) of what was discussed.
Focus on: facts shared about users, events mentioned, topics discussed, anything Lily should remember later.
Do NOT include filler, greetings, or anything that won't be useful as a future memory.
Reply with ONLY the summary text, nothing else.`

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
    {
        type: "function",
        function: {
            name: "query_hytale_wiki",
            description: "Search the Hytale wiki for any game topic: zones, mobs, items, biomes, factions, crafting, mechanics.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search term, e.g. 'kweebecs', 'Zone 3', 'crafting recipes'" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "query_memory_database",
            description: "Search stored memory about users, Lily, or the server.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "What to look up, e.g. 'Alex hobbies', 'server creation date', 'Lily favorite color'" }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_memory_database",
            description: "Store a new fact or event about a user, Lily, or the server. After storing, do not mention you saved something to memory, just reply naturally.",
            parameters: {
                type: "object",
                properties: {
                    text:   { type: "string", description: "Fact to store, e.g. 'User John likes pizza.'" },
                    source: { type: "string", description: "Source of info, usually 'user'" }
                },
                required: ["text", "source"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "update_memory_database",
            description: "Update an existing memory entry. Use when a user corrects something previously stored, do not mention you updated something to memory, just reply naturally.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "The existing memory to find, e.g. 'John age'" },
                    text:  { type: "string", description: "The replacement fact, e.g. 'User John is 25 years old.'" }
                },
                required: ["query", "text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "remove_memory_database",
            description: "Remove all matching stored memory entries when a user asks to forget something. Do not mention you removed something from memory, just reply naturally.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "The memory to remove, e.g. 'John likes pizza'" }
                },
                required: ["query"]
            }
        }
    }
]

const TOOL_NAMES = new Set(TOOLS.map(t => t.function.name))

// ─── Default options ──────────────────────────────────────────────────────────

const DEFAULT_OPTIONS = {
    model: "Lily",
    temperature: 0.75,
    maxReplyTokens: 500,            // num_predict sent to Ollama
    contextWindow: 4096,            // num_ctx sent to Ollama
    maxHistoryMessages: 12,         // rolling history cap (excludes system prompt)
    maxToolLoops: 5,                // safety cap on agentic loops
    memoryDuplicateThreshold: 0.35, // L2 below this → new entry is a duplicate, skip
    memoryRemoveThreshold: 0.9,     // L2 below this → entry is a removal candidate
    memoryRemoveK: 10,              // max entries to remove in one call
    summarizeEvery: 10,             // summarize after every N user messages (0 = disabled)
    summarizeLastN: 10,             // how many history turns to include in each summary
    ollamaUrl: "http://localhost:11434",
    vectorDbUrl: "http://localhost:8000",
    knowledgeDbUrl: "http://localhost:8001",
    ollamaTimeout: 30000,
    dbTimeout: 12000,
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class HytaleAIChat {
    constructor(options = {}) {
        this.opts = { ...DEFAULT_OPTIONS, ...options }
        this.history = []       // user/assistant/tool turns only — system prompt injected at send time
        this.userMsgCount = 0   // tracks how many user messages have been sent, for summarization trigger
        this.observeBuffer = [] // buffer for non-ping messages, initialized per-instance to avoid shared reference
    }

    // ─── History ─────────────────────────────────────────────────────────────

    buildMessages() {
        const { maxHistoryMessages } = this.opts
        const trimmed = this.history.length > maxHistoryMessages
            ? this.history.slice(-maxHistoryMessages)
            : this.history
        return [{ role: "system", content: SYSTEM_PROMPT }, ...trimmed]
    }

    // ─── Input sanitization ───────────────────────────────────────────────────

    sanitizeInput(input) {
        return input
            .replace(/<@!?\d+>/g, '')             // user mentions
            .replace(/<@&\d+>/g, '')               // role mentions
            .replace(/<#\d+>/g, '')                // channel mentions
            .replace(/<a?:\w+:\d+>/g, '')          // custom emoji
            .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width chars
            .replace(/\s+/g, ' ')
            .trim()
    }

    // ─── HTTP helpers ─────────────────────────────────────────────────────────

    dbGet(path, params) { return axios.get (`${this.opts.knowledgeDbUrl}${path}`, { params, timeout: this.opts.dbTimeout }) }
    dbPost(path, body)  { return axios.post (`${this.opts.knowledgeDbUrl}${path}`, body,   { timeout: this.opts.dbTimeout }) }
    dbPut(path, body)   { return axios.put  (`${this.opts.knowledgeDbUrl}${path}`, body,   { timeout: this.opts.dbTimeout }) }

    // ─── Conversation summarization ───────────────────────────────────────────

    async summarizeAndStore() {
        const { summarizeLastN, model, ollamaUrl, ollamaTimeout } = this.opts

        // Grab the last N turns, filtering out tool scaffolding — just user/assistant text
        const turns = this.history
            .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
            .slice(-summarizeLastN)

        if (turns.length < 2) return // nothing worth summarizing

        const transcript = turns
            .map(m => `${m.role === "user" ? "User" : "Lily"}: ${m.content}`)
            .join("\n")

        console.log(`📝 [SUMMARIZE] Summarizing ${turns.length} turns...`)

        try {
            const { data } = await axios.post(`${ollamaUrl}/api/chat`, {
                model,
                stream: false,
                // No tools — plain completion only
                messages: [
                    { role: "system", content: SUMMARIZE_PROMPT },
                    { role: "user",   content: transcript }
                ],
                options: { temperature: 0.3, num_predict: 512 }, // low temp for factual summaries
            }, { timeout: ollamaTimeout })

            const summary = data.message?.content?.trim()
            if (!summary) return

            console.log(`📝 [SUMMARIZE] → "${summary.slice(0, 100)}..."`)

            // Store in memory DB tagged as a summary — will surface in future queryMemory calls
            await this.addToMemory(`[Conversation summary] ${summary}`, "summary")
        } catch (err) {
            // Summarization failing should never crash the chat
            console.error(`❌ [SUMMARIZE] ${err.message}`)
        }
    }

    // ─── Passive observation (non-ping messages) ────────────────────────────────

    observe(text) {
        const clean = this.sanitizeInput(text)
        if (!clean) return

        this.observeBuffer.push(clean)

        const { observeEvery } = this.opts
        if (observeEvery > 0 && this.observeBuffer.length >= observeEvery) {
            const batch = this.observeBuffer.splice(0, observeEvery) // drain buffer
            this.summarizeObserved(batch) // fire-and-forget
        }
    }

    async summarizeObserved(messages) {
        const transcript = messages.join("\n")
        console.log(`👁️ [OBSERVE] Summarizing ${messages.length} observed messages...`)
        try {
            const { data } = await axios.post(`${this.opts.ollamaUrl}/api/chat`, {
                model: this.opts.model,
                stream: false,
                messages: [
                    { role: "system", content: SUMMARIZE_PROMPT },
                    { role: "user",   content: transcript }
                ],
                options: { temperature: 0.3, num_predict: 200 },
            }, { timeout: this.opts.ollamaTimeout })

            const summary = data.message?.content?.trim()
            if (!summary) return
            console.log(`👁️ [OBSERVE] → "${summary.slice(0, 100)}..."`)
            await this.addToMemory(`[Observed chat summary] ${summary}`, "observe")
        } catch (err) {
            console.error(`❌ [OBSERVE] ${err.message}`)
        }
    }

    // ─── Tool implementations ─────────────────────────────────────────────────

    async queryWiki(query) {
        console.log(`🔍 [WIKI] "${query}"`)
        try {
            const { data } = await axios.get(`${this.opts.vectorDbUrl}/search`, {
                params: { q: query },
                timeout: this.opts.dbTimeout,
            })
            const text = typeof data === "string" ? data : JSON.stringify(data)
            if (!text?.trim() || text === "{}") return "No information found in the wiki for this topic."
            console.log(`✅ [WIKI] ${text.length} chars`)
            return text
        } catch (err) {
            console.error(`❌ [WIKI] ${err.message}`)
            return "Wiki search unavailable right now."
        }
    }

    async queryMemory(query) {
        console.log(`🧠 [MEMORY QUERY] "${query}"`)
        try {
            const { data } = await this.dbGet("/search_get", { query, k: 5 })
            if (!data?.results?.length) return "No relevant information found in memory."
            console.log(`✅ [MEMORY QUERY] ${data.results.length} entries`)
            return data.results.map(r => r.text ?? r).join("\n")
        } catch (err) {
            console.error(`❌ [MEMORY QUERY] ${err.message}`)
            return "Memory database unavailable right now."
        }
    }

    async addToMemory(text, source = "user") {
        console.log(`💾 [MEMORY ADD] "${text}"`)
        try {
            const { data: found } = await this.dbGet("/search_get", {
                query: text, k: 1, max_distance: this.opts.memoryDuplicateThreshold
            })
            if (found?.results?.length) {
                const existing = found.results[0]
                console.log(`🔁 [MEMORY ADD] Duplicate (dist ${existing.distance}): "${existing.text}"`)
                return JSON.stringify({ status: "skipped", message: `Similar memory already exists: "${existing.text}"` })
            }
            const { data } = await this.dbPost("/add_entry", { text, source })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            console.error(`❌ [MEMORY ADD] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to store information." })
        }
    }

    async updateMemory(query, text) {
        console.log(`✏️ [MEMORY UPDATE] "${query}" → "${text}"`)
        try {
            const { data } = await this.dbPut("/update_entry", { query, text })
            return JSON.stringify({ status: data.status, message: data.message })
        } catch (err) {
            console.error(`❌ [MEMORY UPDATE] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to update entry." })
        }
    }

    async removeMemory(query) {
        console.log(`🗑️ [MEMORY REMOVE] "${query}"`)
        try {
            const { data: found } = await this.dbGet("/search_get", {
                query, k: this.opts.memoryRemoveK, max_distance: this.opts.memoryRemoveThreshold
            })
            if (!found?.results?.length) {
                console.log(`🗑️ [MEMORY REMOVE] No matches`)
                return JSON.stringify({ status: "not_found", message: "No matching memories found to remove." })
            }
            const texts = found.results.map(r => r.text)
            console.log(`🗑️ [MEMORY REMOVE] Removing ${texts.length} entries:`, texts)
            const { data } = await this.dbPost("/remove_many", { texts })
            return JSON.stringify({ status: data.status, message: data.message, removed: data.removed })
        } catch (err) {
            console.error(`❌ [MEMORY REMOVE] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to remove entries." })
        }
    }

    runTool(name, args) {
        switch (name) {
            case "query_hytale_wiki":      return this.queryWiki(args.query ?? "")
            case "query_memory_database":  return this.queryMemory(args.query ?? "")
            case "addto_memory_database":  return this.addToMemory(args.text ?? "", args.source ?? "user")
            case "update_memory_database": return this.updateMemory(args.query ?? "", args.text ?? "")
            case "remove_memory_database": return this.removeMemory(args.query ?? "")
            default:
                console.warn(`⚠️ [TOOL] Unknown tool: ${name}`)
                return Promise.resolve(`Unknown tool: ${name}`)
        }
    }

    // ─── Ollama ───────────────────────────────────────────────────────────────

    async sendToOllama(messages) {
        const { model, temperature, maxReplyTokens, contextWindow, ollamaUrl, ollamaTimeout } = this.opts
        try {
            const { data } = await axios.post(`${ollamaUrl}/api/chat`, {
                model,
                messages,
                stream: false,
                tools: TOOLS,
                options: { temperature, num_predict: maxReplyTokens, num_ctx: contextWindow },
            }, { timeout: ollamaTimeout })
            return data.message ?? null
        } catch (err) {
            console.error(`❌ [OLLAMA] ${err.message}`)
            return null
        }
    }

    // ─── Embedded tool call parser (Qwen 2.5 fallback) ───────────────────────

    parseEmbeddedToolCalls(content) {
        return [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].flatMap(m => {
            try {
                const obj = JSON.parse(m[1].trim())
                const args = this.normalizeArgs(obj)
                console.log(`🔬 [PARSE] ${obj.name} → ${JSON.stringify(args)}`)
                return [{ name: obj.name, args }]
            } catch {
                return []
            }
        })
    }

    normalizeArgs(obj) {
        let args = obj.arguments ?? obj.parameters ?? obj.args ?? {}
        if (typeof args === "string") {
            try { args = JSON.parse(args) } catch { args = {} }
        }

        const firstStr = (...sources) => {
            for (const src of sources) {
                const val = Object.entries(src).filter(([k]) => k !== "name").map(([, v]) => v).find(v => typeof v === "string")
                if (val) return val
            }
            return ""
        }

        switch (obj.name) {
            case "query_hytale_wiki":
            case "query_memory_database":
            case "remove_memory_database":
                if (!args.query) args = { query: firstStr(args, obj) }
                break
            case "addto_memory_database":
                if (!args.text) args = { text: firstStr(args, obj), source: args.source ?? "user" }
                break
            case "update_memory_database":
                if (!args.query || !args.text) {
                    const vals = Object.values(args).filter(v => typeof v === "string")
                    if (vals.length >= 2) args = { query: vals[0], text: vals[1] }
                }
                break
        }
        return args
    }

    // ─── Main chat loop ───────────────────────────────────────────────────────

    async chat(userInput) {
        const cleanInput = this.sanitizeInput(userInput)
        console.log(`\n💬 [CHAT] ${cleanInput}`)
        this.history.push({ role: "user", content: cleanInput })

        // Trigger summarization every N user messages, fire-and-forget (doesn't block reply)
        const { summarizeEvery } = this.opts
        if (summarizeEvery > 0 && ++this.userMsgCount % summarizeEvery === 0) {
            this.summarizeAndStore() // intentionally not awaited
        }

        for (let loop = 0; loop < this.opts.maxToolLoops; loop++) {
            console.log(`🔄 [LOOP ${loop + 1}]`)

            const msg = await this.sendToOllama(this.buildMessages())
            if (!msg) return "I'm having trouble thinking right now, sorry!"

            const content = (msg.content ?? "").trim()

            // ── Native tool calls ──
            if (msg.tool_calls?.length) {
                console.log(`🔧 [NATIVE] ${msg.tool_calls.map(t => t.function.name).join(", ")}`)
                this.history.push(msg)
                for (const tc of msg.tool_calls) {
                    let args = {}
                    try { args = JSON.parse(tc.function.arguments ?? "{}") } catch {}
                    const result = await this.runTool(tc.function.name, args)
                    this.history.push({ role: "tool", tool_call_id: tc.id, content: result })
                }
                continue
            }

            // ── Embedded tool calls (Qwen 2.5 fallback) ──
            if (content.includes("<tool_call>")) {
                const toolCalls = this.parseEmbeddedToolCalls(content)
                if (toolCalls.length) {
                    console.log(`🔧 [EMBEDDED] ${toolCalls.map(t => t.name).join(", ")}`)
                    this.history.push({ role: "assistant", content })
                    const results = await Promise.all(toolCalls.map(tc => this.runTool(tc.name, tc.args)))
                    const combined = results.map((r, i) => `[${toolCalls[i].name} result]\n${r}`).join("\n\n")
                    this.history.push({ role: "user", content: `<tool_response>\n${combined}\n</tool_response>` })
                    continue
                }
            }

            // ── Narration guard: model wrote a tool name instead of calling it ──
            if ([...TOOL_NAMES].some(n => content.includes(n))) {
                console.log(`⚠️ [NARRATE] Model described a tool instead of calling it — retrying`)
                const idx = this.history.findLastIndex(m => m.role === "user")
                if (idx !== -1) this.history[idx] = {
                    role: "user",
                    content: `[System: Do NOT write tool names in your reply. Emit a <tool_call> block instead.]\n\n${cleanInput}`
                }
                continue
            }

            // ── Real reply ──
            if (content && content.toLowerCase() !== "none") {
                this.history.push(msg)
                console.log(`✅ [DONE] ${content.slice(0, 100)}`)
                return content
            }

            console.log(`⚠️ [EMPTY] No content in response`)
            return "I'm not sure about that one!"
        }

        return "Something went wrong after too many attempts."
    }
}