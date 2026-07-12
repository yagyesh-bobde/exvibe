/**
 * Low-level DOM helpers for the x.com human-emulation engine.
 * waitFor / waitForGone via MutationObserver per docs/X-DOM-BRIEF.md section 4.
 */

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Random float in [min, max) — used for human-cadence jitter. */
export const rand = (min: number, max: number): number =>
  min + Math.random() * (max - min);

/**
 * Selector-health logging (X-DOM-BRIEF "Uncertainty flags"): X ships DOM
 * changes without notice, so every selector miss must be loud and traceable
 * back to the hot-patchable map in src/shared/selectors.ts.
 */
export function selectorMiss(selector: string, context: string): void {
  console.warn(
    `[exvibe] selector-health: expected "${selector}" is missing (${context}). ` +
      'X may have changed its DOM — check/update src/shared/selectors.ts.',
  );
}

/**
 * Resolve with the first element matching `selector`, observing DOM mutations
 * until it appears. Rejects (and logs a selector-health warning) on timeout.
 */
export function waitFor(selector: string, timeoutMs = 10_000): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLElement>(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
    });
    timer = setTimeout(() => {
      observer.disconnect();
      selectorMiss(selector, `waitFor timed out after ${timeoutMs}ms`);
      reject(new Error(`timeout waiting for ${selector}`));
    }, timeoutMs);
  });
}

/**
 * Resolve `true` once no element matches `selector`; resolve `false` if it is
 * still present when the timeout elapses (never rejects — callers decide what
 * a lingering element means).
 */
export function waitForGone(selector: string, timeoutMs = 8_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!document.querySelector(selector)) {
      resolve(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => {
      if (!document.querySelector(selector)) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(true);
      }
    });
    observer.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
    });
    timer = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeoutMs);
  });
}
