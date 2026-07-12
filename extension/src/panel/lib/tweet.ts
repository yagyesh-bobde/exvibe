/** Tweet-text helpers: char counting thresholds and permalink URLs. */

export const TWEET_LIMIT = 280;
export const TWEET_WARN = 240;

/**
 * Code-point count (emoji-safe). Not X's weighted count (URLs = 23 etc.) —
 * close enough for drafting; X's composer is the final arbiter.
 */
export function charCount(text: string): number {
  return Array.from(text).length;
}

export type CounterTone = 'neutral' | 'warn' | 'over';

export function counterTone(count: number): CounterTone {
  if (count > TWEET_LIMIT) return 'over';
  if (count > TWEET_WARN) return 'warn';
  return 'neutral';
}

export function tweetUrl(author: string | undefined, tweetId: string): string {
  const user = author && author.length > 0 ? author.replace(/^@/, '') : 'i';
  return `https://x.com/${user}/status/${tweetId}`;
}
