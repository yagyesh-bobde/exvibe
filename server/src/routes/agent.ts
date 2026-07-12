/**
 * GET /agent · POST /agent · POST /agent/study
 *
 * Reads/edits the `claude --agent` persona markdown (DASHBOARD_AGENT_MD) and
 * runs the voice-mining "study" flow: fetch ~50 posts for a handle via the
 * agent-reach `twitter` CLI, have `claude` extract voice patterns, and patch
 * them into the agent file.
 *
 * Ported from the original Python dashboard's server.py
 * (parse_voice_neighborhood, has_yaml_front_matter, write_agent_md,
 * patch_agent_md, VOICE_MINE_PROMPT) — the prompt and the patching heuristics
 * are load-bearing IP; keep them verbatim.
 */

import { rename, stat } from 'node:fs/promises';
import { claudeBin, dashboardAgentMd, twitter } from '../lib/exec';
import { extractJson } from '../lib/extractJson';
import { ApiError, isRecord, json, readJsonBody, requireString } from './http';

// ──────────────────────  agent .md structure markers  ──────────────────────

const VN_HEADER = '## VOICE NEIGHBORHOOD — WHO TO SOUND ADJACENT TO (NOT IMITATE)';
const RP_HEADER = '## REACH PATTERNS — VIRALITY-TUNED TWEET TEMPLATES';
const EMOJI_RULE_TAG = '**Tweet emoji palette:**';
const ABBREV_RULE_TAG = '**Casual abbreviations are part of the brand.';

// ──────────────────────  subprocess helpers  ──────────────────────

/** `twitter user-posts @handle -n 50 --json` → post records (or null). */
async function fetchUserPosts(handle: string, n: number): Promise<unknown[] | null> {
  const at = handle.startsWith('@') ? handle : `@${handle}`;
  let out = await twitter(['user-posts', at, '-n', String(n)], 90_000);
  if (isRecord(out)) {
    out = out['posts'] ?? out['data'] ?? out['tweets'] ?? [];
  }
  return Array.isArray(out) ? out : null;
}

/** Plain `claude -p <prompt>` (no --agent): raw stdout, not JSON-parsed. */
async function callClaudePlain(
  prompt: string,
  timeoutMs: number,
): Promise<{ ok: boolean; out: string }> {
  const bin = claudeBin();
  if (!bin) return { ok: false, out: 'claude CLI not found on PATH' };
  const proc = Bun.spawn({
    cmd: [bin, '-p', prompt],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (timedOut) return { ok: false, out: 'claude call timed out' };
    if (code !== 0) return { ok: false, out: stderr.trim().slice(0, 600) };
    return { ok: true, out: stdout };
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────  agent .md parsing / patching  ──────────────────────

export interface VoiceProfile {
  handle: string;
  url: string;
  note: string;
}

/** Parse the VOICE NEIGHBORHOOD section bullets into [{handle, url, note}]. */
function parseVoiceNeighborhood(content: string): VoiceProfile[] {
  const i = content.indexOf(VN_HEADER);
  if (i === -1) return [];
  // take everything until the next H2 or end
  const rest = content.slice(i + VN_HEADER.length);
  const nxt = rest.search(/\n##\s/);
  const block = nxt === -1 ? rest : rest.slice(0, nxt);
  const out: VoiceProfile[] = [];
  const seen = new Set<string>();
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*-\s+\*\*`@?([A-Za-z0-9_]+)`\*\*\s*[—-]\s*(.+?)\s*$/);
    if (!m) continue;
    const handle = m[1];
    const note = m[2];
    if (!handle || note === undefined || seen.has(handle)) continue;
    seen.add(handle);
    out.push({
      handle: `@${handle}`,
      url: `https://x.com/${handle}`,
      note: note.trim(),
    });
  }
  return out;
}

function hasYamlFrontMatter(content: string): boolean {
  if (!content.startsWith('---')) return false;
  // ensure a closing --- on its own line within the first ~8000 chars
  const end = content.indexOf('\n---', 3);
  return end !== -1 && end < 8000;
}

/** Atomic write. Ensures YAML front matter is intact before writing. */
async function writeAgentMd(path: string, content: string): Promise<void> {
  if (!hasYamlFrontMatter(content)) {
    throw new ApiError(
      400,
      'missing or invalid YAML front matter (must start with --- and have a closing ---)',
    );
  }
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, content);
  await rename(tmp, path);
}

function strField(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === 'string' ? v : '';
}

function numField(rec: Record<string, unknown>, key: string): number {
  const v = rec[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function strListField(rec: Record<string, unknown>, key: string): string[] {
  const v = rec[key];
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Merge a voice-mining analysis into the agent .md content.
 *
 * Mutates in this order:
 *   - add a VOICE NEIGHBORHOOD bullet (if handle not present)
 *   - extend the abbreviations rule with vocab_additions
 *   - extend the emoji-palette rule with emoji_additions
 *   - add new template(s) under REACH PATTERNS (template_additions)
 */
function patchAgentMd(
  original: string,
  analysis: Record<string, unknown>,
  handle: string,
): { content: string; diff: string[] } {
  let content = original;
  const diff: string[] = [];
  const handleNorm = handle.replace(/^@+/, '');

  // 1) voice neighborhood bullet
  const existing = new Set(parseVoiceNeighborhood(content).map((p) => p.handle.toLowerCase()));
  if (!existing.has(`@${handleNorm.toLowerCase()}`)) {
    let note =
      strField(analysis, 'summary').trim() ||
      strField(analysis, 'distinctive').trim() ||
      'voice-mined profile';
    note = note.replace(/\s+/g, ' ').slice(0, 240);
    const newBullet = `- **\`@${handleNorm}\`** — ${note}`;
    // insert as last bullet in the VN section, before the `---` separator that follows
    const vnI = content.indexOf(VN_HEADER);
    if (vnI === -1) {
      throw new ApiError(400, 'VOICE NEIGHBORHOOD section not found in agent file');
    }
    // find end of VN block (next \n--- or next ## )
    const tail = content.slice(vnI);
    const sep = /\n---\s*\n/.exec(tail);
    let insertAt: number;
    if (sep) {
      insertAt = vnI + sep.index;
    } else {
      const nextH2 = /\n##\s/.exec(tail.slice(VN_HEADER.length));
      insertAt = nextH2 ? vnI + VN_HEADER.length + nextH2.index : content.length;
    }
    // ensure exactly one newline before our bullet
    const before = `${content.slice(0, insertAt).replace(/\s+$/, '')}\n`;
    const after = content.slice(insertAt);
    content = `${before}${newBullet}\n${after}`;
    diff.push(`added @${handleNorm} to VOICE NEIGHBORHOOD`);
  }

  // 2) vocab_additions → abbreviations rule
  const vocab = strListField(analysis, 'vocab_additions').filter(
    (v) => !content.toLowerCase().includes(v.toLowerCase()),
  );
  if (vocab.length > 0) {
    const lineIdx = content.indexOf(ABBREV_RULE_TAG);
    if (lineIdx !== -1) {
      const lineEnd = content.indexOf('\n', lineIdx);
      if (lineEnd !== -1) {
        const picked = vocab.slice(0, 8);
        const addition = `, ${picked.map((v) => `"${v}"`).join(', ')}`;
        content = content.slice(0, lineEnd) + addition + content.slice(lineEnd);
        diff.push(`vocab+: ${picked.join(', ')}`);
      }
    }
  }

  // 3) emoji_additions → emoji-palette rule
  const emoji = strListField(analysis, 'emoji_additions').filter((e) => !content.includes(e));
  if (emoji.length > 0) {
    const lineIdx = content.indexOf(EMOJI_RULE_TAG);
    if (lineIdx !== -1) {
      const lineEnd = content.indexOf('\n', lineIdx);
      if (lineEnd !== -1) {
        const picked = emoji.slice(0, 6);
        const addition = `, ${picked.join(', ')}`;
        content = content.slice(0, lineEnd) + addition + content.slice(lineEnd);
        diff.push(`emoji+: ${picked.join(' ')}`);
      }
    }
  }

  // 4) template_additions → new REACH PATTERN entry
  const templates = analysis['template_additions'];
  if (Array.isArray(templates) && templates.length > 0) {
    // count existing "Template N —" headers to pick the next index
    const used = [...content.matchAll(/###\s+Template\s+(\d+)/g)]
      .map((m) => Number.parseInt(m[1] ?? '', 10))
      .filter((n) => Number.isFinite(n));
    let nextN = (used.length > 0 ? Math.max(...used) : 10) + 1;
    const rpI = content.indexOf(RP_HEADER);
    if (rpI !== -1) {
      const tail = content.slice(rpI);
      // insert before the next "\n---" after RP_HEADER
      const sep = /\n---\s*\n/.exec(tail);
      const insertAt = sep ? rpI + sep.index : content.length;
      const blocks: string[] = [];
      for (const t of templates.slice(0, 2)) {
        if (!isRecord(t)) continue;
        const name = strField(t, 'name').trim() || 'Mined Pattern';
        const desc = strField(t, 'description').trim();
        const example = strField(t, 'example').trim();
        const lines = [`\n### Template ${nextN} — ${name} (mined from @${handleNorm})`];
        if (desc) lines.push(desc);
        if (example) {
          for (const ln of example.split('\n')) {
            lines.push(ln.trim() ? `> ${ln}` : '>');
          }
        }
        blocks.push(lines.join('\n'));
        nextN += 1;
      }
      if (blocks.length > 0) {
        content =
          `${content.slice(0, insertAt).replace(/\s+$/, '')}\n\n` +
          `${blocks.join('\n\n')}\n${content.slice(insertAt)}`;
        diff.push(`reach template+: ${blocks.length} new (#${nextN - blocks.length})`);
      }
    }
  }

  return { content, diff };
}

// ──────────────────────  voice-mining prompt (verbatim IP)  ──────────────────────

const VOICE_MINE_PROMPT = `You are analyzing the voice of an X (Twitter) user so that another writer can sound *adjacent* to them.

Read the posts below (JSON). Extract patterns. Return STRICT JSON only — no prose, no code fences.

Schema:
{
  "summary": "<one sentence, ≤180 chars, what makes this account's voice distinctive — usable as a single-line neighborhood note>",
  "openers": ["<short opener phrases this account reaches for>", ...],
  "rhythm": "<sentence-level rhythm in one short clause: short/long, em-dash heavy, question-led, etc.>",
  "vocab_additions": ["<short slangy words/phrases this account uses that would extend an Indian-builder writer's vocabulary — max 8, no duplicates of common words>", ...],
  "emoji_additions": ["<single-char emojis this account uses with semantic load — max 6>", ...],
  "template_additions": [
    {"name": "<short Title Case label>", "description": "<one sentence on the pattern>", "example": "<verbatim short example from the posts>"}
  ],
  "distinctive": "<1-3 sentences: what to borrow vs. what NOT to borrow (their personal-brand baggage)>"
}

Rules:
- "template_additions" should be EMPTY if no genuinely novel reach pattern exists.
- Do not include patterns already obvious (e.g. "uses lowercase tweets" — every Indian builder does).
- Quote examples verbatim; do not paraphrase.
- Output JSON only. Start with { and end with }.

Handle: @__HANDLE__

Posts (JSON):
__POSTS_JSON__
`;

// ──────────────────────  route handlers  ──────────────────────

export async function getAgent(): Promise<Response> {
  const path = dashboardAgentMd();
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ApiError(404, `agent file not found: ${path}`);
  }
  const content = await file.text();
  const st = await stat(path);
  return json({
    path,
    content,
    mtime: st.mtime.toISOString(),
    profiles: parseVoiceNeighborhood(content),
  });
}

export async function postAgent(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const content = body['content'];
  if (typeof content !== 'string' || !content.trim()) {
    throw new ApiError(400, 'content must be a non-empty string');
  }
  const path = dashboardAgentMd();
  await writeAgentMd(path, content);
  const st = await stat(path);
  return json({ ok: true, mtime: st.mtime.toISOString(), bytes: content.length });
}

export async function postAgentStudy(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  const username = requireString(body, 'username').trim();
  const handleNorm = username.replace(/^@+/, '');
  if (!/^[A-Za-z0-9_]{1,20}$/.test(handleNorm)) {
    throw new ApiError(400, 'invalid handle');
  }

  const posts = await fetchUserPosts(handleNorm, 50);
  if (!posts || posts.length === 0) {
    throw new ApiError(502, `no posts fetched for @${handleNorm}`);
  }

  // trim posts payload to keep the prompt under budget
  const slim = posts
    .slice(0, 50)
    .filter(isRecord)
    .map((p) => ({
      text: (strField(p, 'text') || strField(p, 'content')).slice(0, 600),
      likes: numField(p, 'likes') || numField(p, 'favorites'),
      rts: numField(p, 'rts') || numField(p, 'retweets'),
      time: strField(p, 'time') || strField(p, 'created_at') || null,
    }));

  const prompt = VOICE_MINE_PROMPT.replace('__HANDLE__', handleNorm).replace(
    '__POSTS_JSON__',
    JSON.stringify(slim, null, 1).slice(0, 30_000),
  );

  const call = await callClaudePlain(prompt, 180_000);
  if (!call.ok) throw new ApiError(502, 'claude call failed', { detail: call.out });
  const analysis = extractJson(call.out);
  if (!analysis) {
    throw new ApiError(502, 'claude returned malformed JSON', { raw: call.out.slice(0, 1200) });
  }

  const path = dashboardAgentMd();
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ApiError(404, `agent file not found: ${path}`, { analysis });
  }
  const current = await file.text();
  let patched: { content: string; diff: string[] };
  try {
    patched = patchAgentMd(current, analysis, handleNorm);
  } catch (err) {
    if (err instanceof ApiError) {
      throw new ApiError(err.status, err.message, { ...err.extra, analysis });
    }
    throw err;
  }
  await writeAgentMd(path, patched.content);
  const st = await stat(path);
  return json({
    ok: true,
    added_handle: `@${handleNorm}`,
    diff_summary: patched.diff,
    analysis,
    content: patched.content,
    mtime: st.mtime.toISOString(),
  });
}
