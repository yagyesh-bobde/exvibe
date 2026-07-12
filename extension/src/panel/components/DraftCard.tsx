/**
 * One draft (post / reply / quote): editable text with live 280 counter,
 * target preview, and the full action set. Async work is delegated to App via
 * `actions`; callbacks resolve `true` when the card is being removed (so the
 * card skips resetting local busy state on an unmounting component).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { Draft } from '../../shared/models';
import { charCount, TWEET_LIMIT } from '../lib/tweet';
import Counter from './Counter';
import SchedulePopover from './SchedulePopover';
import TargetPreview from './TargetPreview';

export interface DraftActions {
  postNow: (draft: Draft, text: string) => Promise<boolean>;
  queue: (draft: Draft, text: string) => Promise<boolean>;
  schedule: (draft: Draft, text: string, fireAtIso: string) => Promise<boolean>;
  regenerate: (draft: Draft, feedback: string) => Promise<boolean>;
  like: (draft: Draft, text: string) => Promise<boolean>;
  markPosted: (draft: Draft, text: string) => Promise<boolean>;
  discard: (draft: Draft, text: string) => Promise<boolean>;
}

type Busy =
  | 'posting'
  | 'queueing'
  | 'scheduling'
  | 'regenerating'
  | 'liking'
  | 'marking'
  | 'discarding';

const BUSY_RIBBON: Partial<Record<Busy, string>> = {
  posting: 'posting via x.com…',
  regenerating: 'regenerating…',
};

interface Props {
  draft: Draft;
  actions: DraftActions;
}

export default function DraftCard({ draft, actions }: Props): ReactElement {
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenFeedback, setRegenFeedback] = useState('');
  const [liked, setLiked] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Server swapped the draft text (regenerate / refresh) -> reset the editor.
  useEffect(() => {
    setText(draft.text);
  }, [draft.id, draft.text]);

  // Auto-grow the textarea to fit content.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  const count = charCount(text);
  const postable = count > 0 && count <= TWEET_LIMIT && busy === null;
  const edited = text !== draft.text;

  const run = useCallback(
    (kind: Busy, fn: () => Promise<boolean>) => {
      setBusy(kind);
      void fn().then((removed) => {
        if (!removed) setBusy(null);
      });
    },
    [],
  );

  const submitRegenerate = (): void => {
    const feedback = regenFeedback.trim();
    setBusy('regenerating');
    void actions.regenerate(draft, feedback).then(() => {
      setBusy(null);
      setRegenOpen(false);
      setRegenFeedback('');
      setLiked(false);
    });
  };

  const ribbon = busy ? BUSY_RIBBON[busy] : undefined;

  return (
    <article
      className={`ev-card relative rounded-md border border-[var(--line)] bg-[var(--panel)] p-3 transition-colors ${
        busy ? 'border-[var(--line-strong)]' : 'hover:border-[var(--line-strong)]'
      }`}
    >
      <header className="mb-1.5 flex items-center justify-between gap-2">
        <span className="ev-label flex min-w-0 items-center gap-1.5 truncate">
          {draft.template ? (
            <span className="rounded-sm border border-[var(--line)] px-1 py-px text-[9.5px] text-[var(--muted)]">
              {draft.template}
            </span>
          ) : null}
          <span className="text-[var(--dim)]">{draft.id}</span>
          {edited ? (
            <span className="text-[var(--amber)]" title="Edited — your edit is sent as feedback">
              edited
            </span>
          ) : null}
        </span>
        <Counter text={text} />
      </header>

      <TargetPreview draft={draft} />

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && postable) {
            e.preventDefault();
            run('posting', () => actions.postNow(draft, text));
          }
        }}
        disabled={busy !== null}
        rows={2}
        spellCheck
        className={`ev-read w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1 py-0.5 text-[var(--text)] placeholder:text-[var(--dim)] focus:border-[var(--line-strong)] focus:bg-[var(--panel-2)] disabled:opacity-60 ${
          busy === 'regenerating' ? 'ev-shimmer' : ''
        }`}
        placeholder="empty draft"
        aria-label={`${draft.kind} draft text`}
      />

      {ribbon ? (
        <div className="ev-shimmer mt-1.5 flex items-center gap-1.5 text-[10.5px] text-[var(--accent)]">
          <span className="inline-block h-2.5 w-2.5 rounded-full border border-[var(--accent)] border-t-transparent ev-spin" />
          {ribbon}
        </div>
      ) : null}

      <footer className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!postable}
            onClick={() => run('posting', () => actions.postNow(draft, text))}
            title="Post now via the x.com tab (⌘⏎ in the editor)"
            className="rounded border border-[rgba(62,207,142,0.4)] bg-[var(--accent-dim)] px-2.5 py-1 text-[10.5px] font-medium text-[var(--accent)] hover:bg-[rgba(62,207,142,0.22)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === 'posting' ? 'posting…' : 'post now'}
          </button>
          <button
            type="button"
            disabled={!postable}
            onClick={() => run('queueing', () => actions.queue(draft, text))}
            title="Add to the queue, 3h after the last queued item"
            className="rounded border border-[var(--line)] px-2 py-1 text-[10.5px] text-[var(--muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === 'queueing' ? 'queueing…' : 'queue +3h'}
          </button>
          <button
            type="button"
            disabled={!postable}
            onClick={() => {
              setScheduleOpen((v) => !v);
              setRegenOpen(false);
            }}
            title="Schedule for a specific time"
            className={`rounded border px-2 py-1 text-[10.5px] disabled:cursor-not-allowed disabled:opacity-40 ${
              scheduleOpen
                ? 'border-[var(--line-strong)] bg-[var(--panel-2)] text-[var(--text)]'
                : 'border-[var(--line)] text-[var(--muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)]'
            }`}
          >
            schedule…
          </button>
        </div>

        <div className="flex items-center gap-0.5">
          <IconButton
            label={liked ? 'liked' : 'like'}
            title="Like — teaches your voice this is good"
            active={liked}
            disabled={busy !== null || liked}
            onClick={() => {
              setLiked(true);
              run('liking', async () => {
                const ok = await actions.like(draft, text);
                if (!ok) setLiked(false);
                return false;
              });
            }}
          >
            {liked ? '♥' : '♡'}
          </IconButton>
          <IconButton
            label="regen"
            title="Regenerate with a prompt tweak"
            active={regenOpen}
            disabled={busy !== null}
            onClick={() => {
              setRegenOpen((v) => !v);
              setScheduleOpen(false);
            }}
          >
            ↻
          </IconButton>
          <IconButton
            label="posted"
            title="Mark as posted (you posted it yourself)"
            disabled={busy !== null}
            onClick={() => run('marking', () => actions.markPosted(draft, text))}
          >
            ✓
          </IconButton>
          <IconButton
            label="discard"
            title="Discard — teaches your voice this is off"
            danger
            disabled={busy !== null}
            onClick={() => run('discarding', () => actions.discard(draft, text))}
          >
            ✕
          </IconButton>
        </div>
      </footer>

      {scheduleOpen ? (
        <SchedulePopover
          busy={busy === 'scheduling'}
          onClose={() => setScheduleOpen(false)}
          onConfirm={(iso) => run('scheduling', () => actions.schedule(draft, text, iso))}
        />
      ) : null}

      {regenOpen ? (
        <div className="mt-2 rounded border border-[var(--line-strong)] bg-[var(--panel-2)] p-2.5">
          <div className="ev-label mb-1.5">tweak the prompt</div>
          <textarea
            value={regenFeedback}
            onChange={(e) => setRegenFeedback(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && busy === null) {
                e.preventDefault();
                submitRegenerate();
              }
              if (e.key === 'Escape') setRegenOpen(false);
            }}
            rows={2}
            placeholder="e.g. punchier opener, drop the hashtag, more specific"
            className="w-full resize-none rounded border border-[var(--line)] bg-[var(--bg)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--text)] placeholder:text-[var(--dim)]"
            autoFocus
          />
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              disabled={busy !== null}
              onClick={submitRegenerate}
              className="rounded border border-[rgba(62,207,142,0.4)] bg-[var(--accent-dim)] px-2.5 py-1 text-[10.5px] text-[var(--accent)] hover:bg-[rgba(62,207,142,0.22)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'regenerating' ? 'regenerating…' : 'regenerate'}
            </button>
            <button
              type="button"
              onClick={() => setRegenOpen(false)}
              className="rounded border border-[var(--line)] px-2.5 py-1 text-[10.5px] text-[var(--muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)]"
            >
              cancel
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function IconButton({
  label,
  title,
  onClick,
  disabled,
  active = false,
  danger = false,
  children,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled: boolean;
  active?: boolean;
  danger?: boolean;
  children: string;
}): ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-1 rounded px-1.5 py-1 text-[10.5px] disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'text-[var(--accent)]'
          : danger
            ? 'text-[var(--dim)] hover:bg-[var(--red-dim)] hover:text-[var(--red)]'
            : 'text-[var(--dim)] hover:bg-[var(--panel-2)] hover:text-[var(--text)]'
      }`}
    >
      <span aria-hidden="true">{children}</span>
      {label}
    </button>
  );
}
