import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { SessionInfo } from '@jarvis/protocol';
import { FONT_FAMILY, xtermTheme } from './theme';
import { subscribePty } from './ptyBus';
import { openInViewer, sessionRoot, useStore } from './store';
import { quoteSelection } from './quote';

// Paths worth linking: anything with a slash and an extension, or a bare file name with a common extension.
const PATH_RE = /(?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|md|json|ya?ml|toml|sh|css|scss|html|sql|txt|lock|env|c|h|cpp|hpp)(?::\d+(?::\d+)?)?\b/g;

interface Props {
  session: SessionInfo;
  visible: boolean;
}

/** Imperative handle registry so menu actions (clear, font size) can reach the active terminal. */
export const terminals = new Map<string, { term: Terminal; write: (d: string) => void; fit: () => void }>();
// Read-only hook for end-to-end tests (e2e/relaunch.e2e.mjs reads terminal buffers through it).
(window as unknown as { __jarvisTerminals: typeof terminals }).__jarvisTerminals = terminals;

/**
 * An xterm.js view attached to a tmux session through a PTY running `tmux attach`. tmux owns the
 * scrollback and the process; unmounting this view only detaches.
 */
export function TerminalView({ session, visible }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  const fontSize = useStore((s) => s.fontSize);
  const [detached, setDetached] = useState(false);
  const [quoteAt, setQuoteAt] = useState<{ x: number; y: number; since: number } | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [attachSeq, setAttachSeq] = useState(0);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  visibleRef.current = visible;

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize,
      lineHeight: 1.1,
      theme: xtermTheme,
      cursorStyle: 'bar',
      cursorBlink: true,
      allowTransparency: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      scrollback: 1000,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon((e, uri) => {
      if (e.metaKey) window.jarvis.openExternal(uri);
    }));
    term.open(el);
    // ⌘-click a file path in the output to open it in the viewer (at the line, for path:line).
    term.registerLinkProvider({
      provideLinks(y, cb) {
        const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
        const links: import('@xterm/xterm').ILink[] = [];
        for (const m of line.matchAll(PATH_RE)) {
          const textMatch = m[0];
          if (/^\d|^https?:/.test(textMatch) || textMatch.length < 4) continue;
          const start = (m.index ?? 0) + 1;
          links.push({
            range: { start: { x: start, y }, end: { x: start + textMatch.length - 1, y } },
            text: textMatch,
            decorations: { underline: true, pointerCursor: true },
            activate(ev, t) {
              if (!ev.metaKey) return;
              const s = sessionRef.current;
              const [p, ln] = t.split(':');
              const base = s.currentPath || s.cwd;
              const home = base.split('/').slice(0, 3).join('/');
              const abs = p!.startsWith('/') ? p! : p!.startsWith('~') ? home + p!.slice(1) : `${base}/${p!.replace(/^\.\//, '')}`;
              openInViewer({ path: abs, root: sessionRoot(s), mode: 'file', line: ln ? Number(ln) : undefined });
            },
          });
        }
        cb(links);
      },
    });
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* DOM renderer fallback */
    }
    termRef.current = { term, fit };

    let ptyId: number | null = null;
    let disposed = false;
    let unsub: (() => void) | null = null;
    const exits: number[] = [];

    const write = (d: string) => {
      if (ptyId !== null) window.jarvis.ptyWrite(ptyId, d);
    };
    const safeFit = () => {
      if (!visibleRef.current || el.clientWidth < 20 || el.clientHeight < 20) return;
      try {
        fit.fit();
      } catch { /* not laid out yet */ }
    };
    terminals.set(session.id, { term, write, fit: safeFit });

    term.onData(write);
    term.onBinary(write);
    term.onResize(({ cols, rows }) => {
      if (ptyId !== null) window.jarvis.ptyResize(ptyId, cols, rows);
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // ⌘ shortcuts belong to the app menu.
      if (e.metaKey) return false;
      // Shift+Enter: newline in Claude Code (sent as Meta+Enter, which survives tmux).
      if (e.key === 'Enter' && e.shiftKey && !e.altKey && !e.ctrlKey) {
        write('\x1b\r');
        return false;
      }
      // Option+←/→: word jumps, same sequences as the WezTerm config.
      if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        write(e.key === 'ArrowLeft' ? '\x1b[1;3D' : '\x1b[1;3C');
        return false;
      }
      return true;
    });

    const attach = async () => {
      safeFit();
      try {
        const id = await window.jarvis.ptyOpen(session.id, term.cols, term.rows);
        if (disposed) {
          window.jarvis.ptyClose(id);
          return;
        }
        ptyId = id;
        setDetached(false);
        unsub = subscribePty(
          id,
          (d) => term.write(d),
          () => {
            unsub?.();
            unsub = null;
            ptyId = null;
            if (disposed) return;
            // The tmux client ended: session killed, or detached with prefix+d. Reattach unless it keeps failing.
            const now = Date.now();
            exits.push(now);
            while (exits.length && now - (exits[0] ?? 0) > 10_000) exits.shift();
            if (exits.length <= 3) setTimeout(() => !disposed && void attach(), 400);
            else setDetached(true);
          },
        );
        // Make tmux redraw at our exact size.
        window.jarvis.ptyResize(id, term.cols, term.rows);
      } catch {
        if (!disposed) setDetached(true);
      }
    };
    void attach();

    // Quote-reply: after a drag-select, offer to quote it into the agent's prompt.
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: MouseEvent) => {
      down = { x: e.clientX, y: e.clientY, t: Date.now() };
      setQuoteAt(null);
    };
    const onUp = (e: MouseEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) return;
      const r = el.getBoundingClientRect();
      const since = down.t;
      setTimeout(() => setQuoteAt({ x: Math.min(e.clientX - r.left, r.width - 170), y: Math.max(4, e.clientY - r.top - 34), since }), 120);
    };
    el.addEventListener('mousedown', onDown, true);
    el.addEventListener('mouseup', onUp, true);
    const ro = new ResizeObserver(() => requestAnimationFrame(safeFit));
    ro.observe(el);
    const onFocus = () => {
      if (visibleRef.current) term.focus();
    };
    window.addEventListener('jarvis:focus-terminal', onFocus);

    return () => {
      disposed = true;
      el.removeEventListener('mousedown', onDown, true);
      el.removeEventListener('mouseup', onUp, true);
      ro.disconnect();
      window.removeEventListener('jarvis:focus-terminal', onFocus);
      unsub?.();
      if (ptyId !== null) window.jarvis.ptyClose(ptyId);
      terminals.delete(session.id);
      termRef.current = null;
      term.dispose();
    };
    // Re-run only when the session identity changes or a manual reattach is requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, attachSeq]);

  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.term.options.fontSize = fontSize;
    if (visible) requestAnimationFrame(() => {
      try {
        t.fit.fit();
      } catch { /* hidden */ }
    });
  }, [fontSize, visible]);

  useEffect(() => {
    if (!quoteAt) return;
    const t = setTimeout(() => setQuoteAt(null), 7000);
    const k = () => setQuoteAt(null);
    window.addEventListener('keydown', k);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', k);
    };
  }, [quoteAt]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      const t = termRef.current;
      if (!t) return;
      try {
        t.fit.fit();
      } catch { /* hidden */ }
      t.term.focus();
    });
  }, [visible]);

  return (
    <div className="term-wrap" style={{ display: visible ? 'block' : 'none' }}>
      <div className="term-host" ref={host} />
      {quoteAt && visible && session.agent !== 'shell' && (
        <button className="quote-btn" style={{ left: quoteAt.x + 12, top: quoteAt.y + 10 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const since = quoteAt.since;
            setQuoteAt(null);
            void quoteSelection(session, since);
          }}>
          ❝ Quote in reply <kbd>⌘'</kbd>
        </button>
      )}
      {detached && session.status === 'running' && (
        <div className="term-overlay">
          <div className="card">
            <div className="card-title">Detached from tmux</div>
            <div className="card-body">The session is still running.</div>
            <button className="btn primary" onClick={() => setAttachSeq((n) => n + 1)}>Reattach</button>
          </div>
        </div>
      )}
    </div>
  );
}
