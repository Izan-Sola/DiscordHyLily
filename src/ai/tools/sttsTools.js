// discord/tools/sttsTools.js
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import axios from 'axios'
import { Logger } from '../../utils/Logger.js'
import { ok, err } from './toolHelpers.js'
import { checkShrinkRatio, checkStubBodies } from '../../coding/codeEditShared.js'

const execFileAsync = promisify(execFile)

const PI_TIMEOUT_MS = 90_000
const SCREENSHOT_TIMEOUT_MS = 15_000
const FILE_APPEAR_TIMEOUT_MS = 3_000
const FILE_APPEAR_POLL_MS = 100
const COMPANION_REQUEST_TIMEOUT_MS = 5_000

// ─── Desktop/session detection ───────────────────────────────────────────

function detectDesktop() {
    const de = (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase()
    const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase()
    return {
        isGnome: de.includes('gnome'),
        isKde: de.includes('kde') || de.includes('plasma'),
        isWayland: sessionType === 'wayland',
        de,
        sessionType,
    }
}

async function waitForFile(filePath, timeoutMs = FILE_APPEAR_TIMEOUT_MS, pollMs = FILE_APPEAR_POLL_MS) {
    const deadline = Date.now() + timeoutMs
    let lastSize = -1
    let stableCount = 0
    while (Date.now() < deadline) {
        try {
            const s = await stat(filePath)
            if (s.size > 0) {
                if (s.size === lastSize) {
                    stableCount++
                    if (stableCount >= 2) return true
                } else {
                    stableCount = 0
                    lastSize = s.size
                }
            }
        } catch { /* not there yet */ }
        await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    return false
}

// ─── Per-platform/per-DE screenshot capture strategies ───────────────────

async function captureWindows(outPath) {
    const psPath = outPath.replace(/\\/g, '\\\\')
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
        '$graphics = [System.Drawing.Graphics]::FromImage($bmp)',
        '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
        `$bmp.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
        '$graphics.Dispose()',
        '$bmp.Dispose()',
    ].join('\n')

    await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: SCREENSHOT_TIMEOUT_MS },
    )
}

async function captureGnomeDbus(outPath) {
    const { stdout } = await execFileAsync('gdbus', [
        'call', '--session',
        '--dest', 'org.gnome.Shell.Screenshot',
        '--object-path', '/org/gnome/Shell/Screenshot',
        '--method', 'org.gnome.Shell.Screenshot.Screenshot',
        'false', 'false', outPath,
    ], { timeout: SCREENSHOT_TIMEOUT_MS })

    if (!/^\(true,/.test(stdout.trim())) {
        throw new Error(`gnome-shell reported failure: ${stdout.trim()}`)
    }
}

async function captureGnomeScreenshotCli(outPath) {
    await execFileAsync('gnome-screenshot', ['-f', outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

async function captureSpectacle(outPath) {
    await execFileAsync('spectacle', ['-b', '-n', '-o', outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

async function captureGrim(outPath) {
    await execFileAsync('grim', [outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

async function captureScrot(outPath) {
    await execFileAsync('scrot', ['-o', outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

async function captureMaim(outPath) {
    await execFileAsync('maim', [outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

async function captureImportMagick(outPath) {
    await execFileAsync('import', ['-window', 'root', outPath], { timeout: SCREENSHOT_TIMEOUT_MS })
}

// ─── STTS Tool Executor ──────────────────────────────────────────────────
//
// Tools that only make sense while Lily is being talked to via speech.
// Which tools *exist at all* for this process is flag-conditional:
//   - get_screenshot needs only the STTS module (sttsEnabled)
//   - run_system_command additionally needs the pidev bridge (pidevEnabled)
//   - edit_active_vscode_file additionally needs the coding bridge
//     (codingEnabled) AND a companion VSCode extension reachable over
//     HTTP AND an editCallback wired in from Lily (see Lily.generateFileEdit)
// The channel restriction (voiceAssistant-only) is NOT enforced here -
// that's toolRouter's job, since it's the one place that knows the
// calling channel. This executor only decides which tools this process
// is even capable of offering.
class SttsToolExecutor {
    /**
     * @param {boolean} sttsEnabled
     * @param {boolean} pidevEnabled
     * @param {boolean} codingEnabled
     * @param {(filePath: string, originalContent: string, instruction: string) => Promise<string>} [editCallback]
     *   Called to actually generate the new file content for
     *   edit_active_vscode_file. Wired in by Lily so this executor can
     *   reach back into the model without importing Lily directly
     *   (avoids a circular import — same pattern as mcSend).
     */
    constructor(sttsEnabled = false, pidevEnabled = false, codingEnabled = false, editCallback = null) {
        this.sttsEnabled = !!sttsEnabled
        this.pidevEnabled = !!pidevEnabled
        this.codingEnabled = !!codingEnabled
        this._editCallback = editCallback
        this._vscodeCompanionUrl = process.env.VSCODE_COMPANION_URL || 'http://localhost:8768'

        // Tool results are text-only, so a captured screenshot can't be
        // returned inline. It's parked here as base64 instead; the tool
        // loop should drain it after execution (takePendingImages()) and
        // attach it to the next model call, the same way
        // turnAutoMemoryBlocks gets drained per-turn in handleMessage.
        this._pendingImages = []
    }

    get toolNames() {
        return this._activeToolDefs().map(t => t.function.name)
    }

    get tools() {
        return this._activeToolDefs()
    }
    _activeToolDefs() {
        if (!this.sttsEnabled) return []
        const defs = [SCREENSHOT_TOOL]
        if (this.pidevEnabled) defs.push(RUN_COMMAND_TOOL)
        if (this.codingEnabled) defs.push(EDIT_ACTIVE_FILE_TOOL, READ_ACTIVE_FILE_TOOL)
        return defs
    }

    takePendingImages() {
        const images = this._pendingImages
        this._pendingImages = []
        return images
    }

    async getScreenshot() {
        if (!this.sttsEnabled) return err("Screenshot tool isn't enabled.")

        let dir
        try {
            dir = await mkdtemp(path.join(tmpdir(), 'lily-shot-'))
            const file = path.join(dir, 'screenshot.png')

            const usedStrategy = await this._captureScreenshot(file)

            const buf = await readFile(file)
            this._pendingImages.push({ base64: buf.toString('base64'), mediaType: 'image/png' })

            Logger.info(`Captured screenshot via ${usedStrategy} (${(buf.length / 1024).toFixed(0)} KB)`, "STTS")
            return ok("Screenshot captured, it'll be attached to the conversation for you to see.")
        } catch (e) {
            Logger.error(`Screenshot failed: ${e.message}`, "STTS")
            return err("Couldn't capture the screen.")
        } finally {
            if (dir) await rm(dir, { recursive: true, force: true }).catch(() => { })
        }
    }

    _screenshotStrategies() {
        if (process.platform === 'win32') {
            return [['windows', captureWindows]]
        }

        const { isGnome, isKde, isWayland } = detectDesktop()
        const strategies = []
        const seen = new Set()
        const add = (name, fn) => {
            if (seen.has(name)) return
            seen.add(name)
            strategies.push([name, fn])
        }

        if (isGnome) {
            add('gnome-dbus', captureGnomeDbus)
            add('gnome-screenshot', captureGnomeScreenshotCli)
        }
        if (isKde) {
            add('spectacle', captureSpectacle)
        }
        if (isWayland && !isGnome) {
            add('grim', captureGrim)
        }
        if (!isGnome) {
            add('gnome-dbus', captureGnomeDbus)
            add('gnome-screenshot', captureGnomeScreenshotCli)
        }
        if (!isKde) {
            add('spectacle', captureSpectacle)
        }
        if (isWayland) {
            add('grim', captureGrim)
        }
        add('scrot', captureScrot)
        add('maim', captureMaim)
        add('import', captureImportMagick)

        return strategies
    }

    async _captureScreenshot(outPath) {
        const strategies = this._screenshotStrategies()
        const failures = []

        for (const [name, run] of strategies) {
            try {
                await run(outPath)
            } catch (e) {
                failures.push(`${name}: ${e.message}`)
                continue
            }

            if (await waitForFile(outPath)) {
                return name
            }
            failures.push(`${name}: exited cleanly but no file appeared`)
        }

        throw new Error(
            failures.length
                ? `No screenshot tool available. Tried: ${failures.join(' | ')}`
                : 'No screenshot tool available'
        )
    }

    async runSystemCommand(args = {}) {
        if (!this.sttsEnabled || !this.pidevEnabled) {
            return err("System command tool isn't enabled.")
        }

        const { prompt } = args
        if (!prompt?.trim()) return err("prompt required.")

        Logger.info(`Delegating to pi: ${prompt.slice(0, 200)}`, "STTS")

        try {
            const report = await this._runPi(prompt)
            Logger.success(`pi finished: ${report.slice(0, 200)}`, "STTS")
            return ok(report || "Done, no output.")
        } catch (e) {
            Logger.error(`pi failed: ${e.message}`, "STTS")
            return err(e.message === 'timeout'
                ? "Pi took too long and was cut off."
                : "Pi ran into a problem executing that.")
        }
    }
    _runPi(prompt) {
        return new Promise((resolve, reject) => {
            const child = spawn('pi', ['-p', prompt], {
                stdio: ['ignore', 'pipe', 'pipe'],
            })

            let stdout = ''
            let stderr = ''
            child.stdout.on('data', d => { stdout += d })
            child.stderr.on('data', d => { stderr += d })

            const timer = setTimeout(() => {
                child.kill('SIGTERM')
                reject(new Error('timeout'))
            }, PI_TIMEOUT_MS)

            child.on('error', e => {
                clearTimeout(timer)
                reject(e)
            })

            child.on('close', (code) => {
                clearTimeout(timer)
                if (code === 0) resolve(stdout.trim() || stderr.trim())
                else reject(new Error(stderr.trim() || `pi exited with code ${code}`))
            })
        })
    }

    // ─── Voice-triggered VSCode edit ─────────────────────────────────────
    //
    // Continue only executes tool calls in response to requests it starts
    // itself, so a voice command can't reach through Continue. Instead this
    // talks to a small companion VSCode extension (vscode-companion/) over
    // localhost HTTP to read/write the active editor directly, and reuses
    // the same generation + overwrite guard as continue-bridge.js's apply
    // role (see src/coding/codeEditShared.js) rather than reimplementing it.
    async editActiveFile(args = {}) {
        if (!this.sttsEnabled || !this.codingEnabled) {
            return err("VSCode editing tool isn't enabled.")
        }
        if (!this._editCallback) {
            return err("Editing isn't wired up right now.")
        }

        const { instruction } = args
        if (!instruction?.trim()) return err("instruction required.")

        let active
        try {
            const { data } = await axios.get(
                `${this._vscodeCompanionUrl}/active-file`,
                { timeout: COMPANION_REQUEST_TIMEOUT_MS }
            )
            active = data
        } catch (e) {
            Logger.error(`Couldn't reach VSCode companion: ${e.message}`, "STTS")
            return err("Couldn't reach VSCode — is it open with the companion extension installed?")
        }

        if (!active?.path) return err("No file is currently open in VSCode.")

        Logger.info(`Editing ${active.path}: ${instruction.slice(0, 200)}`, "STTS")

        let newContent
        try {
            newContent = await this._editCallback(active.path, active.content, instruction)
        } catch (e) {
            Logger.error(`Edit generation failed: ${e.message}`, "STTS")
            return err("Couldn't come up with an edit for that.")
        }

        if (!newContent?.trim()) return err("Didn't get a usable edit back.")

        const blockReason =
            checkShrinkRatio(active.content, newContent, active.path) ??
            checkStubBodies(newContent, active.path)

        if (blockReason) {
            Logger.warning(`BLOCKED voice edit: ${blockReason}`, "STTS")
            return err("That edit looked like it would wipe out real code, so I didn't apply it. Try being more specific.")
        }

        try {
            await axios.post(
                `${this._vscodeCompanionUrl}/apply-edit`,
                { path: active.path, content: newContent },
                { timeout: COMPANION_REQUEST_TIMEOUT_MS }
            )
        } catch (e) {
            Logger.error(`Apply failed: ${e.message}`, "STTS")
            return err("Generated the edit but couldn't apply it in VSCode.")
        }

        const fileName = active.path.split(/[\\/]/).pop()
        Logger.success(`Applied voice edit to ${fileName}`, "STTS")
        return ok(`Edited ${fileName}. It's applied in the editor as unsaved changes — check it over before saving.`)
    }
    async readActiveFile() {
        if (!this.sttsEnabled || !this.codingEnabled) {
            return err("VSCode reading tool isn't enabled.")
        }

        let active
        try {
            const { data } = await axios.get(
                `${this._vscodeCompanionUrl}/active-file`,
                { timeout: COMPANION_REQUEST_TIMEOUT_MS }
            )
            active = data
        } catch (e) {
            Logger.error(`Couldn't reach VSCode companion: ${e.message}`, "STTS")
            return err("Couldn't reach VSCode — is it open with the companion extension installed?")
        }

        if (!active?.path) return err("No file is currently open in VSCode.")

        Logger.info(`Read active file: ${active.path}`, "STTS")
        return ok(`File: ${active.path}\n\n${active.content}`)
    }
    async execute(name, args) {
        switch (name) {
            case "get_screenshot": return this.getScreenshot()
            case "run_system_command": return this.runSystemCommand(args)
            case "edit_active_vscode_file": return this.editActiveFile(args)
            case "read_active_vscode_file": return this.readActiveFile()
            default:
                Logger.warning(`Unknown: ${name}`, "TOOL")
                return err(`Unknown tool: ${name}`)
        }
    }
}

// ─── Tool Definitions ───────────────────────────────────────────────────

const SCREENSHOT_TOOL = {
    type: "function",
    function: {
        name: "get_screenshot",
        description:
            "Take a screenshot of the user's screen right now. Use this whenever they ask you to look at, check, or react to something visual on their screen ('check this out', 'see this', 'what's on my screen', 'look at this error') during a voice conversation. The image is attached automatically after you call this - just describe or react to what you see once it arrives.",
        parameters: { type: "object", properties: {} },
    },
}

const RUN_COMMAND_TOOL = {
    type: "function",
    function: {
        name: "run_system_command",
        description:
            "Delegate an operating-system task to Pi, your terminal-savvy assistant, when the user asks for something that requires actually touching the system (running a command, finding/editing a file, cleaning something up, checking system state, fixing a bug in a project on disk). Pass what the user wants done as a clear natural-language instruction - Pi figures out the actual commands. Only use this for real system/file actions, not things you can already answer yourself.",
        parameters: {
            type: "object",
            properties: {
                prompt: {
                    type: "string",
                    description: "Natural-language description of the system task, e.g. 'Empty the trash and tell me how much space was freed'.",
                },
            },
            required: ["prompt"],
        },
    },
}

const EDIT_ACTIVE_FILE_TOOL = {
    type: "function",
    function: {
        name: "edit_active_vscode_file",
        description:
            "Edit the file currently open/active in VSCode, based on a natural-language instruction (e.g. 'add error handling to this function', 'rename this variable to userId', 'fix the bug where it double-counts'). Use this when the user asks you to change, fix, or edit code in the editor during a voice conversation. Don't use this for questions about the code - only for actual edit requests. The edit is applied as unsaved changes in VSCode so the user can review and undo it.",
        parameters: {
            type: "object",
            properties: {
                instruction: {
                    type: "string",
                    description: "Clear natural-language description of the change to make to the currently open file.",
                },
            },
            required: ["instruction"],
        },
    },
}
const READ_ACTIVE_FILE_TOOL = {
    type: "function",
    function: {
        name: "read_active_vscode_file",
        description:
            "Read the file currently open/active in VSCode without changing it. Use this when the user asks you to look at, explain, review, or answer questions about the code they're editing, or before making an edit if you need to see the current content first. Returns the file's path and full text content.",
        parameters: { type: "object", properties: {} },
    },
}
const STTS_TOOL_NAMES = new Set(
    [SCREENSHOT_TOOL, RUN_COMMAND_TOOL, EDIT_ACTIVE_FILE_TOOL, READ_ACTIVE_FILE_TOOL].map(t => t.function.name)
)
export { SttsToolExecutor, STTS_TOOL_NAMES }