// STTS/voice/index.js
import { spawn } from 'child_process';
import cfg from '../config/index.js';

const SINK_NAME = cfg.tts.sinkName || 'lily_voice';
const SAMPLE_RATE = 24000;
const DEFAULT_VOICE = cfg.tts.edgeVoice || 'en-US-AnaNeural';
const TTS_ENGINE = (cfg.tts.engine || 'edge-tts').toLowerCase();
const isWindows = String(cfg.tts.platform || 'GNOME').toUpperCase() === 'WINDOWS';
const EDGE_TTS_BIN = process.env.EDGE_TTS_BIN || 'edge-tts';

function silenceStreamErrors(...streams) {
    for (const s of streams) {
        if (s) s.on('error', () => { /* expected on kill — pipe already torn down */ });
    }
}

function spawnPlayer() {
    const player = isWindows
        ? spawn('ffplay', [
            '-loglevel', 'quiet',
            '-nodisp',
            '-autoexit',
            '-f', 's16le',
            '-ar', String(SAMPLE_RATE),
            '-ac', '1',
            '-i', 'pipe:0',
        ])
        : spawn('paplay', [
            '--raw',
            `--rate=${SAMPLE_RATE}`,
            '--format=s16le',
            '--channels=1',
            `--device=${SINK_NAME}`,
        ]);
    player.on('error', (err) => console.error('[STTS voice] player failed:', err.message));
    silenceStreamErrors(player.stdin);
    return player;
}

let activePlayer = null;
let activeUpstream = [];
let activeAbort = null;
let generation = 0;

// Kills the current playback chain and resolves once every process in it
// has actually exited, so callers can safely start a new chain without
// racing the old one for the audio sink.
function killActive() {
    const upstream = activeUpstream;
    const player = activePlayer;
    const abort = activeAbort;
    activeUpstream = [];
    activePlayer = null;
    activeAbort = null;

    if (abort) abort.abort();

    const procs = [...upstream, player].filter(Boolean);
    if (!procs.length) return Promise.resolve();

    const waits = procs.map((p) => new Promise((resolve) => {
        if (p.exitCode !== null || p.signalCode !== null) return resolve();
        p.once('exit', resolve);
        p.once('error', resolve);
    }));

    for (const p of procs) {
        // Unpipe before killing so a half-dead downstream doesn't get fed
        // more writes than it can error out cleanly.
        p.stdout?.unpipe();
        p.kill('SIGTERM');
    }

    // Don't hang forever if a process ignores SIGTERM.
    const timeout = new Promise((resolve) => setTimeout(resolve, 1500));
    return Promise.race([Promise.all(waits), timeout]);
}

function sanitizeInput(text) {
    return text.replace(/[\r\n]+/g, ' ').trim();
}

function playPcmStream(pcmStream, myGen) {
    const player = spawnPlayer();
    silenceStreamErrors(pcmStream);
    pcmStream.pipe(player.stdin);
    activePlayer = player;
    return new Promise((resolve) => {
        player.on('exit', () => {
            if (activePlayer === player) activePlayer = null;
            resolve();
        });
    });
}

async function speakEdgeTts(clean, myGen) {
    const voice = cfg.tts.edgeVoice || DEFAULT_VOICE;
    const rate = cfg.tts.edgeRate || '+20%';
    const synth = spawn(EDGE_TTS_BIN, ['--voice', voice, '--rate', rate, '--text', clean, '--write-media', '-']);
    synth.on('error', (err) => console.error('[STTS voice] edge-tts failed:', err.message));
    synth.stderr.on('data', () => { });

    const decoder = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', String(SAMPLE_RATE),
        '-ac', '1',
        'pipe:1',
    ]);
    decoder.on('error', (err) => console.error('[STTS voice] ffmpeg failed:', err.message));
    silenceStreamErrors(synth.stdout, decoder.stdin, decoder.stdout);

    synth.stdout.pipe(decoder.stdin);
    activeUpstream = [synth, decoder];

    if (myGen !== generation) { synth.kill('SIGTERM'); decoder.kill('SIGTERM'); return; }

    await playPcmStream(decoder.stdout, myGen);
    if (activeUpstream[0] === synth) activeUpstream = [];
}

async function speakXtts(clean, myGen) {
    const url = cfg.tts.xttsUrl;
    if (!url) {
        console.error('[STTS voice] xttsUrl not set');
        return;
    }
    const player = spawnPlayer();
    activePlayer = player;
    const playDone = new Promise((resolve) => {
        player.on('exit', () => {
            if (activePlayer === player) activePlayer = null;
            resolve();
        });
    });
    const abort = new AbortController();
    activeAbort = abort;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: clean }),
            signal: abort.signal,
        });
        if (!res.ok || !res.body) {
            console.error('[STTS voice] xtts error:', res.status, res.statusText);
            player.stdin.end();
        } else {
            const reader = res.body.getReader();
            try {
                while (true) {
                    if (myGen !== generation) break; // superseded — stop feeding a dead/dying player
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!player.stdin.writable) break;
                    player.stdin.write(Buffer.from(value));
                }
            } catch (err) {
                if (err.name !== 'AbortError') console.error('[STTS voice] xtts stream error:', err.message);
            } finally {
                player.stdin.end();
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') console.error('[STTS voice] xtts request failed:', err.message);
        player.stdin.end();
    } finally {
        if (activeAbort === abort) activeAbort = null;
    }
    await playDone;
}

export async function speak(text) {
    const clean = sanitizeInput(text);
    if (!clean) return;

    const myGen = ++generation;

    if (activePlayer || activeUpstream.length || activeAbort) {
        Logger.warning('[STTS voice] speak() while already playing – killing previous');
        await killActive();
    }
    if (myGen !== generation) return; // a newer speak() call already superseded us

    if (TTS_ENGINE === 'xtts') {
        await speakXtts(clean, myGen);
    } else {
        if (TTS_ENGINE !== 'edge-tts') {
            Logger.warning(`[STTS voice] unknown engine "${TTS_ENGINE}", falling back to edge-tts`);
        }
        await speakEdgeTts(clean, myGen);
    }
}