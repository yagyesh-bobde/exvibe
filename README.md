# exvibe

exvibe is an X (Twitter) growth cockpit: a local Bun/TypeScript server ports the
`yagyesh-dashboard` pipeline (interest signature, feed scoring, voice-learned
drafting, feedback loop, analytics) to read your signal and generate posts,
replies, and quote-tweet drafts in your own voice. A Chrome MV3 extension puts a
side panel next to X with tabs for Posts / Replies / Quotes / Queue / Settings,
lets you edit and regenerate drafts, and queues or schedules them.

## Running it

**Server:**
```sh
cd server && bun install && bun start
```
Listens on `http://127.0.0.1:7878` by default (override with `EXVIBE_PORT`).

**Extension:**
```sh
cd extension && bun install && bun run build
```
Then in Chrome: `chrome://extensions` → enable Developer mode → "Load unpacked"
→ select `extension/dist`. Open the side panel via the toolbar icon or the
`Cmd+Shift+Y` (mac) / `Ctrl+Shift+Y` (other) shortcut. If that binding
conflicts with something on your system, rebind it at
`chrome://extensions/shortcuts`.

## Why posting is manual-emulated, not API/CLI

Earlier iterations posted straight through the `agent-reach` `twitter` CLI
(API-style automation). Analytics tanked — X's ranking visibly penalizes
posts that don't originate from real browser interaction. So in exvibe, the
server never posts anything: it only reads signal (bookmarks, likes, feed,
your own posts) and drafts text. All posting, replying, and quoting happens
in the extension's content script, which types into X's real composer with
randomized human-like keystroke cadence and clicks the real Post button in
your logged-in browser tab — the same DOM path a human would use.

This also keeps the two halves cleanly separated: the server owns everything
that benefits from being scriptable and stateful (drafting, voice learning,
scheduling logic can still live there conceptually), while the extension owns
everything that must look and behave like a human using x.com — the queue,
schedule firing (via `chrome.alarms`), and posted history all live in
`chrome.storage` on the extension side for the same reason.
