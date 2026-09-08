// STTS/transcription/vad.js
import { RealTimeVAD } from '@ericedouard/vad-node-realtime';
import cfg from '../config/index.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function initVad({ onSpeechStart, onSpeechEnd }) {
    const modelPath = cfg.sileroVadModelPath
        || join(__dirname, '../../silero_vad.onnx')
        || join(__dirname, '../silero_vad.onnx');

    const vad = await RealTimeVAD.new({
        positiveSpeechThreshold: cfg.vad.positiveThreshold,
        negativeSpeechThreshold: cfg.vad.negativeThreshold,
        minSpeechFrames: cfg.vad.minSpeechFrames,
        redemptionFrames: cfg.vad.redemptionFrames,
        preSpeechPadFrames: cfg.vad.preSpeechPadFrames,
        modelPath,
        onSpeechStart,
        onSpeechEnd,
    });
    vad.start();          // <-- this was missing
    return vad;
}

export function destroyVad(vad) {
    if (vad) vad.destroy();
}