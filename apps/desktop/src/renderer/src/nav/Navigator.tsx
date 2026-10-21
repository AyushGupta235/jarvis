import type { SessionInfo } from '@jarvis/protocol';
import { setState, useStore, type NavTab } from '../store';
import { ActivityTab } from './ActivityTab';
import { ChangesTab, DocsTab, FilesTab } from './FilesTab';
import { ConnectorsTab, PrsTab } from './PrsTab';
import { PulseTab } from './PulseTab';
import { ThinkingTab } from './ThinkingTab';
import { Empty } from './common';

/** 16px line icons, so tabs stay recognisable when the panel is too narrow for labels. */
const ICONS: Record<NavTab, string> = {
  activity: 'M2 8h3l2-5 3 10 2-5h2',
  files: 'M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z',
  changes: 'M5 2v8M2 5h6M9 12h5M11.5 9.5v5',
  docs: 'M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 11h4',
  prs: 'M4.5 4.5v7M4.5 3a1.5 1.5 0 1 0 0 .01M4.5 13a1.5 1.5 0 1 0 0 .01M11.5 13a1.5 1.5 0 1 0 0 .01M11.5 11.5V6.5a2 2 0 0 0-2-2H7m1.5-1.5L7 4.5 8.5 6',
  connectors: 'M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3',
  usage: 'M2 13h12M4 13V9M7 13V5M10 13V7M13 13V3',
  thinking: 'M8 2.5a4 4 0 0 0-2.5 7.1V11h5V9.6A4 4 0 0 0 8 2.5zM6 13h4M7 14.5h2',
};

function TabIcon({ id }: { id: NavTab }) {
  return (
    <svg className="nav-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.35"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[id]} />
    </svg>
  );
}

/** Below this width only the active tab keeps its label. */
const LABELS_MIN_WIDTH = 600;

const TABS: { id: NavTab; label: string; key: string }[] = [
  { id: 'activity', label: 'Activity', key: '1' },
  { id: 'files', label: 'Files', key: '2' },
  { id: 'changes', label: 'Changes', key: '3' },
  { id: 'docs', label: 'Docs', key: '4' },
  { id: 'prs', label: 'PRs', key: '5' },
  { id: 'connectors', label: 'Connectors', key: '6' },
  { id: 'usage', label: 'Pulse', key: '7' },
  { id: 'thinking', label: 'Thinking', key: '8' },
];

export function Navigator({ session }: { session: SessionInfo | null }) {
  const tab = useStore((s) => s.navTab);
  const prCount = useStore((s) => s.snapshot?.prs.prs.filter((p) => p.role === 'reviewer').length ?? 0);
  const errors = useStore((s) => (session ? (s.activity[session.id] ?? []).filter((e) => e.status === 'error').length : 0));
  const needsSession = tab !== 'prs' && tab !== 'usage';
  const navWidth = useStore((s) => s.navWidth);
  const compact = navWidth < LABELS_MIN_WIDTH;
  return (
    <aside className="navigator">
      <div className="nav-tabs drag">
        {TABS.map((t) => (
          <button key={t.id} className={`nav-tab no-drag ${tab === t.id ? 'on' : ''}`} title={`${t.label} (⌥⌘${t.key})`}
            onClick={() => setState({ navTab: t.id })}>
            <TabIcon id={t.id} />
            {(!compact || tab === t.id) && <span className="nav-tab-label">{t.label}</span>}
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
          : tab === 'thinking' ? <ThinkingTab s={session!} />
          : <PulseTab />}
      </div>
    </aside>
  );
}
