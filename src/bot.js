import { Client, Collection, GatewayIntentBits } from "discord.js"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { HytaleAIChat } from "./ai/ollama.js"
import { config } from "./utils/config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ai = new HytaleAIChat(config.modelName)

export async function createBot() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ]
    })

    client.commands = new Collection()

    const commandsPath = path.join(__dirname, "commands")
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"))

    for (const file of commandFiles) {
        const command = await import(`./commands/${file}`)
        client.commands.set(command.data.name, command)
    }

    client.on("interactionCreate", async interaction => {
        if (!interaction.isChatInputCommand()) return
        const command = client.commands.get(interaction.commandName)
        if (!command) return
        try {
            await command.execute(interaction)
        } catch (error) {
            console.error(error)
            await interaction.reply({ content: "Error executing command", ephemeral: true })
        }
    })

    client.on("messageCreate", async message => {
        if (message.author.bot) return
        if (!message.mentions.has(client.user)) return

        const authorName = message.member?.displayName || message.author.username

        const userInput = message.content
            .replace(`<@${client.user.id}>`, "")
            .replace(`<@!${client.user.id}>`, "")
            .trim()

        if (!userInput) {
            await message.reply("Yes? 🍓")
            return
        }

        let formattedMessage = ""

        // Reply handling for messages that directly reply to another message
        if (message.reference?.messageId) {
            try {
                const referenced = await message.channel.messages.fetch(message.reference.messageId)

                if (referenced) {
                    const repliedUser =
                        referenced.member?.displayName || referenced.author.username

                    const quoted = referenced.content
                        ?.replace(/\n/g, " ")
                        .slice(0, 120)

                    formattedMessage =
                        `${authorName} (replying to ${repliedUser} who said "${quoted}"):\n${userInput}`
                }
            } catch {}
        }

        // Mention handling (excluding Lily herself)
        if (!formattedMessage && message.mentions.users.size > 1) {
            const mentionedUsers = message.mentions.users
                .filter(u => u.id !== client.user.id)
                .map(u => message.guild.members.cache.get(u.id)?.displayName || u.username)

            if (mentionedUsers.length > 0) {
                formattedMessage =
                    `${authorName} (mentioning ${mentionedUsers.join(", ")}):\n${userInput}`
            }
        }

        if (!formattedMessage) {
            formattedMessage = `${authorName}: ${userInput}`
        }

        await message.channel.sendTyping()

        try {
            const reply = await ai.chat(formattedMessage)
            await message.reply(reply)
        } catch (err) {
            console.error("Ping handler error:", err)
            await message.reply("I'm having trouble thinking right now, sorry!")
        }
    })

    return client
}
