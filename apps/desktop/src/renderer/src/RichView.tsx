import { useEffect, useMemo, useRef, useState } from 'react';
import type { RichEnvelope, RichEvent, SessionInfo } from '@jarvis/protocol';
import { rpc } from './store';

/** One line describing a tool call, like the Activity tab. */
function toolLine(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const one = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 220);
  if (tool === 'Bash') return one(str(i.command));
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return str(i.file_path) || str(i.notebook_path);
  if (tool === 'Grep' || tool === 'Glob') return `${str(i.pattern)}${i.path ? `  in ${str(i.path)}` : ''}`;
  if (tool === 'Agent' || tool === 'Task') return one(str(i.description) || str(i.prompt));
  if (tool === 'WebFetch') return str(i.url);
  if (tool === 'WebSearch') return str(i.query);
  return one(JSON.stringify(input ?? {}));
}

function authLabel(src: string | null): string | null {
  if (!src) return null;
  if (src === 'none' || src === 'oauth' || src === '/login managed key') return 'your Claude plan';
  if (src === 'ANTHROPIC_API_KEY') return 'API key';
  return src;
}

type Ev<K extends RichEvent['kind']> = Extract<RichEvent, { kind: K }>;

/**
 * A rich session, drawn by Jarvis from SDK events (R0: plain text). The conversation lives in the
 * session's host process and Claude's transcript; this view only renders and sends.
 */
export function RichView({ session, visible }: { session: SessionInfo; visible: boolean }) {
  const [events, setEvents] = useState<RichEnvelope[]>([]);
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const connected = !!session.rich?.connected;
  const hostPid = session.rich?.hostPid ?? null;

  useEffect(() => {
    let live = true;
    void rpc<{ events: RichEnvelope[] }>('rich.history', { id: session.id })
      .then((r) => live && setEvents(r.events))
      .catch(() => {});
    const off = window.jarvis.onRichEvent(({ sessionId, envelope }) => {
      if (sessionId !== session.id) return;
      setEvents((ev) => {
        const last = ev.at(-1)?.seq ?? 0;
        if (envelope.seq === 1) return [envelope]; // a new host (revive) starts its log over
        return envelope.seq > last ? [...ev, envelope] : ev;
      });
    });
    return () => {
      live = false;
      off();
    };
  }, [session.id, hostPid]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => input.current?.focus());
  }, [visible]);

  useEffect(() => {
    const onQuote = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; text: string }>).detail;
      if (d.id !== session.id) return;
      setDraft((cur) => `${d.text}${cur}`);
      window.getSelection()?.removeAllRanges();
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener('jarvis:quote', onQuote);
    return () => window.removeEventListener('jarvis:quote', onQuote);
  }, [session.id]);

  const { ends, resolved } = useMemo(() => {
    const ends = new Map<string, Ev<'tool_end'>>();
    const resolved = new Map<string, 'allow' | 'deny'>();
    for (const { event: e } of events) {
      if (e.kind === 'tool_end') ends.set(e.toolUseId, e);
      else if (e.kind === 'permission_resolved') resolved.set(e.requestId, e.behavior);
    }
    return { ends, resolved };
  }, [events]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !connected) return;
    setDraft('');
    stick.current = true;
    await rpc('rich.send', { id: session.id, text }).catch(() => setDraft(text));
  };
  const respond = (requestId: string, behavior: 'allow' | 'deny') =>
    void rpc('rich.respond', { id: session.id, requestId, behavior }).catch(() => {});
  const working = session.agentState?.phase === 'working';

  let lastStatus = '';
  const rows = events.map(({ seq, event: e, replay }) => {
    const key = `${seq}`;
    const sub = 'parentToolUseId' in e && e.parentToolUseId ? ' rv-sub' : '';
    switch (e.kind) {
      case 'user':
        return <div key={key} className={`rv-user${replay ? ' replay' : ''}`}><span className="rv-caret">›</span>{e.text}</div>;
      case 'text':
        return <div key={key} className={`rv-text${sub}`}>{e.text}</div>;
      case 'thinking':
        return (
          <details key={key} className={`rv-thinking${sub}`}>
            <summary>Thinking</summary>
            <div>{e.text}</div>
          </details>
        );
      case 'tool_start': {
        const end = ends.get(e.toolUseId);
        const state = !end ? 'running' : end.isError ? 'error' : 'ok';
        return (
          <details key={key} className={`rv-tool ${state}${sub}`} open={state === 'error'}>
            <summary>
              <span className="rv-dot">{state === 'running' ? '◌' : state === 'error' ? '✗' : '⏺'}</span>
              <span className="rv-tool-name">{e.tool}</span>
              <span className="rv-tool-arg">{toolLine(e.tool, e.input)}</span>
            </summary>
            <pre className="rv-io">{JSON.stringify(e.input, null, 2)}</pre>
            {end && <pre className={`rv-io out${end.isError ? ' err' : ''}`}>{end.output || '(no output)'}</pre>}
          </details>
        );
      }
      case 'permission_request': {
        const done = resolved.get(e.requestId);
        if (done || replay) {
          return <div key={key} className="rv-note">{done === 'deny' ? 'Denied' : 'Allowed'} {e.tool}</div>;
        }
        return (
          <div key={key} className="rv-perm">
            <div className="rv-perm-title">Allow <b>{e.tool}</b>?</div>
            <div className="rv-perm-arg">{toolLine(e.tool, e.input)}</div>
            {e.reason && <div className="rv-perm-reason">{e.reason}</div>}
            <div className="rv-perm-actions">
              <button className="btn primary" disabled={!connected} onClick={() => respond(e.requestId, 'allow')}>Allow</button>
              <button className="btn" disabled={!connected} onClick={() => respond(e.requestId, 'deny')}>Deny</button>
            </div>
          </div>
        );
      }
      case 'status': {
        const line = [e.model, e.permissionMode && `${e.permissionMode} permissions`, authLabel(e.authSource) && `on ${authLabel(e.authSource)}`]
          .filter(Boolean).join(' · ');
        if (line === lastStatus) return null;
        lastStatus = line;
        return <div key={key} className="rv-note">{line}</div>;
      }
      case 'turn_end':
        return (
          <div key={key} className={`rv-turn${e.ok ? '' : ' err'}`}>
            {e.ok ? 'done' : `failed: ${e.error ?? 'unknown error'}`}
            {e.durationMs != null && ` · ${(e.durationMs / 1000).toFixed(1)}s`}
            {e.costUsd != null && ` · $${e.costUsd.toFixed(3)}`}
          </div>
        );
      case 'compact':
        return <div key={key} className="rv-sep">context compacted</div>;
      case 'resumed':
        return <div key={key} className="rv-sep">resumed · {e.messages} messages from the transcript</div>;
      case 'error':
        return <div key={key} className="rv-error">{e.message}</div>;
      case 'ended':
        return <div key={key} className="rv-sep">session ended: {e.reason}</div>;
      default:
        return null;
    }
  });

  return (
    <div className="rich-wrap" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="rv-scroll" ref={box} onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {!events.length && <div className="rv-empty">{connected ? 'Send a message to start.' : 'Connecting to the session…'}</div>}
        {rows}
      </div>
      <div className="rv-composer">
        <textarea
          ref={input}
          className="rv-input"
          rows={Math.min(10, Math.max(2, draft.split('\n').length))}
          placeholder={connected ? 'Message Claude (↵ send · ⇧↵ newline · esc interrupt)' : 'Not connected'}
          value={draft}
          disabled={!connected}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) {
              e.preventDefault();
              void send();
            } else if (e.key === 'Escape' && working) {
              e.preventDefault();
              void rpc('rich.interrupt', { id: session.id }).catch(() => {});
            }
          }}
        />
        <div className="rv-composer-bar">
          <span className="muted">{working ? `working${session.agentState?.tool ? `: ${session.agentState.tool}` : ''}` : connected ? 'ready' : 'disconnected'}</span>
          <span className="strip-spacer" />
          {working && <button className="chip-btn" onClick={() => void rpc('rich.interrupt', { id: session.id }).catch(() => {})}>Interrupt <kbd>esc</kbd></button>}
          <button className="chip-btn" disabled={!connected || !draft.trim()} onClick={() => void send()}>Send <kbd>↵</kbd></button>
        </div>
      </div>
    </div>
  );
}
