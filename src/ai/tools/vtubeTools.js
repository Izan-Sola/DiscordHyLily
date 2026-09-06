import { Logger } from '../../utils/Logger.js'
import { ok, err } from './toolHelpers.js'

const EXPRESSION_COOLDOWN_MS = 800


class VtubeToolExecutor {
    constructor(vtsClient = null) {
        this.vts = vtsClient
        this.expressionCache = []
        this.lastTrigger = 0

        // Fire-and-forget: if a client was already handed in at
        // construction time, start warming the cache immediately instead
        // of waiting for the first triggerExpression() call to do it -
        // that lazy path only helps *after* the model has already tried
        // and failed once with an empty/undefined enum.
        if (this.vts) this.refreshExpressions()
    }

    async refreshExpressions() {
        if (!this.vts) return
        try {
            this.expressionCache = await this.vts.listHotkeys()
            Logger.info(`Cached ${this.expressionCache.length} expressions`, "VTUBE")
        } catch (e) {
            Logger.error(e.message, "VTUBE")
        }
    }

    setVtsClient(vtsClient) {
        this.vts = vtsClient
        this.expressionCache = []
        // Same reasoning as the constructor - refresh the moment we have
        // a live client, don't wait for a tool call to discover it's empty.
        this.refreshExpressions()
    }

    get toolNames() {
        return VTUBE_TOOL_NAMES
    }

    get isEnabled() {
        return !!this.vts && this.expressionCache.length > 0
    }

    // Built fresh on every access so the enum always reflects whatever is
    // currently in expressionCache. This only works if something already
    // populated expressionCache beforehand (see refreshExpressions calls
    // above) - this getter itself can't await a fetch, it just reads
    // whatever's already cached.
    get tools() {
        return [{
            type: "function",
            function: {
                name: "trigger_expression",
                description: "Trigger a facial expression/animation on your VTuber model. Fires independently of whatever else you're doing (chatting, mining, etc) — use it any time an expression fits the moment.",
                parameters: {
                    type: "object",
                    properties: {
                        expression: {
                            type: "string",
                            enum: this.expressionCache.map(h => h.name),
                            description: "Name of the expression to trigger."
                        }
                    },
                    required: ["expression"]
                }
            }
        }]
    }

    async triggerExpression(args = {}) {
        if (!this.vts) {
            return err("VTuber model isn't connected right now.")
        }

        if (Date.now() - this.lastTrigger < EXPRESSION_COOLDOWN_MS) {
            return JSON.stringify({ status: "cooldown", message: "Expression triggered too recently, skip it." })
        }

        // Lazy refresh: if nothing has populated the cache yet (e.g. this
        // is the very first call before any periodic refresh ran), try
        // once here instead of permanently offering an empty enum.
        if (!this.expressionCache.length) {
            await this.refreshExpressions()
        }

        const match = this.expressionCache.find(h => h.name === args?.expression)
        if (!match) return err("Unknown expression.")

        try {
            await this.vts.triggerHotkeyID(match.hotkeyID)
        } catch (e) {
            Logger.error(e.message, "VTUBE")
            return err("Failed to trigger expression.")
        }

        this.lastTrigger = Date.now()
        Logger.info(`Triggered expression: ${match.name}`, "VTUBE")
        return ok(`Triggered ${match.name}.`)
    }

    async execute(name, args) {
        switch (name) {
            case "trigger_expression": return this.triggerExpression(args)
            default:
                Logger.warning(`Unknown: ${name}`, "TOOL")
                return err(`Unknown tool: ${name}`)
        }
    }
}

const VTUBE_TOOL_NAMES = new Set(['trigger_expression'])

export { VtubeToolExecutor, VTUBE_TOOL_NAMES }