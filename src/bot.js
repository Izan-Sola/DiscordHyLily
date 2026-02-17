import { Client, Collection, GatewayIntentBits } from "discord.js"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export async function createBot() {
    const client = new Client({ intents: [GatewayIntentBits.Guilds] })

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

    return client
}
