/**
 * Verbatim prompt IP ported from pipeline.py: GOLD_EXAMPLES, VOICE_RULES, the
 * three *_SHAPE blocks, the POST_LANES list, and the voice-header assembly.
 * Plus the prompt builders (posts / replies / quotes) and the single-draft
 * builder used by regenerate-with-feedback.
 *
 * The voice rules + gold examples were tuned against the user's REAL
 * posted/scheduled tweets. The single biggest fix vs. the old prompt: stop
 * the model from polishing. His real voice is lowercase, short, smiley-heavy,
 * and a little sloppy on purpose.
 */

import type { DraftKind } from '../types';
import type { NormalizedTweet, PublicSignature } from './signature';

export const GOLD_EXAMPLES = `## GOLD EXAMPLES — real tweets he wrote/approved. Match THIS texture (lowercase, smileys, short, a little sloppy on purpose). Absorb the voice; do NOT copy them.

POSTS:
- "updating my agents.md, it's bloated right now, need to get it under 50-100 lines"
- "trimmed my agents.md from 200 lines to 100. try to keep it upto date on teh changes in the repo :)\\n\\nit's more important than I thought (kept ignoring it)"
- "storage view on mac is still as trash as ever, even on more info it dosen't give proper details"
- "composer 2.5 is pretty good!!!"
- "shipped my own x feed tool last wk. opened twitter 3 times in 4 days. lowkey the most productive stretch of the yr :)"
- "anyone actually moved off claude code to codex full-time? not — like sub cancelled, daily driver swapped. just curious"
- "how are ya'll actually orchestrating multiple agents rn? have tried couple of famous ones in OSS orgs but really not clicking with any good ones"
- "my read on the \\"solo $1B company\\" discourse: it's not abt one founder doing everything. it's one founder steering 8 agents that each do what used to need a team. the bottleneck moved from headcount to judgment and orchaestration"

REPLIES:
- "have to sit on this! some of the skills i've added are way too bloated"
- "my apps don't have as much bugs as claude code :(\\nhappier that way!"
- "skills are lowkey the best thing to happen to claude code. just added the /teach skill 5 mins back :)"
- "gonna try a FULL code refactor workflow on opus 4.8 high effort and letting it sit for a day and seeing what happens"
- "would watch every single one. the skill ecosystem is so under-documented rn, half the good ones are buried in random gists"

QUOTES:
- "this. the ppl shipping fastest right now aren't the ones who stopped reading code — they're the ones reading 10x more of it cuz the agent generates 10x more. taste is the bottleneck, not typing speed."
- "it moved up a layer to steering and orchestration. we're so back."
`;

export const VOICE_RULES = `Rules:
- These must read like a real person typed them fast on his phone — NOT polished marketing copy. If a draft sounds clean and quotable, it's wrong. Rough it up.
- lowercase-first, ALWAYS. Do not capitalize the first word. No Title Case hook lines (real exception rate <1 in 20).
- Keep it SHORT — most posts 10-40 words, one core thought. Go longer only for a genuine rambling aside with a caveat, never a structured build-up to a punchline.
- Use the text smileys ":)" and ":(" liberally and sincerely — they're his signature. Prefer them over emoji; use actual emoji rarely (<=1 in 5), never reaction-emoji spam.
- Leave casual imperfection IN: lowercase "i" mid-sentence, comma splices, the occasional misspelling (dosen't, teh, abt, ya'll, upto, wknd). Do NOT write grammatically perfect sentences — perfect grammar is the #1 tell it's not him.
- Use his abbreviations naturally: abt, rn, wk, wknd, yr, ppl, cuz, lmk, tbh, lowkey, ig, ngl.
- Multi-punctuation ("!!!"/"!!") only for real excitement about something he actually likes.
- Use "\\n\\n" to break a setup from a caveat or aside — not to stack one-line fragments for rhythm. Avoid stacked-fragment blog cadence in tweets.
- Go EASY on em-dashes — his default connectors are commas and "\\n\\n". At most 1-2 across a batch.
- No hashtags. No "Thoughts?"/"What do you think?" closers. No stacked hype ("we're so back"/"this is the way") unless it genuinely fits once.
- Anti-hype, but QUIETLY. State the honest take plainly and let it sit. Don't perform cynicism with big punchlines.
- Community questions stay plain and low-stakes ("anyone actually..."/"how are ya'll..."/"lmk"), not clever.
- Bracketed-label and Title-Case-aphorism formats are RARE — at most one of each per batch, usually zero. Most posts follow no template.
- Name tools specifically and lowercase: claude code, codex, opus 4.8, gemini 3, composer 2.5, agents.md, /skills, react native, figma. Stay in MY stack (React Native, AI agents, Claude Code, indie dev). Don't fabricate projects.
- Replies/quotes: even shorter and plainer than posts. Lead with the take in 1 line, optionally one line of context. No tidy thesis.
- Vary openers across the batch — don't start every item the same way.
- JSON only. Do not wrap in \`\`\`json. Output must start with \`{\` and end with \`}\`.`;

export const POSTS_SHAPE = `Return JSON ONLY (no preamble, no fences) with this exact shape:
{
  "posts": [
    {"id":"p1","template":"<short tag: ship update | gripe | question | my read | aphorism | none>","text":"<the tweet>"}
  ]
}`;

export const REPLIES_SHAPE = `Return JSON ONLY (no preamble, no fences) with this exact shape:
{
  "replies": [
    {"id":"r1","target_id":"<feed item id>","target_author":"<@handle>","target_text":"<first 80 chars of target>","text":"<your reply, 1-2 short sentences>"}
  ]
}`;

export const QUOTES_SHAPE = `Return JSON ONLY (no preamble, no fences) with this exact shape:
{
  "quotes": [
    {"id":"q1","target_id":"<feed item id>","target_author":"<@handle>","target_text":"<first 80 chars of target>","text":"<your quote-tweet commentary that adds an angle>"}
  ]
}`;

// Per-batch angle lanes. Each post batch is assigned a different lane so the N
// parallel batches explore different territory instead of all collapsing onto
// the gold examples' topics. Bias only — the voice rules still apply.
export const POST_LANES: readonly string[] = [
  'ship/build update — something concrete you actually shipped, fixed, or are mid-building. specific, not abstract.',
  'honest gripe — one small real frustration with a tool or workflow. dry, no big punchline.',
  'my read — an honest take on a current AI-dev discourse. state it plainly and let it sit.',
  "noticing — a small thing you've noticed about how you work now with agents. reflective, not advice.",
  'tool signal — react to / compare specific tools in your stack, named lowercase.',
  'community question — ONE genuine low-stakes question to other devs. plain, not clever.',
];

// ── builders ─────────────────────────────────────────────────────────────────

type InspoItem = Pick<NormalizedTweet, 'author' | 'text'>;
type FeedItem = Pick<NormalizedTweet, 'id' | 'author' | 'text'>;
type MineItem = Pick<NormalizedTweet, 'text'>;

export interface PromptContext {
  sig: PublicSignature;
  mine: MineItem[];
  /** Formatted learned voice blocks (voiceState.formatForPrompt) or ''. */
  learned: string;
  /** Formatted "what's working" block (analytics.formatForPrompt) or ''. */
  performance: string;
}

function voiceHeader(ctx: PromptContext): string {
  const mineBlock = ctx.mine
    .slice(0, 8)
    .map((t) => `- ${t.text.slice(0, 160)}`)
    .join('\n') || '(none)';
  const learned = ctx.learned;
  return (
    'You are running as the configured voice agent. Your persona is already loaded.\n' +
    "Below is today's signal. Draft tweets I can post. Reply with JSON ONLY.\n\n" +
    '## My interest signature (from recent bookmarks + likes)\n' +
    `top keywords: ${ctx.sig.top_keywords.slice(0, 15).join(', ') || '(none)'}\n` +
    `top accounts: ${ctx.sig.top_accounts.slice(0, 10).join(', ') || '(none)'}\n\n` +
    '## My recent posts (do NOT repeat these themes verbatim)\n' +
    `${mineBlock}\n\n` +
    `${GOLD_EXAMPLES}\n` +
    (learned ? '\n' + learned : '')
  );
}

export function buildPostPrompt(
  ctx: PromptContext,
  inspo: InspoItem[],
  count: number,
  lane?: string | null,
  keywords?: string[] | null,
): string {
  const inspoBlock = inspo.map((t) => `- ${t.author}: ${t.text.slice(0, 160)}`).join('\n') || '(none)';
  const kw = keywords ?? ctx.sig.top_keywords;
  const laneBlock = lane
    ? `## This batch's angle (bias toward this; don't make every post fit it)\n${lane}\n\n`
    : '';
  const perf = ctx.performance;
  const perfBlock = perf ? perf + '\n' : '';
  return (
    voiceHeader(ctx) +
    perfBlock +
    laneBlock +
    "## Themes to draw from for THIS batch (stay close to these — other batches cover the rest)\n" +
    (kw.join(', ') || '(none)') +
    '\n\n' +
    "## What's in my world today (anchor posts in DIFFERENT items below — don't all riff the same one)\n" +
    inspoBlock +
    '\n\n' +
    `## Task\nGenerate exactly ${count} original posts in my voice, each on a DISTINCT topic — ` +
    'no two posts should be reworded versions of the same thought. ' +
    'The gold examples show my VOICE, not my topics: do NOT reuse their topics ' +
    '(agents.md, trimming skills, the feed tool) more than once across the batch. ' +
    "Vary openers — don't start more than one post with the same two words.\n\n" +
    POSTS_SHAPE +
    '\n\n' +
    VOICE_RULES
  );
}

export function buildReplyPrompt(ctx: PromptContext, chunk: FeedItem[]): string {
  const feedBlock = chunk.map((t) => `[${t.id}] ${t.author}: ${t.text.slice(0, 200)}`).join('\n');
  return (
    voiceHeader(ctx) +
    '## Feed items to reply to (write ONE reply per item, using its EXACT id)\n' +
    feedBlock +
    '\n\n' +
    `## Task\nWrite a reply for EVERY one of the ${chunk.length} items above — aim for all ${chunk.length}. ` +
    "Only skip an item if it's an ad/spam/non-English or has literally nothing worth engaging.\n\n" +
    REPLIES_SHAPE +
    '\n\n' +
    VOICE_RULES
  );
}

export function buildQuotePrompt(ctx: PromptContext, chunk: FeedItem[]): string {
  const feedBlock = chunk.map((t) => `[${t.id}] ${t.author}: ${t.text.slice(0, 200)}`).join('\n');
  return (
    voiceHeader(ctx) +
    '## Feed items to quote-tweet (add MY angle; write ONE quote per item, using its EXACT id)\n' +
    feedBlock +
    '\n\n' +
    `## Task\nWrite a quote-tweet for EVERY one of the ${chunk.length} items above — aim for all ${chunk.length}. ` +
    "Only skip an item if it's an ad/spam/non-English or has literally nothing worth adding to.\n\n" +
    QUOTES_SHAPE +
    '\n\n' +
    VOICE_RULES
  );
}

// ── regenerate-with-feedback ─────────────────────────────────────────────────

export interface RegenOptions {
  /** The draft text the user asked to regenerate. */
  previousText: string;
  /** The user's prompt tweak — honored above conflicting guidance. */
  feedback: string;
  /** Posts only: inspiration feed slice. */
  inspo?: InspoItem[];
  /** Posts only: themes to draw from (defaults to signature keywords). */
  keywords?: string[];
  /** Replies/quotes: the original target tweet. */
  target?: FeedItem;
}

/**
 * Single-draft prompt used by POST /draft/regenerate — same voice header,
 * shape, and rules as the batch builders, plus the previous draft and the
 * user's feedback ("tweak the prompt") woven in.
 */
export function buildDraftPrompt(kind: DraftKind, ctx: PromptContext, opts: RegenOptions): string {
  const regenBlock =
    '## Previous draft (the user rejected this exact wording — write a FRESH take, not a light edit)\n' +
    `${opts.previousText || '(none)'}\n\n` +
    '## User feedback to honor (this overrides any conflicting guidance above)\n' +
    `${opts.feedback || '(none)'}\n\n`;

  if (kind === 'post') {
    const kw = opts.keywords ?? ctx.sig.top_keywords;
    const inspoBlock =
      (opts.inspo ?? []).map((t) => `- ${t.author}: ${t.text.slice(0, 160)}`).join('\n') || '(none)';
    const perf = ctx.performance;
    return (
      voiceHeader(ctx) +
      (perf ? perf + '\n' : '') +
      "## Themes to draw from (stay close to these)\n" +
      (kw.join(', ') || '(none)') +
      '\n\n' +
      "## What's in my world today\n" +
      inspoBlock +
      '\n\n' +
      regenBlock +
      '## Task\nGenerate exactly 1 original post in my voice.\n\n' +
      POSTS_SHAPE +
      '\n\n' +
      VOICE_RULES
    );
  }

  const target = opts.target;
  const feedBlock = target
    ? `[${target.id}] ${target.author}: ${target.text.slice(0, 200)}`
    : '(none)';
  if (kind === 'reply') {
    return (
      voiceHeader(ctx) +
      '## Feed item to reply to (use its EXACT id)\n' +
      feedBlock +
      '\n\n' +
      regenBlock +
      '## Task\nWrite exactly 1 reply to the item above.\n\n' +
      REPLIES_SHAPE +
      '\n\n' +
      VOICE_RULES
    );
  }
  return (
    voiceHeader(ctx) +
    '## Feed item to quote-tweet (add MY angle; use its EXACT id)\n' +
    feedBlock +
    '\n\n' +
    regenBlock +
    '## Task\nWrite exactly 1 quote-tweet for the item above.\n\n' +
    QUOTES_SHAPE +
    '\n\n' +
    VOICE_RULES
  );
}
