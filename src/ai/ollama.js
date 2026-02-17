import axios from "axios"

export class HytaleAIChat {
    constructor(modelName = "Lily") {
        this.model = modelName
        this.vectorDbUrl = "http://localhost:8000"

        this.conversationHistory = [
            {
            role: "system",
            content:`You are a cute discord and Hytale bot with knowledge about the Hytale game wiki. Your name is Lily.
            You currently reside in the discord server called Bendcraft or Bendtale. Your favorite food are berries.
	      # CONVERSATION RULES:
	      - Most of the time, just chat naturally and warmly
	      - If the user says "no", "stop", or seems uninterested, respect that and just chat
	      
	      # HYTALE WIKI QUESTIONS:
	      - If asked about items, crafting, mobs, blocks, or game mechanics, use query_hytale_wiki tool
	      - After getting tool results, describe them in a helpful way
	      - If no data found, say paraphrase this: "I dont know what that is sorry!"
	      `
            }
        ]

        this.tools = [
            {
                type: "function",
                function: {
                    name: "query_hytale_wiki",
                    description: "Search Hytale wiki. REQUIRED for all Hytale related questions. If failed to find information, answer normally that you dont have information about that.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "Topic to search"
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
                    return typeof response.data === "string"
                        ? response.data
                        : JSON.stringify(response.data)
                }
            } catch {
                if (attempt < retries - 1) continue
            }
        }

        return "No wiki info found."
    }

    async handleToolCall(toolCall) {
        const funcName = toolCall.function.name
        const args = JSON.parse(toolCall.function.arguments || "{}")

        console.log("\n🔧 Tool called:", funcName)
        console.log("🔧 Args:", args)

        let result = "Unknown tool"

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
            } catch {
                if (attempt < 2) continue
            }
        }

        return { message: { content: "Error connecting to AI" } }
    }

async chat(userInput) {
    this.conversationHistory.push({
        role: "user",
        content: userInput
    })

    const maxAttempts = 8

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const response = await this.sendToOllama(this.conversationHistory)
        if (!response.message) return "AI error."

        let msg = response.message

        // "None" fallback logic
        if (!msg.tool_calls && msg.content?.trim().toLowerCase() === "none") {
            const lastUserMsg = userInput

            if (attempt < maxAttempts - 1) {
                const wikiResult = await this.queryWiki(lastUserMsg)

                this.conversationHistory.pop()

                this.conversationHistory.push({
                    role: "user",
                    content: `${lastUserMsg}\n\n[Wiki context: ${wikiResult}]`
                })

                continue
            } else {
                break
            }
        }

        this.conversationHistory.push(msg)

        if (msg.tool_calls) {
            for (const toolCall of msg.tool_calls) {
                const toolResult = await this.handleToolCall(toolCall)
                this.conversationHistory.push(toolResult)
            }

            const final = await this.sendToOllama(this.conversationHistory)

            if (final.message) {
                this.conversationHistory.push(final.message)
                return trimAfterSlash(final.message.content)
            }
        } else {
            return trimAfterSlash(msg.content)
        }
    }

    return "Something went wrong."
}

// -------------------------
// Helper function to trim after slash

}
function trimAfterSlash(text) {
    if (!text) return text
    const index = text.indexOf("/")
    if (index === -1) return text.trim()
    return text.slice(0, index).trim()
}