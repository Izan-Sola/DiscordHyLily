// Mining state manages breaking blocks
// Tracks whether mining has started and handles transitions
export class MiningState {
    constructor(ctx) {
        this.ctx = ctx
    }

    onEnter({ payload = null } = {}) {
        this.payload = payload
        this.started = false
        this.expectedAmount = payload?.amount || 1
        this.brokenCount = 0
    }

    onExit() {
        if (this.started) this.ctx.mcSend('cancel_break')
        this.payload = null
        this.started = false
    }

    async onTick() {
        const { ctx } = this

        if (!this.payload) {
            ctx.transitionTo('IDLE')
            return
        }

        if (!this.started) {
            this.started = true
            ctx.mcSend('break', this.payload)
            console.log('[MINING] Sent break command:', JSON.stringify(this.payload))
        }
    }

    onMiningStarted() {
        // placeholder
    }

    onBlockBroken(event) {
        console.log('[MINING] Received block_broken event:', JSON.stringify(event))

        if (!this.started) {
            console.log('[MINING] Ignoring event – mining not started')
            return
        }

        // If the event indicates chaining, stay in MINING
        if (event.done === false && event.nextX != null) {
            console.log('[MINING] Chaining to next block – staying in MINING')
            return
        }

        // If done is true, we're finished
        if (event.done === true) {
            console.log('[MINING] Mining complete – transitioning to IDLE')
            this.started = false
            this.payload = null
            this.ctx.transitionTo('IDLE')
            return
        }

        // If done is missing or malformed, log and stay (safety)
        console.warn('[MINING] Unexpected event – done=' + event.done + ', nextX=' + event.nextX)
        // If we have a nextX but done is not false, we still try to stay
        if (event.nextX != null) {
            console.log('[MINING] nextX present but done not false – staying')
            return
        }

        // Fallback: if done is false but nextX is null, treat as done (shouldn't happen)
        this.started = false
        this.payload = null
        this.ctx.transitionTo('FOLLOWING')
    }
}