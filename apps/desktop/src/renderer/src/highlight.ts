import { createHighlighter, bundledLanguages, type Highlighter, type BundledLanguage } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

let hl: Promise<Highlighter> | null = null;
const loaded = new Set<string>();

function highlighter(): Promise<Highlighter> {
  hl ??= createHighlighter({ themes: ['rose-pine-moon'], langs: [], engine: createJavaScriptRegexEngine() });
  return hl;
}

const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript',
  py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish', ps1: 'powershell', sql: 'sql',
  json: 'json', jsonl: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml', html: 'html',
  css: 'css', scss: 'scss', less: 'less', md: 'markdown', mdx: 'mdx', graphql: 'graphql', gql: 'graphql', proto: 'proto',
  tf: 'hcl', hcl: 'hcl', lua: 'lua', vue: 'vue', svelte: 'svelte', dockerfile: 'docker', makefile: 'make', diff: 'diff', patch: 'diff',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', scala: 'scala', r: 'r', dart: 'dart', zig: 'zig', nix: 'nix', prisma: 'prisma',
};

export function langFor(path: string): string {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  if (base === 'dockerfile') return 'docker';
  if (base === 'makefile') return 'make';
  if (base.startsWith('.env')) return 'dotenv';
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  return EXT[ext] ?? 'text';
}

async function ensureLang(h: Highlighter, lang: string): Promise<string> {
  const key = (lang in bundledLanguages ? lang : 'text') as BundledLanguage | 'text';
  if (key !== 'text' && !loaded.has(key)) {
    await h.loadLanguage(key as BundledLanguage);
    loaded.add(key);
  }
  return key;
}

/** Highlighted lines as HTML strings (one per source line). Falls back to escaped text for huge files. */
export async function highlightLines(code: string, lang: string): Promise<string[]> {
  if (code.length > 400_000) return code.split('\n').map(escapeHtml);
  const h = await highlighter();
  const l = await ensureLang(h, lang);
  const tokens = h.codeToTokensBase(code, { lang: l as BundledLanguage, theme: 'rose-pine-moon' });
  return tokens.map((line) =>
    line.map((t) => `<span style="color:${t.color ?? 'inherit'}${t.fontStyle === 1 ? ';font-style:italic' : ''}${t.fontStyle === 2 ? ';font-weight:600' : ''}">${escapeHtml(t.content)}</span>`).join(''),
  );
}

export async function highlightBlock(code: string, lang: string): Promise<string> {
  const lines = await highlightLines(code, lang);
  return lines.join('\n');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
