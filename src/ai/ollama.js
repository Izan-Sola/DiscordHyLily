import axios from "axios"

export class HytaleAIChat {
    constructor(modelName = "Lily") {
        this.model = modelName
        this.vectorDbUrl = "http://localhost:8000"

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
- Do NOT include the username format in your reply.
- Respond naturally as Lily would in Discord.

# HYTALE WIKI QUESTIONS:
- If asked about Hytale items, crafting, mobs, blocks, biomes, factions, zones, or mechanics,
  ALWAYS use the query_hytale_wiki tool first.
- After receiving tool results, describe them in a helpful, detailed way.
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
                    description: "Search the Hytale wiki for information about the game.",
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
        ]
    }

    trimHistory() {
        if (this.conversationHistory.length <= this.maxHistoryMessages + 1) return

        const systemMessage = this.conversationHistory[0]
        const recentMessages = this.conversationHistory.slice(-this.maxHistoryMessages)
        this.conversationHistory = [systemMessage, ...recentMessages]

        console.log(`🧹 Trimmed history. Current length: ${this.conversationHistory.length}`)
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

                    if (!result || result.trim() === "" || result === "{}") {
                        return "No information found in the wiki for this topic."
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

        let result = "Unknown tool called."

        if (funcName === "query_hytale_wiki") {
            result = await this.queryWiki(args.query || "")
        }

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
                this.trimHistory()

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
                return "I couldn't think of a response, sorry!"
            }

            const msg = response.message
            const rawContent = msg.content?.trim() ?? ""

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
