/**
 * Discriminated-union message contract for panel <-> background service
 * worker <-> content script communication (chrome.runtime.sendMessage /
 * chrome.tabs.sendMessage).
 */

import type { DraftKind, QueueItem } from './models';

export interface PostPayload {
  kind: DraftKind;
  text: string;
  target_id?: string;
}

/** Panel -> background: post immediately via the DOM emulation engine. */
export interface PostNowMsg {
  type: 'POST_NOW';
  payload: PostPayload;
}

/** Background -> content script: perform the human-emulated post now. */
export interface DoPostMsg {
  type: 'DO_POST';
  payload: PostPayload;
}

/** Content script -> background -> panel: outcome of a DO_POST. */
export interface PostResultMsg {
  type: 'POST_RESULT';
  ok: boolean;
  tweet_url?: string;
  error?: string;
}

/** Panel -> background: add an item to the fire-immediately-after-cadence queue. */
export interface EnqueueMsg {
  type: 'ENQUEUE';
  item: QueueItem;
}

/** Panel -> background: schedule an item for a specific fire_at_iso time. */
export interface ScheduleMsg {
  type: 'SCHEDULE';
  item: QueueItem;
}

/** Panel -> background: cancel a pending queue/scheduled item. */
export interface CancelQueueItemMsg {
  type: 'CANCEL_QUEUE_ITEM';
  id: string;
}

/** Any context -> background: liveness check. */
export interface PingMsg {
  type: 'PING';
}

/** Background -> any context: liveness reply. */
export interface PongMsg {
  type: 'PONG';
}

/** Background -> panel: queue state changed, panel should re-fetch chrome.storage. */
export interface QueueUpdatedMsg {
  type: 'QUEUE_UPDATED';
}

/** Panel -> background: request the side panel be toggled/opened for a tab. */
export interface TogglePanelMsg {
  type: 'TOGGLE_PANEL';
}

/**
 * Content script -> background: insert `text` into the currently focused
 * composer as TRUSTED input via chrome.debugger + Input.insertText. DOM
 * insertion (execCommand/paste) no-ops when the x.com tab is not the focused
 * document — which it never is when driven from the side panel — so trusted
 * CDP input is the only path that registers. Background replies with CdpAckMsg.
 */
export interface CdpInsertTextMsg {
  type: 'CDP_INSERT_TEXT';
  text: string;
}

/** Content script -> background: detach the debugger from this tab (drops the infobar). */
export interface CdpDetachMsg {
  type: 'CDP_DETACH';
}

/** Background -> content script: outcome of a CDP typing/detach request. */
export interface CdpAckMsg {
  type: 'CDP_ACK';
  ok: boolean;
  error?: string;
}

export type Msg =
  | PostNowMsg
  | DoPostMsg
  | PostResultMsg
  | EnqueueMsg
  | ScheduleMsg
  | CancelQueueItemMsg
  | PingMsg
  | PongMsg
  | QueueUpdatedMsg
  | TogglePanelMsg
  | CdpInsertTextMsg
  | CdpDetachMsg
  | CdpAckMsg;

export type MsgType = Msg['type'];

/** Send a message to the background service worker (from panel or content script). */
export function sendToBackground(msg: Msg): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

/** Send a message to the content script running in a specific tab (from background). */
export function sendToTab(tabId: number, msg: Msg): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, msg);
}
