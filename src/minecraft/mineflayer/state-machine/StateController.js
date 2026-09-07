import { IdleState } from './states/IdleState.js'
import { FollowingState } from './states/FollowingState.js'
import { AttackingState } from './states/AttackingState.js'
import { RecoveringState } from './states/RecoveringState.js'
import { MiningState } from './states/MiningState.js'
import { SneakHelper } from './helpers/sneak.js'
import { MovementHelper } from './helpers/movement.js'
import { mcWhisper } from './helpers/whisper.js'
import { Logger } from '../../../utils/Logger.js'

export const State = {
    IDLE: 'IDLE',
    FOLLOWING: 'FOLLOWING',
    ATTACKING: 'ATTACKING',
    RECOVERING: 'RECOVERING',
    MINING: 'MINING'
    // Note: no DUELING/bending here — that system (comboExecutor, duelPromptBuilder,
    // PKCombosData) was built entirely around ProjectKorra, which only exists in the
    // modded NeoForge world. A cracked plugin server has no equivalent, so it's
    // dropped rather than faked. If the target server runs a PvP/duel plugin with
    // its own ability set, that would need its own state built from scratch.
}

const BLOCKS_OF_INTEREST = [
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
    'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore',
    'gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
    'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore', 'ancient_debris',
    'wheat', 'carrots', 'potatoes', 'beetroots', 'melon', 'pumpkin', 'sugar_cane'
]
const BLOCK_SCAN_INTERVAL_MS = 4000

const HOSTILE_MOB_NAMES = new Set([
    'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray',
    'wither_skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
    'witch', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator',
    'evoker', 'vex', 'ravager', 'silverfish', 'endermite', 'blaze',
    'ghast', 'hoglin', 'zoglin', 'piglin_brute', 'shulker', 'guardian',
    'elder_guardian', 'warden'
])

export class StateController {
    constructor(bot, opts = {}) {
        this.bot = bot
        this.opts = {
            followTarget: null,
            followDistance: 3,
            attackRange: 4,
            lowHpThreshold: 10,
            tickMs: 150,
            ...opts
        }
        this.lastUserMessage = null
        this.environmentInfo = {}
        // Shared data (kept as plain objects/names so prompt-builders written
        // against the old shape mostly work unchanged)
        this.players = {}
        this.lilyPos = null
        this.lilyHp = 20
        this.lilyHunger = 20
        this.lilyArmor = 0
        this.hostiles = []
        this.passives = []
        this.blocksOfInterest = []
        this.inventoryItems = {}
        this.chatHistory = []

        // Helpers
        this.sneak = new SneakHelper(bot)
        this.move = new MovementHelper(bot)

        // States
        this.states = {
            [State.IDLE]: new IdleState(this),
            [State.FOLLOWING]: new FollowingState(this),
            [State.ATTACKING]: new AttackingState(this),
            [State.RECOVERING]: new RecoveringState(this),
            [State.MINING]: new MiningState(this)
        }

        this.currentStateName = State.IDLE
        this.currentState = this.states[State.IDLE]
        this.tickInterval = null
        this._lastBlockScan = 0
    }

    start() {
        if (this.tickInterval) return
        Logger.info('Controller started', "STATE")
        this.tickInterval = setInterval(() => this._tick(), this.opts.tickMs)
    }

    stop() {
        clearInterval(this.tickInterval)
        this.tickInterval = null
        this.sneak.cancelHold()
        this.sneak.setSneaking(false)
        this.move.stop()
        this.transitionTo(State.IDLE)
        Logger.info('Controller stopped', "STATE")
    }

    transitionTo(stateName, payload = {}) {
        if (this.currentStateName === stateName) {
            if (this.currentState?.onEnter) this.currentState.onEnter(payload)
            return
        }
        const oldName = this.currentStateName
        const newState = this.states[stateName]
        if (!newState) {
            Logger.error(`Unknown state: ${stateName}`, "STATE")
            return
        }
        if (this.currentState?.onExit) this.currentState.onExit()
        this.currentStateName = stateName
        this.currentState = newState
        if (this.currentState?.onEnter) this.currentState.onEnter(payload)
        Logger.info(`➡️ ${oldName} → ${stateName}${payload?.player ? ` (${payload.player})` : ''}`, "STATE")
    }

    // ── Actions (mirrors StateController.dispatchAction from the mod version) ──
    dispatchAction(action, args = {}) {
        switch (action) {
            case 'follow':
                if (!args.player) return { ok: false, message: 'follow needs a player name.' }
                this.setFollowTarget(args.player)
                this.transitionTo(State.FOLLOWING)
                return { ok: true }

            case 'break': {
                const hasCoords = args.x != null && args.y != null && args.z != null
                const hasBlock = typeof args.block === 'string' && args.block.trim().length > 0
                if (!hasCoords && !hasBlock) {
                    return { ok: false, message: 'break needs either x/y/z or a block name.' }
                }
                const amount = Math.max(1, Math.min(32, args.amount ?? 1))
                this.transitionTo(State.MINING, hasCoords
                    ? { x: args.x, y: args.y, z: args.z, amount }
                    : { block: args.block, radius: args.radius, amount })
                return { ok: true }
            }

            case 'attack': {
                if (args.entityId == null) return { ok: false, message: 'attack needs an entityId to target.' }
                const target = this.findEntityById(args.entityId)
                if (!target) return { ok: false, message: 'That entity is no longer nearby.' }
                if (args.slot != null) this._equipSlot(args.slot)
                this.transitionTo(State.ATTACKING, { entityId: args.entityId })
                return { ok: true }
            }

            case 'retreat':
                if (args.player) this.setFollowTarget(args.player)
                this.transitionTo(State.RECOVERING, { explicit: true })
                return { ok: true }

            case 'stop':
                this.transitionTo(State.IDLE)
                return { ok: true }

            case 'move_to':
                if (args.x == null || args.z == null) return { ok: false, message: 'move_to needs x and z.' }
                this.move.moveToward(this.lilyPos, { x: args.x, y: args.y ?? this.lilyPos?.y ?? 64, z: args.z })
                return { ok: true }

            case 'use': {
                const item = this.bot.heldItem
                if (item) this.bot.activateItem()
                return { ok: true }
            }

            case 'swap_slot':
            case 'equip_slot': {
                if (args.slot == null) return { ok: false, message: 'needs a slot number.' }
                this._equipSlot(args.slot)
                return { ok: true }
            }

            case 'drop': {
                if (args.slot == null) return { ok: false, message: 'drop needs a slot number.' }
                const item = this.bot.inventory.slots[args.slot]
                if (item) this.bot.tossStack(item)
                return { ok: true }
            }

            case 'chat':
                if (!args.message) return { ok: false, message: 'chat needs a message.' }
                this.mcChat(args.message)
                return { ok: true }

            default:
                return { ok: false, message: `Unknown action: ${action}` }
        }
    }

    _equipSlot(slot) {
        const item = this.bot.inventory.slots[slot]
        if (item) this.bot.equip(item, 'hand').catch(() => {})
    }

    // ── Chat / whisper ──────────────────────────────────────────────────────
    // Public chat, split into <=250 char chunks like the original mcChat.
    mcChat(message) {
        this._splitMessage(message).forEach(chunk => this.bot.chat(chunk))
    }

    // Private reply via /msg — used when the incoming message was a whisper,
    // so Lily doesn't spam the public channel replying to a DM.
    mcWhisper(username, message) {
        mcWhisper(this.bot, username, message)
    }

    setLastUserMessage(player, message, channel = 'public') {
        this.lastUserMessage = { player, message, channel, timestamp: Date.now() }
    }

    // ── Queries used by states / prompt builders ────────────────────────────
    getPlayerByName(name) { return this.players[name] ?? null }

    getFollowTarget() { return this.players[this.opts.followTarget] ?? null }

    getFollowTargetEntity() {
        if (!this.opts.followTarget) return null
        const p = this.bot.players[this.opts.followTarget]
        return p?.entity ?? null
    }

    findEntityById(id) {
        return this.bot.entities[id] ?? null
    }

    nearestHostile() {
        if (!this.lilyPos || !this.hostiles.length) return null
        let nearest = null
        let nearestDist = this.opts.attackRange
        for (const h of this.hostiles) {
            const d = this._dist(this.lilyPos, h.position)
            if (d < nearestDist) { nearest = h; nearestDist = d }
        }
        return nearest
    }

    nearestHostileWithin(maxDist) {
        if (!this.lilyPos || !this.hostiles.length) return null
        let nearest = null
        let nearestDist = maxDist
        for (const h of this.hostiles) {
            const d = this._dist(this.lilyPos, h.position)
            if (d < nearestDist) { nearest = h; nearestDist = d }
        }
        return nearest
    }

    setFollowTarget(name) {
        this.opts.followTarget = name
        Logger.info(`Follow target → ${name}`, "STATE")
    }

    getStatus() {
        return {
            state: this.currentStateName,
            lilyHp: this.lilyHp,
            lilyPos: this.lilyPos,
            players: Object.keys(this.players),
            hostiles: this.hostiles.length,
            isSneaking: this.sneak.isSneaking
        }
    }

    _dist(a, b) {
        if (!a || !b) return Infinity
        return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    }

    // ── Per-tick world-state refresh + delegate to active state ─────────────
    _tick() {
        this._refreshWorldState()
        if (!this.lilyPos) return
        if (this.currentState?.onTick) this.currentState.onTick()
    }

    _refreshWorldState() {
        const bot = this.bot
        if (!bot.entity) return

        this.lilyPos = bot.entity.position
        this.lilyHp = bot.health ?? 20
        this.lilyHunger = bot.food ?? 20

        // Players (exclude self)
        const players = {}
        for (const [name, p] of Object.entries(bot.players)) {
            if (name === bot.username) continue
            if (!p.entity) continue
            players[name] = {
                x: p.entity.position.x, y: p.entity.position.y, z: p.entity.position.z,
                hp: p.entity.health ?? 20
            }
        }
        this.players = players

        // Hostiles / passives from tracked entities
        const hostiles = []
        const passives = []
        for (const e of Object.values(bot.entities)) {
            if (e.type !== 'mob' && e.type !== 'hostile' && e.kind !== 'Hostile mobs') continue
            if (!e.position || e === bot.entity) continue
            const name = (e.name || e.mobType || '').toLowerCase()
            if (HOSTILE_MOB_NAMES.has(name)) hostiles.push(e)
            else passives.push(e)
        }
        this.hostiles = hostiles
        this.passives = passives

        // Inventory
        const inv = {}
        for (const item of bot.inventory.items()) {
            inv[item.slot] = `${item.name} x${item.count}`
        }
        this.inventoryItems = inv

        // Nearby blocks worth mining — scanned less often, it's a relatively
        // expensive chunk-column search compared to everything else above.
        const now = Date.now()
        if (now - this._lastBlockScan > BLOCK_SCAN_INTERVAL_MS) {
            this._lastBlockScan = now
            try {
                const positions = bot.findBlocks({
                    matching: (block) => BLOCKS_OF_INTEREST.includes(block.name),
                    maxDistance: 24,
                    count: 20
                })
                this.blocksOfInterest = positions.map(pos => {
                    const b = bot.blockAt(pos)
                    return { x: pos.x, y: pos.y, z: pos.z, block: b?.name ?? 'unknown' }
                })
            } catch {
                // findBlocks can throw if chunks aren't loaded yet — just skip this pass
            }
        }

        // Environment
        this.environmentInfo = {
            biome: bot.world?.getBiome
                ? undefined // biome lookup varies by version; wire up via mineflayer-biome or similar if needed
                : undefined,
            time_of_day: this._timeOfDayLabel(bot.time?.timeOfDay ?? 0),
            is_raining: !!bot.isRaining,
            is_thundering: bot.thunderState > 0,
            can_see_sky: bot.entity.position ? bot.blockAt(bot.entity.position.offset(0, 2, 0))?.skyLight > 8 : undefined
        }
    }
    _splitMessage(message, maxLen = 250) {
        const text = String(message ?? '').trim()
        if (!text) return []
        const chunks = []
        for (let i = 0; i < text.length; i += maxLen) {
            chunks.push(text.slice(i, i + maxLen))
        }
        return chunks
    }
    _timeOfDayLabel(t) {
        // vanilla ticks: 0=dawn, 6000=noon, 12000=dusk, 18000=midnight
        if (t < 1000) return 'dawn'
        if (t < 6000) return 'morning'
        if (t < 12000) return 'afternoon'
        if (t < 13000) return 'dusk'
        if (t < 18000) return 'night'
        if (t < 22000) return 'midnight'
        return 'predawn'
    }
}
