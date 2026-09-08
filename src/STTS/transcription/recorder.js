// STTS/transcription/recorder.js
import { spawn } from 'child_process';
import cfg from '../config/index.js';

const isWindows = String(cfg.tts.platform || 'GNOME').toUpperCase() === 'WINDOWS';
let carryByte = null;

export function startRecorder(onData) {
    const proc = isWindows
        ? spawn('ffmpeg', [
            '-loglevel', 'error',
            '-f', 'dshow',
            '-i', `audio=${cfg.audioMonitorSource}`,
            '-ac', '1',
            '-ar', '16000',
            '-f', 's16le',
            'pipe:1',
        ])
        : spawn('parec', [
            '--channels=1',
            '--rate=16000',
            '--format=s16le',
            '-d', cfg.audioMonitorSource,
        ]);

    proc.stdout.on('data', (chunk) => {
      //  console.log('[STTS recorder] chunk bytes:', chunk.length);
        if (carryByte !== null) {
            chunk = Buffer.concat([carryByte, chunk]);
            carryByte = null;
        }
        if (chunk.length % 2 !== 0) {
            carryByte = Buffer.from(chunk.subarray(chunk.length - 1));
            chunk = chunk.subarray(0, chunk.length - 1);
        }
        if (chunk.length) onData(chunk);
    });

    proc.on('error', (err) => {
        console.error('[STTS recorder] error:', err.message);
    });

    proc.on('exit', (code) => {
        if (code !== 0 && !proc.killed) {
            console.error(`[STTS recorder] exited with code ${code}, restarting...`);
            setTimeout(() => startRecorder(onData), 500);
        }
    });
    proc.stderr.on('data', (data) => {
        Logger.error('[STTS recorder] stderr:', data.toString());
    });
    return proc;
}

export function stopRecorder(proc) {
    if (proc) proc.kill('SIGTERM');
    carryByte = null;
}