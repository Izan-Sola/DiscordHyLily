// STTS/transcription/index.js
import { EventEmitter } from 'events';
import { initVad, destroyVad } from './vad.js';
import { startRecorder, stopRecorder } from './recorder.js';
import { transcribeBuffer, cleanTranscript, extractWakeSentence } from './transcriber.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { unlink, readFile } from 'fs/promises';
import cfg from '../config/index.js';

const emitter = new EventEmitter();
let vad = null;
let recorder = null;
let ambientBuffer = [];
let lastTranscript = '';
let manualActive = false;
let manualProc = null;
let manualResolve = null;
const MANUAL_AUDIO_PATH = join(tmpdir(), 'lily_manual_audio.wav');

export function getLastTranscript() { return lastTranscript; }
export function getAmbientBuffer() { return ambientBuffer; }
export function isManualRecordingActive() { return manualActive; }

export async function start() {
    if (vad) {
        Logger.info('[STTS] already running');
        return;
    }

    Logger.info('[STTS] initializing VAD...');
    vad = await initVad({
        onSpeechStart: () => {
            // Logger.debug('[STTS] speech started');
            emitter.emit('speechStart');
        },
        onSpeechEnd: async (float32Audio) => {
            // Logger.debug('[STTS] speech ended, transcribing...');
            const rawText = await transcribeBuffer(floatToWav(float32Audio));
            const text = cleanTranscript(rawText);

            if (!text) {
                // Logger.debug('[STTS] empty transcript, ignoring');
                return;
            }

            lastTranscript = text;
            ambientBuffer.push(text);
            if (ambientBuffer.length > 10) ambientBuffer.shift();

            emitter.emit('speech', text);
            Logger.success(`[STTS] Speech: "${text}"`);

            if (cfg.enableWakeWord === false) {
             //   Logger.info(`[STTS] Wake word disabled, treating as wake: "${text}"`);
                emitter.emit('wake', text, text);
            } else {
                const wake = extractWakeSentence(text);
                if (wake) {
                    Logger.success(`[STTS] Wake word detected: "${wake}"`);
                    emitter.emit('wake', wake, text);
                }
                // else: no wake word (silent)
            }
        }
    });

    Logger.info('[STTS] starting recorder...');
    recorder = startRecorder((chunk) => {
        if (vad) {
            vad.processAudio(int16BufferToFloat32(chunk)).catch(err => {
                Logger.error('[STTS] VAD processing error:', err.message);
            });
        }
    });

    Logger.success('[STTS] Transcription started, listening for audio...');
}

export function stop() {
    if (recorder) stopRecorder(recorder);
    if (vad) destroyVad(vad);
    vad = null;
    recorder = null;
    ambientBuffer = [];
    lastTranscript = '';
    if (manualProc) {
        manualProc.kill('SIGTERM');
        manualProc = null;
    }
    manualActive = false;
    Logger.info('[STTS] transcription stopped');
}

export function skipCurrentRecording() {
    if (vad) vad.flush().catch(() => { });
}

export function startManualRecording() {
    if (manualActive) return;
    manualActive = true;
    Logger.info('[STTS] manual recording started');

    if (vad) vad.flush().catch(() => { });
    const isWindows = String(cfg.tts.platform || 'GNOME').toUpperCase() === 'WINDOWS';
    manualProc = isWindows
        ? spawn('ffmpeg', [
            '-y',
            '-loglevel', 'error',
            '-f', 'dshow',
            '-i', `audio=${cfg.audioMonitorSource}`,
            '-ac', '1',
            '-ar', '16000',
            MANUAL_AUDIO_PATH,
        ])
        : spawn('parec', [
            '--file-format=wav',
            '--channels=1',
            '--rate=16000',
            '-d', cfg.audioMonitorSource,
            MANUAL_AUDIO_PATH,
        ]);
    manualProc.on('error', (err) => {
        Logger.error('[STTS] manual recording failed:', err.message);
        manualActive = false;
        manualProc = null;
    });
}

export function stopManualRecording() {
    if (!manualActive || !manualProc) return Promise.resolve('');
    Logger.info('[STTS] manual recording stopping...');
    const proc = manualProc;
    manualProc = null;
    const isWindows = String(cfg.tts.platform || 'GNOME').toUpperCase() === 'WINDOWS';
    return new Promise((resolve) => {
        proc.once('exit', async () => {
            try {
                const rawText = await transcribeFile(MANUAL_AUDIO_PATH);
                await unlink(MANUAL_AUDIO_PATH).catch(() => { });
                const text = cleanTranscript(rawText);
                Logger.success(`[STTS] Manual transcript: "${text}"`);
                manualActive = false;
                resolve(text);
            } catch (err) {
                Logger.error('[STTS] manual transcription error:', err.message);
                manualActive = false;
                resolve('');
            }
        });
        if (isWindows) {
            proc.stdin.write('q');
        } else {
            proc.kill('SIGTERM');
        }
    });
}

export function on(event, callback) {
    emitter.on(event, callback);
}

export function off(event, callback) {
    emitter.off(event, callback);
}

function floatToWav(float32Audio, sampleRate = 16000) {
    const pcm16 = new Int16Array(float32Audio.length);
    for (let i = 0; i < float32Audio.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Audio[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const dataSize = pcm16.length * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).copy(buffer, 44);
    return buffer;
}

function int16BufferToFloat32(buf) {
    const sampleCount = buf.length >> 1;
    const out = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        const sample = buf.readInt16LE(i * 2);
        out[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
    }
    return out;
}

async function transcribeFile(wavPath) {
    const buf = await readFile(wavPath);
    return transcribeBuffer(buf);
}