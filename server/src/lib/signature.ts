/**
 * Interest signature + feed scoring — verbatim port of the math in
 * pipeline.py (`tokenize`, `interest_signature`, `score_feed`,
 * `trending_feed`, plus the tweet normalizers they run on).
 */

export const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'is', 'it', 'you', 'i', 'my', 'me', 'we', 'our',
  'for', 'on', 'with', 'at', 'by', 'this', 'that', 'these', 'those', 'be', 'are', 'was', 'were', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'not', 'no', 'so', 'just', 'like', 'im', 'ive', 'its', 'dont', 'cant',
  'all', 'one', 'two', 'get', 'got', 'go', 'going', 'want', 'need', 'new', 'now', 'from', 'up', 'out', 'about',
  'your', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'as', 'into', 'over', 'than', 'then', 'when',
  'what', 'why', 'how', 'who', 'which', 'more', 'most', 'some', 'any', 'can', 'will', 'would', 'should', 'could',
  'rt', 'u', 'amp', 'https', 'http', 'co', 't', 's', 't.co', 'de', 're', 'll', 've', 'm',
]);

export interface NormalizedTweet {
  id: string;
  author: string;
  text: string;
  likes: number;
  rts: number;
  replies: number;
  /** Human-facing local wall-clock string (for display; may lack a timezone). */
  time: string;
  /** Unambiguous ISO-8601 creation timestamp (UTC offset present) — used for age math. */
  createdAtISO: string;
}

export interface ScoredTweet extends NormalizedTweet {
  score: number;
  score_author: number;
  score_kw: number;
}

export interface TrendingTweet extends NormalizedTweet {
  trend_score: number;
}

export interface PublicSignature {
  top_keywords: string[];
  top_accounts: string[];
  bookmark_authors: string[];
  fav_authors: string[];
  top_hashtags: string[];
  sample_size: number;
}

export interface SignatureWeights {
  /** lowercased @handle → combined weight (bookmark*5 + like*2 + mention*1) */
  accounts: Map<string, number>;
  /** keyword → raw frequency (top 60) */
  keywords: Map<string, number>;
  /** lowercased authors the user has bookmarked */
  bookmarkAuthorsSet: Set<string>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Counter increment. */
function inc(counter: Map<string, number>, key: string, by = 1): void {
  counter.set(key, (counter.get(key) ?? 0) + by);
}

/** Counter.most_common — sorted by count desc, stable on insertion order for ties. */
function mostCommon(counter: Map<string, number>, n?: number): Array<[string, number]> {
  const entries = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  return n === undefined ? entries : entries.slice(0, n);
}

export function tokenize(text: string): string[] {
  let t = text.replace(/https?:\/\/\S+/g, ' ');
  t = t.replace(/[^a-zA-Z@#0-9_\s]/g, ' ');
  return t
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

// ── normalization ────────────────────────────────────────────────────────────

/** Reduce a tweet record (full or compact CLI shape) to {id, author, text, likes, rts, replies, time}. */
export function normalizeTweet(t: unknown): NormalizedTweet | null {
  const rec = asRecord(t);
  if (!rec) return null;
  const text = str(rec['text']) || str(rec['full_text']);

  const rawAuthor = rec['author'] ?? rec['user'] ?? rec['screen_name'] ?? '';
  const authorRec = asRecord(rawAuthor);
  let author: string;
  if (authorRec) {
    author = str(authorRec['screenName']) || str(authorRec['screen_name']) || str(authorRec['username']);
  } else {
    author = str(rawAuthor);
  }
  if (author && !author.startsWith('@')) {
    author = '@' + author.replace(/^@+/, '');
  }

  const metrics = asRecord(rec['metrics']);
  const likes = metrics ? num(metrics['likes']) : num(rec['likes']) || num(rec['favorite_count']);
  const rts = metrics ? num(metrics['retweets']) : num(rec['rts']) || num(rec['retweet_count']);
  const replies = metrics ? num(metrics['replies']) : num(rec['replies']) || num(rec['reply_count']);

  const timeStr = str(rec['createdAtLocal']) || str(rec['time']) || str(rec['created_at']);
  // Prefer an offset-bearing timestamp so age math is timezone-safe. The local
  // string (createdAtLocal) has no offset and JavaScriptCore won't parse it
  // reliably, so it's the last resort.
  const isoStr =
    str(rec['createdAtISO']) || str(rec['createdAt']) || str(rec['created_at']) || timeStr;

  return {
    id: str(rec['id']) || str(rec['rest_id']),
    author,
    text,
    likes: likes || 0,
    rts: rts || 0,
    replies: replies || 0,
    time: timeStr,
    createdAtISO: isoStr,
  };
}

export function normalizeList(data: unknown): NormalizedTweet[] {
  let list: unknown = data;
  const rec = asRecord(data);
  if (rec) {
    list = [];
    for (const k of ['tweets', 'data', 'items', 'results']) {
      if (Array.isArray(rec[k])) {
        list = rec[k];
        break;
      }
    }
  }
  if (!Array.isArray(list)) return [];
  const out: NormalizedTweet[] = [];
  for (const raw of list) {
    const n = normalizeTweet(raw);
    if (n && n.text) out.push(n);
  }
  return out;
}

// ── interest signature ───────────────────────────────────────────────────────

/**
 * Returns { public, weights }.
 * public  — what we display in the sidebar and pass to claude.
 * weights — internal per-account + per-keyword scoring weights for scoreFeed.
 *
 * Bookmarks signal strongest (intentional save), then favorites (like), then
 * @-mentions inside text.
 */
export function interestSignature(
  bookmarks: NormalizedTweet[],
  favorites: NormalizedTweet[],
): { public: PublicSignature; weights: SignatureWeights } {
  const bookmarkAuthors = new Map<string, number>();
  const favAuthors = new Map<string, number>();
  const mentioned = new Map<string, number>();
  const words = new Map<string, number>();
  const hashtags = new Map<string, number>();

  const consume = (pool: NormalizedTweet[], authorsCounter: Map<string, number>): void => {
    for (const t of pool) {
      const a = t.author || '';
      if (a) inc(authorsCounter, a);
      for (const w of tokenize(t.text)) {
        if (w.startsWith('@') && w.length > 1) {
          inc(mentioned, w.toLowerCase());
        } else if (w.startsWith('#') && w.length > 1) {
          inc(hashtags, w.toLowerCase());
        } else if (w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) {
          inc(words, w);
        }
      }
    }
  };

  consume(bookmarks, bookmarkAuthors);
  consume(favorites, favAuthors);

  // Combined account weight — bookmark author is 5× a mention, like author 2×.
  const accountsW = new Map<string, number>();
  for (const [a, n] of bookmarkAuthors) inc(accountsW, a.toLowerCase(), n * 5);
  for (const [a, n] of favAuthors) inc(accountsW, a.toLowerCase(), n * 2);
  for (const [a, n] of mentioned) inc(accountsW, a, n * 1);

  const pub: PublicSignature = {
    top_keywords: mostCommon(words, 20).map(([w]) => w),
    top_accounts: mostCommon(accountsW, 15).map(([a]) => a),
    bookmark_authors: mostCommon(bookmarkAuthors, 10).map(([a]) => a),
    fav_authors: mostCommon(favAuthors, 10).map(([a]) => a),
    top_hashtags: mostCommon(hashtags, 8).map(([h]) => h),
    sample_size: bookmarks.length + favorites.length,
  };
  const weights: SignatureWeights = {
    accounts: accountsW,
    keywords: new Map(mostCommon(words, 60)),
    bookmarkAuthorsSet: new Set([...bookmarkAuthors.keys()].map((a) => a.toLowerCase())),
  };
  return { public: pub, weights };
}

// ── feed scoring ─────────────────────────────────────────────────────────────

/**
 * Score feed by overlap with weighted signature.
 *
 * Author signal dominates (×5 multiplier on the per-account weight).
 * Keyword signal is additive on weighted hits.
 * Engagement is a tiny log-scaled tiebreaker, capped so a 145k-like Elon
 * tweet can't drown out a 50-like tweet from someone you actually bookmark.
 *
 * Returns up to ~140 candidates so there's a deep enough target pool to seed
 * 100 replies + 100 quotes against real ids.
 */
export function scoreFeed(
  feed: NormalizedTweet[],
  weights: SignatureWeights,
  mine: NormalizedTweet[],
): ScoredTweet[] {
  const accW = weights.accounts;
  const kwW = weights.keywords;
  const bookmarkedAuthors = weights.bookmarkAuthorsSet;
  const mineIds = new Set(mine.filter((t) => t.id).map((t) => t.id));

  const scored: Array<{ score: number; t: NormalizedTweet; authorScore: number; kwScore: number }> = [];
  for (const t of feed) {
    if (!t.text || mineIds.has(t.id)) continue;
    const author = (t.author || '').toLowerCase();
    const toks = new Set(tokenize(t.text));

    let authorScore = (accW.get(author) ?? 0) * 5;
    // extra bump if you've literally bookmarked this author before
    if (bookmarkedAuthors.has(author)) {
      authorScore += 25;
    }

    let kwScore = 0;
    for (const w of toks) {
      const v = kwW.get(w);
      if (v !== undefined) kwScore += v;
    }

    const likes = Math.trunc(t.likes || 0);
    const eng = Math.min(Math.log10(likes + 1) * 0.3, 1.0);

    const score = authorScore + kwScore + eng;

    // Threshold: need author match OR strong keyword overlap.
    // This kills the random viral-Elon-tweet problem.
    if (authorScore === 0 && kwScore < 4) continue;
    scored.push({ score, t, authorScore, kwScore });
  }

  scored.sort((a, b) => b.score - a.score);
  const out: ScoredTweet[] = [];
  const seenAuthors = new Map<string, number>();
  for (const { score, t, authorScore, kwScore } of scored) {
    // cap any single author at 4 picks
    if ((seenAuthors.get(t.author) ?? 0) >= 4) continue;
    inc(seenAuthors, t.author);
    out.push({
      ...t,
      score: round2(score),
      score_author: round2(authorScore),
      score_kw: round2(kwScore),
    });
    if (out.length >= 140) break;
  }
  return out;
}

/**
 * Items outside your interest signature, ranked by raw engagement.
 * Useful for spotting broader-zeitgeist conversations — and as extra reply/quote
 * targets when the curated pool is thin.
 */
export function trendingFeed(
  feed: NormalizedTweet[],
  curated: ScoredTweet[],
  mine: NormalizedTweet[],
): TrendingTweet[] {
  const curatedIds = new Set(curated.map((t) => t.id));
  const mineIds = new Set(mine.filter((t) => t.id).map((t) => t.id));
  const pool: Array<{ score: number; t: NormalizedTweet }> = [];
  for (const t of feed) {
    if (!t.text || curatedIds.has(t.id) || mineIds.has(t.id)) continue;
    const likes = Math.trunc(t.likes || 0);
    const rts = Math.trunc(t.rts || 0);
    const score = Math.log10(likes + 1) * 1.0 + Math.log10(rts + 1) * 1.4;
    pool.push({ score, t });
  }
  pool.sort((a, b) => b.score - a.score);
  const out: TrendingTweet[] = [];
  const seenAuthors = new Map<string, number>();
  for (const { score, t } of pool) {
    if ((seenAuthors.get(t.author) ?? 0) >= 2) continue;
    inc(seenAuthors, t.author);
    out.push({ ...t, trend_score: round2(score) });
    if (out.length >= 80) break;
  }
  return out;
}
