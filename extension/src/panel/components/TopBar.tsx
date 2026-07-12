/** Top bar: wordmark + @handle, server status dot, refresh action. */

import type { ReactElement } from 'react';

export type ServerStatus = 'checking' | 'up' | 'down';

const STATUS_META: Record<ServerStatus, { cls: string; label: string }> = {
  up: { cls: 'bg-[var(--accent)] ev-dot-live', label: 'server connected' },
  down: { cls: 'bg-[var(--red)]', label: 'server offline' },
  checking: { cls: 'bg-[var(--amber)]', label: 'checking server…' },
};

interface Props {
  handle: string | undefined;
  status: ServerStatus;
  refreshing: boolean;
  onRefresh: () => void;
}

export default function TopBar({ handle, status, refreshing, onRefresh }: Props): ReactElement {
  const meta = STATUS_META[status];
  return (
    <header className="flex items-center justify-between gap-2 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[13px] font-semibold tracking-tight text-[var(--text)]">
          ex<span className="text-[var(--accent)]">vibe</span>
        </span>
        {handle ? (
          <a
            href={`https://x.com/${handle}`}
            target="_blank"
            rel="noreferrer"
            className="truncate text-[11px] text-[var(--muted)] hover:text-[var(--text)]"
            title={`Open @${handle} on X`}
          >
            @{handle}
          </a>
        ) : null}
      </div>
      <div className="flex items-center gap-2.5">
        <span className="flex items-center" title={meta.label} aria-label={meta.label}>
          <span className={`h-[7px] w-[7px] rounded-full ${meta.cls}`} />
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing || status !== 'up'}
          title="Re-run the pipeline: read your X signal, redraft everything"
          className="flex items-center gap-1.5 rounded border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span aria-hidden="true" className={refreshing ? 'inline-block ev-spin' : ''}>
            ↻
          </span>
          {refreshing ? 'refreshing' : 'refresh'}
        </button>
      </div>
    </header>
  );
}
