# DiscordHyLily
Discord bot to talk with Lily!


# TODO:

  - Add the new tool calls
  - Avoid error replies or "None" replies at all costs, if querying fails, query the other database, and if it also fails answer normally, for edge cases.
  - If no info is found when querying the persistent knowledge database, consider if adding the info she was asked about, and then reply normally
  - Add chat history to system prompt, tell her in context which user is talking to her, who is the user talking about, etc... Let her clearly know
    Who is talking to her, who is the user replying or talking about.


# HyLilty DISCORD Bot version data overview:

## Query Hytale Wiki Toolcall:

    - 209 Samples

## Query Persistent Knowledge Database Toolcall:

    - 91 Samples

## Add to Persistent Knowledge Database Toolcall:

    - 112 Samples

## Conversational Samples (Including negative examples):

    - 464 Samples
