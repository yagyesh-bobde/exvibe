/**
 * Daily-guarded, fully-automatic eval that tunes the learned voice state.
 * Port of eval_engine.py.
 *
 * Reads kept (good) vs discarded (bad) drafts from feedback.ts, asks claude
 * what separates them, and auto-writes voiceState's data file. Every run is
 * logged to server/data/evals.json with the conclusion, the diff applied, and
 * a state snapshot for one-click revert.
 */

import type { VoiceState } from '../types';
import { claude, dashboardAgent } from './exec';
import * as fb from './feedback';
import { dataPath, readJson, writeJsonAtomic } from './storage';
import * as voiceState from './voiceState';

const EVALS_PATH = dataPath('evals.json');

const MIN_EVENTS = Number(process.env['EVAL_MIN_EVENTS'] ?? '') || 5;
const CADENCE_HOURS = 24;
const MAX_EXAMPLES = 40;

export interface EvalRun {
  id: string;
  ts: string;
  conclusion: string;
  added: Record<voiceState.VoiceKey, string[]>;
  counts: { good: number; bad: number; since_last: number };
  state_before: VoiceState;
  reverted: boolean;
  reverted_at?: string;
}

export interface EvalSkipped {
  skipped: string;
}

export type EvalResult = EvalRun | EvalSkipped;

export type EvalCaller = (prompt: string) => Promise<Record<string, unknown> | null>;

export function loadRuns(path: string = EVALS_PATH): EvalRun[] {
  const data = readJson<unknown>(path, []);
  return Array.isArray(data) ? (data as EvalRun[]) : [];
}

function saveRuns(runs: EvalRun[], path: string = EVALS_PATH): void {
  writeJsonAtomic(path, runs);
}

function parseTs(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts.replace('Z', '+00:00').replace('+00:00', 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function defaultCaller(prompt: string): Promise<Record<string, unknown> | null> {
  return claude(prompt, dashboardAgent(), { timeoutMs: 300_000, label: 'eval' });
}

export function buildPrompt(good: fb.FeedbackRecord[], bad: fb.FeedbackRecord[], state: VoiceState): string {
  const block = (items: fb.FeedbackRecord[]): string => {
    const out: string[] = [];
    for (const e of items) {
      const t = (e.final_text || e.original_text || '').trim();
      if (!t) continue;
      const tag = e.edited ? ` (edited from: ${e.original_text})` : '';
      out.push(`- [${e.kind ?? '?'}] ${t}${tag}`);
    }
    return out.join('\n') || '(none)';
  };

  const current = voiceState.formatForPrompt(state) || '(none yet)';
  return (
    'You tune the voice of an automated tweet-drafting system by contrasting drafts ' +
    'the user KEPT against drafts they DISCARDED.\n\n' +
    '## KEPT (good — these match his voice / were worth posting)\n' +
    `${block(good)}\n\n` +
    '## DISCARDED (bad — he rejected these; learn what to avoid)\n' +
    `${block(bad)}\n\n` +
    '## Current learned guidance already in the prompt\n' +
    `${current}\n\n` +
    '## Task\n' +
    'Figure out what separates kept from discarded. Then return JSON ONLY (no fences, ' +
    'start with `{` end with `}`) with this exact shape:\n' +
    '{\n' +
    '  "conclusion": "<2-4 sentences: what makes his kept drafts work and what the discarded ones got wrong>",\n' +
    '  "gold_examples_to_add": ["<verbatim text of the best KEPT drafts to reuse as exemplars; 0-5 items>"],\n' +
    '  "anti_examples_to_add": ["<verbatim text of representative DISCARDED drafts to explicitly avoid; 0-5 items>"],\n' +
    '  "rule_adjustments": ["<short new voice-rule lines distilled from the contrast; 0-4 items>"]\n' +
    '}\n' +
    'Only include NEW items not already covered by the current guidance. Empty arrays are fine.'
  );
}

function shouldRun(runs: EvalRun[], events: fb.FeedbackRecord[], now: Date): { ok: boolean; reason: string } {
  const last = runs.length ? runs[runs.length - 1]?.ts ?? null : null;
  if (last) {
    const lastDt = parseTs(last);
    if (lastDt && now.getTime() - lastDt.getTime() < CADENCE_HOURS * 3600_000) {
      return { ok: false, reason: 'cadence' };
    }
  }
  const newEvents = events.filter((e) => !last || (e.ts ?? '') > last).length;
  if (newEvents < MIN_EVENTS) {
    return { ok: false, reason: 'insufficient' };
  }
  return { ok: true, reason: '' };
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function runId(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

export interface RunEvalOptions {
  force?: boolean;
  now?: Date;
  caller?: EvalCaller;
}

export async function runEval(options: boolean | RunEvalOptions = {}): Promise<EvalResult> {
  const opts: RunEvalOptions = typeof options === 'boolean' ? { force: options } : options;
  const now = opts.now ?? new Date();
  const runs = loadRuns();
  const events = fb.loadEvents();
  if (!opts.force) {
    const { ok, reason } = shouldRun(runs, events, now);
    if (!ok) return { skipped: reason };
  }

  // Fresh-per-cycle: only learn from feedback gathered since the last eval, so
  // each eval evaluates the draft set produced after the previous one (the old
  // set's feedback is considered consumed once an eval has run on it).
  const lastTs = runs.length ? runs[runs.length - 1]?.ts ?? null : null;
  const fresh = events.filter((e) => !lastTs || (e.ts ?? '') > lastTs);
  const good = fresh.filter((e) => e.signal === 'good').slice(-MAX_EXAMPLES);
  const bad = fresh.filter((e) => e.signal === 'bad').slice(-MAX_EXAMPLES);
  const state = voiceState.loadState();
  const caller = opts.caller ?? defaultCaller;

  const result = await caller(buildPrompt(good, bad, state));
  if (!result) return { skipped: 'claude_failed' };

  const newState = voiceState.mergeState(state, {
    gold: strList(result['gold_examples_to_add']),
    anti: strList(result['anti_examples_to_add']),
    rules: strList(result['rule_adjustments']),
  });
  voiceState.saveState(newState);

  const added: Record<voiceState.VoiceKey, string[]> = { gold: [], anti: [], rules: [] };
  for (const k of voiceState.VOICE_KEYS) {
    added[k] = newState[k].filter((x) => !(state[k] ?? []).includes(x));
  }
  const run: EvalRun = {
    id: runId(now),
    ts: now.toISOString(),
    conclusion: typeof result['conclusion'] === 'string' ? result['conclusion'] : '',
    added,
    counts: {
      good: good.length,
      bad: bad.length,
      since_last: events.filter((e) => !lastTs || (e.ts ?? '') > lastTs).length,
    },
    state_before: state,
    reverted: false,
  };
  runs.push(run);
  saveRuns(runs);
  return run;
}

export function revertEval(runId_: string, now?: Date): { ok: boolean; id?: string; error?: string } {
  const at = now ?? new Date();
  const runs = loadRuns();
  for (const r of runs) {
    if (r.id === runId_ && !r.reverted) {
      voiceState.saveState(r.state_before ?? voiceState.loadState());
      r.reverted = true;
      r.reverted_at = at.toISOString();
      saveRuns(runs);
      return { ok: true, id: runId_ };
    }
  }
  return { ok: false, error: 'not found or already reverted' };
}

/**
 * True iff an eval run actually altered the learned voice state (added any
 * gold/anti example or rule) — i.e. the drafting prompt is now different.
 */
export function voiceChanged(run: EvalResult | null | undefined): boolean {
  if (!run || 'skipped' in run) return false;
  return Object.values(run.added ?? {}).some((v) => v.length > 0);
}

export interface EvalOverview {
  runs: EvalRun[];
  summary: fb.FeedbackSummary;
  state: VoiceState;
}

export function overview(): EvalOverview {
  const runs = loadRuns();
  const events = fb.loadEvents();
  const lastTs = runs.length ? runs[runs.length - 1]?.ts ?? null : null;
  return {
    runs: [...runs].reverse(), // newest first for the UI
    summary: fb.summarize(events, lastTs),
    state: voiceState.loadState(),
  };
}
