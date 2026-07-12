/**
 * Machine-managed learned voice state injected into draft prompts.
 * Port of voice_state.py. The eval (evalEngine.ts) writes this file
 * automatically; the pipeline reads it and appends the formatted blocks to
 * every draft prompt. Lives in server/data/voice_state.json (gitignored).
 */

import type { VoiceState } from '../types';
import { dataPath, readJson, writeJsonAtomic } from './storage';

export const VOICE_KEYS = ['gold', 'anti', 'rules'] as const;
export type VoiceKey = (typeof VOICE_KEYS)[number];

export const CAPS: Record<VoiceKey, number> = { gold: 20, anti: 20, rules: 12 };

const STATE_PATH = dataPath('voice_state.json');

function empty(): VoiceState {
  return { gold: [], anti: [], rules: [] };
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

export function loadState(path: string = STATE_PATH): VoiceState {
  const data = readJson<Record<string, unknown> | null>(path, null);
  if (data === null || typeof data !== 'object') return empty();
  return {
    gold: strList(data['gold']),
    anti: strList(data['anti']),
    rules: strList(data['rules']),
  };
}

export function saveState(state: VoiceState, path: string = STATE_PATH): void {
  writeJsonAtomic(path, {
    gold: [...(state.gold ?? [])],
    anti: [...(state.anti ?? [])],
    rules: [...(state.rules ?? [])],
  });
}

export interface MergeAdditions {
  gold?: string[] | null;
  anti?: string[] | null;
  rules?: string[] | null;
}

/** Append new (trimmed, deduped) items per key and cap each list. */
export function mergeState(state: VoiceState, additions: MergeAdditions): VoiceState {
  const out: VoiceState = {
    gold: [...(state.gold ?? [])],
    anti: [...(state.anti ?? [])],
    rules: [...(state.rules ?? [])],
  };
  for (const key of VOICE_KEYS) {
    for (const raw of additions[key] ?? []) {
      const item = (raw ?? '').trim();
      if (item && !out[key].includes(item)) {
        out[key].push(item);
      }
    }
    out[key] = out[key].slice(-CAPS[key]);
  }
  return out;
}

export function formatForPrompt(state: VoiceState): string {
  const gold = state.gold ?? [];
  const anti = state.anti ?? [];
  const rules = state.rules ?? [];
  if (!gold.length && !anti.length && !rules.length) return '';
  const parts: string[] = [];
  if (gold.length) {
    parts.push(
      "## LEARNED — drafts you've kept (match this texture)\n" + gold.map((g) => `- ${g}`).join('\n'),
    );
  }
  if (anti.length) {
    parts.push(
      '## LEARNED — drafts I rejected, do NOT write like these\n' + anti.map((a) => `- ${a}`).join('\n'),
    );
  }
  if (rules.length) {
    parts.push('## LEARNED — extra voice rules\n' + rules.map((r) => `- ${r}`).join('\n'));
  }
  return parts.join('\n\n') + '\n';
}
