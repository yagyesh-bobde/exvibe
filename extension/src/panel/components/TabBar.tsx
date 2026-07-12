/** Tab strip: Posts / Replies / Quotes / Queue / Settings, with counts. */

import type { ReactElement } from 'react';

export type TabId = 'posts' | 'replies' | 'quotes' | 'queue' | 'settings';

export const TAB_ORDER: readonly TabId[] = ['posts', 'replies', 'quotes', 'queue', 'settings'];

const TAB_LABEL: Record<TabId, string> = {
  posts: 'posts',
  replies: 'replies',
  quotes: 'quotes',
  queue: 'queue',
  settings: 'settings',
};

interface Props {
  active: TabId;
  counts: Partial<Record<TabId, number>>;
  onSelect: (tab: TabId) => void;
}

export default function TabBar({ active, counts, onSelect }: Props): ReactElement {
  return (
    <nav
      role="tablist"
      aria-label="exvibe sections"
      className="flex border-b border-[var(--line)] px-1"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const idx = TAB_ORDER.indexOf(active);
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        const next = TAB_ORDER[(idx + delta + TAB_ORDER.length) % TAB_ORDER.length];
        if (next) onSelect(next);
      }}
    >
      {TAB_ORDER.map((tab, i) => {
        const isActive = tab === active;
        const count = counts[tab];
        return (
          <button
            key={tab}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(tab)}
            title={`${TAB_LABEL[tab]} (${i + 1})`}
            className={`relative flex-1 px-1 py-2 text-[10.5px] uppercase tracking-[0.12em] transition-colors ${
              isActive ? 'text-[var(--text)]' : 'text-[var(--dim)] hover:text-[var(--muted)]'
            }`}
          >
            {TAB_LABEL[tab]}
            {typeof count === 'number' && count > 0 ? (
              <span
                className={`ml-1 tabular-nums ${isActive ? 'text-[var(--accent)]' : 'text-[var(--dim)]'}`}
              >
                {count}
              </span>
            ) : null}
            <span
              aria-hidden="true"
              className={`absolute inset-x-2 bottom-0 h-px transition-colors ${
                isActive ? 'bg-[var(--accent)]' : 'bg-transparent'
              }`}
            />
          </button>
        );
      })}
    </nav>
  );
}
