import axios from "axios"

const SYSTEM_PROMPT = `
# BASIC INFORMATION    
- You are a discord bot with knowledge about the Hytale game wiki in specific, but also about everything else.
- Your name is Lily.
- You chat casually, and adapt your tone and personality to the conversation.

# USER CONTEXT RULES:
- Messages are formatted like this:

  Username: message

  Username (replying to OtherUser who said "quote"):
  message

  Username (mentioning OtherUser):
  message

- Always pay attention to who is speaking.
- If someone is replying to another user, treat it as part of an ongoing conversation thread.
- If someone is mentioning another user, they are directing the message toward them.
- Keep awareness of multiple users in the chat.
- DO NOT include the username format in your reply.
- Respond naturally as Lily would in Discord.
`.trim()

const TOOLS = [
    {
        type: "function",
        function: {
            name: "query_hytale_wiki",
            description: "Search the Hytale wiki for information about the game: mobs, items, blocks, biomes, zones, factions, crafting, mechanics. Do NOT use for personal info or memory.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "The topic or question to search for in the wiki."
                    }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "query_memory_database",
            description: "Search your personal memory database for information about yourself (Lily), the server, users, their hobbies/interests/age/preferences, or things you've been told to remember. Use this for any question about a person or the server.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "What to search for, e.g. 'Pikahoran hobbies interests', 'Who created Lily?', 'What is Bendcraft?', 'alex age'"
                    }
                },
                required: ["query"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "addto_memory_database",
            description: "Store new information in your memory database when users tell you facts or ask you to remember something about a person or the server.",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description: "The fact to remember, written as a clear statement. E.g. 'User John likes pizza.' or 'The server was created in 2013.' or 'Alex is 22 years old.'"
                    },
                    source: {
                        type: "string",
                        description: "Where this info came from. Use 'user' when a user told you this directly."
                    }
                },
                required: ["text", "source"]
            }
        }
    }
]

export class HytaleAIChat {
    constructor(modelName = "Lily-old") {
        this.model = modelName
        this.vectorDbUrl = "http://localhost:8000"
        this.knowledgeDbUrl = "http://localhost:8001"
        this.maxHistoryMessages = 12

        this.conversationHistory = [
            { role: "system", content: SYSTEM_PROMPT }
        ]
    }

    // ─── History ─────────────────────────────────────────────────────────────

    trimHistory() {
        if (this.conversationHistory.length <= this.maxHistoryMessages + 1) return
        const [system] = this.conversationHistory
        this.conversationHistory = [system, ...this.conversationHistory.slice(-this.maxHistoryMessages)]
        console.log(`🧹 [TRIM] History trimmed to ${this.conversationHistory.length} messages`)
    }

    logHistory() {
        console.log("\n" + "═".repeat(80))
        console.log("📚 [HISTORY] Current conversation state:")
        console.log("═".repeat(80))
        this.conversationHistory.forEach((msg, idx) => {
            const role = msg.role.toUpperCase().padEnd(10)
            let preview
            if (msg.role === "system") {
                preview = "[System prompt]"
            } else if (msg.role === "tool") {
                preview = `[tool] ${msg.content.slice(0, 100)}${msg.content.length > 100 ? "..." : ""}`
            } else if (msg.tool_calls?.length) {
                preview = `[TOOL CALLS: ${msg.tool_calls.map(t => t.function.name).join(", ")}]`
            } else {
                const c = msg.content ?? "[empty]"
                preview = c.length > 150 ? c.slice(0, 150) + "..." : c
            }
            console.log(`  [${idx}] ${role} | ${preview}`)
        })
        console.log("═".repeat(80) + "\n")
    }

    // ─── HTTP helpers ─────────────────────────────────────────────────────────

    async fetchWithRetry(label, fn, retries = 3) {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                return await fn()
            } catch (err) {
                console.error(`❌ [${label}] Attempt ${attempt + 1}: ${err.message}`)
                if (attempt === retries - 1) return null
            }
        }
    }

    // ─── Tool implementations ─────────────────────────────────────────────────

    async queryWiki(query) {
        console.log(`\n🔍 [WIKI] Searching: "${query}"`)
        const result = await this.fetchWithRetry("WIKI", async () => {
            const start = Date.now()
            const { status, data } = await axios.get(`${this.vectorDbUrl}/search`, {
                params: { q: query },
                timeout: 10000
            })
            const elapsed = Date.now() - start
            if (status !== 200 || !data) return null
            const text = typeof data === "string" ? data : JSON.stringify(data)
            if (!text?.trim() || text === "{}") {
                console.log(`⚠️  [WIKI] No data (${elapsed}ms)`)
                return "No information found in the wiki for this topic."
            }
            console.log(`✅ [WIKI] ${text.length} chars in ${elapsed}ms`)
            this.logData("WIKI", text)
            return text
        })
        return result ?? "Wiki search unavailable right now."
    }

    async queryKnowledge(query) {
        console.log(`\n🧠 [MEMORY] Searching: "${query}"`)
        const result = await this.fetchWithRetry("MEMORY", async () => {
            const start = Date.now()
            const { status, data } = await axios.get(`${this.knowledgeDbUrl}/search_get`, {
                params: { query, k: 5 },
                timeout: 10000
            })
            const elapsed = Date.now() - start
            if (status !== 200 || !data?.results) return null
            if (!data.results.length) {
                console.log(`⚠️  [MEMORY] No results (${elapsed}ms)`)
                return "No relevant information found in memory database."
            }
            const text = data.results.map(r => r.text || r).join("\n")
            console.log(`✅ [MEMORY] ${data.results.length} entries in ${elapsed}ms`)
            this.logData("MEMORY", text)
            return text
        })
        return result ?? "Memory database unavailable right now."
    }

    async addToKnowledge(text, source = "user") {
        console.log(`\n💾 [MEMORY ADD] Storing: "${text}" (source: ${source})`)
        const result = await this.fetchWithRetry("MEMORY ADD", async () => {
            const { status, data } = await axios.post(
                `${this.knowledgeDbUrl}/add_entry`,
                { text, source },
                { timeout: 10000 }
            )
            if (status !== 200) return null
            console.log(`✅ [MEMORY ADD] ${data.status} — ${data.message}`)
            return JSON.stringify({ status: data.status, message: data.message })
        })
        return result ?? JSON.stringify({ status: "error", message: "Failed to store information." })
    }

    logData(label, text) {
        console.log(`📄 [${label} DATA]\n${"─".repeat(80)}`)
        console.log(text.slice(0, 400))
        if (text.length > 400) console.log("... [truncated]")
        console.log("─".repeat(80))
    }

    // ─── Tool dispatch ────────────────────────────────────────────────────────

    async handleToolCall(toolCall) {
        const name = toolCall.function.name
        console.log(`\n🔧 [TOOL] Called: ${name}`)

        let args = {}
        try {
            args = JSON.parse(toolCall.function.arguments || "{}")
            console.log(`🔧 [TOOL] Args:`, args)
        } catch (err) {
            console.error(`❌ [TOOL] Arg parse error: ${err.message}`)
        }

        let content
        switch (name) {
            case "query_hytale_wiki":
                content = await this.queryWiki(args.query || "")
                break
            case "query_memory_database":
                content = await this.queryKnowledge(args.query || "")
                break
            case "addto_memory_database":
                content = await this.addToKnowledge(args.text || "", args.source || "user")
                break
            default:
                content = `Unknown tool: ${name}`
        }

        return { role: "tool", content, tool_call_id: toolCall.id || "" }
    }

    // ─── Ollama ───────────────────────────────────────────────────────────────

    async sendToOllama(messages, useTools = true) {
        console.log(`\n🤖 [OLLAMA] Model: ${this.model} | Messages: ${messages.length} | Tools: ${useTools}`)

        const result = await this.fetchWithRetry("OLLAMA", async () => {
            const payload = { model: this.model, messages, stream: false }
            if (useTools) payload.tools = TOOLS

            const { status, data } = await axios.post(
                "http://localhost:11434/api/chat",
                payload,
                { timeout: 30000 }
            )
            if (status !== 200) return null

            const msg = data.message
            if (msg?.tool_calls?.length) {
                console.log(`🔧 [OLLAMA] Tool calls: ${msg.tool_calls.map(t => t.function.name).join(", ")}`)
            } else if (msg?.content) {
                console.log(`💬 [OLLAMA] Preview: ${msg.content.slice(0, 100)}${msg.content.length > 100 ? "..." : ""}`)
            }
            return data
        })

        return result ?? { message: { content: "I'm having trouble thinking right now, sorry!" } }
    }

    // ─── Input sanitization ───────────────────────────────────────────────────

    sanitizeInput(input) {
        return input
            // Remove Discord user mentions: <@123456> or <@!123456>
            .replace(/<@!?\d+>/g, '')
            // Remove Discord role mentions: <@&123456>
            .replace(/<@&\d+>/g, '')
            // Remove Discord channel mentions: <#123456>
            .replace(/<#\d+>/g, '')
            // Remove custom emoji: <:name:123456> or <a:name:123456>
            .replace(/<a?:\w+:\d+>/g, '')
            // Clean up multiple spaces
            .replace(/\s+/g, ' ')
            .trim()
    }

    // ─── Main chat loop ───────────────────────────────────────────────────────

    async chat(userInput) {
        const cleanInput = this.sanitizeInput(userInput)

        console.log("\n" + "▓".repeat(80))
        console.log(`💬 [CHAT] Original: "${userInput}"`)
        if (cleanInput !== userInput) {
            console.log(`🧹 [CLEAN] Sanitized: "${cleanInput}"`)
        }
        console.log("▓".repeat(80))

        this.trimHistory()
        this.conversationHistory.push({ role: "user", content: cleanInput })

        const MAX_LOOPS = 5
        const MAX_NONE_RETRIES = 2
        let noneRetries = 0

        for (let loop = 0; loop < MAX_LOOPS; loop++) {
            console.log(`\n🔄 [LOOP ${loop + 1}/${MAX_LOOPS}]`)
            this.logHistory()

            const response = await this.sendToOllama(this.conversationHistory, true)
            if (!response?.message) return "I couldn't think of a response, sorry!"

            const msg = response.message
            const content = msg.content?.trim() ?? ""
            const isNone = !msg.tool_calls?.length && content.toLowerCase() === "none"

            // Handle "None" responses
            if (isNone) {
                noneRetries++
                console.log(`⚠️  [NONE ${noneRetries}/${MAX_NONE_RETRIES}]`)
                this.conversationHistory.pop()

                if (noneRetries <= MAX_NONE_RETRIES) {
                    this.conversationHistory.push({
                        role: "user",
                        content: `${cleanInput}\n\nPlease respond. Use query_memory_database for people/server info, query_hytale_wiki for game content. Do NOT reply with "None".`
                    })
                    continue
                }

                // Last resort: answer without tools
                this.conversationHistory.push({ role: "user", content: `${cleanInput}\n\nJust answer naturally. Do not say "None".` })
                const fallback = await this.sendToOllama(this.conversationHistory, false)
                const fallbackContent = fallback?.message?.content?.trim()

                if (!fallbackContent || fallbackContent.toLowerCase() === "none") {
                    return "I'm not sure about that! Ask me something else maybe?"
                }

                this.conversationHistory.push(fallback.message)
                return fallbackContent
            }

            // Handle tool calls
            if (msg.tool_calls?.length) {
                this.conversationHistory.push(msg)
                for (const toolCall of msg.tool_calls) {
                    this.conversationHistory.push(await this.handleToolCall(toolCall))
                }
                continue
            }

            // Final answer
            this.conversationHistory.push(msg)
            this.logHistory()
            console.log("▓".repeat(80))
            console.log(`🏁 [DONE] "${content.slice(0, 100)}${content.length > 100 ? "..." : ""}"`)
            console.log("▓".repeat(80) + "\n")
            return content
        }

        return "Something went wrong after too many attempts."
    }
}