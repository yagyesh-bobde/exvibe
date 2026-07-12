/**
 * x.com content script entry: human-emulation engine wiring.
 *
 * Receives DO_POST from the background service worker, runs the appropriate
 * compose flow (emulate.ts), and answers with POST_RESULT. Also resumes
 * reply flows interrupted by a full-page permalink navigation, watches SPA
 * route changes, and logs selector-health warnings.
 */

import { X_SELECTORS } from '../shared/selectors';
import { sendToBackground } from '../shared/messages';
import type { Msg, PostPayload, PostResultMsg } from '../shared/messages';
import {
  composePost,
  composeQuote,
  composeReply,
  isOnPermalink,
  takePendingJob,
} from './emulate';
import { startRouteWatcher } from './nav';

console.log('[exvibe] content script loaded on', location.href);

// --- DO_POST handling --------------------------------------------------------

async function handleDoPost(payload: PostPayload): Promise<PostResultMsg> {
  try {
    const confirmation =
      payload.kind === 'post'
        ? await composePost(payload.text)
        : payload.kind === 'quote'
          ? await composeQuote(requireTarget(payload), payload.text)
          : await composeReply(requireTarget(payload), payload.text);
    return { type: 'POST_RESULT', ok: true, tweet_url: confirmation.tweetUrl };
  } catch (err) {
    return {
      type: 'POST_RESULT',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function requireTarget(payload: PostPayload): string {
  if (!payload.target_id) throw new Error(`${payload.kind} requires target_id`);
  return payload.target_id;
}

chrome.runtime.onMessage.addListener(
  (message: Msg, _sender, sendResponse: (response: PostResultMsg) => void) => {
    if (message.type !== 'DO_POST') return false;
    // NOTE: a reply whose flow triggers a full permalink navigation destroys
    // this instance mid-await — sendResponse then never fires and the sender
    // sees a closed message port. The resumed instance reports the outcome via
    // a POST_RESULT runtime message instead (resumePendingJob below); the
    // background must accept both paths.
    void handleDoPost(message.payload).then(sendResponse);
    return true; // keep the sendResponse channel open for the async flow
  },
);

// --- Resume replies interrupted by full-page permalink navigation ------------

const PENDING_JOB_MAX_AGE_MS = 2 * 60_000;

async function resumePendingJob(): Promise<void> {
  const job = takePendingJob();
  if (!job) return;
  if (Date.now() - job.saved_at > PENDING_JOB_MAX_AGE_MS) {
    console.warn('[exvibe] dropping stale pending reply job', job);
    return;
  }
  if (!isOnPermalink(job.url)) {
    // Landed somewhere else (redirect, login wall) — do NOT retry composeReply
    // here, it would re-save + re-navigate and could loop.
    await reportResult({
      type: 'POST_RESULT',
      ok: false,
      error: `navigation to ${job.url} landed on ${location.href} instead`,
    });
    return;
  }
  console.log('[exvibe] resuming pending reply after permalink navigation');
  try {
    const confirmation = await composeReply(job.target, job.text);
    await reportResult({ type: 'POST_RESULT', ok: true, tweet_url: confirmation.tweetUrl });
  } catch (err) {
    await reportResult({
      type: 'POST_RESULT',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function reportResult(msg: PostResultMsg): Promise<void> {
  try {
    await sendToBackground(msg);
  } catch (err) {
    console.warn('[exvibe] could not deliver POST_RESULT to background', err);
  }
}

void resumePendingJob();

// --- SPA route watching + passive selector health -----------------------------

const healthWarned = new Set<string>();

/**
 * Passive selector-health check for elements expected on every logged-in
 * desktop page. Operational misses (composer, buttons, toast) are logged at
 * the point of failure by dom.waitFor / emulate.ts.
 */
function checkSelectorHealth(): void {
  const expectedEverywhere: ReadonlyArray<readonly [name: string, selector: string]> = [
    ['sideNavNewTweetButton', X_SELECTORS.sideNavNewTweetButton],
  ];
  for (const [name, selector] of expectedEverywhere) {
    if (!document.querySelector(selector) && !healthWarned.has(selector)) {
      healthWarned.add(selector);
      console.warn(
        `[exvibe] selector-health: "${name}" (${selector}) not found on ${location.pathname}. ` +
          'Logged out, narrow layout, or X changed its DOM — check src/shared/selectors.ts.',
      );
    }
  }
}

startRouteWatcher((pathname) => {
  console.debug('[exvibe] route change ->', pathname);
  setTimeout(checkSelectorHealth, 1_500); // let the new view render first
});

setTimeout(checkSelectorHealth, 3_000);
