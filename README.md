# simple-chatgpt-ui

A two-file JS-based UI for interacting with ChatGPT in your browser. Requires you to supply your own API key.


## Why?

I wanted something simple I could play with. The [free ChatGPT demo](https://chat.openai.com/chat) is a nice UI, but it's not always available unless you get the $20 / month "ChatGPT Plus" plan. The API, [priced at](https://openai.com/pricing) $0.002 / 1K tokens, will let you generate millions of words for that $20, but it doesn't have the nice UI.

Other people have already built similar things, such as [this](https://github.com/WongSaang/chatgpt-ui) or [this](https://github.com/cogentapps/chat-with-gpt). If you're looking for something more fully-featured, try one of those. The point of this project was to extremely simple, so that it's easy to modify.


## Setup

Get an API key from OpenAI and put it in `OPENAI_KEY.txt`.

Ensure you have a reasonably recent version of node installed. Then

```sh
npm install
node run.js
```

This will bring up a server at `http://localhost:21665`; point your browser there.

Happy chatting! And remember: _don't trust it_.


## TODO

- save conversations to disk
  - support loading old conversations by drag-and-drop'ing them onto the window
  - including deleted messages
- let you change the "system" prompt (currently hardcoded to "You are a helpful graduate-level tutor for any academic subject.").
  - store old prompts in localstorage, default to most recent
- let you delete messages
- let you reroll the most recent message
- maybe let you customize [the other parameters](https://platform.openai.com/docs/api-reference/chat/create)
- give you a tree view of the conversation so you can jump around
- support up arrow to load old messages
- stop button
- error handling, I guess
