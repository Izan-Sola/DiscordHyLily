import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(__dirname, 'vtube_config.json')

// ─── VTubing / YouTube config ──────────────────────────────────────────
//
// Split out from ai/config.js: this file holds settings that belong to
// the streaming/vtubing side of things (platform + TTS output device,
// YouTube chat batching) and have nothing to do with the AI brain
// itself. Keeps the two from getting tangled as either grows.
//
// Same lazy-read-and-cache shape as getConfig() so it's a drop-in swap
// at call sites - just change the import.
let cached = null

export function getVtubeConfig() {
    if (!cached) {
        cached = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    }
    return cached
}

// Call this if vtube.config.json is edited while the process is running
// and you want the next getVtubeConfig() to pick up the change.
export function reloadVtubeConfig() {
    cached = null
    return getVtubeConfig()
}