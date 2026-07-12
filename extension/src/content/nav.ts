/**
 * SPA route watcher for x.com, per docs/X-DOM-BRIEF.md section 4.
 *
 * One content-script instance persists across pushState transitions, so route
 * changes must be observed. Primary signal: the Navigation API (Chrome 102+),
 * which fires on every SPA transition — including pushState — from the content
 * script's isolated world. Do NOT monkeypatch history.pushState here: the
 * isolated world gets a separate JS wrapper, so the page's calls are invisible.
 * Fallbacks: popstate + a <title> MutationObserver (title mutates on route
 * change).
 */

export type RouteHandler = (pathname: string, href: string) => void;

/** Minimal structural type for the Navigation API (not yet in this TS lib). */
interface NavigationLike {
  addEventListener(type: 'navigate', listener: () => void): void;
}

export function startRouteWatcher(onRoute: RouteHandler): void {
  let last = location.href;
  const onNav = (): void => {
    if (location.href === last) return;
    last = location.href;
    onRoute(location.pathname, location.href);
  };

  const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
  if (nav) {
    // location.href is not yet updated when 'navigate' fires — check after.
    nav.addEventListener('navigate', () => queueMicrotask(onNav));
  } else {
    console.warn('[exvibe] Navigation API unavailable — relying on popstate/title fallbacks');
  }

  window.addEventListener('popstate', onNav);

  // Belt-and-suspenders: the document title mutates on every route change.
  const title = document.querySelector('title');
  const observer = new MutationObserver(onNav);
  if (title) observer.observe(title, { childList: true });
  else if (document.head) observer.observe(document.head, { childList: true, subtree: true });
}
