/**
 * Typed client for the exvibe local companion server.
 * See docs/DASHBOARD-SPEC.md "Server API" for the source contract.
 */

import type {
  Draft,
  DraftBundle,
  DraftKind,
  FeedbackAction,
  FeedCard,
  Signature,
  VoiceState,
} from './models';

export const DEFAULT_SERVER_PORT = 7878;
export const SERVER_BASE_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

export interface HealthResponse {
  ok: boolean;
  now: string;
}

export type DataResponse = DraftBundle | { empty: true; message: string };

export type FeedKind = 'for-you' | 'trending';

export interface FeedResponse {
  kind: FeedKind;
  page: number;
  cards: FeedCard[];
}

export interface RegenerateRequest {
  kind: DraftKind;
  id: string;
  feedback: string;
}

export interface RemoveDraftRequest {
  kind: DraftKind;
  id: string;
}

export interface FeedbackRequest {
  kind: DraftKind;
  action: FeedbackAction;
  original_text: string;
  final_text: string;
  target_author?: string;
  target_text?: string;
}

export interface EvalRun {
  id: string;
  created_at: string;
  summary: string;
  voice_changed: boolean;
}

export interface EvalsResponse {
  runs: EvalRun[];
  summary: string;
  state: VoiceState;
}

export interface RunEvalResponse {
  run: EvalRun;
  voice_changed: boolean;
}

export interface RevertEvalRequest {
  id: string;
}

export interface AnalyticsResponse {
  generated_at: string;
  insights: string[];
  [key: string]: unknown;
}

export interface AgentResponse {
  path: string;
  content: string;
  mtime: string;
  profiles: string[];
}

export interface SaveAgentRequest {
  content: string;
}

export interface StudyAgentRequest {
  username: string;
}

export interface StudyAgentResponse {
  ok: boolean;
  content: string;
}

export class ServerClient {
  constructor(private readonly baseUrl: string = SERVER_BASE_URL) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`exvibe server ${path} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/healthz');
  }

  getData(): Promise<DataResponse> {
    return this.request<DataResponse>('/data');
  }

  refresh(): Promise<DataResponse> {
    return this.request<DataResponse>('/refresh', { method: 'POST' });
  }

  getSignature(): Promise<Signature> {
    return this.request<Signature>('/signature');
  }

  getFeed(kind: FeedKind, page = 0): Promise<FeedResponse> {
    return this.request<FeedResponse>(`/feed?kind=${kind}&page=${page}`);
  }

  regenerate(req: RegenerateRequest): Promise<Draft> {
    return this.request<Draft>('/draft/regenerate', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  removeDraft(req: RemoveDraftRequest): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/draft/remove', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  feedback(req: FeedbackRequest): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/feedback', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  getEvals(): Promise<EvalsResponse> {
    return this.request<EvalsResponse>('/evals');
  }

  runEval(): Promise<RunEvalResponse> {
    return this.request<RunEvalResponse>('/eval/run', { method: 'POST', body: '{}' });
  }

  revertEval(req: RevertEvalRequest): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/evals/revert', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  getAnalytics(): Promise<AnalyticsResponse> {
    return this.request<AnalyticsResponse>('/analytics');
  }

  runAnalytics(): Promise<AnalyticsResponse> {
    return this.request<AnalyticsResponse>('/analytics/run', { method: 'POST' });
  }

  getAgent(): Promise<AgentResponse> {
    return this.request<AgentResponse>('/agent');
  }

  saveAgent(req: SaveAgentRequest): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>('/agent', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  studyAgent(req: StudyAgentRequest): Promise<StudyAgentResponse> {
    return this.request<StudyAgentResponse>('/agent/study', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }
}
