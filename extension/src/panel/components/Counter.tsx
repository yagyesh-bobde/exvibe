/**
 * Live 280 counter: progress ring + count. Neutral, amber past 240,
 * red past 280 (shows the overflow amount).
 */

import type { ReactElement } from 'react';
import { charCount, counterTone, TWEET_LIMIT } from '../lib/tweet';

const RADIUS = 7;
const CIRC = 2 * Math.PI * RADIUS;

const TONE_COLOR = {
  neutral: 'var(--dim)',
  warn: 'var(--amber)',
  over: 'var(--red)',
} as const;

const TONE_TEXT = {
  neutral: 'text-[var(--muted)]',
  warn: 'text-[var(--amber)]',
  over: 'text-[var(--red)]',
} as const;

export default function Counter({ text }: { text: string }): ReactElement {
  const count = charCount(text);
  const tone = counterTone(count);
  const frac = Math.min(count / TWEET_LIMIT, 1);

  return (
    <span
      className={`flex items-center gap-1.5 tabular-nums ${TONE_TEXT[tone]}`}
      title={`${count} / ${TWEET_LIMIT} characters`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle
          cx="9"
          cy="9"
          r={RADIUS}
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth="1.5"
        />
        <circle
          cx="9"
          cy="9"
          r={RADIUS}
          fill="none"
          stroke={TONE_COLOR[tone]}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - frac)}
          transform="rotate(-90 9 9)"
          className="transition-[stroke-dashoffset] duration-150"
        />
      </svg>
      <span className="text-[10.5px]">
        {tone === 'over' ? `-${count - TWEET_LIMIT}` : `${count} / ${TWEET_LIMIT}`}
      </span>
    </span>
  );
}
