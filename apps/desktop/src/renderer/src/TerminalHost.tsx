import { useEffect, useMemo, useState } from 'react';
import type { SessionInfo } from '@jarvis/protocol';
import { TerminalView } from './TerminalView';
import { activeSession, agentDef, ago, rpc, setState, tildify, useStore } from './store';

/** How many tmux clients stay attached (and xterm instances alive) for fast switching. */
const WARM = 5;

export function TerminalHost() {
  const snapshot = useStore((s) => s.snapshot);
  const active = useStore((s) => activeSession(s));
  const [mounted, setMounted] = useState<string[]>([]);

  useEffect(() => {
    if (!active || active.status !== 'running') return;
    setMounted((m) => [active.id, ...m.filter((id) => id !== active.id)].slice(0, WARM));
  }, [active?.id, active?.status]);

  const byId = useMemo(() => new Map((snapshot?.sessions ?? []).map((s) => [s.id, s])), [snapshot]);
  const live = mounted.map((id) => byId.get(id)).filter((s): s is SessionInfo => !!s && s.status === 'running');

  return (
    <div className="terminals">
      {live.map((s) => (
        <TerminalView key={s.id} session={s} visible={s.id === active?.id} />
      ))}
      {active?.status === 'exited' && <ExitedCard session={active} />}
      {!active && <EmptyState />}
    </div>
  );
}

function ExitedCard({ session }: { session: SessionInfo }) {
  const def = useStore((s) => agentDef(s, session.agent));
  const revive = () => void rpc('sessions.revive', { id: session.id });
  const remove = () => void rpc('sessions.remove', { id: session.id });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.metaKey && !(e.target instanceof HTMLInputElement)) revive();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="term-overlay solid">
      <div className="card">
        <div className="card-title">{session.name} ended {ago(session.exitedAt)} ago</div>
        <div className="card-body">
          {def?.resumeArgs && session.agentSessionId
            ? <>Reviving resumes {def.label} session <code>{session.agentSessionId.slice(0, 8)}</code> in <code>{tildify(session.cwd)}</code>.</>
            : <>Reviving starts a new {def?.label ?? session.agent} in <code>{tildify(session.cwd)}</code>.</>}
        </div>
        <div className="card-actions">
          <button className="btn primary" onClick={revive}>Revive <kbd>↵</kbd></button>
          <button className="btn" onClick={remove}>Remove</button>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  const connected = useStore((s) => s.status.connected);
  return (
    <div className="empty">
      <div className="empty-title">{connected ? 'No sessions yet' : 'Connecting to jarvisd…'}</div>
      {connected && (
        <>
          <div className="empty-sub">Start any coding agent or shell in any repo. Sessions live in tmux, so quitting Jarvis never stops them.</div>
          <button className="btn primary" onClick={() => setState({ dialog: { kind: 'new' } })}>New session <kbd>⌘T</kbd></button>
        </>
      )}
    </div>
  );
}
