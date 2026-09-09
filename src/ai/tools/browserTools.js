
import { ok, err } from './toolHelpers.js'

// ─── Browser Tool Executor ──────────────────────────────────────────────
//
// Talks to the Chrome/Firefox extension through the open-browser-control
// bridge (spawned by browser/bridge.js when the 'browser' flag is set).
// Unlike vtsClient/mcSend, the bridge client connects asynchronously after
// the child process boots, so this executor starts with no client and is
// populated later via setClient() - same deferred-injection shape as
// VtubeToolExecutor. Gating to the voiceAssistant channel happens in
// toolRouter.js (isBrowserTool + the execute() guard), same as sttsTools.
class BrowserToolExecutor {
    constructor(client = null) {
        this.client = client
    }

    setClient(client) {
        this.client = client
    }

    get isEnabled() {
        return !!this.client
    }

    get toolNames() {
        return BROWSER_TOOL_NAMES
    }

    get tools() {
        return this.isEnabled ? BROWSER_TOOLS : []
    }

    async run(action, args = {}) {
        if (!this.client) return err("Browser bridge isn't connected.")

        try {
            const result = await this.client.send(action, args)
            return ok(typeof result === 'string' ? result : JSON.stringify(result))
        } catch (e) {
            Logger.error(e.message, "BROWSER")
            return err(`Browser action failed: ${e.message}`)
        }
    }

    async execute(name, args) {
        switch (name) {
            case "browser_navigate": return this.run("navigate", args)
            case "browser_get_dom": return this.run("get_dom", args)
            case "browser_click": return this.run("click", args)
            case "browser_type": return this.run("type", args)
            case "browser_scroll": return this.run("scroll", args)
            case "browser_wait": return this.run("wait", args)
            case "browser_new_tab": return this.run("new_tab", args)
            case "browser_list_tabs": return this.run("list_tabs", args)
            case "browser_switch_tab": return this.run("switch_tab", args)
            default:
                Logger.warning(`Unknown: ${name}`, "TOOL")
                return err(`Unknown tool: ${name}`)
        }
    }
}

// ─── Tool Definitions ───────────────────────────────────────────────────

const BROWSER_TOOLS = [
    {
        type: "function",
        function: {
            name: "browser_navigate",
            description: "Open a URL in the controlled browser tab.",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "The URL to navigate to." },
                },
                required: ["url"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "browser_get_dom",
            description: "Read the current page's interactive elements (links, buttons, inputs) with their text and position. Call this after navigating or before clicking/typing - you can't see the page otherwise.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "browser_click",
            description: "Click an element on the page, identified by visible text or a CSS selector.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Visible text of the element to click." },
                    selector: { type: "string", description: "CSS selector, if text isn't unique enough." },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "browser_type",
            description: "Type text into the currently focused or specified input field, optionally pressing Enter afterward.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to type." },
                    selector: { type: "string", description: "CSS selector of the field to type into." },
                    pressEnter: { type: "boolean", description: "Press Enter after typing." },
                },
                required: ["text"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "browser_scroll",
            description: "Scroll the page up, down, left, or right.",
            parameters: {
                type: "object",
                properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] } },
                required: ["direction"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "browser_wait",
            description: "Wait for an element or text to appear on the page, or wait a fixed amount of time.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to wait for." },
                    selector: { type: "string", description: "CSS selector to wait for." },
                    ms: { type: "number", description: "Fixed milliseconds to wait, if not waiting on an element." },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "browser_new_tab",
            description: "Open a new browser tab in the current session.",
            parameters: {
                type: "object",
                properties: { url: { type: "string", description: "URL to open in the new tab." } },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "browser_list_tabs",
            description: "List all open tabs in the current browser session.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "browser_switch_tab",
            description: "Switch focus to a different open tab by its ID (from browser_list_tabs).",
            parameters: {
                type: "object",
                properties: { tabId: { type: "string", description: "ID of the tab to switch to." } },
                required: ["tabId"],
            },
        },
    },
]

const BROWSER_TOOL_NAMES = new Set(BROWSER_TOOLS.map(t => t.function.name))

export { BrowserToolExecutor, BROWSER_TOOLS, BROWSER_TOOL_NAMES }