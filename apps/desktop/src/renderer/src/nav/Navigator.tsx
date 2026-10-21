import type { SessionInfo } from '@jarvis/protocol';
import { setState, useStore, type NavTab } from '../store';
import { ActivityTab } from './ActivityTab';
import { ChangesTab, DocsTab, FilesTab } from './FilesTab';
import { ConnectorsTab, PrsTab } from './PrsTab';
import { PulseTab } from './PulseTab';
import { Empty } from './common';

const TABS: { id: NavTab; label: string; key: string }[] = [
  { id: 'activity', label: 'Activity', key: '1' },
  { id: 'files', label: 'Files', key: '2' },
  { id: 'changes', label: 'Changes', key: '3' },
  { id: 'docs', label: 'Docs', key: '4' },
  { id: 'prs', label: 'PRs', key: '5' },
  { id: 'connectors', label: 'Connectors', key: '6' },
  { id: 'usage', label: 'Pulse', key: '7' },
];

export function Navigator({ session }: { session: SessionInfo | null }) {
  const tab = useStore((s) => s.navTab);
  const prCount = useStore((s) => s.snapshot?.prs.prs.filter((p) => p.role === 'reviewer').length ?? 0);
  const errors = useStore((s) => (session ? (s.activity[session.id] ?? []).filter((e) => e.status === 'error').length : 0));
  const needsSession = tab !== 'prs' && tab !== 'usage';
  return (
    <aside className="navigator">
      <div className="nav-tabs drag">
        {TABS.map((t) => (
          <button key={t.id} className={`nav-tab no-drag ${tab === t.id ? 'on' : ''}`} title={`${t.label} (⌥⌘${t.key})`}
            onClick={() => setState({ navTab: t.id })}>
            {t.label}
            {t.id === 'prs' && prCount > 0 && <span className="nav-badge">{prCount}</span>}
            {t.id === 'activity' && errors > 0 && <span className="nav-badge bad">{errors}</span>}
          </button>
        ))}
      </div>
      <div className="nav-body">
        {needsSession && !session ? <Empty>Select a session.</Empty>
          : tab === 'activity' ? <ActivityTab s={session!} />
          : tab === 'files' ? <FilesTab s={session!} />
          : tab === 'changes' ? <ChangesTab s={session!} />
          : tab === 'docs' ? <DocsTab s={session!} />
          : tab === 'prs' ? <PrsTab s={session} />
          : tab === 'connectors' ? <ConnectorsTab s={session!} />
          : <PulseTab />}
      </div>
    </aside>
  );
}
