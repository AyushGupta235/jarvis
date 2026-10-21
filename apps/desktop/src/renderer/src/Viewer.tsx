import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileContent } from '@jarvis/protocol';
import { highlightLines, langFor } from './highlight';
import { WebPreview } from './WebPreview';
import { highlightCodeBlocks, renderMarkdown } from './markdown';
import {
  activeSession, closeViewerTab, focusTerminal, getState, openInViewer, rpc, setState, tildify, useStore, type ViewerTab,
} from './store';

function rel(path: string, root: string | null): string {
  return root && path.startsWith(root + '/') ? path.slice(root.length + 1) : tildify(path);
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/')) || '/';
}

function resolvePath(base: string, href: string): string {
  if (href.startsWith('/')) return href;
  const parts = base.split('/');
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Insert a reference to this file (and selected lines) into the active agent's prompt, without sending. */
async function referenceInPrompt(path: string, range: [number, number] | null): Promise<void> {
  const s = activeSession(getState());
  if (!s || s.status !== 'running') return;
  const cwd = s.currentPath || s.cwd;
  const r = path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path;
  const lines = range ? (range[0] === range[1] ? `#L${range[0]}` : `#L${range[0]}-${range[1]}`) : '';
  await rpc('sessions.paste', { id: s.id, text: `@${r}${lines} ` });
  focusTerminal();
}

/** Web tabs keep their identity while you browse (their URL changes); file tabs are keyed by path. */
function tabKey(t: ViewerTab, i: number): string {
  return t.mode === 'web' ? `web:${i}` : `${t.mode}:${t.path}`;
}

function webLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

export function Viewer() {
  const tabs = useStore((s) => s.viewerTabs);
  const active = useStore((s) => s.viewerActive);
  const tab = tabs[active];
  const look = useStore((s) => s.appearanceVersion);
  return (
    <section className="viewer">
      <div className="viewer-tabs">
        {tabs.map((t, i) => (
          <div key={tabKey(t, i)} className={`vtab ${i === active ? 'on' : ''}`} title={t.path}
            onClick={() => setState({ viewerActive: i })}
            onAuxClick={(e) => e.button === 1 && closeViewerTab(i)}>
            {t.mode === 'diff' && <span className="vtab-mode">Δ</span>}
            {t.mode === 'web' && <span className="vtab-mode web">◎</span>}
            <span className="vtab-name">{t.mode === 'web' ? webLabel(t.path) : t.path.split('/').pop()}</span>
            <button className="vtab-x" onClick={(e) => { e.stopPropagation(); closeViewerTab(i); }}>×</button>
          </div>
        ))}
        <button className="icon-btn vtab-hide" title="Hide viewer (⌘\\)" onClick={() => setState({ viewerOpen: false })}>⇥</button>
      </div>
      {tab
        ? tab.mode === 'web'
          ? <WebPreview key={tabKey(tab, active)} tab={tab} index={active} />
          : <ViewerBody key={`${tabKey(tab, active)}:${look}`} tab={tab} />
        : <div className="viewer-empty">Open a file from the navigator or ⌘O, or a web page with ⇧⌘B.</div>}
    </section>
  );
}

function ViewerBody({ tab }: { tab: ViewerTab }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);
  const [range, setRange] = useState<[number, number] | null>(tab.line ? [tab.line, tab.line] : null);
  const isMd = /\.(md|mdx|markdown)$/i.test(tab.path);

  const load = async () => {
    if (tab.mode === 'diff' && tab.root) {
      const r = await rpc<{ diff: string }>('files.diff', { root: tab.root, path: rel(tab.path, tab.root) });
      setDiff(r.diff);
    } else {
      setFile(await rpc<FileContent>('files.read', { path: tab.path }));
    }
  };

  useEffect(() => {
    void load();
    if (tab.root) void rpc('files.watch', { root: tab.root });
    const off = window.jarvis.onFilesChanged((c) => {
      if (tab.root && c.root === tab.root && c.paths.some((p) => tab.path.endsWith('/' + p) || p === '.git/index')) void load();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.path, tab.mode]);

  useEffect(() => {
    if (tab.line) setRange([tab.line, tab.line]);
  }, [tab.line]);

  return (
    <div className="viewer-body">
      <div className="viewer-bar">
        <span className="vb-path" title={tab.path}>{rel(tab.path, tab.root)}</span>
        {file && file.kind === 'text' && <span className="vb-meta">{file.text!.split('\n').length} lines</span>}
        <span className="vb-spacer" />
        {isMd && tab.mode === 'file' && (
          <button className="chip-btn" onClick={() => setRendered((r) => !r)}>{rendered ? 'Source' : 'Rendered'}</button>
        )}
        {tab.root && (
          <button className="chip-btn" onClick={() => openInViewer({ ...tab, mode: tab.mode === 'diff' ? 'file' : 'diff' })}>
            {tab.mode === 'diff' ? 'File' : 'Diff'}
          </button>
        )}
        <button className="chip-btn" title="Insert @path into the agent's prompt" onClick={() => void referenceInPrompt(tab.path, range)}>
          @ {range ? (range[0] === range[1] ? `L${range[0]}` : `L${range[0]}-${range[1]}`) : 'file'}
        </button>
        <button className="chip-btn" onClick={() => void rpc('open.editor', { path: tab.path, line: range?.[0] })}>Editor</button>
        <button className="chip-btn" onClick={() => window.jarvis.copyText(tab.path)}>Copy path</button>
      </div>
      <div className="viewer-scroll">
        {tab.mode === 'diff' ? (
          diff === null ? <div className="viewer-empty">Loading…</div> : <DiffView diff={diff} />
        ) : !file ? (
          <div className="viewer-empty">Loading…</div>
        ) : file.kind === 'missing' ? (
          <div className="viewer-empty">File no longer exists.</div>
        ) : file.kind === 'image' ? (
          <div className="viewer-image"><img src={file.dataUrl} alt={tab.path} /></div>
        ) : file.kind !== 'text' ? (
          <div className="viewer-empty">{file.kind === 'binary' ? 'Binary file' : 'File is too large to preview'} ({Math.round(file.size / 1024)} KB).</div>
        ) : isMd && rendered ? (
          <MarkdownView text={file.text!} path={tab.path} root={tab.root} />
        ) : (
          <CodeView text={file.text!} path={tab.path} range={range} setRange={setRange} />
        )}
      </div>
    </div>
  );
}

function CodeView({ text, path, range, setRange }: {
  text: string; path: string; range: [number, number] | null; setRange: (r: [number, number] | null) => void;
}) {
  const plain = useMemo(() => text.split('\n'), [text]);
  const [html, setHtml] = useState<string[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const anchor = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    setHtml(null);
    void highlightLines(text, langFor(path)).then((h) => live && setHtml(h));
    return () => { live = false; };
  }, [text, path]);

  useEffect(() => {
    if (!range) return;
    box.current?.querySelector(`[data-line="${range[0]}"]`)?.scrollIntoView({ block: 'center' });
    // only on first highlight or when the requested line changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html === null, range?.[0]]);

  const pick = (n: number, shift: boolean) => {
    if (shift && anchor.current !== null) setRange([Math.min(anchor.current, n), Math.max(anchor.current, n)]);
    else {
      anchor.current = n;
      setRange(range && range[0] === n && range[1] === n ? null : [n, n]);
    }
  };

  return (
    <div className="code" ref={box}>
      {plain.map((l, i) => {
        const n = i + 1;
        const sel = range && n >= range[0] && n <= range[1];
        return (
          <div key={i} className={`cl ${sel ? 'sel' : ''}`} data-line={n}>
            <span className="ln" onClick={(e) => pick(n, e.shiftKey)}>{n}</span>
            {html?.[i] !== undefined
              ? <span className="lc" dangerouslySetInnerHTML={{ __html: html[i] || ' ' }} />
              : <span className="lc">{l || ' '}</span>}
          </div>
        );
      })}
    </div>
  );
}

function MarkdownView({ text, path, root }: { text: string; path: string; root: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  useEffect(() => {
    if (ref.current) void highlightCodeBlocks(ref.current);
  }, [html]);
  return (
    <article
      className="markdown"
      ref={ref}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href') ?? '';
        if (/^https?:\/\//.test(href)) window.jarvis.openExternal(href);
        else if (href.startsWith('#')) ref.current?.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView();
        else if (href) {
          const [p, frag] = href.split('#');
          const target = resolvePath(dirOf(path), decodeURIComponent(p ?? ''));
          const line = frag && /^L(\d+)/.exec(frag)?.[1];
          openInViewer({ path: target, root, mode: 'file', line: line ? Number(line) : undefined });
        }
      }}
    />
  );
}

export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <div className="viewer-empty">No changes against HEAD.</div>;
  let oldN = 0;
  let newN = 0;
  const rows = diff.split('\n').map((l, i) => {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[2]);
      return <div key={i} className="dl hunk">{l}</div>;
    }
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(l)) return <div key={i} className="dl meta">{l}</div>;
    if (l.startsWith('+')) return <div key={i} className="dl add"><span className="dn" /><span className="dn">{newN++}</span><span className="dc">{l}</span></div>;
    if (l.startsWith('-')) return <div key={i} className="dl del"><span className="dn">{oldN++}</span><span className="dn" /><span className="dc">{l}</span></div>;
    if (l.startsWith('\\')) return <div key={i} className="dl meta">{l}</div>;
    const row = <div key={i} className="dl"><span className="dn">{oldN}</span><span className="dn">{newN}</span><span className="dc">{l}</span></div>;
    oldN++;
    newN++;
    return row;
  });
  return <div className="diff">{rows}</div>;
}
