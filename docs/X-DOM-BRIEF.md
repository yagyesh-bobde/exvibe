# X.com Manual-Emulation Automation — Engineering Brief

Testids below have been stable on x.com desktop for years, but X ships DOM changes without notice — **match defensively (`^=` prefix, fallback lists) and log every selector miss at runtime.**

## 1. Composer DOM (desktop web, 2025–2026)

The compose box is a **Draft.js `contenteditable` div**, NOT a `<textarea>`. Structure:
`div.DraftEditor-root > div.public-DraftEditor-content[contenteditable="true"][data-testid="tweetTextarea_0"]`. Placeholder lives in `.public-DraftEditorPlaceholder-inner`.

| Purpose | Selector | Notes |
|---|---|---|
| Compose textarea (all contexts) | `[data-testid="tweetTextarea_0"]` | Index increments per thread item: `tweetTextarea_1`, etc. Use `[data-testid^="tweetTextarea_"]`. |
| Post btn — **modal / dialog** | `[data-testid="tweetButton"]` | Full-screen composer & reply dialog |
| Post btn — **inline** (home top box, permalink reply box) | `[data-testid="tweetButtonInline"]` | |
| New-post nav button (left rail) | `[data-testid="SideNav_NewTweet_Button"]` | |
| Reply button on a tweet | `[data-testid="reply"]` | Opens reply composer (dialog, or inline on permalink) |
| Composer toolbar | `[data-testid="toolBar"]` | media/gif/poll/emoji live here |
| Post-sent toast | `[data-testid="toast"]` | text "Your post was sent" |

**Reply flow:** two variants. (a) On a permalink page (`/<user>/status/<id>`) an **inline** reply box sits at the top of replies — focus `[data-testid^="tweetTextarea_"]`, send via `tweetButtonInline`. (b) Clicking `[data-testid="reply"]` anywhere opens a **`[role="dialog"]`** modal — scope the textarea to the dialog and send via `tweetButton`. Prefer (a) for permalink replies (fewer moving parts).

**Keyboard shortcuts** (X handles these globally when focus is not in an input): `n` = new post modal, `r` = reply to focused tweet, `Cmd/Ctrl+Enter` = send. Dispatching these synthetically is unreliable (isTrusted); prefer DOM clicks below.

## 2. Text insertion that Draft.js registers

**Winner: `document.execCommand('insertText')` after focus.** It drives the *native* `beforeinput`/`input` pipeline that Draft.js's `editOnBeforeInput` handler listens to, so editor state + React sync correctly. Deprecated but fully functional in Chrome and the only simple call that Draft.js reliably picks up.

The `nativeInputValueSetter` React trick does **NOT** apply here — that's for `<input>`/`<textarea>`. The composer is contenteditable; setting `.textContent` or dispatching a hand-built `InputEvent`/`beforeinput` is ignored by Draft.js.

```js
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a,b) => a + Math.random()*(b-a);

async function typeIntoComposer(text, {min=40, max=150} = {}) {
  const box = await waitFor('[data-testid^="tweetTextarea_"]');
  box.focus();
  const sel = getSelection(); sel.selectAllChildren(box); sel.collapseToEnd(); // caret to end
  for (const ch of Array.from(text)) {              // Array.from => emoji-safe
    if (ch === '\n') document.execCommand('insertParagraph');  // insertText '\n' is dropped by Draft
    else             document.execCommand('insertText', false, ch);
    await sleep(rand(min, max));                    // human cadence
  }
}
```

**Instant fallback (very reliable, not human-paced): synthetic paste.** Draft.js's `editOnPaste` reads `clipboardData`:
```js
function pasteIntoComposer(text){
  const box = document.querySelector('[data-testid^="tweetTextarea_"]'); box.focus();
  const dt = new DataTransfer(); dt.setData('text/plain', text);
  box.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles:true, cancelable:true}));
}
```
Gotchas: must `focus()` first; must operate on the contenteditable leaf (the `tweetTextarea_0` div), not an ancestor; if the box was never focused Draft.js has no selection state and insertText no-ops.

## 3. Click post + confirm sent

`element.click()` works: it produces an `isTrusted:false` event, but it still flows through normal DOM dispatch and React's delegated document-level listener fires. Check `aria-disabled` first (button is disabled until text present / under char limit).

```js
async function postCurrent(){
  const btn = document.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
  if(!btn || btn.getAttribute('aria-disabled')==='true') throw new Error('post button not ready');
  btn.click();
  // Confirm via EITHER the toast appearing OR the composer emptying/closing:
  return Promise.race([
    waitFor('[data-testid="toast"]', 8000),
    waitForGone('[data-testid^="tweetTextarea_"]', 8000) // dialog closed
  ]);
}
```
For the inline box (doesn't unmount), confirm by the box re-showing placeholder / button returning to `aria-disabled=true` instead of `waitForGone`.

## 4. SPA navigation watcher

x.com is a single content-script instance persisting across `pushState`. **Use the Navigation API (Chrome 102+) as primary** — it fires on every SPA transition including pushState, from the content script's isolated world:

```js
let last = location.href;
const onNav = () => { if(location.href!==last){ last=location.href; handleRoute(location.pathname); } };
if (window.navigation) navigation.addEventListener('navigate', () => queueMicrotask(onNav));
window.addEventListener('popstate', onNav);
// Belt-and-suspenders: title mutates on route change
new MutationObserver(onNav).observe(document.querySelector('title'), {childList:true});
```
Avoid monkeypatching `history.pushState` from the content script — the isolated world gets a separate JS wrapper; Navigation API sidesteps that.

**Open a permalink + wait:**
```js
async function goPermalink(url){
  if(location.href!==url){ location.assign(url); await waitFor('[data-testid^="tweetTextarea_"]', 12000); }
}
```
`waitFor` / `waitForGone` via MutationObserver:
```js
function waitFor(sel, t=10000){return new Promise((res,rej)=>{const hit=document.querySelector(sel);if(hit)return res(hit);
  const mo=new MutationObserver(()=>{const e=document.querySelector(sel);if(e){mo.disconnect();res(e);}});
  mo.observe(document.body,{childList:true,subtree:true});setTimeout(()=>{mo.disconnect();rej(Error('timeout '+sel));},t);});}
function waitForGone(sel,t=8000){return new Promise((res)=>{if(!document.querySelector(sel))return res();
  const mo=new MutationObserver(()=>{if(!document.querySelector(sel)){mo.disconnect();res();}});
  mo.observe(document.body,{childList:true,subtree:true});setTimeout(()=>{mo.disconnect();res();},t);});}
```

## 5. MV3 manifest + wiring

```json
{
  "manifest_version": 3,
  "permissions": ["sidePanel", "tabs", "scripting", "alarms", "storage"],
  "host_permissions": ["https://x.com/*", "https://twitter.com/*", "http://localhost/*"],
  "background": { "service_worker": "sw.js" },
  "side_panel": { "default_path": "panel.html" },
  "action": { "default_title": "Open composer" },
  "content_scripts": [{ "matches": ["https://x.com/*"], "js": ["content.js"], "run_at": "document_idle" }],
  "commands": {
    "toggle-panel": {
      "suggested_key": { "default": "Ctrl+Shift+Y", "mac": "Command+Shift+Y" },
      "description": "Open composer side panel"
    }
  }
}
```
```js
// sw.js
chrome.runtime.onInstalled.addListener(() =>
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === 'toggle-panel') chrome.sidePanel.open({ tabId: tab.id }); // onCommand IS a user gesture — call open FIRST, don't await anything before it
});
```

**Side panel gotchas:** `openPanelOnActionClick` is **NOT** a manifest field — set it via `setPanelBehavior` in the SW. `sidePanel.open()` only works inside a live user gesture; any `await` before it consumes the gesture and it silently fails. Use `{tabId}` for per-tab, or `{windowId}` for global. Panel is a normal extension page → it can `fetch('http://localhost:...')` directly (host permission granted; SW/panel fetches bypass page CORS).

**Command shortcut / `Cmd+L`:** don't bind it. On macOS `Cmd+L` is Chrome's reserved address-bar focus; manifest bindings can't override reserved browser shortcuts. Ship a non-conflicting default (`Cmd+Shift+Y`) and tell users they can rebind at `chrome://extensions/shortcuts`. Max 4 suggested commands; `_execute_action` is a reserved command name for icon-click behavior as a shortcut.

**Messaging:** side panel ↔ SW ↔ content script. Panel and SW share the extension context (`chrome.runtime.sendMessage` / long-lived `chrome.runtime.connect` port). To reach the page: SW/panel → `chrome.tabs.sendMessage(tabId, msg)` → content script `chrome.runtime.onMessage`. Content scripts should **not** fetch localhost directly (page CSP/CORS); route via the SW.

**`chrome.alarms` for scheduling:** persists across browser restarts (fires only while Chrome is running); **min period is 30s**. On fire, the SW wakes — it must locate/open an x.com tab (`chrome.tabs.query`/`create`), wait for the content script, then message it to run the post. Keep the queue in `chrome.storage` since the SW is ephemeral.

## 6. Anti-detection / "looks manual"

- **isTrusted reality:** synthetic events are `isTrusted:false`. X currently does **not** appear to gate normal input/click on isTrusted, and `execCommand('insertText')` + `.click()` work in practice today. But this is the single biggest fragility risk — treat it as "works until X hardens."
- **Human texture:** per-char insertion with 40–150ms jitter (occasional 200–600ms "thinking" pauses, rare backspace-correct); randomize inter-action gaps (focus → type → 300–1200ms → click); optionally `scrollIntoView` + `mouseover`/`mousemove` on the target before clicking; never post two things back-to-back with identical timing.
- **CDP escape hatch:** `chrome.debugger` + `Input.dispatchKeyEvent` / `Input.insertText` produce **trusted** events (isTrusted:true) — the only way to do so from an extension. Tradeoff: attaching shows a persistent yellow "…is debugging this browser" infobar. **Recommendation:** ship the `execCommand`/`.click()` path by default; keep a debugger-based mode behind a flag as the fallback. Only one debuggee attach at a time; detach when idle to drop the infobar.

## Uncertainty flags
- Testids are long-lived but unversioned — build a selector-health check that logs on miss, keep the selector map in one config module so it can be hot-patched.
- Reply modal vs inline permalink box differ in send button (`tweetButton` vs `tweetButtonInline`) and unmount behavior — handle both.
- If X migrates Draft.js → Lexical, `execCommand insertText` and the synthetic-paste fallback both still generally work (Lexical also listens to native beforeinput/paste), but re-verify.
