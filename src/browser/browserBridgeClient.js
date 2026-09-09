import WebSocket from 'ws'
import { Logger } from '../utils/Logger.js'

const DEFAULT_URL = process.env.BROWSER_BRIDGE_URL || 'ws://localhost:9334'
const ACTION_TIMEOUT_MS = 15000
const RECONNECT_DELAY_MS = 3000

// Talks the open-browser-control standalone bridge protocol:
// out -> {"type":"action","action":"navigate","id":"1","params":{"url":"..."}}
// in  <- assumed {"id":"1","result":...} or {"id":"1","error":"..."} -
// the extension's bridge-server source wasn't available to confirm this,
// so if actions time out instead of resolving, log raw `message` payloads
// here first to check the real response shape.
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
                let msg
                try {
                    msg = JSON.parse(raw.toString())
                } catch {
                    return
                }
                const pending = this._pending.get(msg.id)
                if (!pending) return
                this._pending.delete(msg.id)
                clearTimeout(pending.timer)
                if (msg.error) pending.reject(new Error(msg.error))
                else pending.resolve(msg.result ?? msg)
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
                if (!this.connected) resolve(this) // don't hang startup forever if the first attempt fails
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