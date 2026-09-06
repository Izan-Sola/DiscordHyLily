## HOW TO USE
###### If you are interested in having your own VRChat bot or, for whatever reason you want to use this "brain" for your AI, you are free to do so, and you are gonna need to set up a bunch of stuff, plus a bunch of environment variables. I'm not gonna go too much into detail but all this should be helpful enough if you know what you are doing or at least are tech savvy. If not then well fuck around and find out, AI is free and learning is fun. Yes it is a lot of stuff to setup, welcome to local hosting or whatever. Yes some of my code might suck or be messy. Also this is a WIP, so yeah, it is not perfect. You might need to edit some of the provided python scripts, if you use them, just one or two variables.

###### Now theres also a video guide for the VRChat bot: https://www.youtube.com/watch?v=ylGpdnShBqA

## Index

* [Prerequisites](#prerequisites)
  * [Local AI set-up](#local-ai-set-up)
    
* [Start modes](#start-modes)
* [RAG Database](#rag-database)
* [Discord app set-up](#discord-app-set-up)
* [Memes and GIFS](#memes-and-gifs)
* [Voice](#voice)
* [Minecraft](#minecraft)

  * [Neoforge way](#neoforge-way)
  * [Mineflayer way](#mineflayer-way)
* [VSC integration](#vsc-integration)
* [VRChat WIP guide](#vrchat-wip-guide)

  * [CLI control](#cli-control)
  
* [Pi dev](#pi-dev)

### Prerequisites:

* Install [Node and NPM](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm#using-a-node-installer-to-install-nodejs-and-npm). Also [Python](https://www.python.org/downloads/).
* Recommended to have a decent GPU (12GB vram atleast) if you want to run both a decent AI model and decent transcriptor tier. If not you are gonna have to sacrifice quality on one of those, or both.
* Note that each functionality is separate from others. So if you want to only run the discord bot, you don't need to set up anything else.

#### Local AI set-up:

* This uses [llama.cpp](https://llama-cpp.com/download/) with --port 11435 to talk to the AI. Personally I use this command and flags to run it:
```
CUDA_VISIBLE_DEVICES=0 /mnt/CA200B97200B8A21/llama.cpp/build/bin/llama-server \
  --model /mnt/CA200B97200B8A21/.unsloth/studio/exports/qwen3-vl-8b-instruct-unsloth-bnb-4bit-gguf/qwen3-vl-8b-instruct.Q6_K.gguf \
  --mmproj /mnt/CA200B97200B8A21/.unsloth/studio/exports/qwen3-vl-8b-instruct-unsloth-bnb-4bit-gguf/mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf \
  --jinja \
  --parallel 1 \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --port 11435 \
  -c 12000 \
  --image-min-tokens 1024 \
  --host 0.0.0.0 \
  -ngl 999
```
* Ofc you can change/add/remove any flags, and ofc you should change the model path.

* You can browse models in [Huggingface](https://huggingface.co/models).
* Remember to change the system prompts inside **src/ai/prompts.js**.

### Start modes:

- There's a bunch of flags you can combine to enable each functionality. I.E, imagine you want discord and modded minecraft, you would use: `npm run start -- modded discord` or `npm run start -- discord modded`

- All the available flags are : `modded`, `mineflayer`, `discord`, `bending`, `vrchat` and `vtube`

All modes are configured through a unified start file (`src/start.js`) that automatically loads each functionality based on the flags you choose. The brain is designed to be modular so you can mix and match features by adding the corresponding flags to the `start` command.

> **Note:** Bending (ProjectKorra) functionality only works with the NeoForge modded Minecraft approach. Mineflayer mode does not currently support bending abilities.

### [RAG](https://aws.amazon.com/what-is/retrieval-augmented-generation) Database:

* For running the main brain, you are gonna need to run a RAG database with the same endpoints the brain uses. You can use [this](https://drive.google.com/file/d/1L3apugkfy83m9Lx7gJrxesGMYKFp7CdC/view?usp=sharing) script for the database.

### Discord app set-up:

* You are gonna need to sign up in the developer portal https://discord.com/developers/home
* You will need to run `node run deploy` to deploy all the commands globally.
* You are gonna need to add 2 environment variables:

  * **DISCORD_TOKEN**: Your application secret token found in the OAuth2 tab in your application.
  * **CLIENT_ID**: Your own user client id. Inside your profile, or by right clicking your pfp in a message, "Copy User ID" (You need to activate developer mode in settings).

### Memes and GIFS:

* You are gonna need one environment variable:

  * **KLIPY_API_KEY**: Holding your [Klipy API](https://docs.klipy.com/getting-started) key.

### Voice

* Both `edge-tts` and `StyleTTS2` can be used for voice.

* The brain currently uses the `speak()` function for the custom voice generation in audios, and `speakEdge()` for, well, using the `edge-tts` voice. If you want to use custom voice for both, or the generic `edge-tts` voice for both, just swap the function calls in the code.

* You are gonna need a few environment variables:

  * **PYTHON_BIN**: Containing the path to your python binary.
  * **EDGE_TTS_BIN**: Containing the path to your `edge-tts` binary.
  * **STYLETTS2_SCRIPT**: Containing the path to the `StyleTTS2` script. I use [this](https://drive.google.com/file/d/1yHyk1kstwbgHXBLlUh3Cnqftlc968WA_/view?usp=sharing) giga vibecoded script to optimize it so my GPU doesn't implode.
  * **VOICE_SAMPLE_PATH**: Containing the path to your voice sample for custom voice generation with `StyleTTS2`.

* For speech transcription, you are going to need `faster-whisper`. The config is hard coded in the `transcribe()` function so go there if you wanna use cpu instead of cuda, a different model tier, etc...

### Minecraft

#### Neoforge way:

* The server or world is gonna need to use this mod: https://github.com/Izan-Sola/Lily-Minecraft. Note that to use projectkorra in a modded server, you need Arclight.
* You are also gonna need to download the [SiliconeDolls](https://www.curseforge.com/minecraft/mc-mods/siliconedolls) mod as a dependency.

* If the server does not run in the same local network, you are gonna need to register your own [DuckDNS](duckdns.org) (or any other) sub-domain and edit the config file `lilybridge-common.toml` generated in the config folder of the server:
  ```toml
  [network]
         #WebSocket URL of your Node.js server.
         serverUrl = ""
  ```

* Then, run [Caddy](https://caddyserver.com/) (or any proxy) in your machine with this config:
  ```
  yourURLhere.duckdns.org {
     reverse_proxy 127.0.0.1:8766
  }
  ```

  ###### (if you are a winslop user I think you can do it through a GUI)

* Then you are gonna need to allow the port 8766 in your firewall.

* If the server runs in the same local network, then you can just use `wss://localhost:8766` or `wss://127.0.0.1:8766` as the url.

#### Mineflayer way (wip)

###### Barely tested btw. So if it doesnt work it iiiiis what it iiiiis.

* You are gonna need 4 environment variables:

  * **MC_SERVER_HOST**: The IP of the cracked server. If you wanted it to play in premium servers, your bot would need its own Microslop and Minecraft account (yes, that means paying for MC again for your bot).
  * **MC_SERVER_PORT**: The port of the server, default 25565.
  * **MC_BOT_USERNAME**: The username of your bot.
  * **MC_AUTH_PASSWORD**: The password your bot will use when attempting to /register and /login

### VSC integration

- For this I used the extension called `Continue`. There is 2 things you need to run with `node` in **src/lilycoding**, a bridge so the messages in the `Continue` chat go through the "brain" and a MCP Server for Tavily, for proper image search and url indexation.

- You need to edit `Continue`'s config, to look something like this:

   ```yaml
    name: Main Config
    version: 1.0.0
    schema: v1
    models:
      - name: a name
        provider: openai
        model: your model
        apiBase: http://localhost:8767/v1
      roles:
        - chat
        - edit
      capabilities:
        - tool_use
      requestOptions:
        timeout: 120000
    mcpServers:
     - name: a name
       type: stdio
       command: node
       args:
         - path/to/src/lilycoding/tavily-mcp-server.js
       env:
         TAVILY_API_KEY: your api key here
  ```

- Also add this tool with this config: <br><br> <img width="577" height="277" alt="image" src="https://github.com/user-attachments/assets/85b52a00-d5fe-4273-9982-adf34dd28677" /> <br>

- And preferably disable `Continue`'s own web search tool, since the brain already includes one.

### VRChat

###### I'm gonna assume you are going to run this on a separate machine and play with the bot, since the program is made for the bot to follow you.

* If you have been linked here directly, you may also want to check this: [Prerequisites](#prerequisites). And remember to change the prompts in `bot/prompts.js`
  
* If you want to run this separately (not connected to the main brain) downlaod this: https://github.com/Izan-Sola/LilyVrchat on the machine where your bot's game is gonna be running. Start it by running: `node index.js` and `node vrchatBridge.js`. For testing that the custom OSC parameters are working, you can use `node osc-test.js`, walk near your bot and check if the console logs anything. If you are gonna run it connected to the main brain, just run it with the `vrchat` flag.

* This thingy exposes a website in port 3030 as an alternative for talking to her through there via text (she will still respond in game), with an option to append a screenshot of what she sees. This is not necessary, but if you wanted to make it publicly accesible, then you would need to register a sub-domain with DuckDNS and reverse proxy.

* Needless to say you are gonna need to allow all the ports mentioned in your firewall. And port 9000 for vrchat OSC stuff.

* You are going to need a second Steam account and VRChat account.

* You are also going to need to use `faster-whisper` for the transcription. You will need to expose a python server for it. I've used [this](https://drive.google.com/file/d/1EO6iuGRIuFvvgNk5T_PBZgZrUMSJ7ejD/view?usp=drive_link) script for it, runs on port 8775.

  * If you want to change the transcription language or the model size, you need to edit the python script, changing MODEL_SIZE without language termination (tiny, small medium...) and changing language here:
    ```python
    segments, info = model.transcribe(
        tmp_path,
        language="es", #en, es, etc...
        beam_size=3,
        vad_filter=True, 
    )
    ```
* You will need to download [`Silero VAD`](https://github.com/snakers4/silero-vad/tree/master/src/silero_vad/data), specifically the "silero_vad.onnx" file. This is for detecting when there is speech or silence, to know when to start processing audio.

* You will also need to change a bunch of the values in ```config.json```:

  * **BRAIN_URL**: URL to wherever llama-server, for the standalone version, I.E: http://192.168.3.24:11435/v1/chat/completions
  * **WHISPER_SIDECAR_URL**: URL to wherever `faster-whisper` is running, I.E: http://192.168.3.24:8775/transcribe
  * **VOICE_WAKE_WORD**: A list of words that will trigger a reply from your AI, probably its name. I recommend to add some mispronunciations and to check what the transcription often confuses its name for, to add it to the list, just to be safe.
  * **TTS_ENGINE**: "edge-tts" for, well, `edge-tts`. Or `xtts` to use your custom voice. `StyleTTS2` is too slow for live talk, so you are gonna need to download `xtts` and, again, assuming you are gonna run it on a different machine, you
    will need to run a server for it, I've used [this](https://drive.google.com/file/d/1fC84_PbgrWexmEqxdrlowFcIuEuw6eAx/view?usp=sharing) script for it, runs on 8790.
  * **SILERO_VAD_MODEL_PATH**: Path to the `Silero VAD` .onnx file.
  * **AUDIO_MONITOR_SOURCE**: The source of the game's audio. On Linux, check with `pactl list sources short`, on winslop, check with `ffmpeg -list_devices true -f dshow -i dummy`.
  * **PLATFORM**: "GNOME" for gnome desktop, "WINDOWS", for windows, "KDE" for kde desktop. Note that, while it should work just fine, I have yet to properly test it on windows cuz I'm lazy to set up a VM. But if there are any issues just let me know.
  * **VRCHAT_USERNAME** and **VRCHAT_PASSWORD**: Your bot's credentials.
  * **VRCHAT_TOTP_SECRET**: The autheticator app's set up secret. If you don't set this up, every time your bot's session expires you will need to verificate manually. If you want to automate this, you need to get the secret following these steps:

     * Go to https://vrchat.com/home/profile in your bot's account, and click enable 2FA. If you already had it enabled, you are gonna need to disable it and re-enable it.
     * On this step, click "enter key manually", copy it, and paste it without the spaces as the value of the variable in the `config.json` <br> <br>
     <img width="641" height="175" alt="image" src="https://github.com/user-attachments/assets/1585146c-5b1a-4c62-8110-8852e9113975" /><br>
     ```diff
     - For the love of god, don't ever share this. Don't ever expose it anywhere. 
     - Never share the config without removing all the credential values.
     - Hell, not even to people you trust. It is a "secret" for a very good reason.
     ``` 
  * **VRCHAT_TRUSTED_INVITERS_IDS**: List of the trusted users from whom your bot will automatically accept invites. To get this, just go to https://vrchat.com/home and click on your profile nickname. An ID should appear on the URL (usr_bunchOfNumbersAndLetters)

- These variables are only needed for Linux users (paths differ depending on installation type):

  * **VRCHAT_STEAM_ROOT**: Steam installation path (i.e home/yourUser/.local/share/Steam).
  * **VRCAHT_PROTON_PATH**: Path to the proton that vrchat is actually using. (i.e home/yourUser/.local/share/Steam/steamapps/common/Proton 10.0/proton).
  * **VRCHAT_STEAM_COMPAT_DATA_PATH**: Path to the compatdata of vrchat (i.e home/yourUser/.local/share/Steam/steamapps/compatdata/438100).
  * **VRCHAT_LAUNCH_EXE_PATH**: Path to VRChat's executable (i.e /home/yourUser/.local/share/Steam/steamapps/common/VRChat/launch.exe).
  * **VRCHAT_STEAM_COMPAT_CLIENT_INSTALL_PATH**: Should be the same as **VRCHAT_STEAM_ROOT** unless you have manually changed it.

- If the game closes after sending an invitation to your bot, that's normal. It will reopen and instantly join you.

* Alright now, you are gonna need to mess with your model and the bot's model in Unity, so you are gonna need the .unitypackage of both. You can browse for free downloadable models at [VRCMods](https://vrcmods.com)

* Download [ALCOM](https://vrc-get.anatawa12.com/en/alcom), it will make it easy to upload your model once finished and will install the VRChat SDK.

* First, let's start with your model. Create a project in Unity and import the model through Assets > Import Package > Custom Package. All you are going to need is to create an empty object wherever in the model, and attach the "VRC Sender" component: <br><br>
  <img width="643" height="509" alt="image" src="https://github.com/user-attachments/assets/0573690d-7637-4efe-a8cc-3a2defc9e74c" /></br>

* Make it small and center it on your model. Change the collision tag to something unique like your nickname.

* Then, click "VRChat SDK" option on the top, log-in with YOUR account. Then in the "Builder" tab set a name to the model and click "Build & Publish", "Build type" being set to "Build & Publish Your Avatar Online".

* Now, open a new project and import your bot's model.

* You are gonna need to add 5 receiver components, one for the center and one for each side, looking something like this:  <br> <br>
  <img width="1937" height="683" alt="image" src="https://github.com/user-attachments/assets/fbe8d0fb-dc55-40d6-8557-865fbbcd4dfe" /> <br>

* Each receiver's collision tag need to match your model's  sender's collision tag name. Make the boxes generously big. They won't affect anything other than the distance at which your bot's model can detect yours.

* Each receiver's type need to be set to "Proximity". The "Parameter" names are not arbitrary, the code for the VRChat bot expects the next parameters for each receiver:

  * **"ProximityToCenter"**: for the receiver on the center.
  * **"ProximityToBack"**: for the receiver on the back.
  * **"ProximityToFront"**: for the receiver on the front.
  * **"ProximityToRight"**: for the receiver on the right.
  * **"ProximityToLeft"**: for the receiver on the left.

* Now, in the "Project" tab below, click on the model's VRC Expression Parameters (wherever the fuck the author decided to put it, good luck)

* You need to create an entry for each receiver, like this: <br> <br>
  <img width="636" height="199" alt="image" src="https://github.com/user-attachments/assets/a2cbd376-d5b1-415c-9351-66c624d5ebbd" /> <br>

* Make sure "Saved" is unchecked for all of them, and "Synced" checked.

* Then, click on the model's Animator Controller (again, wherever the fuck it might be) and add one entry for each receiver, of "float" type, like this: <br> <br>
<img width="659" height="507" alt="image" src="https://github.com/user-attachments/assets/b28b4f9e-f088-4b67-a768-64903f2042e2" /> <br>

* And you are finally good to go. Log-out of YOUR account in the VRChat SDK control panel, and log-in with your bot's account. Then name the model and publish it the same way as with yours.

* Change yourself and your bot to the respective models and test. They will appear in https://vrchat.com/home/avatars. If it doesn't work, make sure you followed all of the steps, named everything correctly, etc... If it still doesn't work, skill issue, ask Claude.

#### CLI control

* Some keys are set to do some stuff when pressed on the terminal where this thingy is running:

  * **Enter**: Start/stop forcibly recording all audio until you press enter again. With a wake word included or not, it will respond to whatever was recorded.
  * **Backspace**: Force the last transcripted text to be sent as a prompt. Useful for when a wake word is misheard or you just want it to react to something that was said.
  * **Tab**: Same shit, but with a screenshot of its game included.
  * **b**: Toggle off/on butt-in replies. It won't ever respond to anything that doesn't contain a wake word.
  * **f**: Toggle off/on following.
  * **space**: Forcibly starts processing the audio. Not so useful anymore. It was for when it used to listen for X seconds then process, so I could force processing the audio without waiting the entire timer.
  * **1 to 8**: Forcibly make it perform a default VRChat expression.

### Pi dev
 
 - You need to run the `pidev-bridge.js` inside **src/pidev-bridge/** with `node pidev-bridge.js`
 - Then edit the `models.json` config of pi-dev to look something like this:
    ```json
      {
       "providers": {
         "llama-swap": {
           "baseUrl": "url-to-bridge:3100/v1/chat/completions",
           "api": "openai-completions",
           "apiKey": "not-required",
           "models": [
             {
               "id": "qwen3-vl-8b-instruct.Q6_K",
               "name": "qwen3-vl-8b-instruct.Q6_K",
               "contextWindow": 32000,
               "maxTokens": 8096
             }
           ]
         }
       }
     }
    ```
- Ofc adjust the model id/name, context window etc...
