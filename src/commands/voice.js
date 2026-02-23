import { SlashCommandBuilder } from "discord.js"
import { joinVoiceChannel, getVoiceConnection } from "@discordjs/voice"
import { startVoiceSession } from "../bot.js"

export const data = new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Control Lily's voice channel presence")
    .addSubcommand(sub =>
        sub.setName("join")
           .setDescription("Lily joins your current voice channel")
    )
    .addSubcommand(sub =>
        sub.setName("leave")
           .setDescription("Lily leaves the voice channel")
    )

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand()

    // ─── /voice join ─────────────────────────────────────────────────────────
    if (subcommand === "join") {
        const voiceChannel = interaction.member.voice?.channel

        if (!voiceChannel) {
            return interaction.reply({
                content: "You need to be in a voice channel first!",
                flags: 64,
            })
        }

        const existingConnection = getVoiceConnection(interaction.guild.id)
        if (existingConnection) {
            return interaction.reply({
                content: "I'm already in a voice channel!",
                flags: 64,
            })
        }

        const connection = joinVoiceChannel({
            channelId:      voiceChannel.id,
            guildId:        interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf:       false,
            selfMute:       false,
        })

        startVoiceSession(connection, interaction.guild)  // ← pass interaction.guild here

        return interaction.reply({
            content: `Joined **${voiceChannel.name}**! 🎙️ I'm listening~`,
        })
    }

    // ─── /voice leave ─────────────────────────────────────────────────────────
    if (subcommand === "leave") {
        const connection = getVoiceConnection(interaction.guild.id)

        if (!connection) {
            return interaction.reply({
                content: "I'm not in a voice channel!",
                flags: 64,
            })
        }

        connection.destroy()

        return interaction.reply({
            content: "Left the voice channel! 👋",
        })
    }
}