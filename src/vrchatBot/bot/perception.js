import { exec } from "child_process";
import { readFile } from "fs/promises";
import cfg from "../util/config.js";

// Screenshot tool differs per desktop, and there's no reliable way to
// detect "KDE vs GNOME" from Node -- both are just "linux" to
// process.platform, and env-var sniffing (XDG_CURRENT_DESKTOP etc.) is
// inconsistent across distros/sessions. So this is explicit: set
// PLATFORM in config.json to "KDE", "GNOME", or "WINDOWS".
function screenshotCommand() {
  const platform = String(cfg.PLATFORM || "GNOME").toUpperCase();
  switch (platform) {
    case "KDE":
      return `spectacle -b -f -n -o "${cfg.SCREENSHOT_PATH}"`;
    case "WINDOWS":
      // No screenshot CLI ships with Windows by default -- ffmpeg (already
      // a dependency for TTS decoding) grabs the desktop via gdigrab.
      return `ffmpeg -y -loglevel error -f gdigrab -framerate 1 -i desktop -frames:v 1 "${cfg.SCREENSHOT_PATH}"`;
    case "GNOME":
    default:
      if (platform !== "GNOME") {
        Logger.warn(`[perception] unknown PLATFORM "${cfg.PLATFORM}", falling back to GNOME's gnome-screenshot`);
      }
      return `gnome-screenshot -f "${cfg.SCREENSHOT_PATH}"`;
  }
}

function captureScreen() {
  return new Promise((resolve, reject) => {
    exec(screenshotCommand(), (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export async function captureBase64() {
    await captureScreen();
    const buf = await readFile(cfg.SCREENSHOT_PATH);
    return buf.toString("base64");
}