/**
 * Central request dispatcher: method+path route table, CORS preflight, and
 * uniform JSON error handling ({ok:false, error} — ApiError keeps its status,
 * anything else becomes a 500).
 *
 * NOTE: there is deliberately NO /post route — posting/replying/quoting is the
 * extension's job (human-emulation in the real x.com tab). The extension
 * reports successful posts back via POST /feedback {action:"post"}.
 */

import { getAgent, postAgent, postAgentStudy } from './agent';
import { getAnalytics, postAnalyticsRun } from './analytics';
import { getData, getFeed, getSignature, postRefresh } from './data';
import { postDraftRegenerate, postDraftRemove } from './drafts';
import { getEvals, postEvalRun, postEvalsRevert } from './evals';
import { postFeedback } from './feedback';
import { ApiError, json, preflight } from './http';

type Handler = (req: Request, url: URL) => Promise<Response> | Response;

const ROUTES: ReadonlyMap<string, Handler> = new Map<string, Handler>([
  ['GET /healthz', () => json({ ok: true, now: new Date().toISOString() })],
  ['GET /data', getData],
  ['POST /refresh', postRefresh],
  ['GET /signature', getSignature],
  ['GET /feed', getFeed],
  ['POST /draft/regenerate', postDraftRegenerate],
  ['POST /draft/remove', postDraftRemove],
  ['POST /feedback', postFeedback],
  ['GET /evals', getEvals],
  ['POST /eval/run', postEvalRun],
  ['POST /evals/revert', postEvalsRevert],
  ['GET /analytics', getAnalytics],
  ['POST /analytics/run', postAnalyticsRun],
  ['GET /agent', getAgent],
  ['POST /agent', postAgent],
  ['POST /agent/study', postAgentStudy],
]);

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return preflight();

  const handler = ROUTES.get(`${req.method} ${url.pathname}`);
  if (!handler) {
    const pathExists = ['GET', 'POST'].some((m) => ROUTES.has(`${m} ${url.pathname}`));
    return json(
      { ok: false, error: pathExists ? 'method not allowed' : 'not found' },
      pathExists ? 405 : 404,
    );
  }

  try {
    return await handler(req, url);
  } catch (err) {
    if (err instanceof ApiError) {
      return json({ ok: false, error: err.message, ...err.extra }, err.status);
    }
    console.error(`[exvibe] ${req.method} ${url.pathname} failed:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: message }, 500);
  }
}
