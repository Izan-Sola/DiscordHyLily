import { REST, Routes } from "discord.js"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { config } from "./src/utils/config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const commands = []
const commandsPath = path.join(__dirname, "src/commands")
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"))

for (const file of commandFiles) {
    const command = await import(`./src/commands/${file}`)
    commands.push(command.data.toJSON())
}

const rest = new REST({ version: "10" }).setToken(config.token)

// Register global commands
await rest.put(
    Routes.applicationCommands(config.clientId),
    { body: commands }
)

console.log("✅ Slash commands deployed globally!")
