export class MovementHelper {
  constructor(mcSend) {
    this.mcSend = mcSend
    this.movingToTarget = false
    this.lastTarget = null
    this.RETARGET_DIST = 0.75  // cheap now, so retarget much more often
  }

  moveToward(from, to) {
    if (!from || !to) return

    if (this.movingToTarget && this.lastTarget) {
      const shifted = Math.hypot(to.x - this.lastTarget.x, to.z - this.lastTarget.z)
      if (shifted < this.RETARGET_DIST) return
      this.mcSend('update_target', { x: to.x, z: to.z })  // cheap, no state reset server-side
      this.lastTarget = { x: to.x, z: to.z }
      return
    }

    this.mcSend('move_to', { x: to.x, z: to.z })  // full start, only for a brand-new engage
    this.movingToTarget = true
    this.lastTarget = { x: to.x, z: to.z }
  }

  stop() {
    if (this.movingToTarget) {
      this.mcSend('stop')
      this.movingToTarget = false
      this.lastTarget = null
    }
  }
}