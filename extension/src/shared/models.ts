/**
 * Shared data model contracts for exvibe.
 *
 * These types are used across the panel, background service worker, content
 * script, and the server's JSON payloads. Keep this file the single source of
 * truth for shape — server/src/types.ts mirrors it manually (no cross-package
 * import between extension and server).
 */

export type DraftKind = 'post' | 'reply' | 'quote';

export interface Draft {
  id: string;
  kind: DraftKind;
  text: string;
  /** Post-lane template name (posts only), e.g. "hook", "thread-starter". */
  template?: string;
  /** Reply/quote target tweet id. */
  target_id?: string;
  /** Reply/quote target author handle (no @). */
  target_author?: string;
  /** Reply/quote target tweet text, for preview. */
  target_text?: string;
}

export interface DraftBundle {
  posts: Draft[];
  replies: Draft[];
  quotes: Draft[];
  generated_at: string;
}

export interface Signature {
  top_keywords: string[];
  top_accounts: string[];
  bookmark_authors: string[];
  fav_authors: string[];
  sample_size: number;
}

export interface FeedCard {
  id: string;
  author: string;
  text: string;
  likes: number;
  retweets: number;
  replies: number;
  url: string;
  score?: number;
}

export type QueueItemStatus = 'pending' | 'fired' | 'failed' | 'cancelled';
export type QueueItemSource = 'queue' | 'manual' | 'scheduled';

export interface QueueItem {
  id: string;
  kind: DraftKind;
  text: string;
  target_id?: string;
  fire_at_iso: string;
  created_at: string;
  status: QueueItemStatus;
  source: QueueItemSource;
  fired_at?: string;
  result?: string;
  error?: string;
}

export interface PostedItem {
  id: string;
  posted_at: string;
  kind: DraftKind;
  text: string;
  target_id?: string;
  tweet_id?: string;
  tweet_url?: string;
  source: string;
}

export type FeedbackAction = 'discard' | 'mark_posted' | 'like' | 'post';

export interface VoiceState {
  gold: string[];
  anti: string[];
  rules: string[];
}
