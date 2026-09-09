// src/browser/browserBridgeClient.js
import WebSocket from 'ws'
import { Logger } from '../utils/Logger.js'

const DEFAULT_URL = process.env.BROWSER_BRIDGE_URL || 'ws://localhost:9334'
const ACTION_TIMEOUT_MS = 30000 // increased to 30s for slower actions
const RECONNECT_DELAY_MS = 3000

class BrowserBridgeClient {
    constructor(url = DEFAULT_URL) {
        this.url = url
        this.ws = null
        this.connected = false
        this._pending = new Map()
        this._nextId = 1
        this._closedByUser = false
    }

    connect() {
        this._closedByUser = false
        return new Promise((resolve) => {
            const ws = new WebSocket(this.url)
            this.ws = ws

            ws.on('open', () => {
                this.connected = true
                Logger.success(`Connected to browser bridge (${this.url})`, "BROWSER")
                resolve(this)
            })

            ws.on('message', (raw) => {
                const str = raw.toString()
                // --- LOG THE RAW MESSAGE (critical for debugging) ---
                Logger.info(`[BROWSER RAW] ${str}`, "BROWSER")

                let msg
                try {
                    msg = JSON.parse(str)
                } catch {
                    Logger.warning(`Non-JSON message: ${str}`, "BROWSER")
                    return
                }

                // Try to extract an ID from common fields
                const id = msg.id ?? msg.requestId ?? msg.reqId ?? msg.request_id
                if (!id) {
                    Logger.warning(`Message without ID: ${str}`, "BROWSER")
                    return
                }

                const pending = this._pending.get(String(id))
                if (!pending) {
                    Logger.warning(`No pending request for ID ${id}`, "BROWSER")
                    return
                }

                this._pending.delete(String(id))
                clearTimeout(pending.timer)

                // Handle error, then result/data/success
                if (msg.error) {
                    pending.reject(new Error(msg.error))
                } else {
                    // Try multiple possible result fields
                    const result = msg.result ?? msg.data ?? msg.response ?? msg
                    pending.resolve(result)
                }
            })

            ws.on('close', () => {
                this.connected = false
                for (const { reject, timer } of this._pending.values()) {
                    clearTimeout(timer)
                    reject(new Error('Browser bridge connection closed'))
                }
                this._pending.clear()
                if (!this._closedByUser) {
                    Logger.warning(`Browser bridge connection closed, retrying in ${RECONNECT_DELAY_MS}ms`, "BROWSER")
                    setTimeout(() => this.connect(), RECONNECT_DELAY_MS)
                }
            })

            ws.on('error', (err) => {
                Logger.error(`Browser bridge socket error: ${err.message}`, "BROWSER")
                if (!this.connected) resolve(this) // don't hang startup
            })
        })
    }

    close() {
        this._closedByUser = true
        this.ws?.close()
    }

    send(action, params = {}) {
        if (!this.connected || !this.ws) {
            return Promise.reject(new Error('Browser bridge is not connected'))
        }

        const id = String(this._nextId++)
        const payload = { type: 'action', action, id, params }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(id)
                reject(new Error(`Browser action "${action}" timed out`))
            }, ACTION_TIMEOUT_MS)

            this._pending.set(id, { resolve, reject, timer })
            this.ws.send(JSON.stringify(payload))
        })
    }
}

export { BrowserBridgeClient }