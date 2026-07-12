/**
 * Server-side mirror of extension/src/shared/models.ts.
 *
 * Kept as a manual copy (no cross-package import — extension and server ship
 * independently) since the shapes are the wire contract in
 * docs/DASHBOARD-SPEC.md. Keep these two files in sync by hand.
 */

export type DraftKind = 'post' | 'reply' | 'quote';

export interface Draft {
  id: string;
  kind: DraftKind;
  text: string;
  template?: string;
  target_id?: string;
  target_author?: string;
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

export type FeedbackAction = 'discard' | 'mark_posted' | 'like' | 'post';

export interface FeedbackEvent {
  kind: DraftKind;
  action: FeedbackAction;
  original_text: string;
  final_text: string;
  target_author?: string;
  target_text?: string;
  created_at: string;
}

export interface VoiceState {
  gold: string[];
  anti: string[];
  rules: string[];
}
