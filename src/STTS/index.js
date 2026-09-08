// STTS/index.js
import * as sttModule from './transcription/index.js';
import * as ttsModule from './voice/index.js';

// Re-export everything
export const stt = sttModule;
export const tts = ttsModule;

// Convenience exports
export const start = sttModule.start;
export const stop = sttModule.stop;
export const on = sttModule.on;
export const off = sttModule.off;
export const speak = ttsModule.speak;