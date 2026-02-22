import axios from "axios"

// ─── Logger ───────────────────────────────────────────────────────────────────

let logChannel = null

export async function initLogChannel(client) {
    for (const guild of client.guilds.cache.values()) {
        const found = guild.channels.cache.find(
            ch => ch.name === "hylily-livechat-logs" && ch.isTextBased()
        )
        if (found) {
            logChannel = found
            log(`📋 [LOGS] Log channel found: #${found.name} in ${guild.name}`)
            break
        }
    }
    if (!logChannel) console.warn("⚠️ [LOGS] No HyLily-livechat-logs channel found — logging to terminal only")
}

function log(message) {
    console.log(message)
    if (logChannel) {
        const truncated = message.length > 1900 ? message.slice(0, 1900) + "..." : message
        logChannel.send(`\`\`\`\n${truncated}\n\`\`\``).catch(() => {})
    }
}

function logError(message) {
    console.error(message)
    if (logChannel) {
        const truncated = message.length > 1900 ? message.slice(0, 1900) + "..." : message
        logChannel.send(`\`\`\`\n❌ ${truncated}\n\`\`\``).catch(() => {})
    }
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are Lily, a Discord bot that chats casually and adapts to the user's style and tone. 
You have acces to the hytale wiki, which you can query with the query_hytale_wiki tool.
Always store information the user shares with you into memory by calling the addto_memory_database tool.
Always use the query_memory_database tool to answer questions about users.

TOOLS AVAILABLE:
- query_hytale_wiki: For Hytale game questions (zones, mobs, items, biomes, mechanics, etc.)
- query_memory_database: for facts about users, yourself (Lily), or questions about the server. Reply naturally using what you found.
- addto_memory_database: store events and facts about users or the server everytime they are mentioned. After storing, reply naturally to what the user has told you.
- remove_memory_database: use it when a user asks you to forget or remove something, or if the user denies a fact you have in memory.
- update_memory_database: when a user corrects something you already know.

USERNAMES:
- Text inside [brackets] at the start of a message is ALWAYS a username, never a word or object
- Usernames can look like anything: [Jwaffles], [ShinyShadow_], [xX_k1ller_Xx], [cloud99]
- Always treat the username as the identity of who is speaking
- When storing to memory, always include the username: "User Jwaffles likes pizza"
- Never confuse a username with a common word even if it looks like one

RULES:
1. STORAGE RULE (highest priority): Any message containing personal info about a user — 
   jobs, hobbies, plans, opinions, current activities, feelings, relationships, anything 
   about their life — MUST trigger addto_memory_database BEFORE replying. This includes 
   casual mentions like "im tired", "i dont have a job", "im working on X", "i like Y". 
   When in doubt, STORE IT.
2. User asks facts about themselves, another user, yourself (Lily), or the server → call query_memory_database first.
3. User asks about Hytale game content → call query_hytale_wiki first.
4. User denies personal information or tells you to forget/remove something → call remove_memory_database first.
5. User corrects something you know → call update_memory_database first.
6. NEVER write a tool name in your reply. Emit the tool call block silently.
7. For anything else, reply naturally.
8. User asks about YOU (Lily) → query_memory_database first. If nothing found or does not answer what you were asked, create 
   your own answer and store it with addto_memory_database.

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
The text between brackets identifies who is talking to you directly.
`.trim()

// ─── Summarization prompt ─────────────────────────────────────────────────────

const SUMMARIZE_PROMPT = `You are a memory assistant for a Discord bot called Lily.
Given a conversation excerpt, write a concise factual summary of what was discussed.
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

const TOOL_NAMES = new Set(TOOLS.map(tool => tool.function.name))

// ─── Default options ──────────────────────────────────────────────────────────

const DEFAULT_OPTIONS = {
    model: "Lily",
    temperature: 0.75,
    maxReplyTokens: 712,
    contextWindow: 4096,
    maxHistoryMessages: 12,
    maxToolLoops: 5,
    memoryDuplicateThreshold: 0.35,
    memoryRemoveThreshold: 0.88,
    memoryRemoveK: 2,
    summarizeEvery: 10,
    summarizeLastN: 10,
    observeEvery: 20,
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
        this.conversationHistory = []
        this.userMessageCount = 0
        this.observeBuffer = []
        this.writeToolUsedThisTurn = false
    }

    // ─── History ─────────────────────────────────────────────────────────────

    buildMessagesForOllama() {
        const { maxHistoryMessages } = this.opts
        const recentHistory = this.conversationHistory.length > maxHistoryMessages
            ? this.conversationHistory.slice(-maxHistoryMessages)
            : this.conversationHistory
        return [{ role: "system", content: SYSTEM_PROMPT }, ...recentHistory]
    }

    // ─── Input sanitization ───────────────────────────────────────────────────

    sanitizeInput(rawInput) {
        return rawInput
            .replace(/<@!?\d+>/g, '')
            .replace(/<@&\d+>/g, '')
            .replace(/<#\d+>/g, '')
            .replace(/<a?:\w+:\d+>/g, '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
    }

    // ─── HTTP helpers ─────────────────────────────────────────────────────────

    knowledgeGet(path, params)  { return axios.get (`${this.opts.knowledgeDbUrl}${path}`, { params, timeout: this.opts.dbTimeout }) }
    knowledgePost(path, body)   { return axios.post(`${this.opts.knowledgeDbUrl}${path}`, body, { timeout: this.opts.dbTimeout }) }
    knowledgePut(path, body)    { return axios.put (`${this.opts.knowledgeDbUrl}${path}`, body, { timeout: this.opts.dbTimeout }) }

    // ─── Conversation summarization ───────────────────────────────────────────

    async summarizeConversationAndStore() {
        const { summarizeLastN, model, ollamaUrl, ollamaTimeout } = this.opts

        const recentTurns = this.conversationHistory
            .filter(turn => (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string" && turn.content.trim())
            .slice(-summarizeLastN)

        if (recentTurns.length < 2) return

        const conversationTranscript = recentTurns
            .map(turn => `${turn.role === "user" ? "User" : "Lily"}: ${turn.content}`)
            .join("\n")

        log(`📝 [SUMMARIZE] Summarizing ${recentTurns.length} turns...`)

        try {
            const { data: ollamaResponse } = await axios.post(`${ollamaUrl}/api/chat`, {
                model,
                stream: false,
                messages: [
                    { role: "system", content: SUMMARIZE_PROMPT },
                    { role: "user",   content: conversationTranscript }
                ],
                options: { temperature: 0.3, num_predict: 512 },
            }, { timeout: ollamaTimeout })

            const summaryText = ollamaResponse.message?.content?.trim()
            if (!summaryText) return

            log(`📝 [SUMMARIZE] → "${summaryText.slice(0, 100)}..."`)
            await this.memoryAdd(`[Conversation summary] ${summaryText}`, "summary")
        } catch (err) {
            logError(`[SUMMARIZE] ${err.message}`)
        }
    }

    // ─── Passive observation ──────────────────────────────────────────────────

    observe(rawMessage) {
        const cleanMessage = this.sanitizeInput(rawMessage)
        if (!cleanMessage) return

        this.observeBuffer.push(cleanMessage)

        const { observeEvery } = this.opts
        if (observeEvery > 0 && this.observeBuffer.length >= observeEvery) {
            const bufferedMessages = this.observeBuffer.splice(0, observeEvery)
            this.summarizeObservedAndStore(bufferedMessages)
        }
    }

    async summarizeObservedAndStore(bufferedMessages) {
        const observedTranscript = bufferedMessages.join("\n")
        log(`👁️ [OBSERVE] Summarizing ${bufferedMessages.length} observed messages...`)
        try {
            const { data: ollamaResponse } = await axios.post(`${this.opts.ollamaUrl}/api/chat`, {
                model: this.opts.model,
                stream: false,
                messages: [
                    { role: "system", content: SUMMARIZE_PROMPT },
                    { role: "user",   content: observedTranscript }
                ],
                options: { temperature: 0.3, num_predict: 200 },
            }, { timeout: this.opts.ollamaTimeout })

            const summaryText = ollamaResponse.message?.content?.trim()
            if (!summaryText) return

            log(`👁️ [OBSERVE] → "${summaryText.slice(0, 100)}..."`)
            await this.memoryAdd(`[Observed chat summary] ${summaryText}`, "observe")
        } catch (err) {
            logError(`[OBSERVE] ${err.message}`)
        }
    }

    // ─── Tool implementations ─────────────────────────────────────────────────

    async wikiSearch(query) {
        log(`🔍 [WIKI QUERY] "${query}"`)
        try {
            const { data: wikiResult } = await axios.get(`${this.opts.vectorDbUrl}/search`, {
                params: { q: query },
                timeout: this.opts.dbTimeout,
            })
            const wikiText = typeof wikiResult === "string" ? wikiResult : JSON.stringify(wikiResult)
            if (!wikiText?.trim() || wikiText === "{}") return "No information found in the wiki for this topic."
            log(`✅ [WIKI] ${wikiText.length} chars`)
            return wikiText
        } catch (err) {
            logError(`[WIKI] ${err.message}`)
            return "Wiki search unavailable right now."
        }
    }

    async memoryQuery(query) {
        log(`🧠 [MEMORY QUERY] "${query}"`)
        try {
            const { data: searchResult } = await this.knowledgeGet("/search_get", { query, k: 5 })
            if (!searchResult?.results?.length) return "No relevant information found in memory."
            log(`✅ [MEMORY QUERY] ${searchResult.results.length} entries`)
            return searchResult.results.map(entry => entry.text ?? entry).join("\n")
        } catch (err) {
            logError(`[MEMORY QUERY] ${err.message}`)
            return "Memory database unavailable right now."
        }
    }

    async memoryAdd(factText, source = "user") {
        log(`💾 [MEMORY ADD] "${factText}"`)
        try {
            const { data: duplicateCheck } = await this.knowledgeGet("/search_get", {
                query: factText, k: 1, max_distance: this.opts.memoryDuplicateThreshold
            })
            if (duplicateCheck?.results?.length) {
                const duplicateEntry = duplicateCheck.results[0]
                log(`🔁 [MEMORY ADD] Duplicate (dist ${duplicateEntry.distance}): "${duplicateEntry.text}"`)
                return JSON.stringify({ status: "skipped", message: `Similar memory already exists: "${duplicateEntry.text}"` })
            }
            const { data: addResult } = await this.knowledgePost("/add_entry", { text: factText, source })
            return JSON.stringify({ status: addResult.status, message: addResult.message })
        } catch (err) {
            logError(`[MEMORY ADD] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to store information." })
        }
    }

    async memoryUpdate(searchQuery, updatedText) {
        log(`✏️ [MEMORY UPDATE] "${searchQuery}" → "${updatedText}"`)
        try {
            const { data: updateResult } = await this.knowledgePut("/update_entry", { query: searchQuery, text: updatedText })
            return JSON.stringify({ status: updateResult.status, message: updateResult.message })
        } catch (err) {
            logError(`[MEMORY UPDATE] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to update entry." })
        }
    }

    async memoryRemove(searchQuery) {
        log(`🗑️ [MEMORY REMOVE] "${searchQuery}"`)
        try {
            const { data: matchingEntries } = await this.knowledgeGet("/search_get", {
                query: searchQuery, k: this.opts.memoryRemoveK, max_distance: this.opts.memoryRemoveThreshold
            })
            if (!matchingEntries?.results?.length) {
                log(`🗑️ [MEMORY REMOVE] No matches found`)
                return JSON.stringify({ status: "not_found", message: "No matching memories found to remove." })
            }
            const textsToRemove = matchingEntries.results.map(entry => entry.text)
            log(`🗑️ [MEMORY REMOVE] Removing ${textsToRemove.length} entries: ${JSON.stringify(textsToRemove)}`)
            const { data: removeResult } = await this.knowledgePost("/remove_many", { texts: textsToRemove })
            return JSON.stringify({ status: removeResult.status, message: removeResult.message, removed: removeResult.removed })
        } catch (err) {
            logError(`[MEMORY REMOVE] ${err.message}`)
            return JSON.stringify({ status: "error", message: "Failed to remove entries." })
        }
    }

    runTool(toolName, toolArgs) {
        const isWriteTool = ["addto_memory_database", "update_memory_database", "remove_memory_database"].includes(toolName)

        if (isWriteTool) {
            if (this.writeToolUsedThisTurn) {
                console.warn(`⚠️ [TOOL] Write tool "${toolName}" blocked — already wrote memory this turn`)
                return Promise.resolve(JSON.stringify({ status: "skipped", message: "Memory already written this turn. Stop calling write tools and reply to the user now." }))
            }
            this.writeToolUsedThisTurn = true
        }

        switch (toolName) {
            case "query_hytale_wiki":      return this.wikiSearch(toolArgs.query ?? "")
            case "query_memory_database":  return this.memoryQuery(toolArgs.query ?? "")
            case "addto_memory_database":  return this.memoryAdd(toolArgs.text ?? "", toolArgs.source ?? "user")
            case "update_memory_database": return this.memoryUpdate(toolArgs.query ?? "", toolArgs.text ?? "")
            case "remove_memory_database": return this.memoryRemove(toolArgs.query ?? "")
            default:
                console.warn(`⚠️ [TOOL] Unknown tool: ${toolName}`)
                return Promise.resolve(`Unknown tool: ${toolName}`)
        }
    }

    // ─── Ollama ───────────────────────────────────────────────────────────────

    async sendToOllama(messages) {
        const { model, temperature, maxReplyTokens, contextWindow, ollamaUrl, ollamaTimeout } = this.opts
        try {
            const { data: ollamaResponse } = await axios.post(`${ollamaUrl}/api/chat`, {
                model,
                messages,
                stream: false,
                tools: TOOLS,
                options: { temperature, num_predict: maxReplyTokens, num_ctx: contextWindow },
            }, { timeout: ollamaTimeout })
            return ollamaResponse.message ?? null
        } catch (err) {
            logError(`[OLLAMA] ${err.message}`)
            return null
        }
    }

    // ─── Embedded tool call parser ────────────────────────────────────────────

    parseEmbeddedToolCalls(messageContent) {
        return [...messageContent.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].flatMap(match => {
            try {
                const parsedCall = JSON.parse(match[1].trim())
                const normalizedArgs = this.normalizeToolArgs(parsedCall)
                log(`🔬 [PARSE] ${parsedCall.name} → ${JSON.stringify(normalizedArgs)}`)
                return [{ name: parsedCall.name, args: normalizedArgs }]
            } catch {
                return []
            }
        })
    }

    normalizeToolArgs(toolCall) {
        let args = toolCall.arguments ?? toolCall.parameters ?? toolCall.args ?? {}
        if (typeof args === "string") {
            try { args = JSON.parse(args) } catch { args = {} }
        }

        const firstStringValue = (...sources) => {
            for (const source of sources) {
                const found = Object.entries(source)
                    .filter(([key]) => key !== "name")
                    .map(([, value]) => value)
                    .find(value => typeof value === "string")
                if (found) return found
            }
            return ""
        }

        switch (toolCall.name) {
            case "query_hytale_wiki":
            case "query_memory_database":
            case "remove_memory_database":
                if (!args.query) args = { query: firstStringValue(args, toolCall) }
                break
            case "addto_memory_database":
                if (!args.text) args = { text: firstStringValue(args, toolCall), source: args.source ?? "user" }
                break
            case "update_memory_database":
                if (!args.query || !args.text) {
                    const stringValues = Object.values(args).filter(value => typeof value === "string")
                    if (stringValues.length >= 2) args = { query: stringValues[0], text: stringValues[1] }
                }
                break
        }
        return args
    }

    // ─── Main chat loop ───────────────────────────────────────────────────────

    async chat(userInput) {
        const cleanedInput = this.sanitizeInput(userInput)
        log(`\n💬 [USER PROMPT] ${cleanedInput}`)
        this.conversationHistory.push({ role: "user", content: cleanedInput })
        this.writeToolUsedThisTurn = false

        const { summarizeEvery } = this.opts
        if (summarizeEvery > 0 && ++this.userMessageCount % summarizeEvery === 0) {
            this.summarizeConversationAndStore()
        }

        for (let loopCount = 0; loopCount < this.opts.maxToolLoops; loopCount++) {
            log(`🔄 [LOOP ${loopCount + 1}]`)

            const ollamaMessage = await this.sendToOllama(this.buildMessagesForOllama())
            if (!ollamaMessage) return "I'm having trouble thinking right now, sorry!"

            const messageContent = (ollamaMessage.content ?? "").trim()

            // ── Native tool calls ──
            if (ollamaMessage.tool_calls?.length) {
                log(`🔧 [NATIVE] ${ollamaMessage.tool_calls.map(tc => tc.function.name).join(", ")}`)
                this.conversationHistory.push(ollamaMessage)
                for (const toolCall of ollamaMessage.tool_calls) {
                    let parsedArgs = {}
                    try { parsedArgs = JSON.parse(toolCall.function.arguments ?? "{}") } catch {}
                    const toolResult = await this.runTool(toolCall.function.name, parsedArgs)
                    this.conversationHistory.push({ role: "tool", tool_call_id: toolCall.id, content: toolResult })
                }
                continue
            }

            // ── Embedded tool calls ──
            if (messageContent.includes("<tool_call>")) {
                const embeddedToolCalls = this.parseEmbeddedToolCalls(messageContent)
                if (embeddedToolCalls.length) {
                    // log(`🔧 [EMBEDDED] ${embeddedToolCalls.map(tc => tc.name).join(", ")}`)
                    this.conversationHistory.push({ role: "assistant", content: messageContent })
                    const toolResults = await Promise.all(embeddedToolCalls.map(tc => this.runTool(tc.name, tc.args)))
                    const combinedToolResults = toolResults
                        .map((result, index) => `[${embeddedToolCalls[index].name} result]\n${result}`)
                        .join("\n\n")
                    this.conversationHistory.push({ role: "user", content: `<tool_response>\n${combinedToolResults}\n</tool_response>` })
                    continue
                }
            }

            // ── Narration guard ──
            if ([...TOOL_NAMES].some(toolName => messageContent.includes(toolName))) {
                log(`⚠️ [NARRATE] Model described a tool instead of calling it — retrying`)
                const lastUserMessageIndex = this.conversationHistory.findLastIndex(turn => turn.role === "user")
                if (lastUserMessageIndex !== -1) {
                    this.conversationHistory[lastUserMessageIndex] = {
                        role: "user",
                        content: `[System: Do NOT write tool names in your reply. Emit a <tool_call> block instead.]\n\n${cleanedInput}`
                    }
                }
                continue
            }

            // ── Real reply ──
            if (messageContent && messageContent.toLowerCase() !== "none") {
                this.conversationHistory.push(ollamaMessage)
                log(`✅ [LILY REPLY] ${messageContent.slice(0, 100)}`)
                return messageContent
            }

            log(`⚠️ [EMPTY] No content in response`)
            return "I'm not sure about that one!"
        }

        return "Something went wrong after too many attempts."
    }
}