# exvibe — plan

X growth cockpit as a Chrome extension. Port of the local `xai-personalize-dashboard`
skill, with one critical change: **all posting/replying happens through the real
x.com UI in the user's logged-in browser tab, emulating manual human actions**
(typing cadence, real button clicks). No `twitter post|reply|quote` CLI calls —
API-style automation measurably tanked analytics; manual actions performed ~10x
better.

## Components

```
exvibe/
├── extension/            # Chrome MV3, TypeScript + React + Tailwind, Vite build
│   ├── src/panel/        # Side panel UI (right-side, full height)
│   ├── src/content/      # x.com content script: human-emulation engine
│   ├── src/background/   # Service worker: router, scheduler (chrome.alarms)
│   └── src/shared/       # Message + API types shared across contexts
├── server/               # Bun + TypeScript local companion server
│   ├── src/              # HTTP API + pipeline (claude --agent, agent-reach reads)
│   └── data/             # drafts, feedback, voice state, schedule (gitignored)
└── docs/
```

## Extension

- **Side panel** (`chrome.sidePanel`): tabs — Posts / Replies / Quotes / Queue / Settings.
  Draft cards: Edit, Regenerate with feedback ("tweak the prompt"), Like,
  Mark-as-posted, Discard, Post now, Schedule, Queue.
- **Toggle shortcut**: `commands` API. Cmd+L is reserved by Chrome for the omnibox,
  so default is the closest available (Cmd+Shift+L / MacCtrl+L) and the README
  documents rebinding to Cmd+L at `chrome://extensions/shortcuts` if desired.
- **Content script (x.com)** — the human-emulation engine:
  - Insert text into X's contenteditable composer so React/Lexical registers it,
    per-character with randomized 40–150 ms delays.
  - Post flow: open composer → type → click real Post button → confirm sent.
  - Reply flow: navigate to tweet permalink → wait for reply box → type → submit.
  - SPA-aware: route-change watcher; resilient selectors around `data-testid`s.
- **Service worker**: message hub (panel ⇄ content ⇄ server), `chrome.alarms`
  scheduler that fires due queue items and drives the content script.

## Server (localhost, default port 7878)

Ports the Python dashboard pipeline to Bun/TS:

- **Signal**: `agent-reach` twitter CLI (bookmarks, likes, home feed, own posts) —
  reads only.
- **Drafting**: single `claude --agent $DASHBOARD_AGENT` call → JSON drafts
  (posts, replies, quotes) with learned voice state injected.
- **Feedback loop**: append-only feedback events (like / discard / posted / edit
  deltas) → voice state (gold/anti/rules) → eval engine tunes it.
- **API**: /data, /refresh, /drafts actions (feedback, regenerate), /schedule CRUD,
  /history, /settings. **No /post** — the extension posts via the DOM.
- **State**: JSON files under `server/data/`.

## Posting contract

Panel "Post now" → service worker → ensure x.com tab → content script runs
human-emulation → reports posted/failed → panel marks history, server records
feedback. Scheduled items identical, triggered by alarm instead of click.

## Non-goals (v1)

- LinkedIn workspace, media upload, analytics screens from the dashboard.
- Automated tests (deferred by request).
