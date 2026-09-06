import WebSocket from 'ws'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Logger } from '../utils/Logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOKEN_FILE = path.join(__dirname, 'vts_token.json')

// ─── VTube Studio Client ─────────────────────────────────────────────────
//
// A persistent, authenticated connection to the VTube Studio API.
// Instantiated and connected once in start.js, then handed to
// VtubeToolExecutor which calls listHotkeys() / triggerHotkeyID().
export class VTSClient {
    constructor({ host = 'localhost', port = 8001, pluginName = 'LilyVTS', pluginDev = 'Izan' } = {}) {
        this.host = host
        this.port = port
        this.pluginName = pluginName
        this.pluginDev = pluginDev
        this.ws = null
    }

    _send(payload) {
        return new Promise((resolve, reject) => {
            const requestID = payload.requestID || Math.random().toString(36).slice(2)
            payload.requestID = requestID
            const handler = (data) => {
                const msg = JSON.parse(data)
                if (msg.requestID === requestID) {
                    this.ws.off('message', handler)
                    if (msg.messageType === 'APIError') reject(new Error(msg.data.message))
                    else resolve(msg)
                }
            }
            this.ws.on('message', handler)
            this.ws.send(JSON.stringify(payload))
        })
    }

    async _authenticate() {
        let token
        if (fs.existsSync(TOKEN_FILE)) {
            token = JSON.parse(fs.readFileSync(TOKEN_FILE)).token
        } else {
            const req = await this._send({
                apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', messageType: 'AuthenticationTokenRequest',
                data: { pluginName: this.pluginName, pluginDeveloper: this.pluginDev }
            })
            token = req.data.authenticationToken
            fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }))
            Logger.info('New VTS token requested - approve the popup inside VTube Studio', "VTUBE")
        }

        const auth = await this._send({
            apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', messageType: 'AuthenticationRequest',
            data: { pluginName: this.pluginName, pluginDeveloper: this.pluginDev, authenticationToken: token }
        })

        if (!auth.data.authenticated) {
            fs.unlinkSync(TOKEN_FILE)
            throw new Error('VTS token rejected, deleted it - reconnect to request a fresh one')
        }
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`ws://${this.host}:${this.port}`)

            const onConnectError = (err) => {
                reject(new Error(`Could not connect to VTube Studio - is it running with the API enabled? (Settings > Start API) (${err.message})`))
            }
            this.ws.once('error', onConnectError)

            this.ws.once('open', async () => {
                try {
                    await this._authenticate()
                    this.ws.off('error', onConnectError)
                    // Keep a persistent handler so a later drop/error doesn't
                    // crash the process with an unhandled 'error' event.
                    this.ws.on('error', (err) => Logger.error(`VTS connection error: ${err.message}`, "VTUBE"))
                    resolve()
                } catch (e) {
                    reject(e)
                }
            })
        })
    }
 async listHotkeys() {
        const res = await this._send({
            apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', messageType: 'HotkeysInCurrentModelRequest', data: {}
        })
        return res.data.availableHotkeys ?? []
    }

    async triggerHotkeyID(hotkeyID) {
        await this._send({
            apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', messageType: 'HotkeyTriggerRequest',
            data: { hotkeyID }
        })
    }

    async disconnect() {
        this.ws?.close()
        this.ws = null
    }
}