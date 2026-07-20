/**
 * CLI helpers: `claude -p ... --agent ... --effort medium` (drafting) and the
 * agent-reach `twitter <args> --json` CLI (read-only signal). Ports the
 * `_claude_json` / `twitter_json` / `env_for_twitter` logic from pipeline.py.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractJson } from './extractJson';

// Fallback path when `claude` isn't resolvable on PATH (e.g. the server was
// spawned by a daemon whose PATH omits the cmux bin dir, or the
// ~/.local/bin/claude version symlink is mid-rotation during an update).
const DEFAULT_CLAUDE = '/Applications/cmux.app/Contents/Resources/bin/claude';

const ENV_PATH = join(homedir(), '.agent-reach', 'env.sh');

// ── env config ───────────────────────────────────────────────────────────────

let twEnvCache: Record<string, string> | null = null;

/** Source ~/.agent-reach/env.sh and return the resulting env (cached). */
export function envForTwitter(): Record<string, string> {
  if (twEnvCache) return twEnvCache;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  if (existsSync(ENV_PATH)) {
    const proc = Bun.spawnSync({
      cmd: ['bash', '-c', `set -a; source ${ENV_PATH}; env`],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode === 0) {
      for (const line of proc.stdout.toString().split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) {
          env[line.slice(0, eq)] = line.slice(eq + 1);
        }
      }
    }
  }
  twEnvCache = env;
  return env;
}

/** X/Twitter handle (no leading @) from TWITTER_HANDLE, falling back to ~/.agent-reach/env.sh. */
export function twitterHandle(): string {
  const direct = (process.env['TWITTER_HANDLE'] ?? '').replace(/^@+/, '').trim();
  if (direct) return direct;
  return (envForTwitter()['TWITTER_HANDLE'] ?? '').replace(/^@+/, '').trim();
}

/** claude --agent name for drafting (DASHBOARD_AGENT, falling back to ~/.agent-reach/env.sh, then "voice"). */
export function dashboardAgent(): string {
  const direct = (process.env['DASHBOARD_AGENT'] ?? '').trim();
  if (direct) return direct;
  return (envForTwitter()['DASHBOARD_AGENT'] ?? '').trim() || 'voice';
}

/** Path to the agent persona markdown (DASHBOARD_AGENT_MD or ~/.claude/agents/<agent>.md). */
export function dashboardAgentMd(): string {
  const fromEnv =
    (process.env['DASHBOARD_AGENT_MD'] ?? '').trim() ||
    (envForTwitter()['DASHBOARD_AGENT_MD'] ?? '').trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), '.claude', 'agents', `${dashboardAgent()}.md`);
}

// ── process runner ───────────────────────────────────────────────────────────

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runProc(
  cmd: string[],
  opts: { timeoutMs: number; env?: Record<string, string> },
): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(opts.env ? { env: opts.env } : {}),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

// ── claude ───────────────────────────────────────────────────────────────────

export function claudeBin(): string | null {
  const b = Bun.which('claude');
  if (b) return b;
  if (existsSync(DEFAULT_CLAUDE)) return DEFAULT_CLAUDE;
  return null;
}

export interface ClaudeOptions {
  effort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  label?: string;
  retries?: number;
}

/**
 * One `claude -p <prompt> --agent <agent> --effort <effort>` call → parsed
 * JSON object (or null on failure). stdin=/dev/null, 300s timeout, 1 retry.
 * Logs returncode + a stderr/stdout snippet on failure so transient/env
 * failures are diagnosable.
 */
export async function claude(
  prompt: string,
  agent: string,
  opts: ClaudeOptions = {},
): Promise<Record<string, unknown> | null> {
  const { effort = 'medium', timeoutMs = 300_000, label = 'batch', retries = 1 } = opts;
  const cb = claudeBin();
  if (!cb) {
    console.error(
      `[pipeline] ${label}: claude CLI not found ` +
        `(PATH lookup failed and ${DEFAULT_CLAUDE} missing)`,
    );
    return null;
  }
  const cmd = [cb, '-p', prompt, '--agent', agent, '--effort', effort];
  let lastErr = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: RunResult;
    try {
      res = await runProc(cmd, { timeoutMs });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      console.error(`[pipeline] ${label}: spawn failed (attempt ${attempt + 1}): ${lastErr}`);
      continue;
    }
    if (res.timedOut) {
      lastErr = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      console.error(`[pipeline] ${label}: ${lastErr} (attempt ${attempt + 1})`);
      continue;
    }
    if (res.code !== 0) {
      lastErr = (res.stderr || res.stdout || '').trim().slice(0, 200);
      console.error(
        `[pipeline] ${label}: claude rc=${res.code} (attempt ${attempt + 1}): ${lastErr}`,
      );
      continue;
    }
    const parsed = extractJson(res.stdout);
    if (parsed !== null) return parsed;
    lastErr = 'unparseable output';
    console.error(
      `[pipeline] ${label}: rc=0 but JSON unparseable (attempt ${attempt + 1}); ` +
        `stdout[:200]=${JSON.stringify(res.stdout.trim().slice(0, 200))}`,
    );
  }
  console.error(`[pipeline] ${label}: gave up after ${retries + 1} attempts (${lastErr})`);
  return null;
}

// ── twitter (agent-reach) ────────────────────────────────────────────────────

/**
 * Run a `twitter <args> --json` CLI command and parse the JSON output.
 * Returns the parsed value (array or object) or null on any failure.
 */
export async function twitter(args: string[], timeoutMs = 60_000): Promise<unknown> {
  const env = envForTwitter();
  const bin = Bun.which('twitter', env['PATH'] ? { PATH: env['PATH'] } : undefined);
  if (!bin) return null;
  const cmd = [bin, ...args, '--json'];
  let res: RunResult;
  try {
    res = await runProc(cmd, { timeoutMs, env });
  } catch {
    return null;
  }
  if (res.timedOut) {
    console.error(
      `[pipeline] twitter ${args.join(' ')} timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
    return null;
  }
  if (res.code !== 0) {
    console.error(
      `[pipeline] twitter ${args.join(' ')} failed: ${res.stderr.trim().slice(0, 200)}`,
    );
    return null;
  }
  const txt = res.stdout.trim();
  if (!txt) {
    console.error(`[pipeline] twitter ${args.join(' ')} produced no output`);
    return null;
  }
  try {
    return JSON.parse(txt) as unknown;
  } catch {
    const m = txt.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (m && m[1]) {
      try {
        return JSON.parse(m[1]) as unknown;
      } catch {
        // fall through to the log below
      }
    }
    console.error(
      `[pipeline] twitter ${args.join(' ')} output unparseable: ${txt.slice(0, 200)}`,
    );
    return null;
  }
}
