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
