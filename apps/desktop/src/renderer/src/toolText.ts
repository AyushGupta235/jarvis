/**
 * Make a tool call's one-line summary readable: drop the `cd /abs/path &&` that agents prefix most commands
 * with, and shorten paths (inside the session's directory → relative, home → ~, Claude scratchpads and macOS
 * temp dirs → a short marker). Display only; the full command is one click away in the row.
 */
export function shortenCommand(cmd: string, cwd: string, home: string): string {
  let s = cmd.replace(/\s+/g, ' ').trim();
  // Leading `cd <dir> && ` / `cd <dir>; ` (possibly repeated).
  for (;;) {
    const m = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)\s*/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return shortenPaths(s, cwd, home);
}

export function shortenPaths(text: string, cwd: string, home: string): string {
  let s = text;
  // The session's own directory first (macOS reports /var/... and /private/var/... for the same place).
  if (cwd && cwd !== '/') {
    const bare = cwd.replace(/^\/private(?=\/)/, '');
    const forms = [...new Set([/^\/(var|tmp)\//.test(bare) ? `/private${bare}` : cwd, cwd, bare])].sort((a, b) => b.length - a.length);
    for (const dir of forms) {
      const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp(`${esc}/`, 'g'), '').replace(new RegExp(`${esc}(?=\\s|$|['"])`, 'g'), '.');
    }
  }
  s = s.replace(/\/private\/tmp\/claude-\d+\/[^\s/]+\/[0-9a-f-]{36}\/scratchpad/g, '…/scratchpad');
  s = s.replace(/\/(?:private\/)?var\/folders\/[^\s/]+\/[^\s/]+\/T\//g, '$TMPDIR/');
  if (home && home !== '/') {
    const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(esc, 'g'), '~');
  }
  return s;
}

/**
 * A link in a reply that points at a local file (`docs/prd.md`, `./a.ts:12`, `~/x.md#L3`, `file:///abs`), as an
 * absolute path and optional line. Relative paths are from the session's directory. Web links return null.
 */
export function resolveLocalHref(href: string, cwd: string, home: string): { path: string; line?: number } | null {
  let h = href.trim();
  if (!h || /^(https?|mailto|data|javascript):/i.test(h)) return null;
  if (h.startsWith('file://')) h = h.slice('file://'.length);
  let line: number | undefined;
  const anchor = /#L(\d+)(?:-L?\d+)?$/.exec(h);
  if (anchor) {
    line = Number(anchor[1]);
    h = h.slice(0, anchor.index);
  } else {
    const colon = /:(\d+)(?::\d+)?$/.exec(h);
    if (colon) {
      line = Number(colon[1]);
      h = h.slice(0, colon.index);
    }
  }
  h = h.replace(/#.*$/, '');
  try {
    h = decodeURI(h);
  } catch { /* keep as is */ }
  if (!h) return null;
  const path = h.startsWith('/') ? h : h.startsWith('~') ? home + h.slice(1) : `${cwd.replace(/\/$/, '')}/${h.replace(/^\.\//, '')}`;
  return { path: path.replace(/\/\.\//g, '/'), ...(line ? { line } : {}) };
}

/** One line describing a tool call, like the Activity tab. */
export function toolLine(tool: string, input: unknown, cwd = ''): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const one = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 220);
  const home = window.jarvis.homeDir;
  if (tool === 'Bash') return one(shortenCommand(str(i.command), cwd, home));
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return shortenPaths(str(i.file_path) || str(i.notebook_path), cwd, home);
  if (tool === 'Grep' || tool === 'Glob') return `${str(i.pattern)}${i.path ? `  in ${shortenPaths(str(i.path), cwd, home)}` : ''}`;
  if (tool === 'Agent' || tool === 'Task') return one(str(i.description) || str(i.prompt));
  if (tool === 'WebFetch') return str(i.url);
  if (tool === 'WebSearch') return str(i.query);
  return one(JSON.stringify(input ?? {}));
}

