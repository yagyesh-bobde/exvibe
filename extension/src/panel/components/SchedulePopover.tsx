/** Inline datetime picker that expands under a draft card's action row. */

import { useMemo, useState, type ReactElement } from 'react';
import { fmtDayClock, toDatetimeLocalValue } from '../lib/time';

interface Props {
  onConfirm: (fireAtIso: string) => void;
  onClose: () => void;
  busy: boolean;
}

const MIN_LEAD_MS = 60_000;

export default function SchedulePopover({ onConfirm, onClose, busy }: Props): ReactElement {
  const defaultValue = useMemo(() => {
    const d = new Date(Date.now() + 3_600_000);
    d.setMinutes(0, 0, 0);
    return toDatetimeLocalValue(d);
  }, []);
  const [value, setValue] = useState(defaultValue);

  const fireAt = value ? new Date(value) : null;
  const valid =
    fireAt !== null &&
    !Number.isNaN(fireAt.getTime()) &&
    fireAt.getTime() >= Date.now() + MIN_LEAD_MS;

  return (
    <div className="mt-2 rounded border border-[var(--line-strong)] bg-[var(--panel-2)] p-2.5">
      <div className="ev-label mb-1.5">schedule for</div>
      <input
        type="datetime-local"
        value={value}
        min={toDatetimeLocalValue(new Date(Date.now() + MIN_LEAD_MS))}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid && !busy) onConfirm(fireAt.toISOString());
          if (e.key === 'Escape') onClose();
        }}
        className="w-full rounded border border-[var(--line)] bg-[var(--bg)] px-2 py-1.5 text-[11px] text-[var(--text)] [color-scheme:dark]"
        autoFocus
      />
      <div className="mt-1 min-h-[14px] text-[10px] text-[var(--dim)]">
        {fireAt && !Number.isNaN(fireAt.getTime())
          ? valid
            ? fmtDayClock(fireAt.toISOString())
            : 'must be at least a minute out'
          : 'pick a time'}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => fireAt && onConfirm(fireAt.toISOString())}
          className="rounded border border-[rgba(62,207,142,0.4)] bg-[var(--accent-dim)] px-2.5 py-1 text-[10.5px] text-[var(--accent)] hover:bg-[rgba(62,207,142,0.22)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'scheduling…' : 'confirm'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-[var(--line)] px-2.5 py-1 text-[10.5px] text-[var(--muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)]"
        >
          cancel
        </button>
      </div>
    </div>
  );
}
