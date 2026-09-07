const KNOWN_FLAGS = ['discord', 'modded', 'mineflayer', 'bending', 'vtube', 'vrchat', 'coding', 'pidev']

export function parseFlags(argv = process.argv.slice(2)) {
    return new Set(
        argv.map(f => f.toLowerCase()).filter(f => KNOWN_FLAGS.includes(f))
    )
}

// The single source of truth for "what is this process configured to do".
//
// backend is null when neither 'modded' nor 'mineflayer' is set - NOT the
// string 'discord'. The old code conflated "no Minecraft backend" with
// the *unrelated* `discord` flag (whether the Discord bot logs in at
// all) by reusing the string 'discord' for both. Those are independent:
// you can run modded MC with no Discord bot, or a Discord-only bot with
// no MC backend at all. Keeping backend===null for the latter case avoids
// that collision.
//
// vrchat is its own independent boolean, same shape as vtube/discord -
// it's not a Minecraft backend alternative, so it never participates in
// the modded/mineflayer exclusivity check below. You can run e.g.
// `node start.js vrchat` alone, or `node start.js modded vrchat` to have
// both the Minecraft bridge and the VRChat avatar bridge live in one
// process sharing the same Lily instance.
export function getConfigFromFlags(flags = parseFlags()) {
    const isModded = flags.has('modded')
    const isMineflayer = flags.has('mineflayer')

    if (isModded && isMineflayer) {
        throw new Error("Can't combine 'modded' and 'mineflayer' flags - they're alternate Minecraft backends, pick one")
    }

    return {
        backend: isMineflayer ? 'mineflayer' : isModded ? 'modded' : null,
        bending: isModded && flags.has('bending'),
        vtube: flags.has('vtube'),
        discord: flags.has('discord'),
        vrchat: flags.has('vrchat'),
        // Same shape as vrchat above: independent booleans, not Minecraft
        // backend alternatives, so they never touch the modded/mineflayer
        // exclusivity check. `coding` brings up the Continue.dev bridge
        // (continue-bridge.js), `pidev` brings up the Pi coding-assistant
        // bridge (pidev-bridge.js). Either, both, or neither can run
        // alongside any other flag combination.
        coding: flags.has('coding'),
        pidev: flags.has('pidev'),
    }
}

// Cosmetic only - for log lines where you want a single human-readable
// label. Never branch on this string; read the config object's fields
// directly instead, the way describeConfig itself does.
export function describeConfig(config) {
    let label = config.backend ?? 'discord-only'
    if (config.bending) label += '-bending'
    if (config.vtube) label += '-vtube'
    if (config.vrchat) label += '-vrchat'
    if (config.coding) label += '-coding'
    if (config.pidev) label += '-pidev'
    return label
}

export function isDiscordEnabled(flags = parseFlags()) {
    return flags.has('discord')
}

export function isVtubeEnabled(flags = parseFlags()) {
    return flags.has('vtube')
}
export function isMineflayerEnabled(flags = parseFlags()) {
    return flags.has('mineflayer')
}
export function isModdedEnabled(flags = parseFlags()) {
    return flags.has('modded')
}
export function isVrchatEnabled(flags = parseFlags()) {
    return flags.has('vrchat')
}
export function isCodingEnabled(flags = parseFlags()) {
    return flags.has('coding')
}
export function isPidevEnabled(flags = parseFlags()) {
    return flags.has('pidev')
}
// Tool-config derivation for the survival loop / AI layer - takes the
// same config object everything else now uses, not a mode string.
export function getToolConfig(runConfig = {}) {
    return {
        includeMinecraft: true,
        includeVtube: runConfig.vtube,
        includeBending: runConfig.bending,
        includeChat: false // Survival loop doesn't need chat tools
    }
}