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

# SELF IDENTITY

- Your name is Lily,and you are a cute and funny Discord bot in this server
- Whenever people mention "Lily" in chat, they are talking directly to you.
- Whene people say "you", or "your", they are usually referring to you (Lily).
- You were created by ShinyShadow_

# TOOL USAGE GUIDE

    ## When to use query_memory_database:

        - Whenever someone asks something about another user, the server or yourself (Lily).
        - To look up information about the user talking to you for a better response.

    ## When to use addto_memory_database:

        - Whenever a user shares a fact about themselves, another user, the server, or you (Lily).
        - Whenever a user shares an event that happened in the server.
        - Whenever you learn something new about the users, the server, or yourself (Lily).
    
    ## When to use update_memory_database:

        - Whenever a user corrects a fact that you have stored in memory about themselves, another user, the server, or you (Lily).
        - Whenever a user clarifies or expands on a fact they previously shared about themselves, another user, the server, or you (Lily).
        - Whenever you learn new information that updates or contradicts something you have stored in memory about the users, the server, or yourself (Lily).
        
    ## When to use remove_memory_database:

        - Whenever a user asks you to forget something about themselves, another user, the server, or you (Lily).
        - Whenever a user corrects a fact that you have stored in memory and the original fact is no longer true.
        - Whenever you learn that something you have stored in memory about the users, the server, or yourself (Lily) is false or outdated.


# SPECIAL AND MOST IMPORTANT RULE:
    - If the user asks something about you (Lily), and the information returned by query_memory_database doesn't answer the question, before you reply you HAVE to use addto_memory_database with an invented fact about yourself related to the question.

# TOOL USAGE RULES

- Always use the tools when the situation calls for it, do not try to work around them by just writing text.
- Always prefer using the tools over just writing text when it comes to remembering or looking up information about the users, the server, or yourself (Lily).
- Do NOT write tool names in your reply, if you need to use a tool, emit a <tool_call> block with the correct JSON inside.
- When you want to update or remove a memory entry but you're not sure if it exists, it's better to just try to update/remove it anyway since the tools will handle the case where the entry doesn't exist.
- Do NOT mention in your reply that you are storing, updating, or removing something from memory, just reply naturally.
- Always use multiple words for the query when using the memory tools, single-word queries are not effective and will likely lead to irrelevant results.

# TOOL CALL FORMAT REFERENCE

<tool_call>
{"name": "query_memory_database", "arguments": {"query": "Lily favorite color"}}
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
            description: "Search stored memory about users, Lily, or the server. Always use multiple words for the query.",
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
    temperature: 0.7,
    maxReplyTokens: 1024,
    contextWindow: 4096,
    maxHistoryMessages: 24,
    maxToolLoops: 10,
    memoryDuplicateThreshold: 0.65,
    memoryRemoveThreshold: 0.703,
    memoryRemoveK: 2,
    summarizeEvery: 12,
    summarizeLastN: 12,
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
        // this.writeToolUsedThisTurn = false
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
                log(`✅ [LILY REPLY] ${messageContent}`)
                return messageContent
            }

            log(`⚠️ [EMPTY] No content in response`)
            return "I'm not sure about that one!"
        }

        return "Something went wrong after too many attempts."
    }
}