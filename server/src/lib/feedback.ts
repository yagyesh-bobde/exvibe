/**
 * Append-only feedback event store for X drafts. Port of feedback.py.
 *
 * One event per user action on a draft card (discard / mark_posted / like /
 * post). Discards are the negative signal; kept/edited/posted are positive.
 * The eval (evalEngine.ts) reads these to tune the learned voice state.
 * Lives in server/data/feedback.json.
 */

import { dataPath, readJson, writeJsonAtomic } from './storage';

const FEEDBACK_PATH = dataPath('feedback.json');

export const GOOD_ACTIONS: ReadonlySet<string> = new Set(['mark_posted', 'like', 'post']);
export const BAD_ACTIONS: ReadonlySet<string> = new Set(['discard']);

export type FeedbackSignal = 'good' | 'bad' | null;

export interface FeedbackEventInput {
  kind?: string;
  action?: string;
  original_text?: string;
  final_text?: string;
  target_author?: string;
  target_text?: string;
}

export interface FeedbackRecord {
  ts: string;
  kind: string | null;
  action: string | null;
  signal: FeedbackSignal;
  original_text: string;
  final_text: string;
  edited: boolean;
  target_author: string | null;
  target_text: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function loadEvents(path: string = FEEDBACK_PATH): FeedbackRecord[] {
  const data = readJson<unknown>(path, []);
  return Array.isArray(data) ? (data as FeedbackRecord[]) : [];
}

export function recordEvent(event: FeedbackEventInput, path: string = FEEDBACK_PATH): FeedbackRecord {
  const action = event.action ?? null;
  const signal: FeedbackSignal =
    action !== null && GOOD_ACTIONS.has(action)
      ? 'good'
      : action !== null && BAD_ACTIONS.has(action)
        ? 'bad'
        : null;
  const original = (event.original_text ?? '').trim();
  const final = (event.final_text ?? original).trim();
  const rec: FeedbackRecord = {
    ts: nowIso(),
    kind: event.kind ?? null,
    action,
    signal,
    original_text: original,
    final_text: final,
    edited: Boolean(original) && final !== original,
    target_author: event.target_author ?? null,
    target_text: event.target_text ?? null,
  };
  const events = loadEvents(path);
  events.push(rec);
  writeJsonAtomic(path, events);
  return rec;
}

export interface FeedbackSummary {
  good: number;
  bad: number;
  total: number;
  since_last: number;
  by_kind: Record<string, { good: number; bad: number }>;
}

export function summarize(events: FeedbackRecord[], sinceTs?: string | null): FeedbackSummary {
  const good = events.filter((e) => e.signal === 'good').length;
  const bad = events.filter((e) => e.signal === 'bad').length;
  const byKind: Record<string, { good: number; bad: number }> = {};
  for (const e of events) {
    const k = e.kind ?? '?';
    const d = (byKind[k] ??= { good: 0, bad: 0 });
    if (e.signal === 'good') d.good += 1;
    else if (e.signal === 'bad') d.bad += 1;
  }
  const since = sinceTs ? events.filter((e) => (e.ts ?? '') > sinceTs).length : 0;
  return { good, bad, total: events.length, since_last: since, by_kind: byKind };
}
