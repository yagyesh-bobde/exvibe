/**
 * Queue + scheduler: QueueItem[] persisted in chrome.storage.local (the MV3
 * service worker is ephemeral), driven by a periodic chrome.alarms tick that
 * fires due pending items through the poster.
 *
 * Cadence contract (docs/DASHBOARD-SPEC.md): "Queue +3h after latest pending,
 * min lead 60s. Alarm scans every ~30–60s."
 */

import type { Msg, PostPayload } from '../shared/messages';
import type { QueueItem } from '../shared/models';
import { postNow } from './poster';

/** chrome.storage.local key holding the QueueItem[]. */
export const QUEUE_STORAGE_KEY = 'exvibe_queue';

const ALARM_NAME = 'exvibe-tick';
const TICK_PERIOD_MINUTES = 1;
const QUEUE_GAP_MS = 3 * 60 * 60 * 1000; // +3h between queued items
const MIN_LEAD_MS = 60_000; // never fire sooner than now + 60s
const INTER_POST_GAP_MS: readonly [number, number] = [4_000, 12_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randBetween([min, max]: readonly [number, number]): number {
  return min + Math.random() * (max - min);
}

function parseIso(iso: string): number | undefined {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

// ---------------------------------------------------------------------------
// Storage (serialized read-modify-write so concurrent mutations can't clobber)
// ---------------------------------------------------------------------------

async function readQueue(): Promise<QueueItem[]> {
  const store = await chrome.storage.local.get(QUEUE_STORAGE_KEY);
  const raw: unknown = store[QUEUE_STORAGE_KEY];
  return Array.isArray(raw) ? (raw as QueueItem[]) : [];
}

let queueLock: Promise<unknown> = Promise.resolve();

function mutateQueue<T>(fn: (queue: QueueItem[]) => T): Promise<T> {
  const run = async (): Promise<T> => {
    const queue = await readQueue();
    const result = fn(queue);
    await chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: queue });
    return result;
  };
  const next = queueLock.then(run, run);
  queueLock = next.catch(() => undefined);
  return next;
}

/** Nudge the panel to re-read chrome.storage; harmless when the panel is closed. */
function notifyQueueUpdated(): void {
  const msg: Msg = { type: 'QUEUE_UPDATED' };
  chrome.runtime.sendMessage(msg).catch(() => {
    /* no listener (panel closed) — expected */
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add an item at queue cadence: 3h after the latest pending item, never sooner
 * than now + 60s. The incoming item's fire_at_iso is overwritten.
 */
export async function enqueue(item: QueueItem): Promise<QueueItem> {
  const queued = await mutateQueue((queue) => {
    const latestPending = queue
      .filter((q) => q.status === 'pending')
      .map((q) => parseIso(q.fire_at_iso) ?? 0)
      .reduce((max, t) => Math.max(max, t), 0);
    const fireAt = Math.max(
      Date.now() + MIN_LEAD_MS,
      latestPending > 0 ? latestPending + QUEUE_GAP_MS : 0,
    );
    const normalized: QueueItem = {
      ...item,
      id: item.id || crypto.randomUUID(),
      created_at: item.created_at || new Date().toISOString(),
      fire_at_iso: new Date(fireAt).toISOString(),
      status: 'pending',
      source: 'queue',
    };
    queue.push(normalized);
    return normalized;
  });
  notifyQueueUpdated();
  return queued;
}

/** Schedule an item for an explicit fire time (clamped to now + 60s minimum). */
export async function schedule(item: QueueItem, fireAtIso: string): Promise<QueueItem> {
  const requested = parseIso(fireAtIso);
  if (requested === undefined) {
    throw new Error(`invalid fire_at_iso: ${fireAtIso}`);
  }
  const fireAt = Math.max(requested, Date.now() + MIN_LEAD_MS);
  const scheduled = await mutateQueue((queue) => {
    const normalized: QueueItem = {
      ...item,
      id: item.id || crypto.randomUUID(),
      created_at: item.created_at || new Date().toISOString(),
      fire_at_iso: new Date(fireAt).toISOString(),
      status: 'pending',
      source: 'scheduled',
    };
    queue.push(normalized);
    return normalized;
  });
  notifyQueueUpdated();
  return scheduled;
}

/** Cancel a pending item. Returns false if it was not found or already settled. */
export async function cancel(id: string): Promise<boolean> {
  const cancelled = await mutateQueue((queue) => {
    const target = queue.find((q) => q.id === id && q.status === 'pending');
    if (!target) return false;
    target.status = 'cancelled';
    return true;
  });
  if (cancelled) notifyQueueUpdated();
  return cancelled;
}

/** Pending items, soonest first. */
export async function listPending(): Promise<QueueItem[]> {
  const queue = await readQueue();
  return queue
    .filter((q) => q.status === 'pending')
    .sort((a, b) => (parseIso(a.fire_at_iso) ?? 0) - (parseIso(b.fire_at_iso) ?? 0));
}

/** Full queue (all statuses), soonest first — for the panel's Queue tab. */
export async function listQueue(): Promise<QueueItem[]> {
  const queue = await readQueue();
  return queue.sort((a, b) => (parseIso(a.fire_at_iso) ?? 0) - (parseIso(b.fire_at_iso) ?? 0));
}

// ---------------------------------------------------------------------------
// Alarm tick
// ---------------------------------------------------------------------------

let tickInFlight = false;

async function settleItem(id: string, update: Partial<QueueItem>): Promise<void> {
  await mutateQueue((queue) => {
    const target = queue.find((q) => q.id === id);
    if (target) Object.assign(target, update);
  });
}

/** Fire every due pending item, sequentially, with a small human-ish gap. */
async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const now = Date.now();
    const due = (await listPending()).filter((q) => (parseIso(q.fire_at_iso) ?? Infinity) <= now);
    if (due.length === 0) return;

    for (const [index, item] of due.entries()) {
      const payload: PostPayload = {
        kind: item.kind,
        text: item.text,
        target_id: item.target_id,
      };
      const result = await postNow(payload, item.source);
      await settleItem(
        item.id,
        result.ok
          ? { status: 'fired', fired_at: new Date().toISOString(), result: result.tweet_url ?? 'posted' }
          : { status: 'failed', fired_at: new Date().toISOString(), error: result.error ?? 'unknown error' },
      );
      notifyQueueUpdated();
      if (index < due.length - 1) {
        await sleep(randBetween(INTER_POST_GAP_MS)); // never back-to-back with identical timing
      }
    }
  } catch (err) {
    console.warn('[exvibe] scheduler tick failed:', err instanceof Error ? err.message : String(err));
  } finally {
    tickInFlight = false;
  }
}

/** Idempotent — chrome.alarms.create replaces any alarm with the same name. */
export function ensureTickAlarm(): void {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: TICK_PERIOD_MINUTES, delayInMinutes: 1 });
}

// Top-level registration: runs on every service-worker wake, so the alarm and
// its handler survive SW teardown and browser restarts.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void tick();
});
chrome.runtime.onStartup.addListener(() => ensureTickAlarm());
ensureTickAlarm();
