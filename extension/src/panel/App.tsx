/**
 * exvibe side panel root: tabbed cockpit (Posts / Replies / Quotes / Queue /
 * Settings) over the local companion server + the extension scheduler.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { DataResponse } from '../shared/api';
import { sendToBackground } from '../shared/messages';
import type { Draft, DraftBundle, DraftKind, QueueItem } from '../shared/models';
import './panel.css';

import DraftList from './components/DraftList';
import QueueTab from './components/QueueTab';
import SettingsTab from './components/SettingsTab';
import TabBar, { TAB_ORDER, type TabId } from './components/TabBar';
import { ToastProvider, useToast } from './components/Toast';
import TopBar, { type ServerStatus } from './components/TopBar';
import type { DraftActions } from './components/DraftCard';

import { client } from './lib/client';
import { hasChromeRuntime, nextQueueSlot, readQueue, subscribeQueue } from './lib/queue';
import { fetchPanelSettings, type PanelSettings } from './lib/settings';
import { fmtClock, fmtDayClock } from './lib/time';

export default function App(): ReactElement {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

type DataState =
  | { kind: 'loading' }
  | { kind: 'empty'; message: string }
  | { kind: 'ready'; bundle: DraftBundle };

const LANE: Record<DraftKind, keyof Pick<DraftBundle, 'posts' | 'replies' | 'quotes'>> = {
  post: 'posts',
  reply: 'replies',
  quote: 'quotes',
};

function isPostResult(v: unknown): v is { ok: boolean; tweet_url?: string; error?: string } {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).ok === 'boolean';
}

function Shell(): ReactElement {
  const { toast } = useToast();

  const [status, setStatus] = useState<ServerStatus>('checking');
  const [data, setData] = useState<DataState>({ kind: 'loading' });
  const [tab, setTab] = useState<TabId>('posts');
  const [refreshing, setRefreshing] = useState(false);
  const [overlayShown, setOverlayShown] = useState(false);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [settings, setSettings] = useState<PanelSettings>({});
  const dataLoadedRef = useRef(false);

  const applyData = useCallback((res: DataResponse) => {
    if ('empty' in res && res.empty) {
      setData({ kind: 'empty', message: res.message });
    } else {
      setData({ kind: 'ready', bundle: res as DraftBundle });
    }
  }, []);

  // --- server health polling -------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        await client.health();
        if (!cancelled) setStatus('up');
      } catch {
        if (!cancelled) {
          setStatus('down');
          dataLoadedRef.current = false;
        }
      }
    };
    void check();
    const id = window.setInterval(() => void check(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // --- initial / reconnect data load -----------------------------------
  useEffect(() => {
    if (status !== 'up' || dataLoadedRef.current) return;
    dataLoadedRef.current = true;
    void client
      .getData()
      .then(applyData)
      .catch(() => setData({ kind: 'empty', message: 'could not load drafts' }));
    void fetchPanelSettings().then(setSettings);
  }, [status, applyData]);

  // --- queue: read + subscribe -----------------------------------------
  useEffect(() => {
    const load = (): void => {
      void readQueue().then(setQueueItems);
    };
    load();
    return subscribeQueue(load);
  }, []);

  // --- keyboard: 1-5 switches tabs --------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const idx = Number.parseInt(e.key, 10) - 1;
      const next = idx >= 0 && idx < TAB_ORDER.length ? TAB_ORDER[idx] : undefined;
      if (next) setTab(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- refresh -----------------------------------------------------------
  const doRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    setOverlayShown(true);
    client
      .refresh()
      .then((res) => {
        applyData(res);
        toast('success', 'drafts refreshed');
      })
      .catch(() => toast('error', 'refresh failed — check the server logs'))
      .finally(() => {
        setRefreshing(false);
        setOverlayShown(false);
      });
  }, [refreshing, applyData, toast]);

  // --- local draft-state helpers ----------------------------------------
  const removeDraftLocal = useCallback((kind: DraftKind, id: string) => {
    setData((prev) => {
      if (prev.kind !== 'ready') return prev;
      const lane = LANE[kind];
      return {
        kind: 'ready',
        bundle: { ...prev.bundle, [lane]: prev.bundle[lane].filter((d) => d.id !== id) },
      };
    });
  }, []);

  const swapDraftLocal = useCallback((kind: DraftKind, oldId: string, fresh: Draft) => {
    setData((prev) => {
      if (prev.kind !== 'ready') return prev;
      const lane = LANE[kind];
      return {
        kind: 'ready',
        bundle: {
          ...prev.bundle,
          [lane]: prev.bundle[lane].map((d) => (d.id === oldId ? fresh : d)),
        },
      };
    });
  }, []);

  const removeFromServer = useCallback(
    (draft: Draft) => {
      void client.removeDraft({ kind: draft.kind, id: draft.id }).catch(() => {
        toast('error', 'server did not confirm the draft removal');
      });
    },
    [toast],
  );

  // --- draft actions ------------------------------------------------------
  const actions: DraftActions = {
    postNow: async (draft, text) => {
      if (!hasChromeRuntime()) {
        toast('error', 'extension runtime unavailable');
        return false;
      }
      let res: unknown;
      try {
        res = await sendToBackground({
          type: 'POST_NOW',
          payload: { kind: draft.kind, text, target_id: draft.target_id },
        });
      } catch {
        toast('error', 'no reply from the service worker');
        return false;
      }
      if (isPostResult(res) && res.ok) {
        removeFromServer(draft);
        removeDraftLocal(draft.kind, draft.id);
        toast('success', res.tweet_url ? `posted — ${res.tweet_url}` : 'posted to x');
        return true;
      }
      const error = isPostResult(res) ? res.error : undefined;
      toast('error', error ?? 'posting failed — is an x.com tab open?');
      return false;
    },

    queue: async (draft, text) => {
      const fireAt = nextQueueSlot(queueItems);
      const item: QueueItem = {
        id: crypto.randomUUID(),
        kind: draft.kind,
        text,
        target_id: draft.target_id,
        fire_at_iso: fireAt.toISOString(),
        created_at: new Date().toISOString(),
        status: 'pending',
        source: 'queue',
      };
      try {
        await sendToBackground({ type: 'ENQUEUE', item });
      } catch {
        toast('error', 'could not reach the scheduler');
        return false;
      }
      setQueueItems((prev) => [...prev, item]);
      removeFromServer(draft);
      removeDraftLocal(draft.kind, draft.id);
      toast('success', `queued for ${fmtClock(item.fire_at_iso)}`);
      return true;
    },

    schedule: async (draft, text, fireAtIso) => {
      const item: QueueItem = {
        id: crypto.randomUUID(),
        kind: draft.kind,
        text,
        target_id: draft.target_id,
        fire_at_iso: fireAtIso,
        created_at: new Date().toISOString(),
        status: 'pending',
        source: 'scheduled',
      };
      try {
        await sendToBackground({ type: 'SCHEDULE', item });
      } catch {
        toast('error', 'could not reach the scheduler');
        return false;
      }
      setQueueItems((prev) => [...prev, item]);
      removeFromServer(draft);
      removeDraftLocal(draft.kind, draft.id);
      toast('success', `scheduled for ${fmtDayClock(fireAtIso)}`);
      return true;
    },

    regenerate: async (draft, feedback) => {
      try {
        const fresh = await client.regenerate({ kind: draft.kind, id: draft.id, feedback });
        swapDraftLocal(draft.kind, draft.id, fresh);
        toast('success', 'draft regenerated');
      } catch {
        toast('error', 'regenerate failed');
      }
      return false;
    },

    like: async (draft, text) => {
      try {
        await client.feedback({
          kind: draft.kind,
          action: 'like',
          original_text: draft.text,
          final_text: text,
          target_author: draft.target_author,
          target_text: draft.target_text,
        });
        toast('success', 'liked — voice noted');
        return true;
      } catch {
        toast('error', 'like failed — server unreachable?');
        return false;
      }
    },

    markPosted: async (draft, text) => {
      removeDraftLocal(draft.kind, draft.id);
      toast('success', 'marked as posted');
      void client
        .feedback({
          kind: draft.kind,
          action: 'mark_posted',
          original_text: draft.text,
          final_text: text,
          target_author: draft.target_author,
          target_text: draft.target_text,
        })
        .catch(() => toast('error', 'mark-posted feedback did not reach the server'));
      removeFromServer(draft);
      return true;
    },

    discard: async (draft, text) => {
      removeDraftLocal(draft.kind, draft.id);
      toast('info', 'discarded');
      void client
        .feedback({
          kind: draft.kind,
          action: 'discard',
          original_text: draft.text,
          final_text: text,
          target_author: draft.target_author,
          target_text: draft.target_text,
        })
        .catch(() => toast('error', 'discard feedback did not reach the server'));
      removeFromServer(draft);
      return true;
    },
  };

  const cancelQueueItem = useCallback(
    (id: string) => {
      setQueueItems((prev) => prev.filter((i) => i.id !== id));
      void (async () => {
        try {
          await sendToBackground({ type: 'CANCEL_QUEUE_ITEM', id });
          toast('info', 'cancelled');
        } catch {
          toast('error', 'could not reach the scheduler');
          setQueueItems(await readQueue());
        }
      })();
    },
    [toast],
  );

  // --- render --------------------------------------------------------------
  const bundle = data.kind === 'ready' ? data.bundle : null;
  const pendingCount = queueItems.filter((i) => i.status === 'pending').length;
  const counts: Partial<Record<TabId, number>> = {
    posts: bundle?.posts.length,
    replies: bundle?.replies.length,
    quotes: bundle?.quotes.length,
    queue: pendingCount,
  };

  return (
    <div className="ev-atmosphere flex h-screen w-full flex-col overflow-hidden">
      <TopBar
        handle={settings.handle}
        status={status}
        refreshing={refreshing}
        onRefresh={doRefresh}
      />

      {status === 'down' ? (
        <div className="border-y border-[rgba(240,86,74,0.3)] bg-[var(--red-dim)] px-3 py-2 text-[10.5px] leading-relaxed text-[#f2a49e]">
          can't reach the exvibe server — start it and this panel will reconnect
        </div>
      ) : null}

      <TabBar active={tab} counts={counts} onSelect={setTab} />

      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'queue' ? (
          <QueueTab items={queueItems} onCancel={cancelQueueItem} />
        ) : tab === 'settings' ? (
          <SettingsTab settings={settings} serverUp={status === 'up'} />
        ) : data.kind === 'loading' ? (
          <LoadingState serverDown={status === 'down'} />
        ) : data.kind === 'empty' ? (
          <EmptyState
            message={data.message}
            canRefresh={status === 'up' && !refreshing}
            onRefresh={doRefresh}
          />
        ) : (
          <DraftList
            kind={tab === 'posts' ? 'post' : tab === 'replies' ? 'reply' : 'quote'}
            drafts={
              tab === 'posts'
                ? data.bundle.posts
                : tab === 'replies'
                  ? data.bundle.replies
                  : data.bundle.quotes
            }
            actions={actions}
          />
        )}
      </main>

      {refreshing && overlayShown ? <RefreshOverlay onHide={() => setOverlayShown(false)} /> : null}
    </div>
  );
}

function LoadingState({ serverDown }: { serverDown: boolean }): ReactElement {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
      {serverDown ? (
        <p className="text-[11px] text-[var(--muted)]">waiting for the server…</p>
      ) : (
        <>
          <span className="inline-block h-4 w-4 rounded-full border border-[var(--accent)] border-t-transparent ev-spin" />
          <p className="text-[11px] text-[var(--muted)]">loading drafts…</p>
        </>
      )}
    </div>
  );
}

function EmptyState({
  message,
  canRefresh,
  onRefresh,
}: {
  message: string;
  canRefresh: boolean;
  onRefresh: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span aria-hidden="true" className="text-lg text-[var(--dim)]">
        ⌁
      </span>
      <p className="max-w-[26ch] text-[11.5px] leading-relaxed text-[var(--muted)]">{message}</p>
      <button
        type="button"
        disabled={!canRefresh}
        onClick={onRefresh}
        className="rounded border border-[rgba(62,207,142,0.4)] bg-[var(--accent-dim)] px-4 py-1.5 text-[11px] text-[var(--accent)] hover:bg-[rgba(62,207,142,0.22)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        refresh — read your signal &amp; draft
      </button>
    </div>
  );
}

function RefreshOverlay({ onHide }: { onHide: () => void }): ReactElement {
  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-[rgba(10,12,15,0.88)] px-6 text-center backdrop-blur-[2px]">
      <span className="inline-block h-5 w-5 rounded-full border-2 border-[var(--accent)] border-t-transparent ev-spin" />
      <p className="ev-label">rebuilding drafts</p>
      <p className="max-w-[30ch] text-[10.5px] leading-relaxed text-[var(--muted)]">
        reading your bookmarks, likes and feed, then drafting in your voice — this can take a few
        minutes
      </p>
      <button
        type="button"
        onClick={onHide}
        className="mt-1 rounded border border-[var(--line)] px-3 py-1 text-[10px] text-[var(--muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)]"
      >
        hide — keep working
      </button>
    </div>
  );
}
