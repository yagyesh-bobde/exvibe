/**
 * Post orchestrator: given a {kind, text, target_id?} payload, find or create
 * a logged-in x.com tab, make sure the content script is alive, hand it a
 * DO_POST, and await the POST_RESULT. On success, append a PostedItem to
 * chrome.storage.local and report a `post` feedback event to the companion
 * server so voice learning still sees the signal (per docs/DASHBOARD-SPEC.md).
 */

import { ServerClient } from '../shared/api';
import { sendToTab } from '../shared/messages';
import type { Msg, PostPayload, PostResultMsg } from '../shared/messages';
import type { PostedItem, QueueItemSource } from '../shared/models';

/** chrome.storage.local key holding the PostedItem[] history. */
export const POSTED_STORAGE_KEY = 'exvibe_posted';

const X_URL_PATTERNS = ['https://x.com/*', 'https://twitter.com/*'];
const NEW_TAB_URL = 'https://x.com/home';
const TAB_LOAD_TIMEOUT_MS = 30_000;
const CONTENT_READY_TIMEOUT_MS = 20_000;
const CONTENT_READY_POLL_MS = 500;
/** Human-cadence typing of a full post can take ~1 min; leave generous slack. */
const POST_RESULT_TIMEOUT_MS = 120_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function isPostResult(value: unknown): value is PostResultMsg {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown; ok?: unknown };
  return v.type === 'POST_RESULT' && typeof v.ok === 'boolean';
}

/** Resolve once the tab reports status "complete" (or immediately if it already has). */
function waitForTabComplete(tabId: number, timeoutMs = TAB_LOAD_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`tab ${tabId} did not finish loading within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo): void => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // The tab may already be loaded before the listener attached.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish();
      })
      .catch((err: unknown) => finish(new Error(`tab ${tabId} disappeared: ${errorMessage(err)}`)));
  });
}

/** One PING round-trip; true if a content-script listener answered. */
async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    const ping: Msg = { type: 'PING' };
    await sendToTab(tabId, ping);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inject the manifest-declared content script into a tab on demand. Needed
 * because reloading the extension orphans content scripts in already-open tabs,
 * and Chrome will not re-inject them without a page reload. Idempotent enough:
 * we only call this after a failed PING, so there is no live listener to double.
 */
async function injectContentScript(tabId: number): Promise<void> {
  const declared = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  if (declared.length === 0) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: declared });
}

/**
 * Ensure a live content script in the tab: ping, and if nothing answers, inject
 * it and poll until it comes up (or time out).
 */
async function ensureContentReady(
  tabId: number,
  timeoutMs = CONTENT_READY_TIMEOUT_MS,
): Promise<void> {
  if (await pingContentScript(tabId)) return;
  try {
    await injectContentScript(tabId);
  } catch (err) {
    throw new Error(`could not inject content script into tab ${tabId}: ${errorMessage(err)}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingContentScript(tabId)) return;
    await sleep(CONTENT_READY_POLL_MS);
  }
  throw new Error(`content script in tab ${tabId} never became ready after injection`);
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
  }
  await chrome.windows.update(tab.windowId, { focused: true });
}

/** Find an existing x.com/twitter.com tab (prefer the active one) or open one and wait for load. */
async function findOrCreateXTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const tabs = await chrome.tabs.query({ url: X_URL_PATTERNS });
  const existing = tabs.find((t) => t.active && t.id !== undefined) ?? tabs.find((t) => t.id !== undefined);
  if (existing?.id !== undefined) {
    return existing as chrome.tabs.Tab & { id: number };
  }
  const created = await chrome.tabs.create({ url: NEW_TAB_URL, active: true });
  if (created.id === undefined) {
    throw new Error('failed to create an x.com tab');
  }
  await waitForTabComplete(created.id);
  return created as chrome.tabs.Tab & { id: number };
}

async function sendDoPost(tabId: number, payload: PostPayload): Promise<PostResultMsg> {
  const msg: Msg = { type: 'DO_POST', payload };
  const response = await withTimeout(sendToTab(tabId, msg), POST_RESULT_TIMEOUT_MS, 'DO_POST');
  if (!isPostResult(response)) {
    throw new Error('content script returned an unexpected DO_POST response');
  }
  return response;
}

async function appendPostedItem(item: PostedItem): Promise<void> {
  const store = await chrome.storage.local.get(POSTED_STORAGE_KEY);
  const raw: unknown = store[POSTED_STORAGE_KEY];
  const items: PostedItem[] = Array.isArray(raw) ? (raw as PostedItem[]) : [];
  items.push(item);
  await chrome.storage.local.set({ [POSTED_STORAGE_KEY]: items });
}

async function recordSuccess(
  payload: PostPayload,
  result: PostResultMsg,
  source: QueueItemSource,
): Promise<void> {
  const posted: PostedItem = {
    id: crypto.randomUUID(),
    posted_at: new Date().toISOString(),
    kind: payload.kind,
    text: payload.text,
    target_id: payload.target_id,
    tweet_id: result.tweet_url?.match(/status\/(\d+)/)?.[1],
    tweet_url: result.tweet_url,
    source,
  };
  await appendPostedItem(posted);
  // Feed the voice-learning loop; the server has no /post endpoint by design.
  try {
    await new ServerClient().feedback({
      kind: payload.kind,
      action: 'post',
      original_text: payload.text,
      final_text: payload.text,
    });
  } catch (err) {
    console.warn('[exvibe] server /feedback {action:post} failed (non-fatal):', errorMessage(err));
  }
}

/**
 * Orchestrate a full human-emulated post. Never throws — always resolves to a
 * PostResultMsg so callers (router, scheduler) can report status uniformly.
 */
export async function postNow(
  payload: PostPayload,
  source: QueueItemSource = 'manual',
): Promise<PostResultMsg> {
  try {
    const tab = await findOrCreateXTab();
    await focusTab(tab);
    await ensureContentReady(tab.id);
    const result = await sendDoPost(tab.id, payload);
    if (result.ok) {
      await recordSuccess(payload, result, source);
    }
    return result;
  } catch (err) {
    const message = errorMessage(err);
    console.warn('[exvibe] postNow failed:', message);
    return { type: 'POST_RESULT', ok: false, error: message };
  }
}
