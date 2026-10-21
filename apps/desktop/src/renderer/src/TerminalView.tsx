import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { SessionInfo } from '@jarvis/protocol';
import { currentTheme, monoFamily, xtermThemeFor } from './appearance';
import { subscribePty } from './ptyBus';
import { isLocalUrl, openInViewer, openPreview, rpc, sessionRoot, useStore } from './store';
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
      fontFamily: monoFamily(),
      fontSize,
      lineHeight: 1.1,
      theme: xtermThemeFor(currentTheme()),
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
      if (!e.metaKey) return;
      // ⌘-click a localhost URL (a dev server) to open it in the preview pane beside the terminal.
      if (isLocalUrl(uri)) openPreview(uri);
      else window.jarvis.openExternal(uri);
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
    const claudePane = () => {
      const s = sessionRef.current;
      const cmd = (s.paneCommand ?? '').replace(/^-/, '');
      return s.agent === 'claude' && !!cmd && !['zsh', 'bash', 'fish', 'sh', 'login', 'tmux'].includes(cmd);
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // ⌘ shortcuts belong to the app menu.
      if (e.metaKey) return false;
      // Shift+Enter: newline in Claude Code (sent as Meta+Enter, which survives tmux).
      if (e.key === 'Enter' && e.shiftKey && !e.altKey && !e.ctrlKey) {
        write('\x1b\r');
        return false;
      }
      // Ctrl+B in Claude Code backgrounds the running task, but tmux's prefix is also Ctrl+B. In a Claude pane,
      // send it twice: tmux's prefix + C-b passes one Ctrl+B through (send-prefix). Your second prefix (C-a)
      // and the menu keep tmux commands working there.
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b' && claudePane()) {
        write('\x02\x02');
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

    // OSC 52: programs (tmux's set-clipboard, Claude Code, vim over ssh) set the clipboard with this escape.
    // xterm.js drops it unless handled. Clipboard reads ("?") are never answered.
    term.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(';') + 1);
      if (!b64 || b64 === '?') return true;
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        if (text) window.jarvis.copyText(text);
      } catch { /* not base64 */ }
      return true;
    });

    // Mouse selection. tmux has mouse mode on, so by default every click and drag goes to tmux, which
    // copies on release and drops the highlight. When the program in the pane doesn't want the mouse
    // (a shell, unlike Claude Code's fullscreen TUI), select in xterm instead: the highlight stays,
    // ⌘C copies it, and it is also copied on release. ⌥-drag forces this anywhere.
    let appMouse = sessionRef.current.agent !== 'shell';
    let mouseCheckedAt = 0;
    const refreshMouse = (force = false) => {
      if (!force && Date.now() - mouseCheckedAt < 700) return;
      mouseCheckedAt = Date.now();
      rpc<{ appMouse: boolean }>('tmux.mouseState', { id: sessionRef.current.id })
        .then((r) => { appMouse = r.appMouse; })
        .catch(() => {});
    };
    const synthetic = new WeakSet<Event>();
    const resend = (e: MouseEvent, altKey: boolean) => {
      const copy = new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, composed: true, view: window, detail: e.detail,
        clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
        button: e.button, buttons: 1, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey,
      });
      synthetic.add(copy);
      e.target?.dispatchEvent(copy);
    };
    // A plain press is held until we know whether it's a click (goes to tmux: focus a split, place the
    // cursor) or a drag (re-sent with ⌥, which xterm.js treats as "select, don't report").
    let pending: MouseEvent | null = null;
    const onSelectDown = (e: MouseEvent) => {
      if (synthetic.has(e) || e.button !== 0 || e.altKey || e.metaKey || appMouse) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.detail >= 2) resend(e, true); // double-click word, triple-click line
      else pending = e;
    };
    const onSelectMove = (e: MouseEvent) => {
      if (pending && Math.hypot(e.clientX - pending.clientX, e.clientY - pending.clientY) > 3) {
        const p = pending;
        pending = null;
        resend(p, true);
      }
    };
    const onSelectUp = () => {
      if (!pending) return;
      const p = pending;
      pending = null;
      term.clearSelection();
      resend(p, false);
    };
    const onHover = () => refreshMouse();
    window.addEventListener('mousemove', onSelectMove, true);
    window.addEventListener('mouseup', onSelectUp, true);
    el.addEventListener('mousemove', onHover);
    el.addEventListener('mouseenter', onHover);
    refreshMouse(true);

    // Quote-reply: after a drag-select, offer to quote it into the agent's prompt.
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: MouseEvent) => {
      if (synthetic.has(e)) return;
      down = { x: e.clientX, y: e.clientY, t: Date.now() };
      setQuoteAt(null);
    };
    const onUp = (e: MouseEvent) => {
      // Copy on release, as tmux does, for selections made in xterm (drag, double-click word, triple-click line).
      setTimeout(() => {
        if (term.hasSelection()) window.jarvis.copyText(term.getSelection());
      }, 0);
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) return;
      const r = el.getBoundingClientRect();
      const since = down.t;
      setTimeout(() => setQuoteAt({ x: Math.min(e.clientX - r.left, r.width - 170), y: Math.max(4, e.clientY - r.top - 34), since }), 120);
    };
    el.addEventListener('mousedown', onDown, true);
    el.addEventListener('mouseup', onUp, true);
    el.addEventListener('mousedown', onSelectDown, true);
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
      el.removeEventListener('mousedown', onSelectDown, true);
      window.removeEventListener('mousemove', onSelectMove, true);
      window.removeEventListener('mouseup', onSelectUp, true);
      el.removeEventListener('mousemove', onHover);
      el.removeEventListener('mouseenter', onHover);
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
