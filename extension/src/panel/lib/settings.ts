/**
 * Tolerant fetch of GET /settings (handle + agent name). The endpoint is
 * planned but not part of the hard API contract, so failures degrade to {}.
 */

import { SERVER_BASE_URL } from '../../shared/api';

export interface PanelSettings {
  handle?: string;
  agent?: string;
}

export async function fetchPanelSettings(): Promise<PanelSettings> {
  try {
    const res = await fetch(`${SERVER_BASE_URL}/settings`, { cache: 'no-store' });
    if (!res.ok) return {};
    const json: unknown = await res.json();
    if (typeof json !== 'object' || json === null) return {};
    const o = json as Record<string, unknown>;
    return {
      handle: typeof o.handle === 'string' ? o.handle.replace(/^@/, '') : undefined,
      agent: typeof o.agent === 'string' ? o.agent : undefined,
    };
  } catch {
    return {};
  }
}
