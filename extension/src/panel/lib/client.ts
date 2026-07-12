/** Shared singleton ServerClient for the panel. */

import { SERVER_BASE_URL, ServerClient } from '../../shared/api';

export const client = new ServerClient();
export { SERVER_BASE_URL };
