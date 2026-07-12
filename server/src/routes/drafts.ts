/**
 * POST /draft/regenerate · POST /draft/remove
 *
 * `regenerateDraft` (../pipeline) generates ONE fresh draft in the given lane,
 * honoring the user's prompt tweak (`feedback`), updates dashboard_data.json
 * in place, and returns the fresh draft — or null when the draft id is
 * unknown or the claude call failed.
 */

import { regenerateDraft } from '../pipeline';
import type { DraftKind } from '../types';
import { ApiError, json, optionalString, readJsonBody, requireDraftKind, requireString } from './http';
import { loadDashboardData, saveDashboardData, type DraftListKey } from './store';

export async function postDraftRegenerate(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const kind = requireDraftKind(body);
  const id = requireString(body, 'id').trim();
  const feedback = optionalString(body, 'feedback')?.trim() ?? '';
  const draft = await regenerateDraft(kind, id, feedback);
  if (!draft) {
    throw new ApiError(502, `regenerate failed for ${kind} ${id} (draft not found or claude call failed)`);
  }
  return json(draft);
}

const KIND_KEYS: Record<DraftKind, DraftListKey> = {
  post: 'posts',
  reply: 'replies',
  quote: 'quotes',
};

/**
 * Persistently remove a draft from dashboard_data.json so it does not
 * reappear on reload/refresh. Used for both discard and mark-posted (the
 * good/bad signal is recorded separately via /feedback). Idempotent.
 */
export async function postDraftRemove(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const kind = requireDraftKind(body);
  const id = requireString(body, 'id').trim();

  const data = await loadDashboardData();
  if (!data) throw new ApiError(400, 'no dashboard data');

  const key = KIND_KEYS[kind];
  const drafts = data.drafts ?? {};
  const list = drafts[key] ?? [];
  const kept = list.filter((d) => String(d.id ?? '') !== id);
  const removed = list.length - kept.length;
  if (removed > 0) {
    drafts[key] = kept;
    data.drafts = drafts;
    await saveDashboardData(data);
  }
  return json({ ok: true, removed });
}
