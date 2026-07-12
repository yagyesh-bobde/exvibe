/**
 * X (twitter.com/x.com) DOM selector map, kept in one hot-patchable module
 * per docs/X-DOM-BRIEF.md section 1 & "Uncertainty flags". If X ships a DOM
 * change, update this object only — don't scatter selector strings through
 * the content script.
 */

export const X_SELECTORS = {
  /** Compose textarea (contenteditable leaf). Index increments per thread item. */
  tweetTextareaPrefix: '[data-testid^="tweetTextarea_"]',
  /** Post button inside a modal/dialog composer (full-screen composer, reply dialog). */
  tweetButton: '[data-testid="tweetButton"]',
  /** Post button for inline composers (home top box, permalink reply box). */
  tweetButtonInline: '[data-testid="tweetButtonInline"]',
  /** Reply button on a tweet card; opens the reply composer. */
  reply: '[data-testid="reply"]',
  /** Post-sent confirmation toast. */
  toast: '[data-testid="toast"]',
  /** Composer toolbar (media/gif/poll/emoji). */
  toolBar: '[data-testid="toolBar"]',
  /** Left-rail "new post" nav button. */
  sideNavNewTweetButton: '[data-testid="SideNav_NewTweet_Button"]',
} as const;

export type XSelectorKey = keyof typeof X_SELECTORS;
