/** Target-tweet preview for reply/quote cards, with an open-in-X link. */

import { useState, type ReactElement } from 'react';
import type { Draft } from '../../shared/models';
import { tweetUrl } from '../lib/tweet';

const CLAMP_AT = 160;

export default function TargetPreview({ draft }: { draft: Draft }): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  if (!draft.target_id && !draft.target_text) return null;

  const text = draft.target_text ?? '';
  const clampable = text.length > CLAMP_AT;
  const shown = !expanded && clampable ? `${text.slice(0, CLAMP_AT).trimEnd()}…` : text;

  return (
    <div className="mb-2 rounded border-l-2 border-[var(--line-strong)] bg-[var(--panel-2)] px-2.5 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="ev-label truncate">
          {draft.kind === 'quote' ? 'quoting' : 'replying to'}{' '}
          <span className="normal-case tracking-normal text-[var(--text)]">
            @{draft.target_author ?? 'unknown'}
          </span>
        </span>
        {draft.target_id ? (
          <a
            href={tweetUrl(draft.target_author, draft.target_id)}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[10px] text-[var(--muted)] underline decoration-[var(--line-strong)] underline-offset-2 hover:text-[var(--accent)]"
            title="Open target tweet on X"
          >
            open ↗
          </a>
        ) : null}
      </div>
      {text ? (
        <p className="ev-read text-[13px] leading-normal text-[var(--muted)]">
          {shown}
          {clampable ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="ml-1.5 align-baseline font-[family-name:var(--font-mono)] text-[10px] text-[var(--dim)] hover:text-[var(--accent)]"
            >
              {expanded ? 'less' : 'more'}
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
