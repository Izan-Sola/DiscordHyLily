import { SlashCommandBuilder, EmbedBuilder } from "discord.js"

export const data = new SlashCommandBuilder()
    .setName("aboutlily")
    .setDescription("Shows information about the HyLily bot")

export async function execute(interaction) {
    const embed = new EmbedBuilder()
        .setTitle("About me!")
        .setColor(0xd04ec9) 
        .setDescription(`Here's a quick overview of me since you asked ${interaction.user.username}!`)
        .addFields(
            { 
            name: "Me!",     
            value: `Hii! I'm Lily, a cute and funny Discord bot in this server! \n I was created by ShinyShadow_! \n`,  inline: false },
            { 
            name: "What can I do?",     
            value: [
                "I can do a lot of things!",
                "- I can chat with you! Just ping me or reply to me and I'll get to you asap!",
                "  If you want to talk to me in voice chat, just join a voice channel and use /voice join!",
                "- I can also answer questions about Hytale by searching its Wiki!",
                "- I'm very smart hehe~ so I can remember facts about you and the server!",
            ].join("\n"), inline: false }

        )
        // .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
        .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp()

    await interaction.reply({ embeds: [embed] })
}