/**
 * Queue tab: pending + scheduled items grouped by due / within the hour /
 * today / tomorrow / later, live countdowns, per-item cancel. Failed items
 * surface at the bottom with their error.
 */

import { useEffect, useState, type ReactElement } from 'react';
import type { QueueItem } from '../../shared/models';
import {
  countdown,
  fmtClock,
  fmtDayClock,
  groupQueueItems,
  QUEUE_GROUP_LABEL,
} from '../lib/time';

interface Props {
  items: QueueItem[];
  onCancel: (id: string) => void;
}

const KIND_GLYPH: Record<QueueItem['kind'], string> = {
  post: '✎',
  reply: '↩',
  quote: '❝',
};

export default function QueueTab({ items, onCancel }: Props): ReactElement {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const pending = items.filter((i) => i.status === 'pending');
  const failed = items.filter((i) => i.status === 'failed');
  const groups = groupQueueItems(pending, now);

  if (pending.length === 0 && failed.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 px-4 py-14 text-center">
        <p className="text-[11px] text-[var(--muted)]">the queue is empty</p>
        <p className="text-[10px] text-[var(--dim)]">
          queue or schedule a draft and it fires here on time
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-2.5">
      {groups.map(({ key, items: groupItems }) => (
        <section key={key}>
          <h2 className="ev-label mb-1.5 px-0.5">
            {QUEUE_GROUP_LABEL[key]}
            <span className="ml-1.5 text-[var(--dim)]">{groupItems.length}</span>
          </h2>
          <div className="flex flex-col gap-1.5">
            {groupItems.map((item) => (
              <QueueRow key={item.id} item={item} now={now} onCancel={onCancel} />
            ))}
          </div>
        </section>
      ))}

      {failed.length > 0 ? (
        <section>
          <h2 className="ev-label mb-1.5 px-0.5 text-[var(--red)]">failed</h2>
          <div className="flex flex-col gap-1.5">
            {failed.map((item) => (
              <div
                key={item.id}
                className="rounded-md border border-[rgba(240,86,74,0.3)] bg-[var(--panel)] p-2.5"
              >
                <p className="ev-read truncate text-[12.5px] text-[var(--muted)]">{item.text}</p>
                <p className="mt-1 text-[10px] text-[var(--red)]">
                  {item.error ?? 'posting failed'}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function QueueRow({
  item,
  now,
  onCancel,
}: {
  item: QueueItem;
  now: number;
  onCancel: (id: string) => void;
}): ReactElement {
  const fireAt = Date.parse(item.fire_at_iso);
  const remaining = fireAt - now;
  const due = remaining <= 0;
  const isToday = new Date(fireAt).toDateString() === new Date(now).toDateString();

  return (
    <div className="ev-card group rounded-md border border-[var(--line)] bg-[var(--panel)] p-2.5 hover:border-[var(--line-strong)]">
      <div className="flex items-center justify-between gap-2">
        <span className="ev-label flex items-center gap-1.5">
          <span aria-hidden="true" className="text-[var(--dim)]">
            {KIND_GLYPH[item.kind]}
          </span>
          {item.kind}
          {item.source === 'scheduled' ? (
            <span className="text-[var(--dim)]">· scheduled</span>
          ) : null}
        </span>
        <span
          className={`tabular-nums text-[10.5px] ${due ? 'ev-shimmer text-[var(--accent)]' : 'text-[var(--muted)]'}`}
          title={fmtDayClock(item.fire_at_iso)}
        >
          {due ? 'firing…' : `in ${countdown(remaining)}`}
        </span>
      </div>
      <p className="ev-read mt-1.5 text-[12.5px] leading-normal text-[var(--text)]">{item.text}</p>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] tabular-nums text-[var(--dim)]">
          {isToday ? fmtClock(item.fire_at_iso) : fmtDayClock(item.fire_at_iso)}
        </span>
        <button
          type="button"
          onClick={() => onCancel(item.id)}
          className="rounded px-1.5 py-0.5 text-[10px] text-[var(--dim)] hover:bg-[var(--red-dim)] hover:text-[var(--red)]"
          title="Cancel this queued item"
        >
          cancel
        </button>
      </div>
    </div>
  );
}
