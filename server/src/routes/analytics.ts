/**
 * GET /analytics · POST /analytics/run
 *
 * ../lib/analytics ports analytics.py: overview() returns the last saved
 * report (null → `{}` here, matching the original), runAnalytics(true) forces
 * a fresh snapshot → compute → claude-insights run and persists it.
 */

import * as analytics from '../lib/analytics';
import { json } from './http';

export function getAnalytics(): Response {
  return json(analytics.overview() ?? {});
}

export async function postAnalyticsRun(): Promise<Response> {
  return json(await analytics.runAnalytics(true));
}
