import { Client, Collection, GatewayIntentBits, Partials } from "discord.js"
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

    // Slash commands
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

    // Ping/mention handler
    client.on("messageCreate", async message => {
        // Ignore bots and messages that don't ping Lily
        if (message.author.bot) return
        if (!message.mentions.has(client.user)) return

        // Strip the mention out of the message to get the actual text
        const userInput = message.content
            .replace(`<@${client.user.id}>`, "")
            .replace(`<@!${client.user.id}>`)
            .trim()

        if (!userInput) {
            await message.reply("Yes? 🍓")
            return
        }

        // Show typing indicator while Lily thinks
        await message.channel.sendTyping()

        try {
            const reply = await ai.chat(userInput)
            const cleanReply = reply.replace(/\/\w+.*$/s, "").trim()
            await message.reply(cleanReply)
        } catch (err) {
            console.error("Ping handler error:", err)
            await message.reply("I'm having trouble thinking right now, sorry!")
        }
    })

    return client
}