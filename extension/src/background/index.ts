/**
 * Background service worker entry point.
 *
 * Importing router + scheduler at top level registers their listeners on every
 * service-worker wake (MV3 requirement — listeners must be registered
 * synchronously in the first event-loop turn).
 */

import './router';
import './scheduler';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.commands.onCommand.addListener((command, tab) => {
  // onCommand IS a user gesture — sidePanel.open must be called synchronously,
  // with no await before it, or the gesture is consumed and it silently fails.
  if (command === 'toggle-panel' && tab?.id !== undefined) {
    void chrome.sidePanel.open({ tabId: tab.id });
  }
});
