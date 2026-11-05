# Viktrych tools, actions, chat and memory

Viktrych can do more than change settings, still inside the page. There is no Android or desktop app and no helper program to install. Owner switch: `ai_tools` (on until the owner turns it off).

## What a person can do

Ask in the Viktrych chat, in their own words. A step appears only after that. Network, code and anything that changes the app wait for Run. Skip leaves that step. Stop cancels the rest.

- **Direct media.** A message such as “download this video https://cdn.example.com/clip.mp4 and convert it” fetches that https file into a private workspace (`viktrych-tools` in the origin private file system), then can run the pinned single-thread FFmpeg build in a worker. The file is offered through the save dialog where the browser has one, otherwise as a normal download. Success is recorded only when the saved bytes are read back and the count is above zero.
- **Code.** A fenced `js` or `python` block in the person’s own message can run in a worker. The page never uses `eval` or `new Function`. The worker turns network off before the program runs. Python loads a pinned Pyodide build the first time and stays off when the device reports under 4 GB of memory.
- **App actions.** Open a known page, put text in the composer (nothing is posted), open a List draft (nothing is saved until the person saves it on the List page), and create, switch, close or rename a Home tab. Block, mute, unblock and unmute still use the existing people rules: the @name must be in the typed message, the confirm card shows that name, and Undo still works. A post or a web page cannot start any of these.
- **Chat.** Search is on the device, over titles and the full text of the person’s messages and Viktrych’s replies. A result opens that chat and scrolls to the message. Each message can be deleted on its own, with Undo, and the saved history updates. Selecting more than one message, or deleting a whole chat, asks first. Deleting a message also drops a chat note that was taken from that text.
- **Memory.** Short notes stay in this browser. Viktrych adds one only from an explicit line such as “remember that I prefer dark mode”, and only while chat history is on. Notes the person types in Memory stay until they delete them, including when chat history is off. Passwords, tokens and similar strings are refused. The model sees at most five matching notes and a few hundred characters, each marked `user` or `chat`. It is not a full copy of the chats.

Separate tasks is optional and off until the person turns the chip on. One on-device model is shared. A lead note, the tool step and a checker are separate records, not extra models. The checker will not mark the task done when a file step has no bytes. Two reads with no side effect may overlap when the device can spare a worker. This does not make the model smarter. It makes a false “saved” harder.

## What the page cannot do

The page cannot install a system package, open arbitrary folders, or bypass CORS, login, DRM or a playlist. YouTube, TikTok and similar pages are reported as unsupported and are not fetched. FFmpeg here is the single-thread WebAssembly build pinned to `@ffmpeg/core` 0.12.6 from jsDelivr, loaded only after a step needs it. Multi-thread FFmpeg needs cross-origin isolation, which this static host does not set. Python is the pinned Pyodide 0.26.4 script, also only after approval, and it can fail on a small phone.

Nothing in this path is a paid AI API. Tool output is not uploaded. Cookies and account tokens are not sent with a media fetch (`credentials: "omit"`).

## How another action is added

`local-ai-actions.js` `register({ id, effect, needsConfirm, validate, preview })` adds a name to the catalog. `validate(text, ctx)` may return `{ name: id, ... }` only when the person’s own text supports it. An id that contains post, send, delete, logout or publish is rejected. A mutating action cannot skip confirmation. The host in `app.js` (`performAppAction`) must grow a branch for that id and call `accepts` again before it changes anything. Do not synthesize clicks. Do not post, send or delete an account from a tool.

Builtin names today: `nav.open`, `compose.draft`, `list.draft`, `tab.create`, `tab.switch`, `tab.close`, `tab.customize`, `person.block`, `person.mute`, `person.unblock`, `person.unmute`.

## Later

Keyword overlap is the retrieval. A later change could rank notes with a vector already on the device from a model the person downloaded. That should stay on the device, keep the same secret filter, the same size cap, and the same source label. It is not in this change.
