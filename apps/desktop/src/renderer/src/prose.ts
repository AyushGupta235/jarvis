import MarkdownIt, { type Token } from 'markdown-it';
import { escapeHtml, highlightBlock } from './highlight';
import { rpc } from './store';

/**
 * Markdown for agent replies in the rich view. Built for reading rather than a plain render: code blocks
 * with a language label, line count, copy button and collapse; tables that scroll and right-align numbers;
 * GitHub-style callouts; task lists; file paths in inline code that open in the viewer.
 * Raw HTML stays off: replies are rendered as markdown only, never as live HTML.
 */
const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });

/** Collapse code blocks longer than this, with a "Show all" control. */
const COLLAPSE_LINES = 28;

const LANG_LABEL: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TSX', typescript: 'TypeScript', js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
  py: 'Python', python: 'Python', sh: 'Shell', bash: 'Shell', zsh: 'Shell', shell: 'Shell', console: 'Shell',
  json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', sql: 'SQL', go: 'Go', rust: 'Rust', rs: 'Rust',
  diff: 'Diff', patch: 'Diff', html: 'HTML', css: 'CSS', md: 'Markdown', markdown: 'Markdown', text: 'Text', txt: 'Text',
  graphql: 'GraphQL', dockerfile: 'Dockerfile', docker: 'Dockerfile', java: 'Java', kotlin: 'Kotlin', swift: 'Swift',
  ruby: 'Ruby', rb: 'Ruby', php: 'PHP', c: 'C', cpp: 'C++', csharp: 'C#', cs: 'C#', xml: 'XML', ini: 'INI', env: 'Env',
};

const SHIKI_ALIAS: Record<string, string> = {
  sh: 'bash', zsh: 'bash', shell: 'bash', console: 'bash', ts: 'typescript', js: 'javascript', py: 'python', rs: 'rust',
  yml: 'yaml', rb: 'ruby', md: 'markdown', patch: 'diff', txt: 'text', docker: 'dockerfile', cs: 'csharp', env: 'dotenv',
};

md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx]!;
  const lang = ((t.info || '').trim().split(/\s+/)[0] || 'text').toLowerCase();
  const code = t.content.replace(/\n$/, '');
  const lines = code ? code.split('\n').length : 0;
  const long = lines > COLLAPSE_LINES;
  const label = LANG_LABEL[lang] ?? lang;
  return `<div class="pc-block${long ? ' collapsed' : ''}">`
    + `<div class="pc-head"><span class="pc-lang">${escapeHtml(label)}</span>`
    + `<span class="pc-lines">${lines} line${lines === 1 ? '' : 's'}</span>`
    + `<button class="pc-btn" data-act="copy">Copy</button></div>`
    + `<pre class="pc-pre" data-lang="${escapeHtml(SHIKI_ALIAS[lang] ?? lang)}"><code>${escapeHtml(code)}</code></pre>`
    + (long ? `<button class="pc-more" data-act="expand">Show all ${lines} lines</button>` : '')
    + `</div>`;
};

// Images in replies would load remote URLs; show them as links instead.
md.renderer.rules.image = (tokens, idx) => {
  const t = tokens[idx]!;
  const src = String(t.attrGet('src') ?? '');
  return `<a data-href="${escapeHtml(src)}" title="${escapeHtml(src)}">${escapeHtml(t.content || 'image')}</a>`;
};

// Tables scroll on their own instead of widening the conversation.
md.renderer.rules.table_open = () => '<div class="pc-table"><table>';
md.renderer.rules.table_close = () => '</table></div>';

/** Looks like a file path (with an extension or a slash), optionally with :line. */
const PATH_RE = /^(?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?$|^(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*[\w.@+-]+\/?$/;
/** Also: dotfiles (.env, .env.local, config/.env, ~/.zshrc), a name inside a folder, and the well-known extensionless names. */
const CAND_RE = new RegExp(`${PATH_RE.source}|^(?:~|\\.{1,2})?\\/?(?:[\\w.@+-]+\\/)*\\.[\\w@+-][\\w.@+-]*(?::\\d+(?::\\d+)?)?$|^(?:~|\\.{1,2})?\\/?(?:[\\w.@+-]+\\/)+[\\w@+-][\\w.@+-]*(?::\\d+(?::\\d+)?)?$|^(?:Dockerfile|Makefile|Procfile|Gemfile|Rakefile|LICENSE|README|CHANGELOG)$`);
const isCandidate = (c: string) => CAND_RE.test(c) && !/^\d+(\.\d+)*$/.test(c) && !c.includes('://') && !/^(?:e\.g|i\.e|etc|vs)\.?$/i.test(c);

// A path in `code` is only a candidate here: enhanceProse checks the file exists (wherever the agent is working)
// before making it a link, so nothing clickable leads to "file not found".
md.renderer.rules.code_inline = (tokens, idx) => {
  const c = tokens[idx]!.content;
  if (isCandidate(c)) return `<code class="pc-cand" data-cand="${escapeHtml(c)}">${escapeHtml(c)}</code>`;
  return `<code>${escapeHtml(c)}</code>`;
};

md.renderer.rules.link_open = (tokens, idx) => {
  const href = String(tokens[idx]!.attrGet('href') ?? '');
  return `<a data-href="${escapeHtml(href)}" title="${escapeHtml(href)}">`;
};

const CALLOUTS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

/** GitHub-style callouts (`> [!NOTE]`) and task-list items (`- [ ]`, `- [x]`). */
md.core.ruler.after('inline', 'jarvis-prose', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === 'blockquote_open') {
      const inline = tokens[i + 2];
      const m = inline?.type === 'inline' ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(inline.content) : null;
      if (m && inline) {
        const kind = m[1]!.toUpperCase();
        t.attrJoin('class', `pc-callout ${kind.toLowerCase()}`);
        t.attrSet('data-title', CALLOUTS[kind]!);
        stripPrefix(inline, m[0].length);
      }
    }
    if (t.type === 'list_item_open') {
      const inline = tokens[i + 2];
      const m = inline?.type === 'inline' ? /^\[([ xX])\]\s+/.exec(inline.content) : null;
      if (m && inline) {
        t.attrJoin('class', `pc-task${m[1] === ' ' ? '' : ' done'}`);
        stripPrefix(inline, m[0].length);
      }
    }
  }
});

/** Remove the first `n` characters of an inline token's text (the `[!NOTE]` or `[ ]` marker). */
function stripPrefix(inline: Token, n: number): void {
  inline.content = inline.content.slice(n).replace(/^\n/, '');
  const kids = inline.children ?? [];
  const first = kids[0];
  if (first?.type === 'text') first.content = first.content.slice(n).trimStart();
  // `> [!NOTE]` on its own line leaves an empty text node and a line break; drop both.
  while (kids.length && ((kids[0]!.type === 'text' && !kids[0]!.content) || kids[0]!.type === 'softbreak')) kids.shift();
}

const refCache = new Map<string, string>();
const split = (ref: string): { file: string; suffix: string } => {
  const m = /^(.*?)((?::\d+){1,2})$/.exec(ref);
  return m ? { file: m[1]!, suffix: m[2]! } : { file: ref, suffix: '' };
};

/** Words in plain text that might be files: trimmed of the punctuation around them. */
function textCandidates(root: HTMLElement): { node: Text; start: number; end: number; ref: string }[] {
  const out: { node: Text; start: number; end: number; ref: string }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('a, code, pre, .pc-path, [data-href], .pc-btn') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    for (const m of node.data.matchAll(/\S+/g)) {
      const word = m[0];
      const lead = /^[([{"'<]*/.exec(word)![0].length;
      const trail = /[)\]}"'>,;:!?]*\.?$/.exec(word.slice(lead))![0].length;
      const ref = word.slice(lead, word.length - trail);
      if (ref.length > 2 && isCandidate(ref)) out.push({ node, start: m.index! + lead, end: m.index! + lead + ref.length, ref });
    }
  }
  return out;
}

/**
 * Make the files a reply names clickable: the ones in `code` and the ones in plain text. The daemon says which exist
 * (an absolute or ~ path as is, a relative one under each of `bases`: where the agent is, its repo and their parents);
 * only those become links, so a click always opens something.
 */
async function linkPaths(root: HTMLElement, bases: string[]): Promise<void> {
  const codes = [...root.querySelectorAll<HTMLElement>('code.pc-cand:not([data-done])')];
  const texts = textCandidates(root).slice(0, 80);
  const key = (file: string) => `${bases.join('|')}\n${file}`;
  const files = [...new Set([...codes.map((c) => c.dataset.cand!), ...texts.map((t) => t.ref)].map((r) => split(r).file))].slice(0, 120);
  const unknown = files.filter((f) => !refCache.has(key(f)));
  if (unknown.length) {
    try {
      const r = await rpc<{ paths: (string | null)[] }>('files.resolve', { refs: unknown, bases });
      unknown.forEach((f, i) => { if (r.paths[i]) refCache.set(key(f), r.paths[i]!); });
    } catch { /* offline: nothing links */ }
  }
  if (!root.isConnected) return;
  const abs = (ref: string) => {
    const { file, suffix } = split(ref);
    const hit = refCache.get(key(file));
    return hit ? hit + suffix : null;
  };
  for (const c of codes) {
    c.dataset.done = '1';
    const a = abs(c.dataset.cand!);
    if (a) { c.classList.add('pc-path'); c.dataset.path = a; c.title = `Open ${a.replace(/^\/Users\/[^/]+/, '~')}`; }
  }
  // Last match first, so splitting a text node does not shift the offsets of the ones before it.
  for (const t of texts.reverse()) {
    const a = abs(t.ref);
    if (!a || !t.node.parentNode) continue;
    const mid = t.node.splitText(t.start);
    mid.splitText(t.end - t.start);
    const span = document.createElement('span');
    span.className = 'pc-path pc-plain';
    span.dataset.path = a;
    span.title = `Open ${a.replace(/^\/Users\/[^/]+/, '~')}`;
    span.textContent = mid.data;
    mid.replaceWith(span);
  }
}

export function renderProse(src: string): string {
  return md.render(src);
}

/**
 * After the HTML is in the page: highlight code blocks, right-align numeric table columns, and mark callouts
 * with their title. Safe to call again; finished nodes are skipped.
 */
export async function enhanceProse(root: HTMLElement, bases: string[] = []): Promise<void> {
  for (const bq of root.querySelectorAll<HTMLElement>('blockquote.pc-callout:not([data-done])')) {
    bq.dataset.done = '1';
    const title = document.createElement('div');
    title.className = 'pc-callout-title';
    title.textContent = bq.dataset.title ?? '';
    bq.prepend(title);
  }
  for (const table of root.querySelectorAll<HTMLTableElement>('table:not([data-done])')) {
    table.dataset.done = '1';
    const rows = [...table.tBodies[0]?.rows ?? []];
    const cols = table.tHead?.rows[0]?.cells.length ?? 0;
    for (let c = 0; c < cols; c++) {
      const cells = rows.map((r) => r.cells[c]?.textContent?.trim() ?? '').filter(Boolean);
      const numeric = cells.length > 0 && cells.filter((x) => /^[-+]?[$€£]?[\d,]*\.?\d+\s*(%|ms|s|m|h|d|k|K|M|B|KB|MB|GB|x)?$/.test(x)).length / cells.length >= 0.8;
      if (!numeric) continue;
      for (const r of [table.tHead?.rows[0], ...rows]) r?.cells[c]?.classList.add('num');
    }
  }
  for (const pre of root.querySelectorAll<HTMLPreElement>('pre.pc-pre:not([data-done])')) {
    pre.dataset.done = '1';
    const lang = pre.dataset.lang || 'text';
    if (lang === 'text') continue;
    try {
      pre.querySelector('code')!.innerHTML = await highlightBlock(pre.textContent ?? '', lang);
    } catch { /* unknown language: stays plain */ }
  }
  await linkPaths(root, bases);
}
