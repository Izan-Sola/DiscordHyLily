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

        const isMentioned = message.mentions.has(client.user)
        const isReplyToBot = message.reference?.messageId
            ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === client.user.id
            : false


        const authorName = message.member?.displayName || message.author.username

        const userInput = message.content
            .replace(`<@${client.user.id}>`, "")
            .replace(`<@!${client.user.id}>`, "")
            .trim()

        if (!isMentioned && !isReplyToBot)  {
            ai.observe(`${authorName} said ${userInput}`)
            return
        }
        if (!userInput) {
            await message.reply("Yes? 🍓")
            return
        }

        let formattedMessage = ""

        // Reply to another message
        if (message.reference?.messageId) {
            try {
                const referenced = await message.channel.messages.fetch(message.reference.messageId)
                if (referenced) {
                    const repliedUser = referenced.member?.displayName || referenced.author.username
                    const quoted = referenced.content?.replace(/\n/g, " ").slice(0, 120)
                    formattedMessage = `${authorName} says to you, replying to ${repliedUser} who said "${quoted}": ${userInput}`
                }
            } catch {}
        }

        // Mentioning another user
        if (!formattedMessage && message.mentions.users.size > 1) {
            const mentionedUsers = message.mentions.users
                .filter(u => u.id !== client.user.id)
                .map(u => message.guild.members.cache.get(u.id)?.displayName || u.username)
            if (mentionedUsers.length > 0) {
                formattedMessage = `${authorName} mentioned ${mentionedUsers.join(", ")}, ${authorName} says to you ${userInput}`
            }
        }

        // Plain message
        if (!formattedMessage) {
            formattedMessage = `${authorName} says to you: ${userInput}`
        }


        await message.channel.sendTyping()

        try {
            const reply = await ai.chat(formattedMessage)
            await message.reply(reply.replace(/\/\w+.*$/s, "").trim())
        } catch (err) {
            console.error("Ping handler error:", err)
            await message.reply("I'm having trouble thinking right now, sorry!")
        }
    })

    return client
}