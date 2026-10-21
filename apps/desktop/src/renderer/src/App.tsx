import { useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { TerminalHost } from './TerminalHost';
import { NewSessionDialog, OpenFileDialog, QuickSwitcher, RenameDialog } from './Dialogs';
import { Navigator } from './nav/Navigator';
import { Viewer } from './Viewer';
import { Resizer } from './Resizer';
import { checksIcon } from './nav/PrsTab';
import { activeSession, fmtTokens, fmtUsd, setState, syncUi, tildify, useStore } from './store';
import { handleMenu } from './actions';

export function App() {
  const sidebar = useStore((s) => s.sidebar);
  const dialog = useStore((s) => s.dialog);
  const error = useStore((s) => s.error);
  const connected = useStore((s) => s.status.connected);
  const statusError = useStore((s) => s.status.error);
  const active = useStore((s) => activeSession(s));
  const navOpen = useStore((s) => s.navOpen);
  const navWidth = useStore((s) => s.navWidth);
  const viewerOpen = useStore((s) => s.viewerOpen && s.viewerTabs.length > 0);
  const viewerWidth = useStore((s) => s.viewerWidth);
  const wsName = useStore((s) => s.snapshot?.workspaces.find((w) => w.root === active?.repoRoot)?.name);

  useEffect(() => window.jarvis.onMenu(handleMenu), []);
  useEffect(() => {
    document.title = active ? `${active.name} · Jarvis` : 'Jarvis';
    syncUi();
  }, [active?.id, active?.name]);

  const a = active?.agentState;
  const pct = a?.context?.usedPct ?? null;
  return (
    <div className={`app ${sidebar ? '' : 'no-sidebar'}`}>
      {sidebar && <Sidebar />}
      <main className="main" style={{ minWidth: viewerOpen ? 800 : 480 }}>
        <header className="titlebar drag">
          {active ? (
            <>
              <span className="tb-name">{active.name}</span>
              <span className="tb-sep">·</span>
              <span className="tb-repo">{wsName}</span>
              {active.worktree && <span className="chip">⑂ {active.worktree.split('/').pop()}</span>}
              {active.branch && <span className="chip branch">{active.branch}</span>}
              {active.pr && (() => {
                const c = checksIcon(active.pr.checks);
                return (
                  <button className={`chip pr no-drag ${c.cls}`} title={`${active.pr.title}\n${c.label}`} onClick={() => window.jarvis.openExternal(active.pr!.url)}>
                    {c.icon} #{active.pr.number}
                  </button>
                );
              })()}
              {a && <span className={`chip phase ${a.phase}`}>{a.phase === 'needs_input' ? 'needs you' : a.phase}</span>}
              {(a?.model || active.model) && <span className="chip model">{a?.model ?? active.model}</span>}
              {pct != null && <span className={`chip ctx ${pct > 80 ? 'hot' : pct > 60 ? 'warm' : ''}`} title={`${fmtTokens(a?.context?.usedTokens)} / ${fmtTokens(a?.context?.windowTokens)} tokens`}>ctx {Math.round(pct)}%</span>}
              {a?.costUsd != null && <span className="chip">{fmtUsd(a.costUsd)}</span>}
              <span className="tb-path">{tildify(active.currentPath || active.cwd)}</span>
            </>
          ) : (
            <span className="tb-name muted">Jarvis</span>
          )}
          <div className="tb-toggles no-drag">
            <button className={`icon-btn ${viewerOpen ? 'on' : ''}`} title="File viewer (⌘\\)" onClick={() => handleMenu('toggle-viewer')}>▤</button>
            <button className={`icon-btn ${navOpen ? 'on' : ''}`} title="Navigator (⌘J)" onClick={() => setState((s) => ({ navOpen: !s.navOpen }))}>◧</button>
          </div>
        </header>
        {!connected && <div className="banner">{statusError || 'Connecting to jarvisd…'}</div>}
        {error && <div className="banner error">{error}</div>}
        <div className="workspace">
          <TerminalHost />
          {viewerOpen && (
            <>
              <Resizer field="viewerWidth" min={320} max={1400} />
              <div className="viewer-wrap" style={{ width: viewerWidth }}><Viewer /></div>
            </>
          )}
        </div>
      </main>
      {navOpen && (
        <>
          <Resizer field="navWidth" min={280} max={760} />
          <div className="nav-wrap" style={{ width: navWidth }}><Navigator session={active} /></div>
        </>
      )}
      {dialog?.kind === 'new' && <NewSessionDialog repoPath={dialog.repoPath} />}
      {dialog?.kind === 'switch' && <QuickSwitcher />}
      {dialog?.kind === 'rename' && <RenameDialog id={dialog.id} />}
      {dialog?.kind === 'open-file' && <OpenFileDialog />}
    </div>
  );
}
