/** One lane of draft cards (posts / replies / quotes) with a lane empty state. */

import type { ReactElement } from 'react';
import type { Draft, DraftKind } from '../../shared/models';
import DraftCard, { type DraftActions } from './DraftCard';

const LANE_EMPTY: Record<DraftKind, string> = {
  post: 'no post drafts left',
  reply: 'no reply drafts left',
  quote: 'no quote drafts left',
};

interface Props {
  kind: DraftKind;
  drafts: Draft[];
  actions: DraftActions;
}

export default function DraftList({ kind, drafts, actions }: Props): ReactElement {
  if (drafts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 px-4 py-14 text-center">
        <p className="text-[11px] text-[var(--muted)]">{LANE_EMPTY[kind]}</p>
        <p className="text-[10px] text-[var(--dim)]">hit refresh to draft a fresh batch</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-2.5">
      {drafts.map((draft) => (
        <DraftCard key={draft.id} draft={draft} actions={actions} />
      ))}
    </div>
  );
}
