import { SlashCommandBuilder } from "discord.js"
import { HytaleAIChat } from "../ai/ollama.js"
import { config } from "../utils/config.js"

const ai = new HytaleAIChat(config.modelName)

export const data = new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Talk to Lily")
    .addStringOption(option =>
        option.setName("message")
              .setDescription("What you want to say")
              .setRequired(true)
    )

export async function execute(interaction) {
    const message = interaction.options.getString("message")
    const username = interaction.user.username

    await interaction.deferReply()

    const reply = await ai.chat(message)

    await interaction.editReply(
        username + ": " + message +
        "\n ------- \n" +
        reply.replace(/\/\w+.*$/s, "").trim()
    )
}
