/**
 * Trusted-input typing via chrome.debugger (Chrome DevTools Protocol).
 *
 * WHY THIS EXISTS: x.com's composer is a Draft.js contenteditable. DOM-level
 * insertion (`document.execCommand('insertText')`, synthetic ClipboardEvent
 * paste) only registers when the tab is the *focused document*. When the post
 * is driven from the extension side panel, the panel holds focus and the x.com
 * document does not — verified live: both methods no-op and the Post button
 * stays disabled. CDP `Input.insertText` injects genuinely trusted input at the
 * renderer level, independent of OS/window focus, so Draft.js registers it (and
 * it is more authentic "manual" input than execCommand ever was).
 *
 * The content script focuses the composer element, then asks the background to
 * type into it (the composer is `document.activeElement`, which is where CDP
 * input lands). Attaching shows a "…is debugging this browser" infobar for the
 * few seconds a post takes; we detach as soon as the flow finishes.
 */

const DEBUGGER_PROTOCOL_VERSION = '1.3';

/** Tabs we currently hold a debugger session on. */
const attached = new Set<number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// A navigation, devtools opening, or the user closing the infobar detaches us;
// keep our bookkeeping in sync so the next insert re-attaches cleanly.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
  attached.add(tabId);
}

export async function cdpDetach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already gone (navigation/devtools) — nothing to do.
  }
}

/**
 * Type `text` into the tab's focused element as trusted input, with human
 * cadence (per-character 40–150 ms jitter + occasional thinking pauses).
 * Newlines go in as a real Enter key event (Draft.js inserts a soft break;
 * plain Enter does not submit — only Cmd/Ctrl+Enter does).
 */
export async function cdpInsertText(tabId: number, text: string): Promise<void> {
  await ensureAttached(tabId);
  for (const ch of Array.from(text)) {
    if (ch === '\n') {
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    } else {
      await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: ch });
    }
    await sleep(rand(40, 150));
    if (Math.random() < 0.07) await sleep(rand(200, 600)); // occasional "thinking" pause
  }
}
