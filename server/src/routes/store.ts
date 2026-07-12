/**
 * Route-level access to `server/data/dashboard_data.json` (the pipeline's
 * output payload, shape ported from the Python dashboard's pipeline.py).
 *
 * Uses ../lib/storage (loadJson = tolerant read, saveJson = atomic
 * .tmp+rename) so route writes go through the same persistence layer as the
 * pipeline. Kept loosely typed on purpose: the JSON on disk is external input
 * (hand-editable), so every field is treated as untrusted.
 */

import { dataPath, loadJson, saveJson } from '../lib/storage';
import type { FeedCard } from '../types';

export const DASHBOARD_DATA_PATH = dataPath('dashboard_data.json');

export const FEED_PAGE_SIZE = 10;
export const NO_DATA_MESSAGE = 'no data yet — click refresh.';

export type DraftListKey = 'posts' | 'replies' | 'quotes';

/** Draft record as stored on disk (external JSON — treat every field as untrusted). */
export interface StoredDraft {
  id?: unknown;
  [key: string]: unknown;
}

/** Scored feed item as written by the pipeline (normalize_tweet + score fields). */
export interface RawFeedItem {
  id?: unknown;
  author?: unknown;
  text?: unknown;
  likes?: unknown;
  rts?: unknown;
  replies?: unknown;
  time?: unknown;
  score?: unknown;
  trend_score?: unknown;
  [key: string]: unknown;
}

export interface DashboardData {
  generated_at?: string;
  user?: string;
  interest_signature?: Record<string, unknown>;
  explore?: RawFeedItem[];
  trending?: RawFeedItem[];
  drafts?: Partial<Record<DraftListKey, StoredDraft[]>>;
  [key: string]: unknown;
}

export async function loadDashboardData(): Promise<DashboardData | null> {
  return loadJson<DashboardData | null>(DASHBOARD_DATA_PATH, null);
}

export async function saveDashboardData(data: DashboardData): Promise<void> {
  await saveJson(DASHBOARD_DATA_PATH, data);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function toFeedCard(item: RawFeedItem): FeedCard {
  const id = typeof item.id === 'string' ? item.id : String(item.id ?? '');
  const card: FeedCard = {
    id,
    author: typeof item.author === 'string' ? item.author : '',
    text: typeof item.text === 'string' ? item.text : '',
    likes: toNumber(item.likes),
    retweets: toNumber(item.rts),
    replies: toNumber(item.replies),
    url: `https://x.com/i/status/${id}`,
  };
  const score =
    typeof item.score === 'number'
      ? item.score
      : typeof item.trend_score === 'number'
        ? item.trend_score
        : undefined;
  if (score !== undefined) card.score = score;
  return card;
}
