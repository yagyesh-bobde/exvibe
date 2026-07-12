/** Time formatting, countdowns and queue grouping for the panel. */

import type { QueueItem } from '../../shared/models';

const HOUR = 3_600_000;

/** "due" | "43s" | "12m 05s" | "2h 14m" | "3d 4h" */
export function countdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'due';
  const s = Math.ceil(msRemaining / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtDayClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtClock(iso)}`;
}

export type QueueGroupKey = 'due' | 'hour' | 'today' | 'tomorrow' | 'later';

export const QUEUE_GROUP_ORDER: readonly QueueGroupKey[] = [
  'due',
  'hour',
  'today',
  'tomorrow',
  'later',
];

export const QUEUE_GROUP_LABEL: Record<QueueGroupKey, string> = {
  due: 'due now',
  hour: 'within the hour',
  today: 'today',
  tomorrow: 'tomorrow',
  later: 'later',
};

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function queueGroupOf(fireAtMs: number, nowMs: number): QueueGroupKey {
  const delta = fireAtMs - nowMs;
  if (delta <= 0) return 'due';
  if (delta <= HOUR) return 'hour';
  const fire = new Date(fireAtMs);
  const now = new Date(nowMs);
  if (sameLocalDay(fire, now)) return 'today';
  const tomorrow = new Date(nowMs);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameLocalDay(fire, tomorrow)) return 'tomorrow';
  return 'later';
}

export function groupQueueItems(
  items: QueueItem[],
  nowMs: number,
): Array<{ key: QueueGroupKey; items: QueueItem[] }> {
  const buckets = new Map<QueueGroupKey, QueueItem[]>();
  const sorted = [...items].sort(
    (a, b) => Date.parse(a.fire_at_iso) - Date.parse(b.fire_at_iso),
  );
  for (const item of sorted) {
    const key = queueGroupOf(Date.parse(item.fire_at_iso), nowMs);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return QUEUE_GROUP_ORDER.flatMap((key) => {
    const bucket = buckets.get(key);
    return bucket ? [{ key, items: bucket }] : [];
  });
}

/** Value for <input type="datetime-local"> in the local timezone. */
export function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
