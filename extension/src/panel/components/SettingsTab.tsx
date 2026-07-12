/**
 * Settings tab: detected identity, panel shortcut (with rebind pointer), and
 * the voice-agent editor bound to GET/POST /agent.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { AgentResponse } from '../../shared/api';
import { client } from '../lib/client';
import { hasChromeRuntime } from '../lib/queue';
import type { PanelSettings } from '../lib/settings';
import { useToast } from './Toast';

const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|\s*$)/;

interface Props {
  settings: PanelSettings;
  serverUp: boolean;
}

export default function SettingsTab({ settings, serverUp }: Props): ReactElement {
  const { toast } = useToast();
  const [agent, setAgent] = useState<AgentResponse | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [shortcut, setShortcut] = useState('⌘⇧Y');

  const loadAgent = useCallback(async () => {
    try {
      const res = await client.getAgent();
      setAgent(res);
      setContent(res.content);
      setAgentError(null);
    } catch {
      setAgentError('could not load the voice agent — is the server up?');
    }
  }, []);

  useEffect(() => {
    void loadAgent();
  }, [loadAgent, serverUp]);

  useEffect(() => {
    if (!hasChromeRuntime() || !chrome.commands?.getAll) return;
    chrome.commands.getAll((commands) => {
      const cmd = commands.find((c) => c.name === 'toggle-panel');
      if (cmd?.shortcut) setShortcut(cmd.shortcut);
    });
  }, []);

  const dirty = agent !== null && content !== agent.content;
  const hasFrontMatter = FRONT_MATTER_RE.test(content);
  const byteCount = useMemo(() => new TextEncoder().encode(content).length, [content]);
  const canSave = dirty && hasFrontMatter && !saving && serverUp;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await client.saveAgent({ content });
      toast('success', 'voice agent saved');
      await loadAgent();
    } catch {
      toast('error', 'saving the voice agent failed');
    } finally {
      setSaving(false);
    }
  };

  const agentName = settings.agent ?? agent?.path.split('/').pop()?.replace(/\.md$/, '');

  return (
    <div className="flex flex-col gap-4 p-3">
      <section>
        <h2 className="ev-label mb-2">identity</h2>
        <dl className="flex flex-col gap-1.5 rounded-md border border-[var(--line)] bg-[var(--panel)] p-3">
          <InfoRow label="x handle" value={settings.handle ? `@${settings.handle}` : 'not detected'} />
          <InfoRow label="voice agent" value={agentName ?? 'not detected'} />
          <InfoRow label="server" value={serverUp ? '127.0.0.1:7878 · up' : 'offline'} />
        </dl>
      </section>

      <section>
        <h2 className="ev-label mb-2">shortcut</h2>
        <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--line)] bg-[var(--panel)] p-3">
          <div className="min-w-0">
            <div className="text-[11px] text-[var(--text)]">toggle this panel</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-[var(--dim)]">
              rebind at chrome://extensions/shortcuts — ⌘L is reserved by Chrome
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <kbd className="rounded border border-[var(--line-strong)] bg-[var(--panel-2)] px-2 py-1 text-[11px] text-[var(--text)]">
              {shortcut}
            </kbd>
            {hasChromeRuntime() ? (
              <button
                type="button"
                onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
                className="rounded border border-[var(--line)] px-2 py-1 text-[10px] text-[var(--muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)]"
              >
                rebind
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="ev-label">voice agent</h2>
          <span className="text-[10px] tabular-nums text-[var(--dim)]">
            {byteCount.toLocaleString()} bytes
            {dirty ? <span className="ml-1.5 text-[var(--amber)]">unsaved</span> : null}
          </span>
        </div>

        {agentError ? (
          <div className="rounded-md border border-[var(--line)] bg-[var(--panel)] p-3 text-[11px] text-[var(--muted)]">
            {agentError}
          </div>
        ) : (
          <>
            {agent ? (
              <div className="mb-1.5 truncate text-[10px] text-[var(--dim)]" title={agent.path}>
                {agent.path}
              </div>
            ) : null}
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={agent === null || saving}
              rows={16}
              spellCheck={false}
              className="w-full resize-y rounded-md border border-[var(--line)] bg-[var(--panel)] p-3 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--text)] placeholder:text-[var(--dim)] focus:border-[var(--line-strong)] disabled:opacity-50"
              placeholder={agent === null ? 'loading…' : ''}
              aria-label="voice agent markdown"
            />
            {!hasFrontMatter && content.length > 0 ? (
              <p className="mt-1 text-[10px] text-[var(--red)]">
                YAML front matter required: the file must start with a --- … --- block
              </p>
            ) : null}
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                disabled={!canSave}
                onClick={() => void save()}
                className="rounded border border-[rgba(62,207,142,0.4)] bg-[var(--accent-dim)] px-3 py-1.5 text-[10.5px] text-[var(--accent)] hover:bg-[rgba(62,207,142,0.22)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? 'saving…' : 'save'}
              </button>
              <button
                type="button"
                disabled={!dirty || saving}
                onClick={() => agent && setContent(agent.content)}
                className="rounded border border-[var(--line)] px-3 py-1.5 text-[10.5px] text-[var(--muted)] hover:border-[var(--line-strong)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                discard changes
              </button>
            </div>
          </>
        )}
      </section>

      <p className="px-0.5 pb-2 text-center text-[9.5px] text-[var(--dim)]">
        tabs: 1–5 · post from editor: ⌘⏎
      </p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="ev-label shrink-0">{label}</dt>
      <dd className="truncate text-[11px] text-[var(--text)]" title={value}>
        {value}
      </dd>
    </div>
  );
}
