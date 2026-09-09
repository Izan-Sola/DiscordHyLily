// discord/tools/sttsTools.js
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Logger } from '../../utils/Logger.js'
import { ok, err } from './toolHelpers.js'

const execFileAsync = promisify(execFile)

const PI_TIMEOUT_MS = 90_000
const SCREENSHOT_TIMEOUT_MS = 15_000
// Some capture paths (GNOME's screenshot portal in particular) can return
// control to the caller slightly before the file is flushed to disk. Rather
// than trust a 0 exit code, we poll for the file to actually show up with
// non-zero size before declaring success.
const FILE_APPEAR_TIMEOUT_MS = 3_000
const FILE_APPEAR_POLL_MS = 100

// ─── Desktop/session detection ───────────────────────────────────────────

function detectDesktop() {
    const de = (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase()
    const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase() // 'wayland' | 'x11' | ''
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
    while (Date.now() < deadline) {
        try {
            const s = await stat(filePath)
            if (s.size > 0) return true
        } catch {
            // not there yet, keep polling
        }
        await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    return false
}

// ─── Per-platform/per-DE capture strategies ──────────────────────────────
// Each strategy is (outPath) => Promise<void> that resolves once the OS-level
// call has been issued. A 0 exit code does NOT guarantee the file exists yet
// (see FILE_APPEAR_TIMEOUT_MS above) - callers must still verify the file.

async function captureWindows(outPath) {
    // Captures the full virtual screen (all monitors). Escape backslashes
    // for embedding the Windows path inside the PowerShell string literal.
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
    // Calls the Shell's own screenshot method directly over D-Bus. This is
    // the call gnome-screenshot itself wraps, but going straight to D-Bus
    // makes the success/failure boolean explicit in stdout instead of
    // trusting a CLI wrapper's exit code - which is what was silently lying
    // to us before (exit 0 with no file written under some Wayland/portal
    // setups).
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
    // -b background (no GUI), -n no notification/sound, -o output path.
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
//   - run_system_command additionally needs the pidev bridge, since it's
//     just a wrapper around shelling out to `pi`
// The channel restriction (voiceAssistant-only) is NOT enforced here -
// that's toolRouter's job, since it's the one place that knows the
// calling channel. This executor only decides which tools this process
// is even capable of offering.
class SttsToolExecutor {
    constructor(sttsEnabled = false, pidevEnabled = false) {
        this.sttsEnabled = !!sttsEnabled
        this.pidevEnabled = !!pidevEnabled

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
        return defs
    }

    // Call once per tool-loop turn after executing whatever was
    // requested, to fold any captured screenshots into the next model call.
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

    // Builds the ordered list of capture strategies to try for the current
    // platform/desktop, most-specific/most-reliable first.
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
        // Desktop env couldn't be determined (or wasn't GNOME/KDE) - try the
        // other DE-specific paths too, cheaply, in case detection was wrong.
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
        // Generic X11 fallbacks - harmless to try last even on Wayland,
        // since XWayland setups can still make these work.
        add('scrot', captureScrot)
        add('maim', captureMaim)
        add('import', captureImportMagick)

        return strategies
    }

    // Tries capture strategies in order until one both exits cleanly AND
    // actually produces a non-empty file - fixing the previous bug where a
    // strategy could report success (exit 0) before the file was written.
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
    async execute(name, args) {
        switch (name) {
            case "get_screenshot": return this.getScreenshot()
            case "run_system_command": return this.runSystemCommand(args)
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

const STTS_TOOL_NAMES = new Set([SCREENSHOT_TOOL, RUN_COMMAND_TOOL].map(t => t.function.name))

export { SttsToolExecutor, STTS_TOOL_NAMES }