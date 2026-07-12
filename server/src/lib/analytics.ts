/**
 * X post analytics: daily metric snapshots + deterministic breakdowns + an
 * LLM narrative. Port of analytics.py; mirrors evalEngine.ts. All state lives
 * in server/data/ (analytics.json + analytics_history.json).
 */

import { claude, dashboardAgent, twitter, twitterHandle } from './exec';
import { dataPath, readJson, writeJsonAtomic } from './storage';

const REPORT_PATH = dataPath('analytics.json');
const HISTORY_PATH = dataPath('analytics_history.json');
const POSTED_PATH = dataPath('posted.json');

const WINDOW_DAYS = 30;
const MIN_SUPPORT = 3;
const MIN_VIEWS = 50;
const FETCH_N = 150;
const CADENCE_HOURS = 24;

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was',
  'were', 'be', 'been', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by',
  'from', 'it', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she',
  'we', 'they', 'my', 'your', 'its', 'as', 'so', 'just', 'not', 'no', 'do',
  'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'all',
]);

// ── types ────────────────────────────────────────────────────────────────────

export interface RawMetrics {
  likes?: number;
  retweets?: number;
  replies?: number;
  quotes?: number;
  views?: number;
  bookmarks?: number;
}

export interface RawUserPost {
  id?: string;
  text?: string;
  isRetweet?: boolean;
  createdAtISO?: string;
  createdAtLocal?: string;
  media?: unknown;
  urls?: unknown;
  lang?: string;
  metrics?: RawMetrics;
}

export interface Snapshot {
  ts: string;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  views: number;
  bookmarks: number;
}

export interface HistoryEntry {
  snapshots: Snapshot[];
  created_at?: string;
  created_local?: string;
  kind?: string;
  source?: string;
  text?: string;
  has_media?: boolean;
  has_link?: boolean;
  lang?: string;
}

export type AnalyticsHistory = Record<string, HistoryEntry>;

export interface GroupStat {
  avg_eng_rate: number;
  avg_views: number;
  count: number;
}

export interface KeywordStat {
  token: string;
  support: number;
  avg_eng_rate: number;
  lift: number;
}

export interface ReportCard {
  id: string;
  text: string;
  kind: string;
  eng_rate: number;
  views: number;
  created_local: string;
}

export interface AnalyticsReport {
  n_posts: number;
  metric: string;
  overall: { avg_eng_rate: number; avg_views: number };
  breakdowns: Record<string, Record<string, GroupStat>>;
  keywords: KeywordStat[];
  top: ReportCard[];
  bottom: ReportCard[];
  insights?: Record<string, unknown> | null;
  ts?: string;
  generated_at?: string;
  window_days?: number;
}

export type Fetcher = () => Promise<RawUserPost[]>;
export type InsightCaller = (prompt: string) => Promise<Record<string, unknown> | null>;

// ── deterministic helpers ────────────────────────────────────────────────────

export function engRate(metrics: Snapshot | RawMetrics | null | undefined): number {
  const m = metrics ?? {};
  const engaged =
    (m.likes ?? 0) + (m.retweets ?? 0) + (m.replies ?? 0) + (m.quotes ?? 0) + (m.bookmarks ?? 0);
  return engaged / Math.max(m.views ?? 0, 1);
}

export function classifyLength(text: string): string {
  const n = (text ?? '').length;
  if (n < 100) return 'short';
  if (n <= 200) return 'medium';
  return 'long';
}

export function hasLink(text: string, urls: unknown): boolean {
  if (Array.isArray(urls) ? urls.length > 0 : Boolean(urls)) return true;
  return (text ?? '').includes('http://') || (text ?? '').includes('https://');
}

export function tokenize(text: string): string[] {
  let cleaned = (text ?? '').replace(/https?:\/\/\S+/g, ' ');
  cleaned = cleaned.replace(/[@#]\w+/g, ' ');
  const words = cleaned.toLowerCase().match(/[a-z][a-z'-]+/g) ?? [];
  return words.filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function localHour(createdLocal: string): number {
  return parseInt(createdLocal.slice(11, 13), 10);
}

/** Weekday with Monday=0 … Sunday=6 (matches Python's datetime.weekday()). */
export function localWeekday(createdLocal: string): number {
  // createdLocal format: "%Y-%m-%d %H:%M"
  const d = new Date(createdLocal.replace(' ', 'T') + ':00');
  return (d.getDay() + 6) % 7;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0.0;
}

// ── history persistence ──────────────────────────────────────────────────────

export function loadHistory(): AnalyticsHistory {
  const data = readJson<unknown>(HISTORY_PATH, {});
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnalyticsHistory)
    : {};
}

export function saveHistory(hist: AnalyticsHistory): void {
  writeJsonAtomic(HISTORY_PATH, hist);
}

interface KindAttribution {
  kind: string;
  source: string;
}

/** tweet_id → kind/source from posted.json (best-effort attribution). */
function kindMap(): Record<string, KindAttribution> {
  const posted = readJson<unknown>(POSTED_PATH, []);
  if (!Array.isArray(posted)) return {};
  const out: Record<string, KindAttribution> = {};
  for (const p of posted) {
    if (p === null || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    const tid = typeof rec['tweet_id'] === 'string' ? rec['tweet_id'] : '';
    if (tid) {
      out[tid] = {
        kind: typeof rec['kind'] === 'string' ? rec['kind'] : 'post',
        source: typeof rec['source'] === 'string' ? rec['source'] : 'unknown',
      };
    }
  }
  return out;
}

function parseIso(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── snapshotting ─────────────────────────────────────────────────────────────

async function defaultFetcher(): Promise<RawUserPost[]> {
  const res = await twitter(['user-posts', `@${twitterHandle()}`, '-n', String(FETCH_N)], 150_000);
  if (res !== null && typeof res === 'object' && !Array.isArray(res)) {
    const data = (res as Record<string, unknown>)['data'];
    return Array.isArray(data) ? (data as RawUserPost[]) : [];
  }
  return Array.isArray(res) ? (res as RawUserPost[]) : [];
}

export async function snapshotMetrics(now: Date, fetcher?: Fetcher): Promise<AnalyticsHistory> {
  const fetch_ = fetcher ?? defaultFetcher;
  const hist = loadHistory();
  const kinds = kindMap();
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * 86400_000);
  const today = now.toISOString().slice(0, 10);
  for (const raw of (await fetch_()) ?? []) {
    if (raw.isRetweet) continue;
    const tid = raw.id;
    const created = parseIso(raw.createdAtISO);
    if (!tid || !created || created < cutoff) continue;
    const attrib = kinds[tid] ?? null;
    const kind = attrib?.kind ?? 'post';
    if (kind === 'reply') continue; // v1 excludes replies
    const text = raw.text ?? '';
    const entry: HistoryEntry = hist[tid] ?? { snapshots: [] };
    hist[tid] = entry;
    entry.created_at = raw.createdAtISO ?? '';
    entry.created_local = raw.createdAtLocal ?? '';
    entry.kind = kind;
    entry.source = attrib?.source ?? 'unknown';
    entry.text = text;
    entry.has_media = Array.isArray(raw.media) ? raw.media.length > 0 : Boolean(raw.media);
    entry.has_link = hasLink(text, raw.urls);
    entry.lang = raw.lang ?? '';
    const snaps = entry.snapshots;
    const lastSnap = snaps.length ? snaps[snaps.length - 1] : undefined;
    if (lastSnap && (parseIso(lastSnap.ts) ?? now).toISOString().slice(0, 10) === today) {
      continue; // already snapshotted today
    }
    const m = raw.metrics ?? {};
    snaps.push({
      ts: now.toISOString(),
      likes: m.likes ?? 0,
      retweets: m.retweets ?? 0,
      replies: m.replies ?? 0,
      quotes: m.quotes ?? 0,
      views: m.views ?? 0,
      bookmarks: m.bookmarks ?? 0,
    });
  }
  saveHistory(hist);
  return hist;
}

// ── report ───────────────────────────────────────────────────────────────────

interface Rec {
  id: string;
  text: string;
  kind: string;
  has_media: boolean;
  has_link: boolean;
  created_local: string;
  views: number;
  eng_rate: number;
}

function group(recs: Rec[], keyfn: (r: Rec) => string | number): Record<string, GroupStat> {
  const buckets = new Map<string, Rec[]>();
  for (const r of recs) {
    const k = String(keyfn(r));
    const arr = buckets.get(k);
    if (arr) arr.push(r);
    else buckets.set(k, [r]);
  }
  const out: Record<string, GroupStat> = {};
  for (const [k, v] of buckets) {
    out[k] = {
      avg_eng_rate: round4(avg(v.map((x) => x.eng_rate))),
      avg_views: round1(avg(v.map((x) => x.views))),
      count: v.length,
    };
  }
  return out;
}

export function computeReport(
  history: AnalyticsHistory,
  now: Date,
  windowDays: number = WINDOW_DAYS,
): AnalyticsReport {
  const cutoff = new Date(now.getTime() - windowDays * 86400_000);
  const recs: Rec[] = [];
  for (const [tid, e] of Object.entries(history)) {
    if (!e.snapshots?.length) continue;
    const created = parseIso(e.created_at);
    if (!created || created < cutoff) continue;
    const snap = e.snapshots[e.snapshots.length - 1];
    if (!snap) continue;
    recs.push({
      id: tid,
      text: e.text ?? '',
      kind: e.kind ?? 'post',
      has_media: e.has_media ?? false,
      has_link: e.has_link ?? false,
      created_local: e.created_local ?? '',
      views: snap.views ?? 0,
      eng_rate: engRate(snap),
    });
  }

  const overallRate = avg(recs.map((r) => r.eng_rate));
  const withLocal = recs.filter((r) => r.created_local);
  const breakdowns: Record<string, Record<string, GroupStat>> = {
    type: group(recs, (r) => r.kind),
    media: group(recs, (r) => (r.has_media ? 'with_media' : 'text_only')),
    link: group(recs, (r) => (r.has_link ? 'with_link' : 'no_link')),
    length: group(recs, (r) => classifyLength(r.text)),
    hour: group(withLocal, (r) => localHour(r.created_local)),
    weekday: group(withLocal, (r) => localWeekday(r.created_local)),
  };

  // keyword lift
  const tokRates = new Map<string, number[]>();
  for (const r of recs) {
    for (const tok of new Set(tokenize(r.text))) {
      const arr = tokRates.get(tok);
      if (arr) arr.push(r.eng_rate);
      else tokRates.set(tok, [r.eng_rate]);
    }
  }
  const keywords: KeywordStat[] = [];
  for (const [tok, rates] of tokRates) {
    if (rates.length < MIN_SUPPORT) continue;
    const a = avg(rates);
    keywords.push({
      token: tok,
      support: rates.length,
      avg_eng_rate: round4(a),
      lift: overallRate ? round2(a / overallRate) : 0.0,
    });
  }
  keywords.sort((a, b) => b.lift - a.lift);

  const ranked = recs.filter((r) => r.views >= MIN_VIEWS).sort((a, b) => b.eng_rate - a.eng_rate);

  const card = (r: Rec): ReportCard => ({
    id: r.id,
    text: r.text,
    kind: r.kind,
    eng_rate: round4(r.eng_rate),
    views: r.views,
    created_local: r.created_local,
  });

  return {
    n_posts: recs.length,
    metric: 'engagement_rate',
    overall: {
      avg_eng_rate: round4(overallRate),
      avg_views: round1(avg(recs.map((r) => r.views))),
    },
    breakdowns,
    keywords: keywords.slice(0, 20),
    top: ranked.slice(0, 5).map(card),
    bottom: ranked.slice(-5).reverse().map(card),
  };
}

// ── LLM narrative ────────────────────────────────────────────────────────────

export function buildInsightPrompt(report: AnalyticsReport): string {
  const cards = (items: ReportCard[]): string =>
    items
      .map((c) => `- [${c.kind}] eng_rate=${c.eng_rate} views=${c.views} :: ${c.text}`)
      .join('\n') || '(none)';
  const kw =
    report.keywords
      .slice(0, 12)
      .map((k) => `${k.token}(x${k.lift})`)
      .join(', ') || '(none)';
  return (
    "You analyze what's working on an X (Twitter) account. Engagement rate = " +
    '(likes+rts+replies+quotes+bookmarks)/views.\n\n' +
    `## Best performers\n${cards(report.top)}\n\n` +
    `## Worst performers\n${cards(report.bottom)}\n\n` +
    `## High-lift keywords\n${kw}\n\n` +
    '## Format/timing breakdowns (avg_eng_rate, count)\n' +
    `${JSON.stringify(report.breakdowns)}\n\n` +
    '## Task\nReturn JSON ONLY (no fences, start with `{` end with `}`):\n' +
    '{\n' +
    '  "themes_working": ["<themes/topics that resonate; 0-5>"],\n' +
    '  "themes_flat": ["<themes that fall flat; 0-5>"],\n' +
    '  "timing_insight": "<1-2 sentences on best posting times>",\n' +
    '  "format_insight": "<1-2 sentences on post type/length/media/link>",\n' +
    '  "recommendations": ["<concrete next-post suggestions; 2-5>"]\n' +
    '}'
  );
}

/**
 * Render analytics.json into a compact "what's working" block for the posts
 * prompt, or '' when there's nothing useful. Never throws.
 */
export function formatForPrompt(report: AnalyticsReport | Record<string, unknown> | null): string {
  const rep = (report ?? {}) as Partial<AnalyticsReport>;
  const insights = (rep.insights ?? null) as Record<string, unknown> | null;
  if (!insights || Object.keys(insights).length === 0) return '';

  const joined = (key: string): string => {
    const raw = insights[key];
    const vals = (Array.isArray(raw) ? raw : [])
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
    return vals.join(', ');
  };

  const working = joined('themes_working');
  const flat = joined('themes_flat');
  const fmt = typeof insights['format_insight'] === 'string' ? insights['format_insight'].trim() : '';
  const recs = joined('recommendations');

  const kws: string[] = [];
  for (const k of rep.keywords ?? []) {
    const lift = k.lift ?? 0;
    if (lift > 1.0) {
      kws.push(`${k.token}(x${lift})`);
    }
    if (kws.length >= 8) break;
  }

  const lines: string[] = [];
  if (working) lines.push(`Themes that resonate: ${working}`);
  if (flat) lines.push(`Themes that fall flat: ${flat}`);
  if (fmt) lines.push(`Format: ${fmt}`);
  if (kws.length) lines.push('Topics that overperform: ' + kws.join(', '));
  if (recs) lines.push(`Lean into: ${recs}`);
  if (!lines.length) return '';

  const window = rep.window_days ?? WINDOW_DAYS;
  const header = `## WHAT'S ACTUALLY WORKING ON X (from real engagement, last ${window}d)`;
  return header + '\n' + lines.join('\n') + '\n';
}

// ── orchestration ────────────────────────────────────────────────────────────

function defaultCaller(prompt: string): Promise<Record<string, unknown> | null> {
  return claude(prompt, dashboardAgent(), { timeoutMs: 300_000, label: 'analytics' });
}

export function loadReport(): AnalyticsReport | null {
  return readJson<AnalyticsReport | null>(REPORT_PATH, null);
}

function shouldRun(now: Date): { ok: boolean; reason: string } {
  const rep = loadReport();
  const last = rep ? parseIso(rep.generated_at) : null;
  if (last && now.getTime() - last.getTime() < CADENCE_HOURS * 3600_000) {
    return { ok: false, reason: 'cadence' };
  }
  return { ok: true, reason: '' };
}

export interface RunAnalyticsOptions {
  force?: boolean;
  now?: Date;
  fetcher?: Fetcher;
  caller?: InsightCaller;
}

export type AnalyticsResult = AnalyticsReport | { skipped: string };

export async function runAnalytics(options: boolean | RunAnalyticsOptions = {}): Promise<AnalyticsResult> {
  const opts: RunAnalyticsOptions = typeof options === 'boolean' ? { force: options } : options;
  const now = opts.now ?? new Date();
  if (!opts.force) {
    const { ok, reason } = shouldRun(now);
    if (!ok) return { skipped: reason };
  }
  const caller = opts.caller ?? defaultCaller;
  const hist = await snapshotMetrics(now, opts.fetcher);
  const report = computeReport(hist, now);
  try {
    report.insights = (await caller(buildInsightPrompt(report))) ?? null;
  } catch {
    report.insights = null;
  }
  report.ts = now.toISOString();
  report.generated_at = now.toISOString();
  report.window_days = WINDOW_DAYS;
  writeJsonAtomic(REPORT_PATH, report);
  return report;
}

export function overview(): AnalyticsReport | null {
  return loadReport();
}
