import { Logger } from "../../../../utils/Logger.js"

const ATTACK_RANGE = 2.5
const TICK_MS = 150          // fast enough for responsive look_at/retarget
const ATTACK_COOLDOWN_MS = 625  // matches vanilla sword attack cooldown

export class AttackingState {
  constructor(ctx) {
    this.ctx = ctx
    this.attackInterval = null
    this.targetId = null
    this.lastAttackAt = 0
  }

  onEnter(payload = {}) {
    this.targetId = payload.entityId ?? null
    this.lastAttackAt = 0
    Logger.info(`Engaging ${this.targetId != null ? `target id:${this.targetId}` : 'nearest hostile (autonomous)'}`, "ATTACKING")

    if (this.attackInterval) clearInterval(this.attackInterval)
    this.attackInterval = setInterval(() => this._tick(), TICK_MS)
    this._tick()
  }

  _resolveTarget() {
    if (this.targetId != null) return this.ctx.findEntityById(this.targetId)
    return this.ctx.nearestHostile()
  }

  _tick() {
    if (this.ctx.currentStateName !== 'ATTACKING') return

    const target = this._resolveTarget()
    if (!target) { this.ctx.transitionTo('IDLE'); return }

    this.ctx.mcSend('look_at', { x: target.x, y: target.y + 1, z: target.z })

    // Always let the helper decide whether a new move_to is actually needed
    // (its RETARGET_DIST throttle handles that). Never explicitly stop while
    // still engaged, a hard stop resets Java's movement task and forces a
    // full BFS replan the next time we move, which is the freeze.
    this.ctx.move.moveToward(this.ctx.lilyPos, target)

    const dist = this.ctx._dist(this.ctx.lilyPos, target)
    const now = Date.now()
    if (dist <= ATTACK_RANGE && now - this.lastAttackAt >= ATTACK_COOLDOWN_MS) {
      this.ctx.mcSend('attack', { mode: 'once' })
      this.lastAttackAt = now
    }
  }

  onTick() {
    this._tick()
  }

  onExit() {
    if (this.attackInterval) {
      clearInterval(this.attackInterval)
      this.attackInterval = null
    }
    this.targetId = null
    this.ctx.move.stop()   // only place we actually halt: leaving combat entirely
    Logger.info('Exited', "ATTACKING")
  }
}