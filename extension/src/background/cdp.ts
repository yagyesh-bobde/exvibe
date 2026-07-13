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

/** Public trusted click (attaches if needed), e.g. to press the Post button. */
export async function cdpClickAt(tabId: number, x: number, y: number): Promise<void> {
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Page.bringToFront').catch(() => undefined);
  await cdpClick(tabId, x, y);
}

/** Trusted mouse click at viewport CSS coordinates, to focus an element. */
async function cdpClick(tabId: number, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left' as const, clickCount: 1 };
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    ...base,
    type: 'mousePressed',
  });
  await sleep(rand(30, 80));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    ...base,
    type: 'mouseReleased',
  });
}

/**
 * Insert `text` into the composer as trusted input, like a paste: each line
 * goes in as one Input.insertText call. Newlines still go in as a real Enter
 * key event — Draft.js ignores '\n' inside insertText but inserts a soft break
 * on Enter (plain Enter does not submit; only Cmd/Ctrl+Enter does).
 *
 * When `focus` is given, the page is brought to front and a trusted click lands
 * on the composer first so Input.insertText has a focused element to target
 * (a programmatic element.focus() does not stick in an unfocused WebContents).
 */
export async function cdpInsertText(
  tabId: number,
  text: string,
  focus?: { x: number; y: number },
): Promise<void> {
  await ensureAttached(tabId);
  // Focus the page's renderer, then trust-click the composer to focus it.
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.bringToFront');
  } catch {
    // Page domain not available on this target — best effort.
  }
  if (focus) {
    await cdpClick(tabId, focus.x, focus.y);
    await sleep(rand(120, 300));
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line) {
      await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: line });
    }
    if (i < lines.length - 1) {
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
      await sleep(rand(60, 150));
    }
  }
}
