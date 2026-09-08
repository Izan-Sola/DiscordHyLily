import { IdleState } from './states/IdleState.js'
import { FollowingState } from './states/FollowingState.js'
import { AttackingState } from './states/AttackingState.js'
import { RecoveringState } from './states/RecoveringState.js'
import { DuelingState } from './states/DuelingState.js'
import { SneakHelper } from './helpers/sneak.js'
import { MovementHelper } from './helpers/movement.js'
import { MiningState } from './states/MiningState.js'
import { Logger } from '../../../utils/Logger.js'

export const State = {
    IDLE: 'IDLE',
    FOLLOWING: 'FOLLOWING',
    ATTACKING: 'ATTACKING',
    RECOVERING: 'RECOVERING',
    DUELING: 'DUELING',
    MINING: 'MINING'
}

export class StateController {
    constructor(mcSend, opts = {}) {
        this.mcSend = mcSend
        this.opts = {
            followTarget: 'shinyshadow_',
            followDistance: 3,
            attackRange: 4,
            lowHpThreshold: 10,
            tickMs: 25,
            ...opts
        }
        this.lastUserMessage = null
        this.environmentInfo = {}
        // Shared data
        this.players = {}
        this.lilyPos = null
        this.lilyHp = 20
        this.lilyHunger = 20
        this.lilyArmor = 0
        this.hostiles = []
        this.passives = []
        this.blocksOfInterest = []
        this.duelTarget = null
        this.ai = opts.ai
        // Ability tracking
        this.bindings = {}   // slot -> raw ability name
        this.abilityCooldowns = {}   // ability name -> expiry timestamp (ms)
        this.abilityStats = {}   // ability name -> { range, cooldown, actions, actionTimes, description }
        this.currentElement = ""
        // Helpers
        this.sneak = new SneakHelper(mcSend)
        this.move = new MovementHelper(mcSend)

        // States
        this.states = {
            [State.IDLE]: new IdleState(this),
            [State.FOLLOWING]: new FollowingState(this),
            [State.ATTACKING]: new AttackingState(this),
            [State.RECOVERING]: new RecoveringState(this),
            [State.DUELING]: new DuelingState(this),
            [State.MINING]: new MiningState(this)
        }
        this._pendingCrafts = new Map()
        this.currentStateName = State.IDLE
        this.currentState = this.states[State.IDLE]
        this.tickInterval = null
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
    craftItem(item, amount) {
        return new Promise((resolve) => {
            const requestId = `craft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            const timeout = setTimeout(() => {
                this._pendingCrafts.delete(requestId)
                resolve({ ok: false, message: 'Crafting timed out — no response from the game.' })
            }, 20000) // generous: may include a walk to a crafting table

            this._pendingCrafts.set(requestId, { resolve, timeout })
            this.mcSend('craft', { requestId, item, amount })
        })
    }

    // Called by the WS message dispatcher when a 'craft_result' message arrives.
    handleCraftResult(msg) {
        const pending = this._pendingCrafts.get(msg.requestId)
        if (!pending) return // stale/unknown/duplicate — ignore
        clearTimeout(pending.timeout)
        this._pendingCrafts.delete(msg.requestId)
        pending.resolve({ ok: msg.status === 'ok', message: msg.message })
    }
    transitionTo(stateName, payload = {}) {
        if (this.currentStateName === stateName) {
            // Already in this state — let it re-enter with fresh payload instead
            // of no-op'ing, so e.g. "follow Bob" while already following Alice
            // actually retargets instead of being silently ignored.
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

    getPlayerByName(name) {
        return this.players[name] ?? null
    }
    setLastUserMessage(player, message) {
        this.lastUserMessage = { player, message, timestamp: Date.now() }
    }
    _findBlockType({ x, y, z }) {
        const match = this.blocksOfInterest?.find(b => b.x === x && b.y === y && b.z === z)
        return match?.type ?? null
    }



    nearestHostileWithin(maxDist) {
        if (!this.lilyPos || !this.hostiles.length) return null
        let nearest = null
        let nearestDist = maxDist
        for (const h of this.hostiles) {
            const d = this._dist(this.lilyPos, h)
            if (d < nearestDist) { nearest = h; nearestDist = d }
        }
        return nearest
    }

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
                this.transitionTo(State.MINING, {
                    payload: hasCoords
                        ? { x: args.x, y: args.y, z: args.z, amount }
                        : { block: args.block, radius: args.radius, amount }
                })
                return { ok: true }
            }
            case 'break_closest_generic': {
                if (!args.block) return { ok: false, message: 'break_closest_generic needs a block name.' }
                this.mcSend('break_closest_generic', { block: args.block, radius: args.radius })
                return { ok: true }
            }
            case 'attack': {
                if (!args.slot) return { ok: false, message: 'attack needs a weapon slot.' }
                if (args.entityId == null) return { ok: false, message: 'attack needs an entityId to target.' }
                const target = this.findEntityById(args.entityId)
                if (!target) return { ok: false, message: 'That entity is no longer nearby.' }
                this.mcSend('hotbar', { slot: args.slot })
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
                this.mcSend('move_to', { x: args.x, z: args.z })
                return { ok: true }

            case 'use': {
                if (args.slot) {
                    this.mcSend('use', { mode: 'once', slot: args.slot });
                } else {
                    this.mcSend('use', { mode: 'once' });
                }
                return { ok: true };
            }

            case 'hotbar': {
                if (!args.slot) return { ok: false, message: 'hotbar needs a slot number.' };
                this.mcSend('hotbar', { slot: args.slot });
                return { ok: true };
            }

            case 'drop': {
                if (!args.slot) return { ok: false, message: 'drop needs a slot number.' };
                this.mcSend('drop', { slot: args.slot });
                return { ok: true };
            }
            default:
                return { ok: false, message: `Unknown action: ${action}` }
        }
    }

    updatePlayers(players) { this.players = players }
    updateLilyState(pos, hp, hunger) {
        this.lilyPos = pos
        this.lilyHp = hp
        if (hunger != null) this.lilyHunger = hunger
    }
    updateHostiles(hostiles) { this.hostiles = hostiles }

    setDuelTarget(targetName) {
        if (!targetName || targetName === '') {
            if (this.duelTarget) {
                this.duelTarget = null
                if (this.currentStateName === State.DUELING) this.transitionTo(State.IDLE)
                Logger.info('Duel ended', "DUEL")
                this.mcSend('unsprint', {})
            }
            return
        }
        this.duelTarget = targetName
        this.transitionTo(State.DUELING)
        Logger.info(`Now dueling ${targetName}`, "DUEL")
        this.mcSend('get_bindings')
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

    bindAbility(slot, abilityName) {
        this.bindings[slot] = abilityName
    }

    setAbilityCooldown(abilityName, durationMs) {
        this.abilityCooldowns[abilityName] = Date.now() + durationMs
    }

    updateAbilityStats(statsMap) {
        this.abilityStats = statsMap
        Logger.info(`Updated ability stats for ${Object.keys(statsMap).length} abilities`, "STATS")
    }

    getFollowTarget() { return this.players[this.opts.followTarget] ?? null }

    handleSourceBlock(event) {
        if (this.currentStateName === 'DUELING') {
            this.currentState.onSourceBlock(event);
        }
    }

    // Java reports back here once a block it was mining is actually gone (or it
    // gave up on a safety-net timeout) — see MiningManager.finish() on the Java
    // side and MiningState.onBlockBroken() here. Needs wiring into whatever
    // dispatches incoming WS messages, alongside handleSourceBlock above —
    // something like: case 'block_broken': ctx.handleBlockBroken(msg); break
    handleBlockBroken(event) {
        if (this.currentStateName === State.MINING) {
            this.currentState.onBlockBroken(event)
        }
    }
    handleMiningStarted(event) {
        if (this.currentStateName === State.MINING) {
            this.currentState.onMiningStarted(event)
        }
    }
    findEntityById(id) {
        return this.hostiles.find(e => e.id === id)
            ?? this.passives.find(e => e.id === id)
            ?? null
    }
    nearestHostile() {
        if (!this.lilyPos || !this.hostiles.length) return null
        let nearest = null
        let nearestDist = this.opts.attackRange
        for (const h of this.hostiles) {
            const d = this._dist(this.lilyPos, h)
            if (d < nearestDist) { nearest = h; nearestDist = d }
        }
        return nearest
    }

    _dist(a, b) {
        if (!a || !b) return Infinity
        return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    }

    async _tick() {
        this.mcSend('get_players')
        this.mcSend('get_lily_state')
        this.mcSend('get_hostiles', { range: 16 })
        if (!this.lilyPos) return
        if (this.currentState?.onTick) await this.currentState.onTick()
    }
}
/**
 * STATE CONTROLLER
 * ─────────────────────────────────────────────────────────────────────────────
 * Central orchestrator for Lily's in-game behavior. Owns all shared game state,
 * manages state transitions, runs the main tick loop, and provides helper
 * methods used by individual states.
 *
 * ARCHITECTURE:
 *   Each behavior is a separate state class (IdleState, FollowingState, etc.)
 *   The controller delegates onTick() to the current active state every tickMs.
 *   States call back into the controller via this.ctx for shared data and helpers.
 *
 * KEY OPTIONS (opts):
 *   followTarget    → username to follow, default "shinyshadow_"
 *   followDistance  → blocks before following kicks in, default 3
 *   attackRange     → blocks to scan for hostiles, default 4
 *   lowHpThreshold  → HP floor for recovering state, default 6
 *   tickMs          → tick interval in ms, default 25
 *
 * SHARED STATE:
 *   this.players         → { name: { x, y, z, hp } } updated every tick from mod
 *   this.lilyPos         → { x, y, z } Lily's position, null until first updat
 *   this.lilyHp          → Lily's HP 0–20, default 20
 *   this.hostiles        → [{ x, y, z, type, id, hp }] nearby hostile entities
 *   this.duelTarget      → player name being dueled or null
 *   this.bindings        → { slot: rawAbilityName }
 *   this.abilityCooldowns → { abilityName: expiryMs }
 *   this.abilityStats    → { abilityName: { range, cooldown, actions, actionTimes, description } }
 *
 * HELPERS AVAILABLE TO STATES:
 *   this.sneak           → SneakHelper — setSneaking(bool), cancelHold()
 *   this.move            → MovementHelper — moveToward(from, to), stop()
 *   this.mcSend(type, data) → sends WebSocket command to Java mod
 *   this.getFollowTarget()  → returns players[followTarget] or null
 *   this.nearestHostile()   → nearest hostile within attackRange or null
 *   this._dist(a, b)        → Math.hypot distance between two {x,y,z} points
 *   this.transitionTo(name) → triggers onExit → onEnter for state change
 */