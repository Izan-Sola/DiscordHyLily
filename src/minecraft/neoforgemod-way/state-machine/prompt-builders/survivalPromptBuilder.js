function cleanName(raw) {
    return raw.replace(/§[0-9a-fk-orxA-FK-ORX]/g, '').replace(/^[>\s]+/, '').trim()
}

function formatEntity(e, lilyPos) {
    const dist = lilyPos ? Math.floor(Math.hypot(e.x - lilyPos.x, e.z - lilyPos.z)) : '?'
    return `- ${e.type ?? e.name} (id: ${e.id}) — ${dist} blocks away at (${Math.floor(e.x)}, ${Math.floor(e.y)}, ${Math.floor(e.z)})`
}

function formatBlockOfInterest(b, lilyPos) {
    const dist = lilyPos ? Math.floor(Math.hypot(b.x - lilyPos.x, b.z - lilyPos.z)) : '?'
    const countStr = b.count != null && b.count > 1 ? ` (x${b.count} nearby)` : '';
    return `${b.block}${countStr} at (${b.x}, ${b.y}, ${b.z}), ${dist}m away`;
}

function formatPlayer(name, p, lilyPos) {
    const dist = lilyPos ? Math.floor(Math.hypot(p.x - lilyPos.x, p.z - lilyPos.z)) : '?'
    return `- ${name} — ${dist} blocks away at (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}) HP: ${p.hp}/20`
}

function getStateDescription(ctx) {
    switch (ctx.currentStateName) {
        case 'IDLE': return 'You are idling, nothing particular going on.'
        case 'FOLLOWING': return `You are following player ${ctx.opts?.followTarget ?? 'someone'}.`
        case 'ATTACKING': return `You are fighting a nearby hostile mob.`
        case 'RECOVERING': return `You are recovering, your health is low and you are waiting it out.`
        default: return 'You are doing something.'
    }
}

function formatEnvironmentInfo(ctx) {
    const env = ctx.environmentInfo ?? {}
    if (!env.biome) return 'Unknown.'

    const weather = env.is_thundering ? 'thunderstorm'
        : env.is_raining ? 'raining'
            : 'clear'
    const location = env.can_see_sky === false ? 'underground / no sky visible (likely a cave or tunnel)' : 'outdoors / sky visible'

    return `Biome: ${env.biome} | Time: ${env.time_of_day ?? 'unknown'} | Weather: ${weather} | ${location}`
}

// THIS IS THE PIECE THAT SHOWS THE LAST USER MESSAGE IN THE SURVIVAL LOOP PROMPT.
function formatLastUserMessage(ctx) {
    const last = ctx.lastUserMessage
    if (!last) return 'None recently.'
    const secondsAgo = Math.floor((Date.now() - last.timestamp) / 1000)
    return `${last.player} said: "${last.message}" (${secondsAgo}s ago)`
}

function buildRecommendation(ctx) {
    const hints = []
    const env = ctx.environmentInfo ?? {}
    const hp = ctx.lilyHp ?? 20
    const hunger = ctx.lilyHunger ?? 20
    const underground = env.can_see_sky === false
    const isNight = ['night', 'midnight', 'predawn'].includes(env.time_of_day)
    const hostilesNearby = (ctx.hostiles ?? []).length > 0
    const blocksNearby = (ctx.blocksOfInterest ?? []).length > 0
    const lowHpThreshold = ctx.opts?.lowHpThreshold ?? 10

    if (hp <= lowHpThreshold) hints.push('Health is low — retreating or being cautious is wise right now.')
    if (hunger <= 6) hints.push('Hunger is low — eat something from inventory if food is available.')
    if (underground && blocksNearby) hints.push('Underground with ores nearby, a good time to mine ores unless told otherwise.')
    if (isNight && !underground && hostilesNearby) hints.push('Nighttime with hostiles nearby — fight if safe, otherwise retreat.')
    if (!hostilesNearby && !blocksNearby && hunger > 10 && hp > lowHpThreshold) hints.push('Nothing urgent nearby, choose to do whatever seems best - hunt, break, or follow')

    return hints.length ? hints.join(' ') : 'Nothing particular stands out,  choose to do whatever seems best - hunt, break, or follow'
}

export function buildWorldStateBlock(ctx) {
    const lilyPos = ctx.lilyPos
    if (!lilyPos) return null

    const hp = ctx.lilyHp ?? 20
    const hunger = ctx.lilyHunger ?? 20
    const armor = ctx.lilyArmor ?? 0

    let inventoryText = ''
    for (let slot = 1; slot <= 36; slot++) {
        const entry = ctx.inventoryItems?.[slot]
        if (!entry) continue
        const [id, count] = entry.split(' x')
        inventoryText += `Slot ${slot}: ${cleanName(id)}${count ? ` x${count}` : ''}\n`
    }

    const players = Object.entries(ctx.players ?? {})
    const hostiles = ctx.hostiles ?? []
    const passives = ctx.passives ?? []
    const blocksOfInterest = ctx.blocksOfInterest ?? []

    const nearbyPlayers = players.length
        ? players.map(([name, p]) => formatPlayer(name, p, lilyPos)).join('\n')
        : 'None nearby.'
    const nearbyHostiles = hostiles.length
        ? hostiles.map(e => formatEntity(e, lilyPos)).join('\n')
        : 'None nearby.'
    const nearbyPassive = passives.length
        ? passives.map(e => formatEntity(e, lilyPos)).join('\n')
        : 'None nearby.'
    const nearbyBlocks = blocksOfInterest.length
        ? blocksOfInterest.map(b => formatBlockOfInterest(b, lilyPos)).join('\n')
        : 'None nearby.'

    return `
# CURRENT ACTIVITY
${getStateDescription(ctx)}

# ENVIRONMENT
${formatEnvironmentInfo(ctx)}

# YOUR STATUS
- Health: ${hp}/20_break
- Hunger: ${hunger}/20
- Armor: ${armor}/20
- Position: (${Math.floor(lilyPos.x)}, ${Math.floor(lilyPos.y)}, ${Math.floor(lilyPos.z)})

# YOUR INVENTORY (SLOTS 1-36)
${inventoryText}
# NEARBY ENTITIES
## Players
${nearbyPlayers}

## Hostile Mobs
${nearbyHostiles}

## Passive Mobs
${nearbyPassive}

# NEARBY BLOCKS OF INTEREST
(wood, ore, food sources — use these coordinates if you decide to mine/break something; never guess coordinates)
${nearbyBlocks}
`.trim()
}

export function buildSurvivalPrompt(ctx, { allowMessage = false } = {}) {
    const worldState = buildWorldStateBlock(ctx)
    if (!worldState) return null

    const messagingSection = allowMessage ? `
# MESSAGING
You can also say something in chat right now if it feels natural — a reaction to what's around you, banter with a nearby player, whatever fits. Don't force it, silence is fine too. Just write it as your normal reply text alongside your action — do not call a tool for it, it's not one of the available tools.` : `
# NO CHAT THIS TICK
Do not say anything in chat right now — you're not talking this tick, only deciding what to do. Don't include any reply text, just call the tool.`

    return `
${worldState}

# LAST MESSAGE FROM A PLAYER
${formatLastUserMessage(ctx)}
Check if that message is actually asking you to DO something right now (e.g. "attack anything you see", "mine all the iron you can find", "keep following me"). If it is, let it guide your action this tick — you don't need to be told again for every single tick, keep acting on it naturally until it's clearly done or countermanded. If it's just chat, banter, or unrelated to action (or there's nothing recent), ignore it for the purposes of deciding what to do.

# SITUATIONAL RECOMMENDATION
${buildRecommendation(ctx)}
This is a suggestion based on current conditions, not a command — weigh it against the last message above and use your judgement.

# DECISION GUIDELINES
Every tick you must make use of the minecraft_action_* tools depending on the context. You can call tools more than once if you need to, per example if you want to break multiple blocks.
Note that if the requested action is not possible because the requested block or mob does not appear in the list, do NOT call the tool. Just wait for the block or mob to appear in the list later.
Never attempt to mine a block not listed in the Blocks of Interest section.
Never attempt to attack a mob not listed in the Hostile/Passive Mobs section.

# ACTION PRIORITY:
- If the last message from a player gave you a standing instruction (e.g. "follow me", "keep attacking") that hasn't been completed or countermanded, that instruction outranks everything below except your own survival — keep doing it.
- If your health is low, prioritize retreating or healing.
- If there are hostile mobs nearby and no standing instruction says otherwise, prioritize fighting or avoiding them.
- If there are blocks of interest nearby and you are not currently under a standing instruction, consider mining or collecting them.
- If none of the above apply, choose to do whatever seems best - hunt, break, or follow
${messagingSection}

# TOOLS
Only use the minecraft_action_* tools you've been given. Never invent arguments. For minecraft_action_break_listed, only ever use coordinates that actually appear under Blocks of Interest above — never guess coordinates.
`.trim()
}