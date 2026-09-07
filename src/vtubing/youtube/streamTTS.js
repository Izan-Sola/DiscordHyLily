import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { sanitizeInput } from '../../ai/utils.js'
import { getVtubeConfig } from '../../vtubing/vtubeConfig.js'

const execAsync = promisify(exec)
const EDGE_TTS_BIN = process.env.EDGE_TTS_BIN

export async function speakToStream(text) {
    const { platform, ttsOutputDevice } = getVtubeConfig()
    const clean = sanitizeInput(text)
    const escaped = clean.replace(/'/g, "\\'").replace(/"/g, '\\"')
    const wavPath = path.join(os.tmpdir(), `lily_stream_${Date.now()}.wav`)

    await execAsync(`${EDGE_TTS_BIN} --text "${escaped}" --voice en-US-AnaNeural --write-media ${wavPath}`)

    try {
        await playAudio(wavPath, platform, ttsOutputDevice)
    } finally {
        fs.unlink(wavPath, () => { })
    }
}

function playAudio(wavPath, platform, ttsOutputDevice) {
    switch (platform) {
        case 'linux': {
            const deviceFlag = ttsOutputDevice ? ` --device=${ttsOutputDevice}` : ''
            return execAsync(`paplay${deviceFlag} "${wavPath}"`)
        }
        case 'windows': {
            // PlaySync() blocks until playback finishes, matching paplay's
            // blocking behavior above. No per-call device selection here -
            // SoundPlayer always uses Windows' current default playback
            // device, so route a virtual cable by setting it as default
            // in Windows Sound settings rather than via ttsOutputDevice.
            const psCmd = `(New-Object Media.SoundPlayer '${wavPath}').PlaySync()`
            return execAsync(`powershell -NoProfile -Command "${psCmd}"`)
        }
        default:
            throw new Error(`Unknown platform "${platform}" in config.json - expected "linux" or "windows"`)
    }
}