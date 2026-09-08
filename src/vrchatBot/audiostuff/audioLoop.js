// vrchatBot/audiostuff/audioLoop.js
import { stt, speak } from '../../STTS/index.js';                // <-- changed
import { requestReply } from '../server.js';
import { setStatus } from '../util/chatbox.js';
import cfg from '../config.js'; // VRChat-specific config still separate

const realLog = (msg) => process.stdout.write(msg + '\n');

let buttInEnabled = true;
let buttInTimer = null;
let ambientBuffer = [];

let listenersAttached = false;

export function setupVrchatVoice() {
  if (listenersAttached) return;
  listenersAttached = true;

  // Wake-word handling
  stt.on('wake', async (wakeSentence, fullText) => {           // <-- changed
    realLog(`[voice] wake: ${wakeSentence}`);
    setStatus('Processing...');
    const { reply, error } = await requestReply('user', wakeSentence);
    if (error) {
      realLog(`[voice] wake skipped: ${error}`);
    } else {
      realLog(`[voice] lily: ${reply}`);
    }
  });

  // Ambient speech (for butt-in)
  stt.on('speech', (text) => {                                 // <-- changed
    ambientBuffer.push(text);
    if (ambientBuffer.length > 10) ambientBuffer.shift();
  });

  scheduleButtIn();
}

function scheduleButtIn() {
  const delay = cfg.BUTTIN_MIN_MS + Math.random() * (cfg.BUTTIN_MAX_MS - cfg.BUTTIN_MIN_MS);
  buttInTimer = setTimeout(runButtInCheck, delay);
}

async function runButtInCheck() {
  const transcript = ambientBuffer.join(' ').trim();
  ambientBuffer = [];

  if (buttInEnabled && transcript) {
    const { reply, error } = await requestReply('ambient', transcript);
    if (!error && reply && reply !== 'NONE') {
      realLog(`[voice] butt-in: ${reply}`);
    }
  }

  scheduleButtIn();
}

export function startVoiceListener() {
  setupVrchatVoice();
  realLog('[voice] VRChat voice listeners attached');
}

export function stopVoiceListener() {
  if (buttInTimer) clearTimeout(buttInTimer);
  listenersAttached = false;
  realLog('[voice] VRChat voice stopped');
}

export function toggleButtIn() {
  buttInEnabled = !buttInEnabled;
  realLog(`[voice] butt-in ${buttInEnabled ? 'enabled' : 'disabled'}`);
  return buttInEnabled;
}

export function isButtInEnabled() {
  return buttInEnabled;
}

export function toggleManualRecording() {
  if (stt.isManualRecordingActive()) {                         // <-- changed
    stt.stopManualRecording().then(text => {                   // <-- changed
      if (text) {
        realLog(`[voice] manual heard: "${text}"`);
        requestReply('user', text, { bypassCooldown: true }).then(({ reply, error }) => {
          if (error) realLog(`[voice] manual skipped: ${error}`);
          else realLog(`[voice] lily (manual): ${reply}`);
        });
      } else {
        realLog('[voice] manual recording was empty');
      }
    });
  } else {
    stt.startManualRecording();                                // <-- changed
    realLog('[voice] manual recording started (press Enter again to stop)');
  }
}

export function isManualRecording() {
  return stt.isManualRecordingActive();                        // <-- changed
}

export async function forceSendLastTranscript(withImage = false) {
  const text = stt.getLastTranscript();                        // <-- changed
  if (!text) {
    realLog('[voice] force-send: nothing transcribed yet');
    return;
  }
  realLog(`[voice] force-send${withImage ? ' +image' : ''}: ${text}`);
  const { reply, error } = await requestReply('user', text, { withImage, bypassCooldown: true });
  if (error) realLog(`[voice] force-send skipped: ${error}`);
  else realLog(`[voice] lily (forced): ${reply}`);
}

export function skipCurrentRecording() {
  stt.skipCurrentRecording();                                  // <-- changed
}