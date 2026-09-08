// voiceAssistant/index.js
import { stt, tts } from '../STTS/index.js';              // <-- changed
import { buildVrchatSystemPrompt } from '../ai/prompts.js';
import { ai } from '../discord/bot.js';

const ASSISTANT_ENABLED = true; // or from config

let started = false;

export function startVoiceAssistant() {
    if (!ASSISTANT_ENABLED || started) return;
    started = true;

    stt.on('wake', async (wakeSentence, fullText) => {    // <-- changed
   //     console.log(`[voiceAssistant] wake: ${wakeSentence}`);
        try {
            const systemPrompt = buildVrchatSystemPrompt(false);
            const result = await ai.chat('voiceAssistant', wakeSentence, systemPrompt, {}, []);
            if (result && result.text) {
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