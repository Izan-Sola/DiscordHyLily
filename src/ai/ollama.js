import axios from "axios"

export class HytaleAIChat {
    constructor(modelName = "Lily") {
        this.model = modelName
        this.vectorDbUrl = "http://localhost:8000"

        this.conversationHistory = [
            {
                role: "system",
                content: `
                # BASIC INFORMATION    
                - You are a discord bot with knowledge about the Hytale game wiki in specific, but also about everything else. When asked things about Hytale, use the query_hytale_wiki tool.
                - Your name is Lily. You chat casually, and adapt your tone and personality to the conversation.

                # HYTALE WIKI QUESTIONS:
                - If asked about Hytale items, crafting, mobs, blocks, biomes, factions, zones, or game mechanics, ALWAYS use the query_hytale_wiki tool first
                - After getting tool results, describe them in a helpful, comprehensive and extensive way.

                # CONVERSATION FORMAT:
                - Messages will appear as: Username: message
                - Replies appear as: Username (replying to OtherUser who said "quote"): message
                - Mentions appear as: Username (mentioning OtherUser): message`.trim();         
            }
        ]

        this.tools = [
            {
                type: "function",
                function: {
                    name: "query_hytale_wiki",
                    description: "Search the Hytale wiki for information about the game. Use this for ALL Hytale-related questions: mobs, items, zones, biomes, factions, mechanics, crafting, etc. Always call this before answering any Hytale question.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "The topic or question to search for in the wiki, e.g. 'Kweebec behavior', 'Emerald Wilds biome', 'combat damage'"
                            }
                        },
                        required: ["query"]
                    }
                }
            }
        ]
    }

    async queryWiki(searchQuery, retries = 3) {
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await axios.get(
                    `${this.vectorDbUrl}/search`,
                    { params: { q: searchQuery }, timeout: 10000 }
                )

                if (response.status === 200 && response.data) {
                    const result = typeof response.data === "string"
                        ? response.data
                        : JSON.stringify(response.data)

                    // If the DB returned something empty or useless, say so clearly
                    // so the AI knows to give a "I don't know" answer rather than error
                    if (!result || result.trim() === "" || result === "{}") {
                        return "No information found in the wiki for this topic. The page may be a stub or not yet written."
                    }

                    return result
                }
            } catch (err) {
                console.error(`Wiki query attempt ${attempt + 1} failed:`, err.message)
                if (attempt < retries - 1) continue
            }
        }

        return "Wiki search unavailable right now."
    }

    async handleToolCall(toolCall) {
        const funcName = toolCall.function.name

        let args = {}
        try {
            args = JSON.parse(toolCall.function.arguments || "{}")
        } catch (err) {
            console.error("Failed to parse tool arguments:", err.message)
        }

        console.log("\n Tool called:", funcName)
        console.log(" Args:", args)

        let result = "Unknown tool called."

        if (funcName === "query_hytale_wiki") {
            result = await this.queryWiki(args.query || "")
        }

        console.log("Tool result preview:", result.slice(0, 150))

        return {
            role: "tool",
            content: result,
            tool_call_id: toolCall.id || "",
            name: funcName
        }
    }

    async sendToOllama(messages) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                console.log(`📤 Attempt ${attempt + 1}:`, JSON.stringify(messages.slice(-3), null, 2))

                const response = await axios.post(
                    "http://localhost:11434/api/chat",
                    {
                        model: this.model,
                        messages: messages,
                        tools: this.tools,
                        stream: false
                    },
                    { timeout: 30000 }
                )

                if (response.status === 200) {
                    return response.data
                }
            } catch (err) {
                console.error(`Ollama attempt ${attempt + 1} failed:`, err.message)
                if (attempt < 2) continue
            }
        }

        return { message: { content: "I'm having trouble thinking right now, sorry!" } }
    }

    async chat(userInput) {
        this.conversationHistory.push({
            role: "user",
            content: userInput
        })

        const maxToolLoops = 5

        for (let attempt = 0; attempt < maxToolLoops; attempt++) {
            const response = await this.sendToOllama(this.conversationHistory)

            if (!response?.message) {
                console.error("No message in Ollama response:", response)
                return "I couldn't think of a response, sorry!"
            }

            const msg = response.message
            const rawContent = msg.content?.trim() ?? ""

            // If the AI fails to generate a response after querying the database,
            // retry the query with the previous query as context. 
            if (!msg.tool_calls?.length && rawContent.toLowerCase() === "none") {
                console.log("Failed wiki query, retrying with injected context")

                const wikiResult = await this.queryWiki(userInput)
                this.conversationHistory.pop()

                this.conversationHistory.push({
                    role: "user",
                    content: `${userInput}\n\n[Wiki context]:\n${wikiResult}`
                })
            }

            if (msg.tool_calls?.length) {
                this.conversationHistory.push(msg)

                for (const toolCall of msg.tool_calls) {
                    const toolResult = await this.handleToolCall(toolCall)
                    this.conversationHistory.push(toolResult)
                }

                continue
            }

            this.conversationHistory.push(msg)
            return rawContent
        }

        return "Something went wrong after too many attempts."
    }
}


