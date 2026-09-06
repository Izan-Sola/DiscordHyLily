import { WebSocketServer } from "ws"
import { StateController } from "./state-machine/StateController.js"
import { Logger } from "../../utils/Logger.js"
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadCombos, enrichCombosData } from './state-machine/helpers/comboExecutor.js'
import { startSurvivalLoop } from './state-machine/helpers/survivalLoop.js'
import axios from "axios"
import { buildMinecraftSystemPrompt } from '../../ai/prompts.js'
import { getConfigFromFlags, describeConfig } from '../../startUtils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let triggerSurvivalTick = null
let currentConfig = getConfigFromFlags() // Use the unified config system
let survivalLoopStarted = false
let survivalLoopInstance = null

export const getConfig = () => currentConfig

let wss = null
let ws = null
let stateController = null
let aiInstance = null
let reconnectTimer = null
let currentVtsClient = null

let staticAbilities = {}

function loadStaticAbilityData() {
    const jsonPath = path.join(__dirname, './state-machine/states/data/PKAbilitiesData.json')
    try {
        const data = fs.readFileSync(jsonPath, 'utf8')
        const json = JSON.parse(data)
        staticAbilities = json.abilities || {}
        Logger.info(`Loaded ${Object.keys(staticAbilities).length} static ability definitions from PKAbilitiesData.json`, "ABILITY")
    } catch (err) {
        Logger.error(`Failed to load PKAbilitiesData.json: ${err.message}`, "ABILITY")
        staticAbilities = {}
    }
}

function mergeAbilityData(liveData) {
    Logger.info(`Received live data. Abilities: ${Object.keys(liveData)}`, "ABILITY")
    let updatedCount = 0;

    for (const [ability, stats] of Object.entries(liveData)) {
        const old = staticAbilities[ability];
        if (old) {
            const oldRange = old.range;
            const oldCooldown = old.cooldown;
            old.range = stats.range;
            old.cooldown = stats.cooldown;
            updatedCount++;
            Logger.info(`Updated ${ability}: range ${oldRange}→${stats.range}, cooldown ${oldCooldown}→${stats.cooldown}`, "ABILITY")
        } else {
            staticAbilities[ability] = {
                description: "Unknown ability",
                actions: [],
                actionTimes: [],
                range: stats.range,
                cooldown: stats.cooldown
            };
            updatedCount++;
            Logger.info(`Created new entry for ${ability}: range=${stats.range}, cooldown=${stats.cooldown}`, "ABILITY")
        }
    }

    if (updatedCount > 0) {
        try {
            const jsonPath = path.join(__dirname, './state-machine/states/data/PKAbilitiesData.json');
            const output = { abilities: staticAbilities };
            fs.writeFileSync(jsonPath, JSON.stringify(output, null, 4));
            Logger.info(`Saved PKAbilitiesData.json (${updatedCount} entries updated/added)`, "ABILITY")
        } catch (err) {
            Logger.error(`Failed to write PKAbilitiesData.json: ${err.message}`, "ABILITY")
        }
    } else {
        Logger.warning(`No abilities matched – check ability name casing`, "ABILITY")
    }
}

function requestAbilityData() {
    mcSend('request_ability_data')
}

export function startMinecraftBot({ port, ai, vtsClient = null, runConfig = null }) {
    aiInstance = ai

    // Use provided config or fallback to current config
    if (runConfig) {
        currentConfig = runConfig
    }

    // Check if we're in a config that supports bending
    const bendingEnabled = currentConfig.bending

    if (bendingEnabled) {
        loadCombos()
        loadStaticAbilityData()
    }

    const resolvedPort = port ?? 8766
    _connect(resolvedPort, vtsClient)
}

function _connect(port, vtsClient) {
    currentVtsClient = vtsClient
    wss = new WebSocketServer({ port })
    Logger.info(`WebSocket server listening on port ${port} (config: ${describeConfig(currentConfig)})`, "MC")

    wss.on("connection", async (socket) => {
        ws = socket
        Logger.info("Java mod connected", "MC")
        clearTimeout(reconnectTimer)

        if (!stateController) {
            stateController = new StateController(mcSend, {
                followTarget: process.env.MC_FOLLOW_TARGET ?? "shinyshadow_",
                followDistance: 3,
                attackRange: 4,
                lowHpThreshold: 6,
                tickMs: 25,
                ai: aiInstance
            })

            if (currentConfig.bending) {
                stateController.updateAbilityStats(staticAbilities)
            }
        }
        stateController.start()

        // Request ability data if bending is enabled
        if (currentConfig.bending) {
            requestAbilityData()
        }

        // The survival loop always runs once the mod is connected - it's not a separate mode
        if (!survivalLoopStarted) {
            const loop = await startSurvivalLoop(
                stateController,
                mcSend,
                mcChat,
                process.env.OLLAMA_URL ?? "http://localhost:11435",
                currentConfig,
                vtsClient
            )

            if (loop) {
                survivalLoopInstance = loop
                triggerSurvivalTick = loop.triggerTick
                survivalLoopStarted = true
                Logger.info('Survival loop started', "SURVIVAL")
            }
        }

        socket.on("message", async (data) => {
            try {
                const event = JSON.parse(data.toString())
                await _handleEvent(event)
            } catch (err) {
                Logger.error(`Message error: ${err.message}`, "MC")
            }
        })

        socket.on("close", () => {
            Logger.info("Java mod disconnected", "MC")
            stateController?.stop()
            ws = null

            // Stop survival loop if running
            if (survivalLoopInstance) {
                survivalLoopInstance.stop?.()
                survivalLoopInstance = null
                survivalLoopStarted = false
            }
        })

        socket.on("error", err => {
            Logger.error(`WS error: ${err.message}`, "MC")
        })
    })
}

async function _handleEvent(event) {
    switch (event.type) {
        case "chat": {
            const player = event.player ?? ""
            const message = event.message ?? ""

            if (player.toLowerCase() === "lily") break
            if (!event.message.toLowerCase().includes("lily") && !event.message.toLowerCase().startsWith("!")) break
            Logger.info(`${player}: ${message}`, "MC CHAT")

            getStateController()?.setLastUserMessage(player, message)

            try {
                const aiReply = await aiInstance.chat(
                    "minecraft",
                    `${player}: ${message}`,
                    buildMinecraftSystemPrompt(getStateController()),
                    {
                        temperature: 0.5,
                        repeat_penalty: 1.0,   // was 1.15 — JSON tool calls are inherently repetitive, don't fight that
                        presence_penalty: 0,   // was 1.0 — this was almost certainly suppressing { } " : tokens
                        repeat_last_n: 64      // shrink the penalty window so tool-schema tokens age out fast, if you keep any penalty at all
                    }
                )
                const text = aiReply?.text?.trim()
                const gifUrl = aiReply?.gifUrl

                if (text) {
                    _splitMessage(text).forEach(msg => mcChat(msg))
                }
                if (gifUrl) {
                    mcChat(gifUrl)
                }

            } catch (err) {
                Logger.error(`${err.message}`, "MC CHAT ERROR")
            }

            break
        }
        case "duel_data": {
            stateController.updateLilyState(
                { x: event.lily.x, y: event.lily.y, z: event.lily.z },
                event.lily.hp,
                event.lily.hunger ?? 20
            );

            if (!stateController.lilyPrevPos) {
                stateController.lilyPrevPos = { x: event.lily.x, y: event.lily.y, z: event.lily.z };
            } else {
                stateController.lilyPrevPos = {
                    x: stateController.lilyPos?.x ?? event.lily.x,
                    y: stateController.lilyPos?.y ?? event.lily.y,
                    z: stateController.lilyPos?.z ?? event.lily.z
                };
            }

            const opp = event.opponent;

            if (!stateController.opponentPrevPos) {
                stateController.opponentPrevPos = {};
            }

            const currentOpp = stateController.players?.[opp.name];
            if (currentOpp) {
                stateController.opponentPrevPos[opp.name] = {
                    x: currentOpp.x,
                    y: currentOpp.y,
                    z: currentOpp.z
                };
            }

            stateController.updatePlayers({
                [opp.name]: {
                    x: opp.x,
                    y: opp.y,
                    z: opp.z,
                    hp: opp.hp
                }
            });

            const bindingsMap = event.bindings;
            if (bindingsMap) {
                for (const [slot, ability] of Object.entries(bindingsMap)) {
                    stateController.bindAbility(parseInt(slot), ability);
                }
            }

            if (event.duelDifficulty) {
                stateController.duelDifficulty = event.duelDifficulty;
            }

            if (event.lily?.sprinting !== undefined) {
                stateController.lilySprinting = event.lily.sprinting;
            }

            if (event.lily?.armor !== undefined) {
                stateController.lilyArmor = event.lily.armor;
            }

            break;
        }

        case "players_list": {
            const players = {}
            if (event.players) {
                event.players.split(";").filter(Boolean).forEach(entry => {
                    try {
                        const colonIdx = entry.indexOf(":")
                        const name = entry.slice(0, colonIdx)
                        const parts = entry.slice(colonIdx + 1).split(",")
                        players[name] = {
                            x: parseFloat(parts[0]),
                            y: parseFloat(parts[1]),
                            z: parseFloat(parts[2]),
                            hp: parseFloat((parts[3] ?? "hp=20").split("=")[1] ?? "20")
                        }
                    } catch { /* skip malformed */ }
                })
            }
            stateController?.updatePlayers(players)
            break
        }

        case "lily_state": {
            stateController?.updateLilyState(
                { x: event.x, y: event.y, z: event.z },
                event.hp ?? 20,
                event.food ?? 20
            )
            if (event.armor !== undefined) {
                stateController.lilyArmor = event.armor
            }
            break
        }
        case "element_changed": {
            stateController.currentElement = event.element
            Logger.info(`Element changed to ${event.element}`, "BEND")
            break
        }
        case "hostiles": {
            stateController?.updateHostiles(event.hostiles ?? [])
            break
        }
        case "environment_scan": {
            if (stateController) {
                stateController.hostiles = event.hostiles ?? []
                stateController.passives = event.passives ?? []
                stateController.blocksOfInterest = event.blocks_of_interest ?? []
                stateController.inventoryItems = event.inventory ?? {}
                stateController.environmentInfo = event.environment_info ?? {}
            }
            break
        }
        case "bindings_update": {
            const bindingsMap = event.bindings ?? {}
            if (stateController) {
                for (const [slot, ability] of Object.entries(bindingsMap)) {
                    stateController.bindAbility(parseInt(slot), ability)
                }
            }
            break
        }
        case "ability_data": {
            // Skip while the survival loop is driving the bot - it doesn't need live PK tuning
            if (survivalLoopStarted) break
            mergeAbilityData(event.abilities)
            if (stateController?.updateAbilityStats) {
                stateController.updateAbilityStats(staticAbilities)
                enrichCombosData(staticAbilities)
            }
            break
        }

        case "set_duel_target": {
            // Skip while the survival loop is driving the bot - duels are a manual/Discord-driven flow
            if (survivalLoopStarted) break
            stateController?.setDuelTarget(event.target)
            stateController.duelDifficulty = event.difficulty || "medium"
            Logger.info(`Difficulty: ${stateController.duelDifficulty}`, "DUEL")
            break
        }

        case "set_follow_target": {
            stateController?.setFollowTarget(event.target)
            break
        }

        case "player_join":
            Logger.info(`${event.player} joined`, "MC")
            break

        case "player_leave":
            Logger.info(`${event.player} left`, "MC")
            break

        case "duel_result": {
            const { winner, loser } = event;
            Logger.info(`Winner: ${winner} | Loser: ${loser}`, "DUEL ENDED")

            if (stateController) {
                stateController.duelTarget = null;
                if (stateController.currentStateName === 'DUELING') {
                    stateController.transitionTo('IDLE');
                }
            }

            axios.post("http://localhost:1234/duel-result", { winner, loser })
                .then(() => Logger.info("Successfully synced score update with Blog Server", "DUEL"))
                .catch(err => Logger.error(`Failed to update Blog Server: ${err.message}`, "DUEL"));

            break;
        }

        case "player_death": {
            const who = event.player
            Logger.info(`${who} died`, "MC")
            break
        }

        case "set_mode": {
            // The Java mod sends `event.mode` as a raw string over its own
            // wire protocol - that's a different boundary than our CLI
            // flags, and not something this file controls, so a string
            // arriving here isn't the same bug as the old internal
            // mode-string plumbing. It only ever toggles bending at
            // runtime (the mod can't change backend or vtube - those are
            // process-launch-time only), so this reads just that one bit
            // out of the wire string rather than resurrecting the old
            // hasBending(modeString) helper.
            //
            // NOTE: if the Java mod can be changed to send a boolean
            // (e.g. { type: "set_mode", bending: true }) instead of a
            // mode-suffix string, that removes the last string-parsing
            // spot in this file. Flagging rather than silently guessing
            // your mod's wire format.
            const newBending = typeof event.mode === 'string'
                && event.mode.includes('bending')
                && !event.mode.includes('nobending')

            currentConfig = { ...currentConfig, bending: newBending }
            Logger.info(`Mode switched (config: ${describeConfig(currentConfig)})`, "MC")

            if (newBending) {
                loadCombos()
                loadStaticAbilityData()
                if (stateController) {
                    stateController.updateAbilityStats(staticAbilities)
                    requestAbilityData()
                }
            }

            // Restart the survival loop so it picks up the new config's tool
            // set (e.g. bending on/off changes which tools it should have)
            if (survivalLoopInstance) {
                survivalLoopInstance.stop?.()
                survivalLoopInstance = null
                survivalLoopStarted = false
            }

            const loop = await startSurvivalLoop(
                stateController,
                mcSend,
                mcChat,
                process.env.OLLAMA_URL ?? "http://localhost:11435",
                currentConfig,
                currentVtsClient
            )
            if (loop) {
                survivalLoopInstance = loop
                triggerSurvivalTick = loop.triggerTick
                survivalLoopStarted = true
            }

            break
        }
        case "block_found": {
            if (!stateController) break

            if (!event.found) {
                Logger.info(`No "${event.block}" found nearby`, "MINE")
                mcChat(`can't find any ${event.block} around here (╥﹏╥)`)
                break
            }

            const target = { x: event.x, y: event.y, z: event.z, type: event.block }
            stateController.transitionTo('MINING', { blocks: [target] })
            break
        }
        case 'craft_result': stateController.handleCraftResult(event); break
        case "source_block": {
            stateController?.handleSourceBlock(event);
            break;
        }
        case 'mining_started': stateController?.handleMiningStarted(event); break
        case 'block_broken': stateController?.handleBlockBroken(event); break
    }
}

export function mcSend(type, data = {}) {
    if (!ws || ws.readyState !== 1) {
        Logger.warning(`WS not ready, dropping: ${type}`, "MC")
        return
    }
    ws.send(JSON.stringify({ type, ...data }))
}

export function mcChat(message) {
    mcSend("chat", { message })
}

export function mcCommand(cmd) {
    mcSend("run_command", { command: cmd })
}

export function mcGetPlayers() {
    mcSend("get_players")
}

export function mcGetScoreboard() {
    mcSend("get_scoreboard")
}

export function stopMinecraftBot() {
    clearTimeout(reconnectTimer)
    stateController?.stop()
    ws?.close()
    wss?.close()
    ws = null
    wss = null
    stateController = null

    // Stop survival loop
    if (survivalLoopInstance) {
        survivalLoopInstance.stop?.()
        survivalLoopInstance = null
        survivalLoopStarted = false
    }
}

export function getStateController() {
    return stateController
}

function _splitMessage(text, limit = 250) {
    const words = text.split(" ")
    const chunks = []
    let current = ""
    for (const word of words) {
        if ((current + " " + word).trim().length > limit) {
            if (current) chunks.push(current.trim())
            current = word
        } else {
            current = current ? current + " " + word : word
        }
    }
    if (current) chunks.push(current.trim())
    return chunks
}