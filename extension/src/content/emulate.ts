/**
 * Human-emulation engine for the x.com composer, per docs/X-DOM-BRIEF.md.
 *
 * The compose box is a Draft.js contenteditable div (NOT a <textarea>), so the
 * only simple insertion path Draft.js reliably registers is
 * `document.execCommand('insertText')` after focus — it drives the native
 * beforeinput/input pipeline that Draft's editOnBeforeInput listens to.
 * Synthetic paste (ClipboardEvent + DataTransfer) is the instant fallback.
 */

import { X_SELECTORS } from '../shared/selectors';
import { sendToBackground } from '../shared/messages';
import type { CdpAckMsg } from '../shared/messages';
import { rand, selectorMiss, sleep, waitFor } from './dom';

function isCdpAck(value: unknown): value is CdpAckMsg {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'CDP_ACK'
  );
}

/**
 * Generic ARIA dialog selector (X-DOM-BRIEF section 1, reply variant b).
 * Not an X testid, so it lives here rather than in the hot-patch selector map.
 */
const DIALOG_SELECTOR = '[role="dialog"]';

/**
 * When a modal composer/reply dialog is open, an inline composer (home top
 * box, permalink reply box) can still exist underneath it. Scope all composer
 * queries to the dialog when one owns a textarea, else the whole document.
 */
function composerScope(): ParentNode {
  const dialog = document.querySelector(DIALOG_SELECTOR);
  if (dialog?.querySelector(X_SELECTORS.tweetTextareaPrefix)) return dialog;
  return document;
}

/** The active composer's contenteditable leaf, or null if none is open. */
export function queryComposer(): HTMLElement | null {
  return composerScope().querySelector<HTMLElement>(X_SELECTORS.tweetTextareaPrefix);
}

/**
 * Focus the composer and put the caret at the end. Draft.js has no selection
 * state until the box is focused — without this, insertText no-ops.
 */
function focusComposer(box: HTMLElement): void {
  box.focus();
  const selection = window.getSelection();
  if (selection) {
    selection.selectAllChildren(box);
    selection.collapseToEnd();
  }
}

/** Light "looks manual" texture before interacting with an element. */
function humanHover(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  for (const type of ['mouseover', 'mousemove'] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
}

/**
 * Type `text` into the active composer as TRUSTED input.
 *
 * DOM insertion (execCommand/paste) no-ops when the x.com tab is not the
 * focused document — which it never is when a post is driven from the side
 * panel (verified live: button stays disabled). So we focus the composer here
 * (making it document.activeElement) and hand the actual keystrokes to the
 * background service worker, which types them via chrome.debugger's
 * Input.insertText — trusted, focus-independent, human-cadenced. See
 * background/cdp.ts.
 */
export async function typeIntoComposer(text: string): Promise<void> {
  await waitFor(X_SELECTORS.tweetTextareaPrefix, 10_000);
  const box = queryComposer();
  if (!box) {
    selectorMiss(X_SELECTORS.tweetTextareaPrefix, 'typeIntoComposer scope query');
    throw new Error('composer textarea not found');
  }
  focusComposer(box);
  await sleep(rand(150, 400)); // settle after focus, like a human finding the caret

  const ack = await sendToBackground({ type: 'CDP_INSERT_TEXT', text });
  if (!isCdpAck(ack) || !ack.ok) {
    const reason = isCdpAck(ack) ? (ack.error ?? 'unknown') : 'no ack from background';
    throw new Error(`trusted typing failed: ${reason}`);
  }
}

/** Ask the background to detach the debugger from this tab (drops the infobar). */
export async function detachDebugger(): Promise<void> {
  try {
    await sendToBackground({ type: 'CDP_DETACH' });
  } catch {
    // Background asleep or already detached — nothing to do.
  }
}

/**
 * Instant fallback: Draft.js's editOnPaste reads clipboardData from a
 * synthetic paste. Reliable but not human-paced — only used when per-char
 * insertion fails. Must target the contenteditable leaf, focused first.
 */
export function pasteIntoComposer(text: string, target?: HTMLElement): void {
  const box = target ?? queryComposer();
  if (!box) {
    selectorMiss(X_SELECTORS.tweetTextareaPrefix, 'pasteIntoComposer');
    throw new Error('composer textarea not found for paste fallback');
  }
  box.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  box.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
  );
}

export interface PostConfirmation {
  confirmedBy: 'toast' | 'composer-settled';
  /** Extracted from the "Your post was sent" toast's View link when present. */
  tweetUrl?: string;
}

/**
 * Click the send button for the active composer and confirm the post went out.
 * Confirmation = race(toast appears, composer gone / reset to placeholder).
 * The inline box doesn't unmount after send, so "settled" also means the box
 * emptied and the button returned to aria-disabled.
 */
export async function postCurrent(): Promise<PostConfirmation> {
  await sleep(rand(300, 1200)); // human gap: re-read the draft before reaching for the button

  const scope = composerScope();
  const btn =
    scope.querySelector<HTMLElement>(X_SELECTORS.tweetButtonInline) ??
    scope.querySelector<HTMLElement>(X_SELECTORS.tweetButton) ??
    document.querySelector<HTMLElement>(X_SELECTORS.tweetButtonInline) ??
    document.querySelector<HTMLElement>(X_SELECTORS.tweetButton);
  if (!btn) {
    selectorMiss(
      `${X_SELECTORS.tweetButtonInline} | ${X_SELECTORS.tweetButton}`,
      'postCurrent',
    );
    throw new Error('post button not found');
  }
  if (btn.getAttribute('aria-disabled') === 'true') {
    throw new Error('post button is disabled — composer empty or over the character limit?');
  }

  const box = scope.querySelector<HTMLElement>(X_SELECTORS.tweetTextareaPrefix);
  humanHover(btn);
  await sleep(rand(80, 250));
  btn.click();

  try {
    return await Promise.race([confirmViaToast(), confirmViaComposerSettled(box, btn)]);
  } catch {
    throw new Error('post not confirmed: no toast and the composer did not settle within 8s');
  }
}

async function confirmViaToast(): Promise<PostConfirmation> {
  const toast = await waitFor(X_SELECTORS.toast, 8_000);
  const link = toast.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  return { confirmedBy: 'toast', tweetUrl: link?.href };
}

async function confirmViaComposerSettled(
  box: HTMLElement | null,
  btn: HTMLElement,
): Promise<PostConfirmation> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    // Dialog composer: the whole editor unmounts on send.
    if (!box || !document.contains(box)) return { confirmedBy: 'composer-settled' };
    // Inline composer: box empties (placeholder returns) and button re-disables.
    const emptied = (box.textContent ?? '').trim().length === 0;
    const disabledAgain =
      !document.contains(btn) || btn.getAttribute('aria-disabled') === 'true';
    if (emptied && disabledAgain) return { confirmedBy: 'composer-settled' };
    await sleep(150);
  }
  throw new Error('composer did not settle');
}

/** Canonical x.com permalink for a raw status id or an existing tweet URL. */
export function permalinkFor(target: string): string {
  if (/^https?:\/\//.test(target)) return target.replace('//twitter.com/', '//x.com/');
  if (/^\d+$/.test(target)) return `https://x.com/i/status/${target}`;
  throw new Error(`cannot build a permalink from target "${target}"`);
}

/**
 * True when the current page is the permalink for `url`'s status id (compares
 * by id because /i/status/<id> redirects to the canonical /<user>/status/<id>).
 */
export function isOnPermalink(url: string): boolean {
  const id = url.match(/status\/(\d+)/)?.[1];
  return id !== undefined && location.pathname.includes(`/status/${id}`);
}

/**
 * Navigate to a tweet permalink and wait for its inline reply box
 * (X-DOM-BRIEF section 4). NOTE: `location.assign` to a different page is a
 * full document navigation on x.com — it destroys this content-script
 * instance, so the awaited waitFor never resolves. Callers that navigate must
 * persist a PendingJob first (see save/takePendingJob) so the fresh instance
 * injected on the new page can resume the flow.
 */
export async function goPermalink(url: string): Promise<void> {
  if (!isOnPermalink(url)) location.assign(url);
  await waitFor(X_SELECTORS.tweetTextareaPrefix, 12_000);
}

// --- Pending-job persistence across full-page permalink navigations ---------

const PENDING_JOB_KEY = 'exvibe.pendingJob';

export interface PendingJob {
  kind: 'reply';
  target: string;
  text: string;
  url: string;
  saved_at: number;
}

export function savePendingJob(job: PendingJob): void {
  try {
    sessionStorage.setItem(PENDING_JOB_KEY, JSON.stringify(job));
  } catch (err) {
    console.warn('[exvibe] could not persist pending job before navigation', err);
  }
}

export function clearPendingJob(): void {
  try {
    sessionStorage.removeItem(PENDING_JOB_KEY);
  } catch {
    /* sessionStorage unavailable — nothing to clear */
  }
}

/** Read-and-clear the pending job left behind by a pre-navigation save. */
export function takePendingJob(): PendingJob | null {
  try {
    const raw = sessionStorage.getItem(PENDING_JOB_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(PENDING_JOB_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const job = parsed as Partial<Record<keyof PendingJob, unknown>>;
    if (
      job.kind === 'reply' &&
      typeof job.target === 'string' &&
      typeof job.text === 'string' &&
      typeof job.url === 'string' &&
      typeof job.saved_at === 'number'
    ) {
      return parsed as PendingJob;
    }
    return null;
  } catch {
    return null;
  }
}

// --- High-level flows --------------------------------------------------------

/**
 * Post flow: ensure a composer is open (existing inline/modal box, else click
 * the left-rail new-post button), type with human cadence, send, confirm.
 */
export async function composePost(text: string): Promise<PostConfirmation> {
  if (!queryComposer()) {
    const navBtn = document.querySelector<HTMLElement>(X_SELECTORS.sideNavNewTweetButton);
    if (!navBtn) {
      selectorMiss(X_SELECTORS.sideNavNewTweetButton, 'composePost');
      throw new Error('no composer open and the new-post nav button is missing');
    }
    humanHover(navBtn);
    await sleep(rand(120, 400));
    navBtn.click();
    await waitFor(X_SELECTORS.tweetTextareaPrefix, 10_000);
  }
  await typeIntoComposer(text);
  return postCurrent();
}

/**
 * Reply flow (X-DOM-BRIEF reply variant a — preferred): navigate to the tweet
 * permalink, then use the inline reply box at the top of the replies.
 *
 * If we are not already on the permalink, `goPermalink` triggers a full
 * navigation that kills this instance — the PendingJob saved just before it
 * lets the content script injected on the permalink page resume and finish
 * (see resumePendingJob in index.ts). In that case the returned promise never
 * settles here; the result reaches the background as a POST_RESULT runtime
 * message from the new instance instead of via sendResponse.
 */
export async function composeReply(target: string, text: string): Promise<PostConfirmation> {
  const url = permalinkFor(target);
  if (!isOnPermalink(url)) {
    savePendingJob({ kind: 'reply', target, text, url, saved_at: Date.now() });
  }
  await goPermalink(url);
  clearPendingJob(); // still alive => no reload happened (or we were already here)
  await typeIntoComposer(text);
  return postCurrent();
}

/**
 * Quote flow: X turns a post whose trailing line is a tweet URL into a quote
 * tweet (the trailing link is hidden in the rendered post), so a quote is just
 * composePost(text + permalink). No navigation needed.
 */
export async function composeQuote(target: string, text: string): Promise<PostConfirmation> {
  return composePost(`${text}\n${permalinkFor(target)}`);
}
