// STTS/config/index.js
import { readFileSync, watch } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, './config.json');

let cache = {};
let debounceTimer = null;

function loadConfigFile() {
    try {
        const raw = readFileSync(CONFIG_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        console.error(`[STTS/config] failed to read/parse config.json: ${err.message}`);
        return null;
    }
}

cache = loadConfigFile() ?? {};

function watchConfig() {
    try {
        const watcher = watch(CONFIG_PATH, (eventType) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const next = loadConfigFile();
                if (next) {
                    cache = next;
                    console.log('[STTS/config] config.json reloaded');
                }
            }, 150);
            if (eventType === 'rename') {
                watcher.close();
                setTimeout(watchConfig, 150);
            }
        });
    } catch (err) {
        console.error(`[STTS/config] watch error: ${err.message}`);
    }
}
watchConfig();

const cfg = new Proxy(
    {},
    {
        get(_target, prop) {
            return cache[prop];
        },
        has(_target, prop) {
            return prop in cache;
        },
        ownKeys() {
            return Reflect.ownKeys(cache);
        },
        getOwnPropertyDescriptor(_target, prop) {
            return Object.getOwnPropertyDescriptor(cache, prop);
        },
    }
);

export default cfg;