import axios from "axios"

export class HytaleAIChat {
    constructor(modelName = "Lily-old") {
        this.model = modelName
        this.vectorDbUrl = "http://localhost:8000"
        this.knowledgeDbUrl = "http://localhost:8001"
        this.maxHistoryMessages = 12

        this.systemPrompt = `
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

        this.conversationHistory = [
            {
                role: "system",
                content: this.systemPrompt
            }
        ]

        this.tools = [
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
            }
            // {
            //     type: "function",
            //     function: {
            //         name: "query_memory_database",
            //         description: "Search your personal memory database for information about yourself (Lily), the server, users, their hobbies/interests/age/preferences, or things you've been told to remember. Use this for any question about a person or the server.",
            //         parameters: {
            //             type: "object",
            //             properties: {
            //                 query: {
            //                     type: "string",
            //                     description: "What to search for, e.g. 'Pikahoran hobbies interests', 'Who created Lily?', 'What is Bendcraft?', 'alex age'"
            //                 }
            //             },
            //             required: ["query"]
            //         }
            //     }
            // },
            // {
            //     type: "function",
            //     function: {
            //         name: "addto_memory_database",
            //         description: "Store new information in your memory database when users tell you facts or ask you to remember something about a person or the server.",
            //         parameters: {
            //             type: "object",
            //             properties: {
            //                 text: {
            //                     type: "string",
            //                     description: "The fact to remember, written as a clear statement. E.g. 'User John likes pizza.' or 'The server was created in 2013.' or 'Alex is 22 years old.'"
            //                 },
            //                 source: {
            //                     type: "string",
            //                     description: "Where this info came from. Use 'user' when a user told you this directly."
            //                 }
            //             },
            //             required: ["text", "source"]
            //         }
            //     }
            //}
        ]
    }

    trimHistory() {
        if (this.conversationHistory.length <= this.maxHistoryMessages + 1) return

        const systemMessage = this.conversationHistory[0]
        const recentMessages = this.conversationHistory.slice(-this.maxHistoryMessages)
        this.conversationHistory = [systemMessage, ...recentMessages]

        console.log(`\n🧹 [TRIM] History trimmed to ${this.conversationHistory.length} messages`)
    }

    logHistory() {
        console.log("\n" + "═".repeat(80))
        console.log("📚 [HISTORY] Current conversation state:")
        console.log("═".repeat(80))
        
        this.conversationHistory.forEach((msg, idx) => {
            const role = msg.role.toUpperCase().padEnd(10)
            let preview = ""
            
            if (msg.role === "system") {
                preview = "[System prompt - not shown]"
            } else if (msg.role === "tool") {
                preview = `[tool] ${msg.content.slice(0, 100)}${msg.content.length > 100 ? "..." : ""}`
            } else if (msg.tool_calls?.length) {
                const calls = msg.tool_calls.map(t => t.function.name).join(", ")
                preview = `[TOOL CALLS: ${calls}]`
            } else {
                preview = msg.content?.slice(0, 150) || "[empty]"
                if (msg.content?.length > 150) preview += "..."
            }
            
            console.log(`  [${idx}] ${role} | ${preview}`)
        })
        console.log("═".repeat(80) + "\n")
    }

    async queryWiki(searchQuery, retries = 3) {
        console.log(`\n🔍 [WIKI QUERY] Searching for: "${searchQuery}"`)
        
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const startTime = Date.now()
                const response = await axios.get(
                    `${this.vectorDbUrl}/search`,
                    { params: { q: searchQuery }, timeout: 10000 }
                )
                const elapsed = Date.now() - startTime

                if (response.status === 200 && response.data) {
                    const result = typeof response.data === "string"
                        ? response.data
                        : JSON.stringify(response.data)

                    if (!result || result.trim() === "" || result === "{}") {
                        console.log(`⚠️  [WIKI RESULT] No data (${elapsed}ms)`)
                        return "No information found in the wiki for this topic."
                    }

                    console.log(`✅ [WIKI RESULT] ${result.length} chars in ${elapsed}ms`)
                    console.log(`📄 [WIKI DATA]\n${"─".repeat(80)}`)
                    console.log(result.slice(0, 400))
                    if (result.length > 400) console.log("... [truncated]")
                    console.log("─".repeat(80))
                    
                    return result
                }
            } catch (err) {
                console.error(`❌ [WIKI ERROR] Attempt ${attempt + 1}: ${err.message}`)
                if (attempt < retries - 1) continue
            }
        }

        console.log(`❌ [WIKI] All retries failed`)
        return "Wiki search unavailable right now."
    }

    async queryKnowledge(searchQuery, retries = 3) {
        console.log(`\n🧠 [KNOWLEDGE QUERY] Searching for: "${searchQuery}"`)
        
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const startTime = Date.now()
                const response = await axios.get(
                    `${this.knowledgeDbUrl}/search_get`,
                    { params: { query: searchQuery, k: 5 }, timeout: 10000 }
                )
                const elapsed = Date.now() - startTime

                if (response.status === 200 && response.data?.results) {
                    const results = response.data.results

                    if (!results.length) {
                        console.log(`⚠️  [KNOWLEDGE RESULT] No relevant results within distance threshold (${elapsed}ms)`)
                        return "No relevant information found in memory database."
                    }

                    // Strip distance field — model only needs the text
                    const formatted = results.map(r => r.text || r).join("\n")
                    console.log(`✅ [KNOWLEDGE RESULT] ${results.length} entries in ${elapsed}ms`)
                    console.log(`📄 [KNOWLEDGE DATA]\n${"─".repeat(80)}`)
                    console.log(formatted.slice(0, 400))
                    if (formatted.length > 400) console.log("... [truncated]")
                    console.log("─".repeat(80))
                    
                    return formatted
                }
            } catch (err) {
                console.error(`❌ [KNOWLEDGE ERROR] Attempt ${attempt + 1}: ${err.message}`)
                if (attempt < retries - 1) continue
            }
        }

        console.log(`❌ [KNOWLEDGE] All retries failed`)
        return "Knowledge database unavailable right now."
    }

    async addToKnowledge(text, source = "user", retries = 3) {
        console.log(`\n💾 [KNOWLEDGE ADD] Storing: "${text}" (source: ${source})`)
        
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await axios.post(
                    `${this.knowledgeDbUrl}/add_entry`,
                    { text, source },
                    { timeout: 10000 }
                )

                if (response.status === 200) {
                    const data = response.data
                    console.log(`✅ [KNOWLEDGE ADD] Response: ${data.status} — ${data.message}`)
                    return JSON.stringify({ status: data.status, message: data.message })
                }
            } catch (err) {
                console.error(`❌ [KNOWLEDGE ADD ERROR] Attempt ${attempt + 1}: ${err.message}`)
                if (attempt < retries - 1) continue
            }
        }

        console.log(`❌ [KNOWLEDGE ADD] All retries failed`)
        return JSON.stringify({ status: "error", message: "Failed to store information." })
    }

    async handleToolCall(toolCall) {
        const funcName = toolCall.function.name
        console.log(`\n🔧 [TOOL] Called: ${funcName}`)
        
        let args = {}
        try {
            args = JSON.parse(toolCall.function.arguments || "{}")
            console.log(`🔧 [TOOL] Args:`, args)
        } catch (err) {
            console.error(`❌ [TOOL] Parse error: ${err.message}`)
        }

        let result = "Unknown tool called."
        
        if (funcName === "query_hytale_wiki") {
            result = await this.queryWiki(args.query || "")
        } else if (funcName === "query_memory_database") {
            result = await this.queryKnowledge(args.query || "")
        } else if (funcName === "addto_memory_database") {
            result = await this.addToKnowledge(args.text || "", args.source || "user")
        }

        return {
            role: "tool",
            content: result,
            tool_call_id: toolCall.id || ""
        }
    }

    async sendToOllama(messages, useTools = true) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                this.trimHistory()

                console.log(`\n🤖 [OLLAMA] Attempt ${attempt + 1}/3 | Tools: ${useTools}`)
                console.log(`🤖 [OLLAMA] Model: ${this.model} | Messages: ${messages.length}`)

                const payload = {
                    model: this.model,
                    messages: messages,
                    stream: false
                }

                if (useTools) {
                    payload.tools = this.tools
                }

                const response = await axios.post(
                    "http://localhost:11434/api/chat",
                    payload,
                    { timeout: 30000 }
                )

                if (response.status === 200) {
                    console.log(`✅ [OLLAMA] Response received`)
                    
                    const msg = response.data.message
                    if (msg?.tool_calls?.length) {
                        console.log(`🔧 [OLLAMA] Tool calls: ${msg.tool_calls.map(t => t.function.name).join(", ")}`)
                    } else if (msg?.content) {
                        console.log(`💬 [OLLAMA] Preview: ${msg.content.slice(0, 100)}${msg.content.length > 100 ? "..." : ""}`)
                    }
                    
                    return response.data
                }
            } catch (err) {
                console.error(`❌ [OLLAMA] Attempt ${attempt + 1} failed: ${err.message}`)
                if (attempt < 2) continue
            }
        }

        console.log(`❌ [OLLAMA] All attempts exhausted`)
        return { message: { content: "I'm having trouble thinking right now, sorry!" } }
    }

    async chat(userInput) {
        console.log("\n" + "▓".repeat(80))
        console.log(`💬 [CHAT START] User: "${userInput}"`)
        console.log("▓".repeat(80))

        this.conversationHistory.push({
            role: "user",
            content: userInput
        })

        const maxToolLoops = 5
        let noneRetries = 0
        const maxNoneRetries = 2

        for (let attempt = 0; attempt < maxToolLoops; attempt++) {
            console.log(`\n🔄 [LOOP ${attempt + 1}/${maxToolLoops}]`)
            
            this.logHistory()
            
            const response = await this.sendToOllama(this.conversationHistory, true)

            if (!response?.message) {
                console.log(`❌ [CHAT] No message in response`)
                return "I couldn't think of a response, sorry!"
            }

            const msg = response.message
            const rawContent = msg.content?.trim() ?? ""

            // Model returned "None" — nudge it to pick a tool or just answer
            if (!msg.tool_calls?.length && rawContent.toLowerCase() === "none") {
                noneRetries++
                console.log(`⚠️  [NONE #${noneRetries}/${maxNoneRetries}] Model returned "None"`)

                if (noneRetries <= maxNoneRetries) {
                    console.log(`🔄 [NONE RETRY] Nudging model to use a tool or answer directly...`)

                    this.conversationHistory.pop()
                    this.conversationHistory.push({
                        role: "user",
                        content: `${userInput}\n\nPlease respond to this. If you need information, use the appropriate tool (query_memory_database for people/server info, query_hytale_wiki for game content). Do NOT reply with just "None".`
                    })

                    continue
                } else {
                    console.log(`⚠️  [NONE LIMIT] Max retries hit, forcing answer without tools`)

                    this.conversationHistory.pop()
                    this.conversationHistory.push({
                        role: "user",
                        content: `${userInput}\n\nJust answer this naturally. Do not say "None".`
                    })

                    const finalResponse = await this.sendToOllama(this.conversationHistory, false)

                    if (finalResponse?.message?.content) {
                        const content = finalResponse.message.content.trim()

                        if (content.toLowerCase() === "none") {
                            console.log(`❌ [NONE FALLBACK] Still got None, returning generic message`)
                            return "I'm not sure about that! Ask me something else maybe?"
                        }

                        this.conversationHistory.push(finalResponse.message)

                        console.log("▓".repeat(80))
                        console.log(`🏁 [CHAT END FALLBACK] "${content.slice(0, 100)}..."`)
                        console.log("▓".repeat(80) + "\n")

                        return content
                    }
                }
            }

            if (msg.tool_calls?.length) {
                console.log(`\n🔧 [CHAT] Processing ${msg.tool_calls.length} tool(s)`)
                this.conversationHistory.push(msg)

                for (const toolCall of msg.tool_calls) {
                    const toolResult = await this.handleToolCall(toolCall)
                    this.conversationHistory.push(toolResult)
                }

                console.log(`✅ [CHAT] Tool results added, looping...`)
                continue
            }

            console.log(`\n✅ [CHAT] Final response ready`)
            this.conversationHistory.push(msg)
            
            this.logHistory()

            console.log("▓".repeat(80))
            console.log(`🏁 [CHAT END] "${rawContent.slice(0, 100)}${rawContent.length > 100 ? "..." : ""}"`)
            console.log("▓".repeat(80) + "\n")

            return rawContent
        }

        console.log(`❌ [CHAT] Max loops exceeded`)
        return "Something went wrong after too many attempts."
    }
}