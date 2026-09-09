import { spawn } from 'node:child_process'
import { Logger } from '../utils/Logger.js'
import { BrowserBridgeClient } from './browserBridgeClient.js'

// The bridge server logs its "listening" line to stderr with no other
// ready signal, so give it a fixed grace period before dialing in rather
// than parsing stderr for a marker string.
const STARTUP_GRACE_MS = 2000

function spawnBridgeProcess() {
    const child = spawn('npx', ['-y', 'open-browser-control', '--bridge'], {
        stdio: 'pipe',
        env: process.env,
    })

    child.on('exit', (code, signal) => {
        Logger.warning(`Browser control bridge process exited (code ${code}, signal ${signal})`, "BROWSER")
    })
    child.on('error', (err) => {
        Logger.error(`Browser control bridge failed to spawn: ${err.message}`, "BROWSER")
    })
    child.stderr?.on('data', (data) => {
        Logger.error(`Browser bridge stderr: ${data.toString()}`, "BROWSER")
    })

    return child
}

// Spawns the open-browser-control bridge process and connects a client to
// it. Returns { process, client } - process for shutdown/kill, client to
// wire into ToolRouter via ai.setBrowserClient().
async function startBrowserBridge() {
    const proc = spawnBridgeProcess()
    await new Promise(resolve => setTimeout(resolve, STARTUP_GRACE_MS))

    const client = new BrowserBridgeClient()
    await client.connect()

    return { process: proc, client }
}

export { startBrowserBridge }