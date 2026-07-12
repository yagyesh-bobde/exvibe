/**
 * GET /data · POST /refresh · GET /signature · GET /feed
 *
 * `runPipeline` (../pipeline) runs the full signal-fetch → score → draft
 * pipeline and writes server/data/dashboard_data.json before resolving.
 */

import { runPipeline } from '../pipeline';
import { ApiError, json } from './http';
import {
  FEED_PAGE_SIZE,
  loadDashboardData,
  NO_DATA_MESSAGE,
  toFeedCard,
} from './store';

export async function getData(): Promise<Response> {
  const data = await loadDashboardData();
  if (!data) return json({ empty: true, message: NO_DATA_MESSAGE });
  return json(data);
}

/**
 * Single-flight guard: the pipeline is heavy (many `claude` calls, ~minutes);
 * a second concurrent /refresh is rejected with 409 instead of queueing.
 */
let refreshing = false;

export async function postRefresh(): Promise<Response> {
  if (refreshing) throw new ApiError(409, 'refresh already in progress');
  refreshing = true;
  try {
    await runPipeline();
  } finally {
    refreshing = false;
  }
  const data = await loadDashboardData();
  if (!data) {
    throw new ApiError(500, 'pipeline finished but wrote no dashboard data');
  }
  return json(data);
}

export async function getSignature(): Promise<Response> {
  const data = await loadDashboardData();
  if (!data || !data.interest_signature) {
    return json({ empty: true, message: NO_DATA_MESSAGE });
  }
  return json(data.interest_signature);
}

export async function getFeed(_req: Request, url: URL): Promise<Response> {
  const kind = url.searchParams.get('kind') ?? 'for-you';
  if (kind !== 'for-you' && kind !== 'trending') {
    throw new ApiError(400, "kind must be 'for-you' or 'trending'");
  }
  const rawPage = url.searchParams.get('page') ?? '0';
  const page = Number.parseInt(rawPage, 10);
  if (!Number.isInteger(page) || page < 0) {
    throw new ApiError(400, 'page must be a non-negative integer');
  }

  const data = await loadDashboardData();
  // "for-you" is the interest-scored pool the pipeline stores as `explore`.
  const pool = (kind === 'for-you' ? data?.explore : data?.trending) ?? [];
  const start = page * FEED_PAGE_SIZE;
  const cards = pool.slice(start, start + FEED_PAGE_SIZE).map(toFeedCard);
  return json({ kind, page, total: pool.length, cards });
}
