/**
 * exvibe pipeline — port of pipeline.py.
 *
 * Fetches the user's recent Twitter signal (bookmarks, likes, home feed, own
 * posts), extracts an interest signature, picks today's most relevant feed
 * candidates, then calls `claude --agent <DASHBOARD_AGENT>` to draft
 * posts/replies/quotes in voice.
 *
 * Drafting is batched + run in parallel so we can produce ~100 of each kind
 * per refresh without blowing a single claude call's context/timeout.
 *
 * Output: server/data/dashboard_data.json
 */

import { join } from 'node:path';
import * as analytics from './lib/analytics';
import * as evalEngine from './lib/evalEngine';
import { claude, dashboardAgent, twitter, twitterHandle } from './lib/exec';
import {
  buildDraftPrompt,
  buildPostPrompt,
  buildQuotePrompt,
  buildReplyPrompt,
  POST_LANES,
  type PromptContext,
} from './lib/prompts';
import {
  interestSignature,
  normalizeList,
  scoreFeed,
  STOPWORDS,
  trendingFeed,
  type NormalizedTweet,
  type PublicSignature,
  type ScoredTweet,
  type TrendingTweet,
} from './lib/signature';
import { dataPath, ensureDataDir, RAW_DIR, readJson, writeJsonAtomic } from './lib/storage';
import * as voiceState from './lib/voiceState';
import type { Draft, DraftKind } from './types';

const OUT_PATH = dataPath('dashboard_data.json');

// ── draft volume / batching ──────────────────────────────────────────────────
// How many drafts of each kind to aim for per refresh.
const POSTS_TARGET = Number(process.env['DASHBOARD_POSTS'] ?? '') || 100;
const REPLIES_TARGET = Number(process.env['DASHBOARD_REPLIES'] ?? '') || 300;
const QUOTES_TARGET = Number(process.env['DASHBOARD_QUOTES'] ?? '') || 300;
// Per-claude-call batch size (keeps each generation focused + within timeout).
const POST_BATCH = 20;
const REPLY_BATCH = 20;
const QUOTE_BATCH = 20;
// Concurrent claude processes. Each is heavy; keep this modest.
const MAX_DRAFT_WORKERS = Number(process.env['DASHBOARD_DRAFT_WORKERS'] ?? '') || 5;
// Hard constraint: we only ever reply to / quote tweets younger than this.
// Engaging a stale tweet reads as necro-posting and gets ~no reach, so a tweet
// whose age we can't confirm is treated as too old and dropped.
const MAX_TARGET_AGE_HOURS = Number(process.env['DASHBOARD_MAX_TARGET_AGE_HOURS'] ?? '') || 12;

// ── payload types ────────────────────────────────────────────────────────────

export interface PostDraft {
  id: string;
  template: string;
  text: string;
}

export interface TargetDraft {
  id: string;
  target_id: string;
  target_author: string;
  target_text: string;
  text: string;
}

export interface DraftsBundle {
  posts: PostDraft[];
  replies: TargetDraft[];
  quotes: TargetDraft[];
}

export interface DashboardPayload {
  generated_at: string;
  user: string;
  interest_signature: PublicSignature;
  explore: ScoredTweet[];
  trending: TrendingTweet[];
  drafts: DraftsBundle;
  counts: { bookmarks: number; favorites: number; feed: number; mine: number };
  elapsed_seconds: number;
}

// ── signal fetch ─────────────────────────────────────────────────────────────

interface RawSignal {
  bookmarks: unknown;
  favorites: unknown;
  feed: unknown;
  mine: unknown;
}

/** Number of usable tweets in a raw twitter payload (bare array or {data:[...]} wrapper). */
function signalCount(v: unknown): number {
  return normalizeList(v).length;
}

/**
 * One signal fetch with a retry and a last-good fallback. The twitter CLI
 * fails transiently (rate limits, ClientTransaction init scrapes) and an
 * empty feed silently zeroes out every reply/quote target downstream, so:
 * retry once after a pause, and if both attempts come back empty, reuse the
 * previous raw dump rather than proceeding with nothing. Raw dumps are only
 * overwritten by non-empty fetches so the fallback is never clobbered.
 */
async function fetchSignal(key: keyof RawSignal, args: string[]): Promise<unknown> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let v: unknown = null;
    try {
      v = await twitter(args, 150_000);
    } catch (e) {
      console.error(`[pipeline] fetch ${key} crashed: ${e instanceof Error ? e.message : e}`);
    }
    if (signalCount(v) > 0) {
      try {
        writeJsonAtomic(join(RAW_DIR, `${key}.json`), v);
      } catch {
        // best-effort
      }
      return v;
    }
    if (attempt === 1) {
      console.error(`[pipeline] fetch ${key} returned no items; retrying once...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const cached = readJson<unknown>(join(RAW_DIR, `${key}.json`), null);
  const n = signalCount(cached);
  if (n > 0) {
    console.error(
      `[pipeline] fetch ${key} empty after retry; falling back to last raw dump (${n} items)`,
    );
    return cached;
  }
  console.error(`[pipeline] fetch ${key} empty after retry and no raw fallback available`);
  return [];
}

/** Parallel fetch of all relevant Twitter signal; raw dumps → data/raw/. */
async function fetchAll(username: string): Promise<RawSignal> {
  // Larger pulls than the original 5-draft pipeline — we want enough feed
  // candidates to seed ~100 replies + ~100 quotes against real target ids.
  // The feed pull alone takes ~45-50s; give fetches a generous timeout so
  // they don't silently drop to zero candidates.
  // NB: `favorites` in the twitter CLI is an alias for bookmarks; actual
  // liked tweets come from `likes <handle>` (own likes only — X made likes
  // private, but the pipeline only ever queries the user's own).
  const tasks: Array<[keyof RawSignal, string[]]> = [
    ['bookmarks', ['bookmarks', '-n', '80']],
    ['favorites', ['likes', `@${username}`, '-n', '80']],
    ['feed', ['feed', '-n', '500']],
    ['mine', ['user-posts', `@${username}`, '-n', '40']],
  ];
  const out: RawSignal = { bookmarks: [], favorites: [], feed: [], mine: [] };
  await Promise.all(
    tasks.map(async ([key, args]) => {
      out[key] = await fetchSignal(key, args);
    }),
  );
  return out;
}

// ── variety: near-duplicate detection, history, target diversification ───────
// The old pipeline produced ~100 of each kind but they clustered hard: the
// same ~8 themes reworded, the same openers, replies+quotes seeded from the
// identical top-of-pool, and nothing checked against what was already
// posted/scheduled. The helpers below force spread.

function norm(text: string): string {
  return (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function wordSet(text: string): Set<string> {
  const words = (text ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w) && w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0.0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function opener(text: string, n = 2): string {
  const words = (text ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return words.slice(0, n).join(' ');
}

export interface DraftHistory {
  post_texts: Array<Set<string>>;
  reply_target_ids: Set<string>;
  quote_target_ids: Set<string>;
}

/**
 * What I've already posted / scheduled — so we never re-surface it.
 * Returns normalized post texts (to drop near-duplicate post drafts) and the
 * target_ids already replied-to / quoted (to drop those reply/quote targets).
 */
export function loadHistory(mine?: NormalizedTweet[]): DraftHistory {
  const postTexts: Array<Set<string>> = [];
  const replyTargetIds = new Set<string>();
  const quoteTargetIds = new Set<string>();
  for (const t of mine ?? []) {
    const ws = wordSet(t.text ?? '');
    if (ws.size) postTexts.push(ws);
  }
  for (const fn of ['posted.json', 'scheduled.json']) {
    const items = readJson<unknown>(dataPath(fn), null);
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (it === null || typeof it !== 'object') continue;
      const rec = it as Record<string, unknown>;
      const kind = rec['kind'];
      const tid = String(rec['target_id'] ?? '');
      if (kind === 'post') {
        const ws = wordSet(typeof rec['text'] === 'string' ? rec['text'] : '');
        if (ws.size) postTexts.push(ws);
      } else if (kind === 'reply' && tid) {
        replyTargetIds.add(tid);
      } else if (kind === 'quote' && tid) {
        quoteTargetIds.add(tid);
      }
    }
  }
  return { post_texts: postTexts, reply_target_ids: replyTargetIds, quote_target_ids: quoteTargetIds };
}

/** Creation time of a tweet in epoch ms, or null if it can't be parsed. */
export function tweetEpochMs(t: { createdAtISO?: string; time?: string }): number | null {
  const raw = (t.createdAtISO || t.time || '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Keep only tweets younger than `maxHours` (measured from `now`). This is a
 * HARD constraint for reply/quote targets: a tweet whose age can't be parsed is
 * dropped rather than assumed fresh.
 */
export function filterFresh<T extends { createdAtISO?: string; time?: string }>(
  items: T[],
  now: number,
  maxHours = MAX_TARGET_AGE_HOURS,
): T[] {
  const cutoffMs = maxHours * 3_600_000;
  return items.filter((t) => {
    const ms = tweetEpochMs(t);
    if (ms === null) return false;
    return now - ms <= cutoffMs;
  });
}

/**
 * Cap how many feed items per author survive so one loud account can't
 * dominate the reply/quote targets. Preserves the incoming (score) order.
 */
export function diversifyPool<T extends { author: string }>(items: T[], perAuthorCap = 2): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const t of items) {
    const a = (t.author ?? '').toLowerCase();
    if (a && (counts.get(a) ?? 0) >= perAuthorCap) continue;
    counts.set(a, (counts.get(a) ?? 0) + 1);
    out.push(t);
  }
  return out;
}

/**
 * Drop near-duplicate posts: exact repeats, high token overlap with an
 * already-kept post or anything in history, and more than `openerCap` posts
 * sharing the same opening words.
 */
export function dedupePosts(
  posts: PostDraft[],
  history: Array<Set<string>> = [],
  simThreshold = 0.55,
  openerCap = 2,
): PostDraft[] {
  const seenExact = new Set<string>();
  const keptSets: Array<Set<string>> = [];
  const openerCounts = new Map<string, number>();
  const out: PostDraft[] = [];
  for (const p of posts) {
    const text = p.text ?? '';
    const key = norm(text);
    if (!key || seenExact.has(key)) continue;
    const ws = wordSet(text);
    if (history.some((h) => jaccard(ws, h) >= simThreshold)) continue;
    if (keptSets.some((k) => jaccard(ws, k) >= simThreshold)) continue;
    const op = opener(text);
    if (op && (openerCounts.get(op) ?? 0) >= openerCap) continue;
    seenExact.add(key);
    keptSets.push(ws);
    openerCounts.set(op, (openerCounts.get(op) ?? 0) + 1);
    out.push(p);
  }
  return out;
}

/** One reply / one quote per target id. */
function dedupeByTarget(items: TargetDraft[]): TargetDraft[] {
  const seen = new Set<string>();
  const out: TargetDraft[] = [];
  for (const it of items) {
    const tid = String(it.target_id ?? '');
    if (seen.has(tid)) continue;
    seen.add(tid);
    out.push(it);
  }
  return out;
}

function chunk<T>(lst: T[], size: number): T[][] {
  if (size <= 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < lst.length; i += size) {
    out.push(lst.slice(i, i + size));
  }
  return out;
}

// ── parallel claude batches ──────────────────────────────────────────────────

/** Run async thunks with bounded concurrency, preserving order. */
async function runPool<T>(tasks: Array<() => Promise<T>>, workers: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i];
      if (!task) break;
      results[i] = await task();
    }
  };
  const n = Math.min(workers, tasks.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** Run many claude calls in parallel; return the parsed dicts that succeeded. */
async function runBatches(prompts: string[], labels: string[]): Promise<Array<Record<string, unknown>>> {
  if (!prompts.length) return [];
  const agent = dashboardAgent();
  const tasks = prompts.map((p, i) => {
    const label = labels[i] ?? `batch ${i + 1}/${prompts.length}`;
    return async (): Promise<Record<string, unknown> | null> => {
      try {
        return await claude(p, agent, { timeoutMs: 300_000, label });
      } catch (e) {
        console.error(`[pipeline] draft batch crashed: ${e instanceof Error ? e.message : e}`);
        return null;
      }
    };
  });
  const results = await runPool(tasks, MAX_DRAFT_WORKERS);
  const out = results.filter((d): d is Record<string, unknown> => d !== null);
  if (out.length < prompts.length) {
    console.error(`[pipeline] draft batches: ${out.length}/${prompts.length} succeeded`);
  }
  return out;
}

// ── result coercion ──────────────────────────────────────────────────────────

function coercePostDrafts(v: unknown): PostDraft[] {
  if (!Array.isArray(v)) return [];
  const out: PostDraft[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec['text'] === 'string' ? rec['text'] : '';
    if (!text) continue;
    out.push({
      id: typeof rec['id'] === 'string' ? rec['id'] : '',
      template: typeof rec['template'] === 'string' ? rec['template'] : 'none',
      text,
    });
  }
  return out;
}

function coerceTargetDrafts(v: unknown): TargetDraft[] {
  if (!Array.isArray(v)) return [];
  const out: TargetDraft[] = [];
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec['text'] === 'string' ? rec['text'] : '';
    if (!text) continue;
    out.push({
      id: typeof rec['id'] === 'string' ? rec['id'] : '',
      target_id: String(rec['target_id'] ?? ''),
      target_author: typeof rec['target_author'] === 'string' ? rec['target_author'] : '',
      target_text: typeof rec['target_text'] === 'string' ? rec['target_text'] : '',
      text,
    });
  }
  return out;
}

// ── draft generation ─────────────────────────────────────────────────────────

function promptContext(sig: PublicSignature, mine: NormalizedTweet[]): PromptContext {
  let learned = '';
  try {
    learned = voiceState.formatForPrompt(voiceState.loadState());
  } catch {
    learned = '';
  }
  let performance = '';
  try {
    performance = analytics.formatForPrompt(analytics.loadReport());
  } catch {
    performance = '';
  }
  return { sig, mine, learned, performance };
}

/**
 * Batched, parallel drafting. Aims for POSTS_TARGET / REPLIES_TARGET /
 * QUOTES_TARGET of each kind. Replies + quotes are seeded from a deduped pool
 * of (curated + trending) feed items so every one references a real target id.
 *
 * Variety is forced three ways: post batches get distinct angle lanes +
 * keyword partitions so they don't converge; the reply/quote pool is capped
 * per-author so one loud account can't dominate; and anything we've already
 * posted/scheduled (per `history`) is excluded.
 */
async function generateDrafts(
  sig: PublicSignature,
  mine: NormalizedTweet[],
  curated: ScoredTweet[],
  trending: TrendingTweet[],
  history: DraftHistory,
): Promise<DraftsBundle> {
  const ctx = promptContext(sig, mine);

  // target pool for replies/quotes — curated first, trending as backfill
  const pool: NormalizedTweet[] = [];
  const seen = new Set<string>();
  for (const t of [...curated, ...trending]) {
    const tid = t.id;
    if (!tid || seen.has(tid)) continue;
    seen.add(tid);
    pool.push(t);
  }

  const prompts: string[] = [];
  const labels: string[] = [];

  // posts — each batch gets a distinct angle lane + a disjoint keyword slice
  // + a disjoint inspiration slice, so the parallel batches spread out.
  const nPostBatches = Math.max(1, Math.ceil(POSTS_TARGET / POST_BATCH));
  const allKw = sig.top_keywords ?? [];
  for (let i = 0; i < nPostBatches; i++) {
    const count = Math.min(POST_BATCH, POSTS_TARGET - i * POST_BATCH);
    if (count <= 0) break;
    const lane = POST_LANES[i % POST_LANES.length] ?? null;
    // round-robin keyword partition: batch i gets every n-th keyword
    const slice = allKw.filter((_, idx) => idx >= i && (idx - i) % nPostBatches === 0);
    const kw = slice.length ? slice : allKw.slice(0, 6);
    const inspo = pool.slice(i * 8, i * 8 + 8);
    prompts.push(buildPostPrompt(ctx, inspo, count, lane, kw));
    labels.push(`posts[${i + 1}]`);
  }

  // replies + quotes — driven by feed targets (one draft per item).
  // HARD constraint: only engage tweets younger than MAX_TARGET_AGE_HOURS.
  // Diversify by author cap so targets aren't dominated by 1-2 accounts, drop
  // anything already replied-to / quoted, then give replies and quotes
  // DIFFERENT orderings so they don't mirror each other's source posts.
  const now = Date.now();
  const freshPool = filterFresh(pool, now);
  if (freshPool.length < pool.length) {
    console.log(
      `[pipeline] reply/quote targets: ${freshPool.length}/${pool.length} within ` +
        `${MAX_TARGET_AGE_HOURS}h (dropped ${pool.length - freshPool.length} stale)`,
    );
  }
  const diverse = diversifyPool(freshPool, 2);
  const replyPool = diverse.filter((t) => !history.reply_target_ids.has(String(t.id)));
  let quotePool = diverse.filter((t) => !history.quote_target_ids.has(String(t.id)));
  quotePool = [...quotePool].reverse(); // quotes lead with different posts than replies
  // Over-provision: the model skips some items, so request ~1.5x targets and
  // trim the aggregated results back down to the target count below.
  const replyTargets = replyPool.slice(0, Math.min(replyPool.length, Math.ceil(REPLIES_TARGET * 1.5)));
  const quoteTargets = quotePool.slice(0, Math.min(quotePool.length, Math.ceil(QUOTES_TARGET * 1.5)));
  chunk(replyTargets, REPLY_BATCH).forEach((ch, i) => {
    prompts.push(buildReplyPrompt(ctx, ch));
    labels.push(`replies[${i + 1}]`);
  });
  chunk(quoteTargets, QUOTE_BATCH).forEach((ch, i) => {
    prompts.push(buildQuotePrompt(ctx, ch));
    labels.push(`quotes[${i + 1}]`);
  });

  console.log(
    `[pipeline] dispatching ${prompts.length} draft batches (${MAX_DRAFT_WORKERS} at a time)...`,
  );
  const results = await runBatches(prompts, labels);

  let posts: PostDraft[] = [];
  let replies: TargetDraft[] = [];
  let quotes: TargetDraft[] = [];
  // Reply/quote targets must be both real (in the pool) AND fresh — this is the
  // gate that enforces the <MAX_TARGET_AGE_HOURS constraint even if the model
  // echoes back an id that wasn't in its prompt.
  const freshIds = new Set(freshPool.map((t) => t.id));
  for (const d of results) {
    posts.push(...coercePostDrafts(d['posts']));
    for (const r of coerceTargetDrafts(d['replies'])) {
      if (freshIds.has(String(r.target_id))) replies.push(r);
    }
    for (const q of coerceTargetDrafts(d['quotes'])) {
      if (freshIds.has(String(q.target_id))) quotes.push(q);
    }
  }

  posts = dedupePosts(posts, history.post_texts).slice(0, POSTS_TARGET);
  replies = dedupeByTarget(replies).slice(0, REPLIES_TARGET);
  quotes = dedupeByTarget(quotes).slice(0, QUOTES_TARGET);

  return { posts, replies, quotes };
}

/** Used only if every claude batch fails — keeps the dashboard non-empty. */
function fallbackDrafts(): DraftsBundle {
  return {
    posts: [
      {
        id: 'p1',
        template: 'ship update',
        text: 'claude call failed during pipeline — drafting offline. fix it and refresh.',
      },
    ],
    replies: [],
    quotes: [],
  };
}

// ── main orchestration ───────────────────────────────────────────────────────

export async function runPipeline(): Promise<DashboardPayload> {
  const username = twitterHandle();
  if (!username) {
    throw new Error(
      'TWITTER_HANDLE is not set. Add `export TWITTER_HANDLE="<your_handle>"` ' +
        '(without the leading @) to ~/.agent-reach/env.sh or your shell and retry.',
    );
  }
  ensureDataDir();
  const t0 = Date.now();
  console.log(`[pipeline] fetching signal for @${username}...`);
  const raw = await fetchAll(username);

  const bookmarks = normalizeList(raw.bookmarks);
  const favorites = normalizeList(raw.favorites);
  const feed = normalizeList(raw.feed);
  const mine = normalizeList(raw.mine);

  console.log(
    `[pipeline] bookmarks=${bookmarks.length} favorites=${favorites.length} ` +
      `feed=${feed.length} mine=${mine.length}`,
  );

  const { public: sig, weights } = interestSignature(bookmarks, favorites);
  const curated = scoreFeed(feed, weights, mine);
  const trending = trendingFeed(feed, curated, mine);
  console.log(
    `[pipeline] curated=${curated.length} trending=${trending.length} ` +
      `bookmark_authors=${JSON.stringify(sig.bookmark_authors.slice(0, 5))} ` +
      `keywords=${JSON.stringify(sig.top_keywords.slice(0, 6))}`,
  );

  console.log(
    `[pipeline] drafting via claude --agent ${dashboardAgent()} ` +
      `(targets: ${POSTS_TARGET} posts / ${REPLIES_TARGET} replies / ${QUOTES_TARGET} quotes)...`,
  );
  const history = loadHistory(mine);
  console.log(
    `[pipeline] history: ${history.post_texts.length} prior posts, ` +
      `${history.reply_target_ids.size} replied + ` +
      `${history.quote_target_ids.size} quoted targets to skip`,
  );

  try {
    const ev = await evalEngine.runEval();
    if ('skipped' in ev) {
      console.log(`[pipeline] eval skipped (${ev.skipped})`);
    } else {
      const a = ev.added;
      console.log(
        `[pipeline] eval ran ${ev.id} (+gold ${a.gold.length} / +anti ${a.anti.length} ` +
          `/ +rules ${a.rules.length})`,
      );
    }
  } catch (e) {
    console.error(`[pipeline] eval failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  try {
    const an = await analytics.runAnalytics();
    if ('skipped' in an) {
      console.log(`[pipeline] analytics skipped (${an.skipped})`);
    } else {
      console.log(`[pipeline] analytics ran (n_posts=${an.n_posts})`);
    }
  } catch (e) {
    console.error(`[pipeline] analytics failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }

  let drafts = await generateDrafts(sig, mine, curated, trending, history);
  if (!drafts.posts.length && !drafts.replies.length && !drafts.quotes.length) {
    drafts = fallbackDrafts();
  }

  // tag drafts with stable, unique ids (override any model-supplied ids)
  drafts.posts.forEach((p, i) => (p.id = `p${i + 1}`));
  drafts.replies.forEach((r, i) => (r.id = `r${i + 1}`));
  drafts.quotes.forEach((q, i) => (q.id = `q${i + 1}`));

  console.log(
    `[pipeline] drafted posts=${drafts.posts.length} replies=${drafts.replies.length} ` +
      `quotes=${drafts.quotes.length}`,
  );

  const payload: DashboardPayload = {
    generated_at: new Date().toISOString(),
    user: `@${username}`,
    interest_signature: sig,
    explore: curated,
    trending,
    drafts,
    counts: {
      bookmarks: bookmarks.length,
      favorites: favorites.length,
      feed: feed.length,
      mine: mine.length,
    },
    elapsed_seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
  writeJsonAtomic(OUT_PATH, payload);
  console.log(`[pipeline] done in ${payload.elapsed_seconds}s → ${OUT_PATH}`);
  return payload;
}

// ── regenerate one draft with user feedback ──────────────────────────────────

export function loadDashboardData(): DashboardPayload | null {
  return readJson<DashboardPayload | null>(OUT_PATH, null);
}

function kindKey(kind: DraftKind): keyof DraftsBundle {
  return kind === 'post' ? 'posts' : kind === 'reply' ? 'replies' : 'quotes';
}

/**
 * Regenerate a single draft in its lane, honoring the user's prompt tweak
 * (`feedback`). Updates dashboard_data.json in place (same id) and returns
 * the fresh draft, or null if the draft wasn't found / claude failed.
 */
export async function regenerateDraft(
  kind: DraftKind,
  id: string,
  feedback: string,
): Promise<Draft | null> {
  const payload = loadDashboardData();
  if (!payload) return null;
  const key = kindKey(kind);
  const list = payload.drafts?.[key] ?? [];
  const existing = list.find((d) => d.id === id);
  if (!existing) return null;

  // Fresh "my recent posts" pull (cheap, 40 items); fall back to empty.
  let mine: NormalizedTweet[] = [];
  const handle = twitterHandle();
  if (handle) {
    try {
      mine = normalizeList(await twitter(['user-posts', `@${handle}`, '-n', '40'], 150_000));
    } catch {
      mine = [];
    }
  }
  const ctx = promptContext(payload.interest_signature, mine);

  let prompt: string;
  if (kind === 'post') {
    prompt = buildDraftPrompt('post', ctx, {
      previousText: existing.text,
      feedback,
      inspo: (payload.explore ?? []).slice(0, 8),
      keywords: payload.interest_signature.top_keywords,
    });
  } else {
    const t = existing as TargetDraft;
    // Prefer the full target text from the stored feed pools over the
    // 80-char echo saved on the draft.
    const full = [...(payload.explore ?? []), ...(payload.trending ?? [])].find(
      (f) => f.id === t.target_id,
    );
    prompt = buildDraftPrompt(kind, ctx, {
      previousText: existing.text,
      feedback,
      target: {
        id: t.target_id,
        author: full?.author ?? t.target_author,
        text: full?.text ?? t.target_text,
      },
    });
  }

  const result = await claude(prompt, dashboardAgent(), {
    timeoutMs: 300_000,
    label: `regen-${kind}-${id}`,
  });
  if (!result) return null;

  if (kind === 'post') {
    const fresh = coercePostDrafts(result['posts'])[0];
    if (!fresh) return null;
    const target = existing as PostDraft;
    target.text = fresh.text;
    target.template = fresh.template;
    writeJsonAtomic(OUT_PATH, payload);
    return { id, kind, text: fresh.text, template: fresh.template };
  }

  const fresh = coerceTargetDrafts(result[key])[0];
  if (!fresh) return null;
  const target = existing as TargetDraft;
  target.text = fresh.text; // keep the original target_* fields — don't trust the echo
  writeJsonAtomic(OUT_PATH, payload);
  return {
    id,
    kind,
    text: fresh.text,
    target_id: target.target_id,
    target_author: target.target_author,
    target_text: target.target_text,
  };
}
