// voiceAssistant/index.js
import { stt, tts } from '../STTS/index.js';              // <-- changed
import { SYSTEM_PROMPT } from '../ai/prompts.js';
import { ai } from '../discord/bot.js';
import { VOICE_ASSISTANT_CHANNEL_ID } from '../ai/Lily.js';

const ASSISTANT_ENABLED = true; // or from config

let started = false;

export function startVoiceAssistant() {
    if (!ASSISTANT_ENABLED || started) return;
    started = true;

    stt.on('wake', async (wakeSentence, fullText) => {    // <-- changed
   //     console.log(`[voiceAssistant] wake: ${wakeSentence}`);
        try {
            const systemPrompt = SYSTEM_PROMPT;
            const result = await ai.chat(VOICE_ASSISTANT_CHANNEL_ID, wakeSentence, systemPrompt, {}, []);   if (result && result.text) {
                const reply = result.text;
                // console.log(`[voiceAssistant] reply: ${reply}`);
                await tts.speak(reply);                    
            }
        } catch (err) {
            console.error('[voiceAssistant] error:', err.message);
        }
    });

  //  console.log('[voiceAssistant] started, listening for wake words...');
}

export function stopVoiceAssistant() {
    started = false;
    // We don't remove listeners; they'll be garbage collected on stop
    console.log('[voiceAssistant] stopped');
}