/**
 * GET /evals · POST /eval/run · POST /evals/revert
 *
 * ../lib/evalEngine ports eval_engine.py: overview() → {runs, summary, state},
 * runEval(true) forces an eval cycle (may still return {skipped}), revertEval
 * restores the pre-run voice state.
 */

import * as evalEngine from '../lib/evalEngine';
import { json, readJsonBody, requireString } from './http';

export function getEvals(): Response {
  return json(evalEngine.overview());
}

export async function postEvalRun(): Promise<Response> {
  const run = await evalEngine.runEval(true);
  // voice_changed signals whether the learned voice prompt actually changed;
  // if so the client should regenerate the (now stale) draft set.
  return json({ ...run, voice_changed: evalEngine.voiceChanged(run) });
}

export async function postEvalsRevert(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const id = requireString(body, 'id').trim();
  const result = await evalEngine.revertEval(id);
  return json(result, result.ok ? 200 : 404);
}
