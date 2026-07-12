import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'exvibe',
  description: 'X growth cockpit — human-emulated posting, replying, and voice-learned drafts.',
  version: '0.1.0',
  permissions: ['sidePanel', 'tabs', 'scripting', 'alarms', 'storage', 'debugger'],
  host_permissions: [
    'https://x.com/*',
    'https://twitter.com/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
  ],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'panel.html',
  },
  action: {
    default_title: 'exvibe — open composer',
  },
  content_scripts: [
    {
      matches: ['https://x.com/*', 'https://twitter.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  commands: {
    'toggle-panel': {
      suggested_key: {
        default: 'Ctrl+Shift+Y',
        mac: 'Command+Shift+Y',
      },
      description: 'Open exvibe side panel',
    },
  },
});
