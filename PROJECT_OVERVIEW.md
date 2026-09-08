# Lily's brain - Overview

###### Last edit: September 2026 (unfinished) This will be an in depth documentation. Believe it or not I find manually documenting stuff fun. It also makes me understand my own project better and find ways to improve it.

# Index

- [Systems](#systems)
  
  - [Tools](#tools)
    
    - [Tool executors](#tool-executors)
      
  - [Modularity](#modularity)
    
  - [Automatic training data generation](#automatic-training-data-generation)
 
  - [Custom Logger](#custom-logger)

- [Main Functionalities](#main-functionalities)
  
  - [Discord](#discord)
    
    - [Features](#features)
      
    - [Commands](#commands)

  - [STTS](#stts)
    
  - [Minecraft](#minecraft)
    
    - [Neoforge (Arclight server)](#neoforge-arclight-server)
      
      - [State Machine](#state-machine)
        
        - [States](#states)
          
        - [Helpers](#helpers)
          
      - [Prompt Builders](#prompt-builders)
        
    - [Mineflayer (wip)](#mineflayer-wip)
      
  - [Vtubing (early wip)](#vtubing-early-wip)
    
  - [VRChat](#vrchat)
 
    - [Listening and voice](#listening-and-voice)

- [Other Functionalities](#other-functionalities)
  
  - [VSC Integration](#vsc-integration)
    
  - [Pi dev](#pi-dev)
<br>

# Systems

## Tools

###### `src/ai/tools/`

- Each main functionality has its own `ToolExecutor` which contains the tool definitions for that specific functionality, its own code logic, and tool functions. Combining functionalities will make each's executor tools available globally. Note that some tools might be filtered in certains part of the code depending on the source of the user message to avoid misuse.

- The main file is `toolRouter.js` which can initialize each independent tool executor for each distinct functionality. It also includes a bunch of helper functions, and routes shared functions that pertain to a specific `ToolExecutor`.

- **Tool executors**:

  - **`ChatToolExecutor`**: Contains all tools for a conversational discord bot. Memory tools, gif/meme tools and web search. If `discord` flag is used, this executor will be enabled.

  - **`MinecraftToolExecutor`**: Contains all the tools for an assitant-like minecraft bot. Mining, dropping, attacking, etc... If either the `mineflayer` or `modded` flag is used, this executor will be enabled.

  - **`VtubeToolExecutor`**: Contains all the tools related to vtubing. Triggering expressions, etc... If the `vtube` flag is used, this executor will be enabled.
<br>

## Modularity

- The brain contains many functionalities, but not all need to be active at the same time. By mixing different flags such as `discord`, `modded`, `vtube` etc... You can choose to enable the functionalities you are actually going to use, anything else will not be enabled.

- The `start.js` file handles the brain initiation, checking the flags that were used and enabling each correspondent functionality.

- `startUtils.js` contains a bunch of helper functions to check which modes are enabled or which tools to use.
<br>

## Automatic training data generation

- The brain inlcudes a system (`saveFlawlessTurns.js`) to automatically records as many flawless turns as configurated in the `config.json` "trainingTurnWindow", and saves the entire conversation in ShareGPT format into a file named `pending_review.jsonl` to review and use as training data for finetuning. Flawless turns are such turns that execute without a single error or warning caused by the AI messing up. If a turn is not flawless, the entire conversation is dropped, and the count is restarted.
<br>

## Custom logger.

- The brain inlcudes a custom logger used by calling `Logger(message, title)`. Displays a formatted log for visual clarity both in the terminal and, if available, a discord channel. Inlcudes the methods `info`, `warning`, `success` and `error`, each with a different color. "title" helps quickly identifying where each log is from, and the color the type of the log.

# Main functionalities

## Discord

###### `src/discord/`

- The main file is `bot.js`, containing all the logic for the discord bot functionality. Handling replies, voice calls, media...

### Features

- Will respond to messages when pinged or replied to.
- Has a very small chance to butt-in and reply to someone when not directly addressed.
- Can send gifs and memes.
- Can see images sent and videos (just a few frames here and there).
- Can send audios and join calls.

### Commands

- **/about**: Displays information about the bot, see `src/discord/commands/about.js` to change the information.
- **/preferences**: Adjust your preferences such as, disabling pings, voice processing (she wont listen to you in voice calls), disabling spontaneous replies to your messages...
- **/voice join/leave**: To make her join or leave a voice channel.
- **/audio**: To make her respond with an audio message.
<br>

## Minecraft

### Neoforge (Arclight server)

###### `src/ai/minecraft/neoforgemod-way/`

#### **State Machine**

###### `src/ai/minecraft/neoforgemod-way/state-machine/`

- The main file is `bot.js`, which handles communication between the NodeJS server and the Java client via the `mcSend(type, data = {})` function:

  - **"chat"**: Displays a message in-game.
  - **"request_ability_data"**: Requests the data of all the abilities in the server. Returns the **"ability_data"** message.
  - **"get_bindings"**: Requests the current bindings of the bot. Returns the **"bindings_update"** message.
  - **"run_command"**: Runs the specified in-game command.
  - **"move_to"**: Moves to the specified coordinates.
  - **"move"**: Moves towards the specified direction.
  - **"stop"**: Stop the bot movement.
  - **"craft"**: Requests crafting the specified item. Returns **"craft_result"**.
  - **"look_at"**: Look towards the specified coordinates.
  - **"attack"**: Simulates left click, optionally swaps to the specified slot.
  - **"break"**: Breaks the block at the target coordinates, or if instead a type of block is sent, the nearest one of the same type is located.
  - **"cancel_break"**: When exiting mining state, cancels any of the tasks  started by `MiningManager.java` and resets state.
  - **"use"**: Simulates right click, optionally swaps to the specified slot.
  - **"drop"**: Drops an item, optionally swaps to the specified slot.
  - **"jump"**: Jumps.
  - **"sneak"**: Simulates shifting.
  - **"sprint"** and **"unsprint"**: Activates/cancels sprint.
  - **"hotbar"**: Swaps to the specified slot.
  - **"spawn"** Handles spawning/respawning.
  - **"look_dir"**: Offsets current look direction.
  - **"fire_pk_event"**: Handles firing events that ProjectKorra listens to, to effectively trigger abilities:

    - **"click"**: Calls `PlayerAnimationEvent`
    - **"sneak"** and **"unsneak"**: Handles sneaking.
    - **"slot"**: Handles swapping slot.
   
  - **"get_lily_state"**: Request data of the bot such as HP, coordinates, armor, food level...
  - **"get_environment_scan"**: Request data of the environment around the bot, such as biome, entities, unique blocks...
  - **"get_source_block"**: Finds the closest valid source block specified. Returns **"source_block"**.
  <br>

- The way the bot's state is managed is via a "state machine". The main file is `StateController.js` which contains a bunch of helper functions, ticks the current state, dispatches in-game actions and updates live in-game data. All states are smoothly transitioned to u sing the `transitionTo(stateName, payload = {}))` function, which can either make the bot re-enter the state with a new payload (data), or stop the current state and enter a new one.
<br>

#### **States** 

###### `states/`

  - **`AttackingSatate.js`**: Activated when a hostile mob gets too close, or via tool calling. Tracks the mob, handles look direction and attacking.
  - **`FollowingState.js`**: A simple state that handles following the player. Handles look direction and movement.
  - **`IdleState.js`**: Idle state, triggered when no condition for any other state is met. `onTick()` Checks different conditions to transtion to any other state.
  - **`MiningState.js`**: Handles mining. The `NodeJS` side only knows when the bot is busy mining, and when it has finished, the Java mod handles everything else.
  - **`RecoveringState.js`**: When low HP, the bot will automatically run towards the closes player.
  - **`DuelingState.js`**: Activated using the duel command. This state handles dueling with ProjectKorra abilities. Handles moving and look direction, block sourcing, when to send the next duel prompt, handles the ability queue, etc... Periodically requests all the necessary data to the Java mod such as coordinates, abilities binded, HP...
<br>

#### **Helpers**

###### `helpers/`

  - **`comboExecutor.js`**: Handles executing the array of abilities returned by the AI when prompted in the dueling state. `data/` Contains all the data of the server's current abilities and all the required manually-inputted information to properly executed them. Example:

      ```json
          {
              "name": "FireKick",
              "description": "[ATTACK] close range.",
              "bindsRequired": ["FireBlast"],
              "actions": ["swap:slot:FireBlast","click:left:2", "sneak:hold:1:continue", "click:left:1"],
              "cooldown": 5000,
              "range": 10,
              "actionsTime": [ 100, 250, 250, 400, 250]
          },                
      ```

  - **"bindsRequired"**: For combos only, is an array containig all the abilities required for the AI to have binded to execute the combo.
  - **"actions"**: It is the list of actions that need to be executed to perform the ability or combo, with a concrete format:

    - **"swap:slot:\<Ability>"**: Swaps to the slot on which that ability is binded. Blocking.
      
    - **"locklook"**: Locks the look direction of the bot to the current look direction. Non-blocking.
      
    - **"source:\<blocks>:<dist>"**: Finds the nearest valid source block. Non-blocking.
      
    - **"click:left|right[:N]"**: Left or right click N times. Blocking per click.
      
    - **"sneak:hold|tap[:N][:cont]"**: Hold or tap sneak, N times. Blocking by default, unless :cont is used.
      
    - **"jump[:N]"**: Jumps N times. Blocking per jump.
      
    - **"forward|back|left|right"**: Forces direction for the duration of the acion. Blocking.
      
    - **"wait"**: Sleep for the duration of the action. Blocking.
      
    - **"look:\<dir>:\<deg>"**: Offsets look direction. Blocking.
      
    - **"stop"**: Stops movement for the duration of the action. Blocking.

  - **"actionsTime"**: The time in ms that each action takes. Note that if an action is specified to be executed more than once using :N, then you will have to specifiy an action time for each.
  
> Blocking means the queue of actions will be paused until the current action finishes. Non-blocking means the queue will continue to be drained while the current action is being executed.
<br>

- **`survivalLoop.js`**: Periodically sends a prompt to the bot with all the necessary information for the bot to decide which action to take.
- **`sneak.js`**: Handles the sneak timing.
- **`movement.js`**: Handles moving to the target location. Re sends "move_to" if the target moves too far.
<br>

#### **Prompt Builders** 

###### `prompt-builders/`

  - **`duelPromptBuilder.js`**: Builds the prompt for dueling with ProjectKorra abilities with data such as cooldown, range, velocity, and short recommendations depending on the situation.
  - **`suvivalPrompBuilder.js`**: Builds the prompt for the survival loop with all the necessary information provided by the `environmentScan` by the Java mod. Formats entity data, block data, etc...
<br>    
  
### Mineflayer (wip)


## Vtubing (early wip)

## VRChat 

###### `src/ai/vrchatbot/`

### Listening and voice

###### `audiostuff/`

- **audioLoop.js**: Handles the listening and processing audio loop. Uses `Silero VAD` to detect speech/silence and know when to start processing audio. Sends transcriptions requests, checks for wake word and schedules butt ins.
- **voice.js**: Handles generating the voice replies from the AI. Depending on the tts engine specified in the `config.json` inside `util`, it will make a request to `edge-tts` or a `xtts` server for custom voice generation.

> Depending on the platform, a different process is used for playing/recording the audio.

<br>

# Other functionalities

## VSC Integration

## Pi dev
s
