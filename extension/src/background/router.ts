/**
 * chrome.runtime.onMessage hub for the background service worker.
 * Routes panel messages: POST_NOW -> poster, ENQUEUE/SCHEDULE/CANCEL/LIST ->
 * scheduler. Async handlers return true to keep sendResponse alive.
 */

import type { CdpAckMsg, Msg, PostResultMsg } from '../shared/messages';
import type { QueueItem } from '../shared/models';
import { cdpDetach, cdpInsertText } from './cdp';
import { postNow } from './poster';
import { cancel, enqueue, listPending, listQueue, schedule } from './scheduler';

/** Panel -> background: list queue items (all statuses, or pending only). */
interface ListQueueMsg {
  type: 'LIST_QUEUE';
  pending_only?: boolean;
}

type RouterMsg = Msg | ListQueueMsg;

export interface QueueOpResponse {
  ok: boolean;
  item?: QueueItem;
  items?: QueueItem[];
  error?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failedResult(err: unknown): PostResultMsg {
  return { type: 'POST_RESULT', ok: false, error: errorMessage(err) };
}

chrome.runtime.onMessage.addListener(
  (message: RouterMsg, sender, sendResponse: (response: unknown) => void) => {
    switch (message.type) {
      case 'PING': {
        const pong: Msg = { type: 'PONG' };
        sendResponse(pong);
        return false;
      }

      case 'CDP_INSERT_TEXT': {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
          sendResponse({ type: 'CDP_ACK', ok: false, error: 'no sender tab' } satisfies CdpAckMsg);
          return false;
        }
        cdpInsertText(tabId, message.text).then(
          () => sendResponse({ type: 'CDP_ACK', ok: true } satisfies CdpAckMsg),
          (err: unknown) =>
            sendResponse({ type: 'CDP_ACK', ok: false, error: errorMessage(err) } satisfies CdpAckMsg),
        );
        return true;
      }

      case 'CDP_DETACH': {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
          sendResponse({ type: 'CDP_ACK', ok: true } satisfies CdpAckMsg);
          return false;
        }
        cdpDetach(tabId).then(
          () => sendResponse({ type: 'CDP_ACK', ok: true } satisfies CdpAckMsg),
          () => sendResponse({ type: 'CDP_ACK', ok: true } satisfies CdpAckMsg),
        );
        return true;
      }

      case 'POST_NOW': {
        postNow(message.payload, 'manual').then(sendResponse, (err: unknown) =>
          sendResponse(failedResult(err)),
        );
        return true;
      }

      case 'ENQUEUE': {
        enqueue(message.item).then(
          (item) => sendResponse({ ok: true, item } satisfies QueueOpResponse),
          (err: unknown) =>
            sendResponse({ ok: false, error: errorMessage(err) } satisfies QueueOpResponse),
        );
        return true;
      }

      case 'SCHEDULE': {
        schedule(message.item, message.item.fire_at_iso).then(
          (item) => sendResponse({ ok: true, item } satisfies QueueOpResponse),
          (err: unknown) =>
            sendResponse({ ok: false, error: errorMessage(err) } satisfies QueueOpResponse),
        );
        return true;
      }

      case 'CANCEL_QUEUE_ITEM': {
        cancel(message.id).then(
          (ok) =>
            sendResponse(
              (ok
                ? { ok: true }
                : { ok: false, error: 'item not found or not pending' }) satisfies QueueOpResponse,
            ),
          (err: unknown) =>
            sendResponse({ ok: false, error: errorMessage(err) } satisfies QueueOpResponse),
        );
        return true;
      }

      case 'LIST_QUEUE': {
        const list = message.pending_only ? listPending() : listQueue();
        list.then(
          (items) => sendResponse({ ok: true, items } satisfies QueueOpResponse),
          (err: unknown) =>
            sendResponse({ ok: false, error: errorMessage(err) } satisfies QueueOpResponse),
        );
        return true;
      }

      default:
        // DO_POST / POST_RESULT / QUEUE_UPDATED etc. are not addressed to the
        // background router; let other listeners (or nobody) handle them.
        return false;
    }
  },
);
