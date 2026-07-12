# yagyesh-dashboard — port spec (source of truth for exvibe)

Original lives at `/Users/void/.claude/skills/yagyesh-dashboard/`. Python stdlib HTTP
server (`server.py`, `127.0.0.1:7873`) + static frontend. Shells out to `claude` CLI for
generation and the `agent-reach` `twitter` CLI for all X I/O; state = JSON files in `data/`.

**Implementation agents: read the original Python files for verbatim prompt IP** —
`pipeline.py` (`GOLD_EXAMPLES`, `VOICE_RULES`, the three `*_SHAPE` blocks, lane list,
signature/scoring math), `eval_engine.py` (`build_prompt`), `analytics.py`
(`build_insight_prompt`), `voice_state.py` (`format_for_prompt`), `feedback.py`. Port these
strings and the JSON-extraction logic verbatim — they are load-bearing.

## exvibe architecture split

The one hard requirement from the user: **posting/replying must emulate manual human
actions in the real logged-in x.com tab** (CLI/API posting tanked analytics). So:

| Concern | Lives in | How |
|---|---|---|
| Read signal (bookmarks/likes/feed/own posts) | **server** | `agent-reach twitter` CLI, read-only (`bookmarks`, `favorites`, `feed`, `user-posts`) |
| Interest signature + feed scoring | **server** | port `pipeline.py` math |
| Drafting posts/replies/quotes | **server** | `claude -p "<prompt>" --agent $DASHBOARD_AGENT --effort medium`, JSON out |
| Voice learning (feedback → eval → voice_state) | **server** | port `feedback.py` / `eval_engine.py` / `voice_state.py` |
| Analytics | **server** | port `analytics.py` (read-only `user-posts`) |
| Draft store, regenerate-with-feedback | **server** | JSON files under `server/data/` |
| **Posting / replying / quoting** | **extension** | content-script DOM emulation (see `X-DOM-BRIEF.md`) |
| **Queue + scheduling** | **extension** | `chrome.alarms` + `chrome.storage` |
| **Posted history** | **extension** | `chrome.storage` |

The server has **no `/post` endpoint**. When the extension successfully posts via the DOM,
it POSTs `/feedback {action:"post"}` back so voice learning still sees the signal.

## Server config (env, from shell or `~/.agent-reach/env.sh`)
`TWITTER_HANDLE` (required, no `@`), `DASHBOARD_AGENT` (default `voice`), `DASHBOARD_AGENT_MD`
(`~/.claude/agents/<agent>.md`), `EXVIBE_PORT` (default `7878`). Draft volume knobs:
`DASHBOARD_POSTS`(100)/`REPLIES`(300)/`QUOTES`(300)/`DRAFT_WORKERS`(5). `claude` fallback
binary: `/Applications/cmux.app/Contents/Resources/bin/claude`. `twitter` resolved via PATH.

## Server API (JSON, loopback only, `no-store`, CORS `*` for the extension)
- `GET /healthz` → `{ok, now}`
- `GET /data` → full drafts payload or `{empty:true, message}`
- `POST /refresh` → run pipeline (single-flight lock, ~900s), returns new data
- `GET /signature` → interest signature block
- `GET /feed?kind=for-you|trending&page=n` → scored feed cards
- `POST /draft/regenerate` `{kind, id, feedback}` → one fresh draft in that lane, honoring the
  user's prompt tweak (`feedback`). ← the "change the prompt a bit" feature
- `POST /draft/remove` `{kind, id}` → drop from store
- `POST /feedback` `{kind, action, original_text, final_text, target_author?, target_text?}`
  `action ∈ discard|mark_posted|like|post`; good = mark_posted/like/post, bad = discard
- `GET /evals` → `{runs, summary, state:{gold,anti,rules}}`
- `POST /eval/run` `{}` → run object + `voice_changed`
- `POST /evals/revert` `{id}`
- `GET /analytics`, `POST /analytics/run`
- `GET /agent` → `{path, content, mtime, profiles}`; `POST /agent` `{content}` (require YAML front matter)
- `POST /agent/study` `{username}` → mine ~50 posts into agent `.md`

## Draft JSON shapes (claude output; port `extract_json`)
- posts: `{posts:[{id, template, text}]}`
- replies: `{replies:[{id, target_id, target_author, target_text, text}]}`
- quotes: `{quotes:[{id, target_id, target_author, target_text, text}]}`

Validate reply/quote `target_id` against the real feed pool; dedupe posts (Jaccard ≥0.55 +
opener cap); one reply/quote per target; re-id `p1…/r1…/q1…`.

## Pipeline signal fetch (server, parallel, `--json`)
`twitter bookmarks -n 80`, `twitter favorites -n 80`, `twitter feed -n 500`,
`twitter user-posts @<HANDLE> -n 40`. Raw dumps → `server/data/raw/*.json`.

## Drafting call (per batch, 5 concurrent, 300s timeout, 1 retry, stdin=/dev/null)
`claude -p "<prompt>" --agent <DASHBOARD_AGENT> --effort medium`. Prompt = voice header
(persona + signature + recent posts + GOLD_EXAMPLES + voice_state block + analytics
"what's working") + lane + themes + inspo + task + per-kind JSON shape + VOICE_RULES.

## Server persistence (`server/data/`, atomic .tmp+rename)
`dashboard_data.json`, `feedback.json`, `evals.json`, `voice_state.json`, `analytics.json`,
`analytics_history.json`, `raw/*.json`. Voice state `{gold[≤20], anti[≤20], rules[≤12]}`.

## Extension-owned models (chrome.storage)
- **Queue/scheduled item**: `{id, kind, text, target_id?, fire_at_iso, created_at,
  status:pending|fired|failed|cancelled, source:queue|manual|scheduled, fired_at?, result?, error?}`
- **Posted item**: `{id, posted_at, kind, text, target_id?, tweet_id?, tweet_url?, source}`
- Queue cadence: +3h after latest pending, min lead 60s. Alarm scans every ~30–60s.

## UI feature parity (side panel, tabs)
Posts / Replies / Quotes (draft cards) · Queue/Scheduled · Settings. Draft card: editable
textarea w/ 280 counter (warn >240, over >280), target-tweet preview + open-link for
reply/quote, and buttons **Post now · Schedule… · Queue +3h · Regenerate (with feedback
box) · Like · Mark posted · Discard**. Feed & analytics screens optional in v1 but wire the
endpoints. Toggle shortcut = `commands` (`Cmd+Shift+Y` default; Cmd+L is Chrome-reserved,
document rebinding at `chrome://extensions/shortcuts`).

## Out of scope for v1
LinkedIn workspace, blog studio, media/image upload, launchd daemons, automated tests.
