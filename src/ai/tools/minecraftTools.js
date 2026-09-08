import { Logger } from '../../utils/Logger.js'
import { ok, err } from './toolHelpers.js'

// ─── Minecraft Tool Executor ────────────────────────────────────────────
//
// Runs in the Minecraft-agent context. Exempt from the chat-turn tool
// budget in chatTools.js — gated by its own per-action cooldown
// (lastMineTime for mining) instead. No turn/flaw bookkeeping lives here;
// that's owned by ChatToolExecutor and delegated to via ToolRouter.
class MinecraftToolExecutor {
    // getStateController is a () => stateController function, same
    // contract as before the split (see lily.js). mcSend is kept for
    // parity with the old constructor signature / setMcSend wiring, even
    // though the action methods below talk to the world exclusively
    // through the state controller.
    constructor(mcSend = null, getStateController = null) {
        this.mcSend = mcSend
        this.getStateController = getStateController
        this.lastMineTime = 0
    }

    setMcSend(mcSend) {
        this.mcSend = mcSend
    }

    get toolNames() {
        return MINECRAFT_TOOL_NAMES
    }

    get tools() {
        return MINECRAFT_TOOLS
    }

    _noController() {
        return err("Can't perform actions right now.")
    }

    // Shared by the simple one-shot actions (attack/eat/swap/follow/retreat/stop).
    _simpleDispatch(action, payload, okMessage, failFallback) {
        const stateController = this.getStateController?.()
        if (!stateController) return this._noController()
        const result = stateController.dispatchAction(action, payload)
        return result.ok
            ? ok(okMessage)
            : err(result.message ?? failFallback)
    }

    async attack(args = {}) {
        const { slot, entityId } = args
        if (!slot || slot < 1 || slot > 36) {
            return err("slot (1-36) required.")
        }
        if (entityId === undefined || entityId === null) {
            return err("entityId required — pick one from the Hostile/Passive Mobs list.")
        }
        Logger.info(`attack slot:${slot} target:${entityId}`, "MINECRAFT")
        return this._simpleDispatch('attack', { slot, entityId }, "Engaging target.", "Attack failed.")
    }

    async eat(args = {}) {
        const { slot } = args
        Logger.info(`Lily ate slot number ${slot ? ` ${slot}` : ''}`, "MINECRAFT")
        return this._simpleDispatch('use', { slot }, "Ate.", "Eat failed.")
    }

    async swapSlot(args = {}) {
        const { slot } = args
        if (!slot || slot < 1 || slot > 36) {
            return err("slot (1-36) required.")
        }
        Logger.info(`Lily swapped to slot number ${slot}`, "MINECRAFT")
        return this._simpleDispatch('swap_slot', { slot }, `Swapped to slot ${slot}.`, "Swap failed.")
    }

    async drop(args = {}) {
        const { slot, amount } = args
        if (!slot || slot < 1 || slot > 36) {
            return err("slot (1-36) required.")
        }
        const count = Number.isInteger(amount) && amount > 0 ? amount : 1
        const MAX_DROPS_PER_CALL = 64

        if (count > MAX_DROPS_PER_CALL) {
            return err(`Can't drop more than ${MAX_DROPS_PER_CALL} at once.`)
        }

        Logger.info(`Lily has dropped the item in slot ${slot} ${count} time(s)`, "MINECRAFT")
        const stateController = this.getStateController?.()
        if (!stateController) return this._noController()

        for (let i = 0; i < count; i++) {
            const result = stateController.dispatchAction('drop', { slot })
            if (!result.ok) {
                return err(result.message ?? `Drop failed after ${i} of ${count} item(s).`)
            }
            if (i < count - 1) {
                await new Promise(resolve => setTimeout(resolve, 250))
            }
        }

        return ok(`Dropped ${count} item(s) from slot ${slot}.`)
    }

    async follow(args = {}) {
        const { player } = args
        if (!player) {
            return err("player name required.")
        }
        Logger.info(`Lily is now following ${player}`, "MINECRAFT")
        return this._simpleDispatch('follow', { player }, `Following ${player}.`, "Follow failed.")
    }

    async retreat(args = {}) {
        const { player } = args
        Logger.info(`Lily is retreating towards ${player ? ` → ${player}` : ''}`, "MINECRAFT")
        return this._simpleDispatch('retreat', { player }, "Retreating.", "Retreat failed.")
    }

    async stop() {
        Logger.info(`Lily stopping`, "MINECRAFT")
        return this._simpleDispatch('stop', {}, "Stopped.", "Stop failed.")
    }

    async break_(args = {}) {
        const requests = Array.isArray(args.blocks) && args.blocks.length > 0
            ? args.blocks
            : [args]

        const now = Date.now()
        if (now - this.lastMineTime < 9000) {
            return JSON.stringify({ status: "cooldown", message: "Mining too fast! Wait a moment." })
        }
        this.lastMineTime = now

        const stateController = this.getStateController?.()
        if (!stateController) return this._noController()

        const MAX_AMOUNT = 32
        const summaries = []

        for (const req of requests) {
            const { x, y, z, block, radius } = req
            const hasCoords = x !== undefined && y !== undefined && z !== undefined
            const hasBlock = typeof block === "string" && block.trim().length > 0

            if (!hasCoords && !hasBlock) {
                summaries.push("skipped one entry — no x/y/z or block name given")
                continue
            }

            const amount = Number.isInteger(req.amount) && req.amount > 0
                ? Math.min(req.amount, MAX_AMOUNT)
                : 1

            const label = hasCoords ? `(${x}, ${y}, ${z})` : `"${block}"${radius ? ` radius:${radius}` : ''}`
            Logger.info(`Lily is breaking the block at ${label} x${amount}`, "MINECRAFT")

            const payload = hasCoords ? { x, y, z, amount } : { block, radius, amount }
            const result = stateController.dispatchAction('break', payload)

            summaries.push(result.ok
                ? `${amount > 1 ? `${amount}x ` : ''}${block ?? label}`
                : `${block ?? label} failed: ${result.message ?? 'unknown error'}`)

            if (requests.indexOf(req) < requests.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1500))
            }
        }

        return ok(`Started mining: ${summaries.join(', ')}.`)
    }

    async craft(args = {}) {
        const { item, quantity } = args
        if (typeof item !== "string" || !item.trim()) {
            return err("item required, in item_name format (e.g. 'iron_sword').")
        }
        const itemId = item.trim().toLowerCase().replace(/^minecraft:/, '')
        const amount = Number.isInteger(quantity) && quantity > 0 ? Math.min(quantity, 64) : 1

        Logger.info(`Lily is crafting ${itemId} x${amount}`, "MINECRAFT")
        const stateController = this.getStateController?.()
        if (!stateController) return this._noController()

        const result = await stateController.craftItem(itemId, amount)
        if (!result.ok) {
            Logger.error(result.message ?? "Crafting failed.", "MINECRAFT")
        }
        return result.ok
            ? ok(result.message ?? `Crafted ${amount}x ${itemId}.`)
            : err(result.message ?? "Crafting failed.")
    }

    async execute(name, args) {
        switch (name) {
            case "minecraft_action_attack": return this.attack(args)
            case "minecraft_action_eat": return this.eat(args)
            case "minecraft_action_swap_slot": return this.swapSlot(args)
            case "minecraft_action_drop": return this.drop(args)
            case "minecraft_action_follow": return this.follow(args)
            case "minecraft_action_retreat": return this.retreat(args)
            case "minecraft_action_stop": return this.stop()
            case "minecraft_action_break": return this.break_(args)
            case "minecraft_action_craft": return this.craft(args)
            default:
                Logger.warning(`Unknown: ${name}`, "TOOL")
                return err(`Unknown tool: ${name}`)
        }
    }
}

// ─── Tool Definitions ───────────────────────────────────────────────────

const MINECRAFT_TOOLS = [
    {
        type: "function",
        function: {
            name: "minecraft_action_attack",
            description: "Attack a specific mob by its id, using a SWORD or AXE from your inventory. Requires slot (1-36, must hold a weapon: sword/axe/trident) and entityId (from Hostile/Passive Mobs list). If no weapon in inventory, don't call this, and explain why in chat. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 36, description: "Inventory slot (1-36) holding a SWORD or AXE." },
                    entityId: { type: "number", description: "Exact id of the mob to attack." }
                },
                required: ["slot", "entityId"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_eat",
            description: "Eat the food item currently held, or swap to a slot first and eat that. Completes instantly. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 36, description: "Optional hotbar slot holding food to swap to first. Omit to eat whatever's held." }
                },
                required: [ "slot" ]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_swap_slot",
            description: "Switch your held hotbar slot without using or dropping anything. Requires slot (1-36). Completes instantly. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 36, description: "Hotbar slot to switch to." }
                },
                required: ["slot"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_drop",
            description: "Drop item(s) from a hotbar slot. If no amount given, use 1. Completes instantly. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    slot: { type: "number", minimum: 1, maximum: 36, description: "Hotbar slot to drop from." },
                    amount: { type: "number", minimum: 1, maximum: 64, description: "How many to drop. Default 1 if unspecified." }
                },
                required: ["slot", "amount"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_follow",
            description: "Follow a player continuously until told to stop. Use for any phrasing meaning 'come with/to me' (follow me, come here, stick with me, walk with me). Runs on its own once called — no need to call again while it continues; only a new follow request calls it again. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: { player: { type: "string", description: "Exact name of the player to follow." } },
                required: ["player"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_retreat",
            description: "Flee toward a player for safety. Optional player name — defaults to usual companion if omitted. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: { player: { type: "string", description: "Optional player to retreat toward." } },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_stop",
            description: "Stop all current actions (attacking, following, moving, mining) and stay in place. Once called, idle is the finished state — don't call again just because you're still shown idle later. Reply naturally after; never mention the tool.",
            parameters: { type: "object", properties: {}, required: [] }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_break",
            description: "Mine blocks. For a block type, pass x/y/z + amount directly. For MULTIPLE distinct block types in one request (e.g. 'acacia AND oak logs'), pass a `blocks` array instead — one entry per type — so it's ONE call, not one per type. Runs on its own after calling; don't call again for the same request. CRITICAL — amount: if the player states or implies a quantity, that exact number MUST go in `amount`. Examples: 'get me 10 oak logs' -> amount:10. 'mine 5 stone' -> amount:5. 'get some wood'/'a few logs' (no number given) -> amount:5. 'get wood' (bare, no quantity language at all) -> amount:8. NEVER default to amount:1 unless the player explicitly says one/a single/just one. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate. Omit if using `blocks` or `block`." },
                    y: { type: "number" },
                    z: { type: "number" },
                    block: { type: "string", description: "Block name, alternative to x/y/z." },
                    radius: { type: "number" },
                    amount: { type: "number", minimum: 1, maximum: 32, description: "How many blocks to mine. Extract the exact number from the player's request if one is given — do not default to 1. See tool description for defaults when no number is stated." },
                    blocks: {
                        type: "array",
                        description: "Use for multiple distinct block types in one request. Each entry is the same shape as the flat args (x/y/z or block, plus amount, following the same amount-extraction rule).",
                        items: {
                            type: "object",
                            properties: {
                                x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
                                block: { type: "string" }, radius: { type: "number" },
                                amount: { type: "number", minimum: 1, maximum: 32 }
                            }
                        }
                    }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "minecraft_action_craft",
            description: "Craft an item. item is REQUIRED and MUST be the plain Minecraft item id in item_name format — lowercase, underscores, NO 'minecraft:' prefix (that gets added automatically on the Java side). Examples: to craft an iron sword pass item: \"iron_sword\"; iron chestplate → item: \"iron_chestplate\"; sticks → item: \"stick\"; a crafting table itself → item: \"crafting_table\". quantity is optional (default 1) and means how many of the FINISHED item to craft, not ingredient count. This call waits for the actual result — if it succeeds you'll be told what was made, if it fails you'll be told exactly why (missing ingredients, not enough of an ingredient, no crafting table nearby, etc) so you can tell the player what's wrong. Reply naturally after; never mention the tool.",
            parameters: {
                type: "object",
                properties: {
                    item: { type: "string", description: "Item id in item_name format, e.g. 'iron_sword', 'iron_chestplate', 'stick', 'crafting_table'. Required, never empty, never prefixed with 'minecraft:'." },
                    quantity: { type: "number", minimum: 1, maximum: 64, description: "How many of the finished item to craft. Default 1 if unspecified." }
                },
                required: ["item"]
            }
        }
    },
]

const MINECRAFT_TOOL_NAMES = new Set(MINECRAFT_TOOLS.map(t => t.function.name))

export { MinecraftToolExecutor, MINECRAFT_TOOLS, MINECRAFT_TOOL_NAMES }