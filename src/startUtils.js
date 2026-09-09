const KNOWN_FLAGS = ['discord', 'modded', 'mineflayer', 'bending', 'vtube', 'vrchat', 'coding', 'pidev', 'stts'];

export function parseFlags(argv = process.argv.slice(2)) {
    return new Set(
        argv.map(f => f.toLowerCase()).filter(f => KNOWN_FLAGS.includes(f))
    )
}

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
        coding: flags.has('coding'),
        pidev: flags.has('pidev'),
        stts: flags.has('stts'),   // <-- new
    }
}

export function describeConfig(config) {
    let label = config.backend ?? 'discord-only'
    if (config.bending) label += '-bending'
    if (config.vtube) label += '-vtube'
    if (config.vrchat) label += '-vrchat'
    if (config.coding) label += '-coding'
    if (config.pidev) label += '-pidev'
    if (config.stts) label += '-stts'   // <-- new
    return label
}
export function getSttsToolConfig(flags = parseFlags()) {
    return {
        enabled: flags.has('stts'),
        pidevEnabled: flags.has('stts') && flags.has('pidev'),
    }
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
export function isSttsEnabled(flags = parseFlags()) {   // <-- new
    return flags.has('stts')
}

export function getToolConfig(runConfig = {}) {
    return {
        includeMinecraft: true,
        includeVtube: runConfig.vtube,
        includeBending: runConfig.bending,
        includeChat: false
    }
}