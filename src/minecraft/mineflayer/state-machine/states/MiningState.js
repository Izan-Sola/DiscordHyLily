import { Logger } from "../../../../utils/Logger.js"
import { Vec3 } from "vec3"

// Mining state manages breaking blocks.
// payload shape (from StateController.dispatchAction 'break'):
//   { x, y, z, amount }                — a specific known block
//   { block: 'iron_ore', radius, amount } — search-and-break by name
export class MiningState {
    constructor(ctx) {
        this.ctx = ctx
    }

    onEnter(payload = {}) {
        if (this.started && !this.cancelled) {
            Logger.warning('Already mining — ignoring new break request until current dig finishes', "MINE")
            return
        }
        this.payload = payload.payload ?? payload ?? null
        this.started = false
        this.broken = 0
        this.cancelled = false
    }

    onExit() {
        this.cancelled = true
        this.payload = null
        this.started = false
    }

    async onTick() {
        const { ctx } = this
        if (!this.payload || this.started) return
        this.started = true

        const amount = Math.max(1, Math.min(32, this.payload.amount ?? 1))

        try {
            for (let i = 0; i < amount; i++) {
                if (this.cancelled || ctx.currentStateName !== 'MINING') return

                const block = this._resolveNextBlock()
                if (!block) {
                    if (i === 0) Logger.info(`No block found to mine (${this.payload.block ?? 'coords'})`, "MINE")
                    break
                }

                if (!ctx.bot.canDigBlock(block)) break

                await ctx.bot.dig(block)
                this.broken++
                if (this.cancelled || ctx.currentStateName !== 'MINING') return
            }
        } catch (err) {
            Logger.warning(`Mining interrupted: ${err.message}`, "MINE")
        }

        if (!this.cancelled && ctx.currentStateName === 'MINING') {
            ctx.transitionTo('IDLE')
        }
    }

    _resolveNextBlock() {
        const { ctx } = this
        const p = this.payload
        if (p.x != null && p.y != null && p.z != null && this.broken === 0) {
            // Specific coordinate — only used for the first block in the batch,
            // subsequent ones (amount > 1) fall through to name-based search.
            const block = ctx.bot.blockAt(new Vec3(p.x, p.y, p.z))
            if (block && block.name !== 'air') return block
        }
        if (p.block) {
            return ctx.bot.findBlock({
                matching: (b) => b.name === p.block,
                maxDistance: p.radius ?? 32,
            })
        }
        return null
    }
}
