import { stt, tts } from '../STTS/index.js';
import { SYSTEM_PROMPT } from '../ai/prompts.js';
import { ai } from '../start.js'         // Lily instance
import { client } from '../discord/bot.js';      // Discord client (must be exported)
import { getConfig } from '../ai/config.js';     // for discordUserID
import { VOICE_ASSISTANT_CHANNEL_ID } from '../ai/Lily.js';
import { Logger } from '../../src/utils/Logger.js'; // optional, but consistent

const ASSISTANT_ENABLED = true;
let started = false;

export function startVoiceAssistant() {
    if (!ASSISTANT_ENABLED || started) return;
    started = true;

    stt.on('wake', async (wakeSentence, fullText) => {
        try {
            const systemPrompt = SYSTEM_PROMPT;
            const result = await ai.chat(VOICE_ASSISTANT_CHANNEL_ID, wakeSentence, systemPrompt, {}, []);

            if (result && result.text) {
                const reply = result.text;
                await tts.speak(reply);

                // --- Handle GIF if present ---
                if (result.gifUrl) {
                    const config = getConfig();
                    const userId = config.discordUserID;
                    if (!userId) {
                        Logger.warning('No discordUserID configured – cannot send GIF DM', 'VOICE GIF');
                    } else if (!client) {
                        Logger.warning('Discord client not available – cannot send GIF DM', 'VOICE GIF');
                    } else {
                        try {
                            const user = await client.users.fetch(userId);
                            await user.send({
                                content: `\n${result.gifUrl}`
                            });
                            Logger.info(`Sent voice‑assistant GIF to ${userId}`, 'VOICE GIF');
                        } catch (err) {
                            Logger.error(`Failed to send GIF DM: ${err.message}`, 'VOICE GIF');
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[voiceAssistant] error:', err.message);
        }
    });
}

export function stopVoiceAssistant() {
    started = false;
    console.log('[voiceAssistant] stopped');
}