import { buildSurvivalPrompt } from '../prompt-builders/survivalPromptBuilder.js'
import { ToolRouter, ALL_TOOL_NAMES } from '../../../../ai/tools/toolRouter.js'
import { Logger } from '../../../../utils/Logger.js'
import { getToolConfig } from '../../../../startUtils.js'

const ACTIONS_INTERVAL_MS = 20000
const MSG_MIN_MS = 2 * 60 * 1000
const MSG_MAX_MS = 6 * 60 * 1000
const HISTORY_MAX_TURNS = 8

// ─── Tool Selection Based on Mode ────────────────────────────────────────────
function getToolsForMode(router, mode) {
    const config = getToolConfig(mode)
    const tools = []

    // Add minecraft tools if enabled
    if (config.includeMinecraft) {
        const mcTools = router.tools.filter(t => router.isMinecraftTool(t.function.name))
        tools.push(...mcTools)

        // If bending is disabled, filter out bending-specific tools
        if (!config.includeBending) {
            // Assuming bending tools have 'bending' in their name or description
            // Adjust this filter based on your actual tool naming
            const filtered = tools.filter(t =>
                !t.function.name.includes('bending') &&
                !t.function.description?.toLowerCase().includes('bend')
            )
            tools.length = 0
            tools.push(...filtered)
        }
    }

    // Add vtube tools if enabled
    if (config.includeVtube) {
        const vtubeTools = router.tools.filter(t => router.isVtubeTool(t.function.name))
        tools.push(...vtubeTools)
    }

    // Log what tools are available
    Logger.info(`Survival tools: ${tools.map(t => t.function.name).join(', ')}`, "SURVIVAL")

    return tools
}

// ─── Delay Calculation ──────────────────────────────────────────────────────
function randomMsgDelay() {
    const min = parseInt(process.env.SURVIVAL_MSG_MIN_MS || MSG_MIN_MS)
    const max = parseInt(process.env.SURVIVAL_MSG_MAX_MS || MSG_MAX_MS)
    return min + Math.random() * (max - min)
}

// ─── Main Survival Loop ─────────────────────────────────────────────────────
export async function startSurvivalLoop(stateController, mcSend, mcChat, ollamaUrl, mode, vtsClient = null) {
    let nextMessageAt = Date.now() + randomMsgDelay()


    const toolRouter = new ToolRouter(mcSend, () => stateController, vtsClient)

    await toolRouter.refreshExpressions()

    // Get tools based on current mode
    const survivalTools = getToolsForMode(toolRouter, mode)

    if (survivalTools.length === 0) {
        Logger.error('No tools available for survival loop!', "SURVIVAL")
        return null
    }

    Logger.info(`Starting survival loop with mode: ${mode}`, "SURVIVAL")
    Logger.info(`Available tools: ${survivalTools.map(t => t.function.name).join(', ')}`, "SURVIVAL")

    // Initialize history on stateController if needed
    if (!stateController.chatHistory) {
        stateController.chatHistory = []
    }

    // ─── Tick Execution ────────────────────────────────────────────────────
    async function runTick() {
        if (!stateController) {
            Logger.warning('State controller missing, skipping tick', "SURVIVAL")
            return
        }

        // Don't run if bot is busy
        const busyStates = ['MINING', 'ATTACKING', 'RECOVERING']
        if (busyStates.includes(stateController.currentStateName)) {
            Logger.info(`Skipping tick — busy in ${stateController.currentStateName}`, "SURVIVAL")
            return
        }

        // Check if we should send a message
        const allowMessage = Date.now() >= nextMessageAt
        if (allowMessage) {
            nextMessageAt = Date.now() + randomMsgDelay()
        }

        // Build the prompt
        const prompt = buildSurvivalPrompt(stateController, { allowMessage })
        if (!prompt) {
            Logger.info('No prompt generated, skipping tick', "SURVIVAL")
            return
        }

        // Prepare messages with history
        const messages = [
            ...stateController.chatHistory.slice(-HISTORY_MAX_TURNS),
            { role: "user", content: prompt }
        ]

        try {
            // ─── AI Request ──────────────────────────────────────────────
            const endpoint = `${ollamaUrl.replace(/\/+$/, '')}/v1/chat/completions`
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: process.env.OLLAMA_MODEL ?? "Lily",
                    stream: false,
                    messages,
                    tools: getToolsForMode(toolRouter, mode),
                    tool_choice: "auto",
                    temperature: parseFloat(process.env.SURVIVAL_TEMPERATURE ?? "0.4"),
                    max_tokens: parseInt(process.env.SURVIVAL_MAX_TOKENS ?? "512")
                })
            })

            if (!response.ok) {
                const errBody = await response.text().catch(() => '')
                Logger.error(`HTTP ${response.status}: ${errBody}`, "SURVIVAL")
                return
            }

            const data = await response.json()
            const message = data.choices?.[0]?.message

            if (!message) {
                Logger.error(`No message in response: ${JSON.stringify(data)}`, "SURVIVAL")
                return
            }

            // ─── Process Response ─────────────────────────────────────────
            const chatText = message.content?.trim()
            if (allowMessage && chatText && mcChat) {
                mcChat(chatText)
            }

            // Record turn in history
            stateController.chatHistory.push({
                role: "user",
                content: prompt
            })
            stateController.chatHistory.push({
                role: "assistant",
                content: message.content ?? "",
                tool_calls: message.tool_calls
            })

            // Trim history if too long
            if (stateController.chatHistory.length > HISTORY_MAX_TURNS * 2) {
                stateController.chatHistory = stateController.chatHistory.slice(-HISTORY_MAX_TURNS * 2)
            }

            // ─── Execute Tool Calls ──────────────────────────────────────
            const toolCalls = message.tool_calls ?? []
            for (const call of toolCalls) {
                await handleSurvivalToolCall(call, toolRouter, mode)
            }

        } catch (err) {
            Logger.error(`AI error: ${err.message}`, "SURVIVAL")
            if (err.stack) {
                Logger.error(err.stack, "SURVIVAL")
            }
        }
    }

    // ─── Start the loop ──────────────────────────────────────────────────
    const interval = setInterval(runTick, ACTIONS_INTERVAL_MS)

    // Store interval for cleanup
    const loop = {
        triggerTick: runTick,
        _interval: interval,
        stop: () => {
            clearInterval(interval)
            Logger.info('Survival loop stopped', "SURVIVAL")
        }
    }

    // Run first tick immediately
    setTimeout(runTick, 1000)

    return loop
}

// ─── Tool Call Handler ──────────────────────────────────────────────────────
async function handleSurvivalToolCall(call, toolRouter, mode) {
    const name = call.function?.name
    if (!name) {
        Logger.warning('Tool call missing function name', "SURVIVAL")
        return
    }

    const config = getToolConfig(mode)

    // Validate the tool is allowed in this mode
    const isMinecraft = toolRouter.isMinecraftTool(name)
    const isVtube = toolRouter.isVtubeTool(name)

    // Check if tool is allowed
    let allowed = false
    if (isMinecraft && config.includeMinecraft) {
        // If bending is disabled, skip bending tools
        if (!config.includeBending && name.includes('bending')) {
            Logger.warning(`Bending tool ${name} not allowed in this mode`, "SURVIVAL")
            return
        }
        allowed = true
    } else if (isVtube && config.includeVtube) {
        allowed = true
    }

    if (!allowed) {
        Logger.warning(`Tool ${name} not allowed in mode ${mode}`, "SURVIVAL")
        return
    }

    // Parse arguments
    let args = {}
    try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
    } catch (err) {
        Logger.error(`Invalid arguments for ${name}: ${call.function.arguments}`, "SURVIVAL")
        return
    }

    // Execute the tool
    try {
        const result = await toolRouter.execute(name, args)
        Logger.info(`${name} → ${result}`, "SURVIVAL")
    } catch (err) {
        Logger.error(`Failed to execute ${name}: ${err.message}`, "SURVIVAL")
    }
}

// ─── Export utilities for testing ──────────────────────────────────────────
export { getToolsForMode, randomMsgDelay }