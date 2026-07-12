/**
 * Shared HTTP plumbing for the exvibe server routes: CORS + no-store JSON
 * responses, typed error propagation, and request-body validation helpers.
 */

import type { DraftKind, FeedbackAction } from '../types';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

/** Throwable HTTP error; the router turns it into `{ok:false, error, ...extra}`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a JSON object body. An empty body is treated as `{}`. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new ApiError(400, 'unreadable request body');
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid JSON body');
  }
  if (!isRecord(parsed)) throw new ApiError(400, 'request body must be a JSON object');
  return parsed;
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(400, `${key} must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ApiError(400, `${key} must be a string`);
  return value;
}

export function requireDraftKind(body: Record<string, unknown>): DraftKind {
  const value = body['kind'];
  if (value === 'post' || value === 'reply' || value === 'quote') return value;
  throw new ApiError(400, "kind must be one of 'post' | 'reply' | 'quote'");
}

export function requireFeedbackAction(body: Record<string, unknown>): FeedbackAction {
  const value = body['action'];
  if (value === 'discard' || value === 'mark_posted' || value === 'like' || value === 'post') {
    return value;
  }
  throw new ApiError(400, "action must be one of 'discard' | 'mark_posted' | 'like' | 'post'");
}
