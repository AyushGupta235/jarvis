import { createElement, useEffect, useRef, useState } from 'react';
import { activeSession, getState, sessionRoot, setState, type ViewerTab } from './store';

/** The parts of Electron's <webview> element this pane uses (the renderer has no Electron types). */
interface WebviewEl extends HTMLElement {
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  loadURL(url: string): Promise<void>;
  openDevTools(): void;
  setZoomFactor(f: number): void;
}

const DEVICES: { id: string; label: string; width: number | null }[] = [
  { id: 'fit', label: 'Fit', width: null },
  { id: 'desktop', label: '1280', width: 1280 },
  { id: 'laptop', label: '1024', width: 1024 },
  { id: 'tablet', label: '768', width: 768 },
  { id: 'phone', label: '390', width: 390 },
];

function normalize(u: string): string {
  const t = u.trim();
  if (/^\d+$/.test(t)) return `http://localhost:${t}`;
  if (/^https?:\/\//i.test(t)) return t;
  return `http://${t}`;
}

/** Update this preview tab in the store (URL, compare URL), so it comes back the same after a restart. */
function patchTab(index: number, patch: Partial<ViewerTab>): void {
  const tabs = getState().viewerTabs.map((t, i) => (i === index ? { ...t, ...patch } : t));
  setState({ viewerTabs: tabs });
}

/** One page: its own address bar and a <webview>, scaled down to fit when a device width is wider than the pane. */
function WebPane({ initialUrl, deviceWidth, onUrl, reloadSignal, onClose }: {
  initialUrl: string; deviceWidth: number | null; onUrl: (u: string) => void; reloadSignal: number; onClose?: () => void;
}) {
  const view = useRef<WebviewEl | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [draft, setDraft] = useState(initialUrl);
  const [nav, setNav] = useState({ back: false, fwd: false });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [avail, setAvail] = useState(0);
  const src = useRef(initialUrl);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const sync = () => {
      const u = v.getURL();
      setUrl(u);
      setDraft(u);
      onUrl(u);
      setNav({ back: v.canGoBack(), fwd: v.canGoForward() });
    };
    const start = () => { setLoading(true); setFailed(null); };
    const stop = () => setLoading(false);
    const fail = (e: Event) => {
      const ev = e as Event & { errorCode: number; errorDescription: string; isMainFrame: boolean; validatedURL: string };
      if (ev.isMainFrame && ev.errorCode !== -3) setFailed(`${ev.errorDescription || 'Could not load'} (${ev.validatedURL})`);
    };
    v.addEventListener('did-navigate', sync);
    v.addEventListener('did-navigate-in-page', sync);
    v.addEventListener('did-start-loading', start);
    v.addEventListener('did-stop-loading', stop);
    v.addEventListener('did-fail-load', fail);
    return () => {
      v.removeEventListener('did-navigate', sync);
      v.removeEventListener('did-navigate-in-page', sync);
      v.removeEventListener('did-start-loading', start);
      v.removeEventListener('did-stop-loading', stop);
      v.removeEventListener('did-fail-load', fail);
    };
  }, [onUrl]);

  useEffect(() => {
    if (reloadSignal) view.current?.reload();
  }, [reloadSignal]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A device width wider than the pane is rendered at that width and zoomed down, like a browser's device toolbar.
  const zoom = deviceWidth && avail ? Math.min(1, avail / deviceWidth) : 1;
  useEffect(() => {
    try { view.current?.setZoomFactor(zoom); } catch { /* not attached yet */ }
  }, [zoom, loading]);

  const go = () => {
    const u = normalize(draft);
    setFailed(null);
    void view.current?.loadURL(u).catch(() => {});
  };

  return (
    <div className="wp-pane">
      <div className="wp-bar">
        <button className="icon-btn wp-opt" disabled={!nav.back} title="Back" onClick={() => view.current?.goBack()}>‹</button>
        <button className="icon-btn wp-opt" disabled={!nav.fwd} title="Forward" onClick={() => view.current?.goForward()}>›</button>
        <button className="icon-btn" title="Reload" onClick={() => view.current?.reload()}>{loading ? '×' : '↻'}</button>
        <input className="wp-url" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') setDraft(url); }} />
        <button className="icon-btn wp-opt" title="Developer tools" onClick={() => view.current?.openDevTools()}>⚙</button>
        <button className="icon-btn wp-opt" title="Open in your browser" onClick={() => window.jarvis.openExternal(url)}>↗</button>
        {onClose && <button className="icon-btn" title="Close this side" onClick={onClose}>×</button>}
      </div>
      <div className="wp-frame" ref={frame}>
        <div className="wp-device" style={deviceWidth ? { width: Math.round(deviceWidth * zoom) } : undefined}>
          {createElement('webview', {
            ref: (el: WebviewEl | null) => { view.current = el; },
            src: src.current,
            partition: 'persist:jarvis-preview',
            className: 'wp-view',
          })}
        </div>
        {failed && (
          <div className="wp-failed">
            <div>{failed}</div>
            <div className="muted">Is the dev server running? Start it in a session, then reload.</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Web preview in the viewer pane: a page next to the agent, for frontend work. Compare splits it into two
 * pages side by side (say, localhost against staging); device widths render the page at that width.
 */
export function WebPreview({ tab, index }: { tab: ViewerTab; index: number }) {
  const [device, setDevice] = useState('fit');
  const [compare, setCompare] = useState<string | null>(tab.compare ?? null);
  const [reloadOnSave, setReloadOnSave] = useState(false);
  const [reloadSignal, setReloadSignal] = useState(0);
  const width = DEVICES.find((d) => d.id === device)?.width ?? null;

  useEffect(() => {
    if (!reloadOnSave) return;
    const root = sessionRoot(activeSession(getState()));
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = window.jarvis.onFilesChanged((c) => {
      if (root && c.root !== root) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => setReloadSignal((n) => n + 1), 350);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [reloadOnSave]);

  const toggleCompare = () => {
    const next = compare ? null : tab.path;
    setCompare(next);
    patchTab(index, { compare: next });
  };

  return (
    <div className="web-preview">
      <div className="wp-tools">
        <div className="seg small">
          {DEVICES.map((d) => (
            <button key={d.id} className={`seg-btn ${device === d.id ? 'on' : ''}`} title={d.width ? `${d.width}px wide` : 'Fill the pane'}
              onClick={() => setDevice(d.id)}>{d.label}</button>
          ))}
        </div>
        <span className="strip-spacer" />
        <label className="wp-check" title="Reload when files in the session's repo change (for servers without hot reload)">
          <input type="checkbox" checked={reloadOnSave} onChange={(e) => setReloadOnSave(e.target.checked)} /> reload on save
        </label>
        <button className={`chip-btn ${compare ? 'on' : ''}`} title="Show a second page side by side" onClick={toggleCompare}>
          {compare ? 'Single' : 'Compare'}
        </button>
      </div>
      <div className={`wp-panes ${compare ? 'two' : ''}`}>
        <WebPane initialUrl={tab.path} deviceWidth={width} reloadSignal={reloadSignal}
          onUrl={(u) => { if (u && u !== 'about:blank') patchTab(index, { path: u }); }} />
        {compare && (
          <WebPane initialUrl={compare} deviceWidth={width} reloadSignal={reloadSignal}
            onUrl={(u) => { if (u && u !== 'about:blank') patchTab(index, { compare: u }); }}
            onClose={toggleCompare} />
        )}
      </div>
    </div>
  );
}
