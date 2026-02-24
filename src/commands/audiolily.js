import { SlashCommandBuilder } from "discord.js"
import { speak } from "../bot.js"
import { HytaleAIChat } from "../ai/ollama.js"
import { config } from "../utils/config.js"
import fs from "fs"

const ai = new HytaleAIChat(config.modelName)

export const data = new SlashCommandBuilder()
    .setName("audiolily")
    .setDescription("Ask Lily something and she'll respond with her voice!")
    .addStringOption(option =>
        option
            .setName("message")
            .setDescription("What do you want to say to Lily?")
            .setRequired(true)
    )

export async function execute(interaction) {
    await interaction.deferReply()

    const userMessage = interaction.options.getString("message")
    const authorName  = interaction.member?.displayName || interaction.user.username

    try {
        // Get Lily's text response
        // const formattedMessage = `[${authorName}] says to you: ${userMessage}`
        const reply = await ai.chat(userMessage)
        const cleanReply = reply.replace(/\/\w+.*$/s, "").trim()

        // Convert to audio
        const oggPath = await speak(cleanReply)

        // Send the text and the audio file together
        await interaction.editReply({
            content: `💬 *"${cleanReply}"*`,
            files: [{
                attachment: oggPath,
                name: "lily_response.ogg",
                description: "Lily's voice response"
            }]
        })

        // Clean up the temp file after sending
        fs.unlink(oggPath, () => {})

    } catch (err) {
        console.error("[/audiolily] Error:", err)
        await interaction.editReply({
            content: "Sowwy, something went wrong generating my voice response! 🍓",
        })
    }
}