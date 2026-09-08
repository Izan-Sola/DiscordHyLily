import readline from "readline";
import { initFollow, stopFollow, toggleFollowFeature } from "./bot/follow.js";
import { initOsc } from "./vrchat/osc.js";
import { triggerAvatarActionById } from "./bot/avatarActions.js";
import { startWebServer, requestReply, setBrain } from "./server.js";
import { startVoiceListener, stopVoiceListener, skipCurrentRecording, toggleManualRecording, toggleButtIn, forceSendLastTranscript } from "./audiostuff/audioLoop.js";
import { initVrchatAutoJoin, stopVrchatAutoJoin, toggleAutoJoin } from "./vrchat/vrchatBridge.js";

// Entry point for the VRChat avatar bridge when this process is started
// with the 'vrchat' flag (see ../start.js). Everything below is the same
// wiring the standalone app used to do at module load time -- now wrapped
// in a function so it only runs when the flag opts in, and so it can
// share the one `ai` (Lily) instance the rest of the process already
// built instead of talking to a local Ollama endpoint on its own.
export async function startVrchatBot({ ai }) {
    setBrain(ai);

    initOsc();
    initFollow();
    startWebServer(3030);
    // Start voice listener (now just attaches event listeners, doesn't start audio capture)
    startVoiceListener();
    initVrchatAutoJoin();

    console.log(`
[vrchat] Commands:
  !<text>    - send text-only message to Lily     (e.g. !hi)
  !+<text>   - screenshot + message to Lily        (e.g. !+what do you see)
  <space>    - while Lily is listening, skip the countdown and process now
  <backspace> - force-send whatever was last transcribed, text-only, no wake word or cooldown needed
  <tab>      - same as backspace, but attaches a screenshot to the forced send
  1-8        - fire the matching avatar action directly over OSC (testing, bypasses the brain)
  <enter>    - press on an empty line to start an untimed recording; press
               again to stop, transcribe, and send it -- bypasses the wake word
  b          - toggle ambient butt-in commentary on/off
  j          - toggle auto-joining instances you invite the bot to
`);

    // output (and terminal:true) must be passed for readline to treat this as
    // a real terminal -- without it, raw/keypress mode never turns on, so
    // spacebar never fires (Enter still works because that's just a buffered
    // line read, not a keypress).
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });

    const onKeypress = (str, key) => {
        if (key?.name === "space") {
            skipCurrentRecording();
        }
        if (key?.name === "b" && !key.ctrl && !key.meta) {
            toggleButtIn();
        }
        if (key?.name === "j" && !key.ctrl && !key.meta) {
            toggleAutoJoin();
        }
        if (key?.name === "f" && !key.ctrl && !key.meta) {
            const enabled = toggleFollowFeature();
            console.log(`[vrchat] follow ${enabled ? "enabled" : "disabled"}`);
        }
        if (key?.name === "backspace") {
            forceSendLastTranscript();
        }
        if (key?.name === "tab") {
            forceSendLastTranscript(true);
        }
        if (key?.name && !key.ctrl && !key.meta && /^[1-8]$/.test(key.name)) {
            const result = triggerAvatarActionById(Number(key.name));
            console.log(`[vrchat] ${result}`);
        }
    };

    // readline already puts a TTY stdin into keypress mode -- just listen in.
    if (process.stdin.isTTY) {
        process.stdin.on("keypress", onKeypress);
    }

    rl.on("line", async (line) => {
        const raw = line.trim();

        if (raw === "") {
            toggleManualRecording();
            return;
        }

        if (!raw.startsWith("!")) {
            console.log("(ignored -- messages must start with ! or !+)");
            return;
        }

        // Every prompt now always carries a screenshot, so !text and !+text
        // behave the same -- !+ is kept around as a familiar alias.
        const text = raw.startsWith("!+") ? raw.slice(2).trim() : raw.slice(1).trim();
        console.log("(capturing screenshot...)");
        const { reply, error } = await requestReply("user", text, { withImage: true });
        if (error) {
            console.log(`(skipped: ${error})`);
            return;
        }
        console.log(`Lily: ${reply}`);
    });

    return {
        stop() {
            if (process.stdin.isTTY) process.stdin.removeListener("keypress", onKeypress);
            rl.close();
            stopFollow();
            stopVoiceListener();
            stopVrchatAutoJoin();
        },
    };
}