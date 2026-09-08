// STTS/transcription/transcriber.js
import { readFile } from 'fs/promises';
import cfg from '../config/index.js';

export async function transcribeBuffer(wavBuffer) {
    const form = new FormData();
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    try {
       // console.log(`[STTS transcriber] sending ${wavBuffer.length} bytes to Whisper`);
        const res = await fetch(cfg.whisperSidecarUrl, {
            method: 'POST',
            body: form,
        });
        if (!res.ok) {
            console.error(`[STTS transcriber] whisper server error: ${res.status}`);
            return '';
        }
        const data = await res.json();
       // console.log(`[STTS transcriber] received: "${data.text}"`);
        return (data.text ?? '').replace(/\n/g, ' ').trim();
    } catch (err) {
        Logger.error('[STTS transcriber] request failed:', err.message);
        return '';
    }
}

export async function transcribeFile(wavPath) {
    const buf = await readFile(wavPath);
    return transcribeBuffer(buf);
}

export function cleanTranscript(text) {
    return text.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
}

export function extractWakeSentence(text) {
    const wakeWords = (Array.isArray(cfg.wakeWords) ? cfg.wakeWords : [cfg.wakeWords])
        .map(w => w.toLowerCase());
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
        const sLower = s.toLowerCase();
        if (wakeWords.some(w => sLower.includes(w))) return s.trim();
    }
    return null;
}