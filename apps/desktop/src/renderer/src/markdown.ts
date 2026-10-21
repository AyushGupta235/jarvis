import MarkdownIt from 'markdown-it';
import { escapeHtml, highlightBlock } from './highlight';

// Raw HTML is disabled: repo markdown is rendered as markdown only, never as live HTML.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });

// Code fences render as placeholders that get highlighted asynchronously after mount.
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx]!;
  const lang = (t.info || '').trim().split(/\s+/)[0] || 'text';
  return `<pre class="md-code" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(t.content)}</code></pre>`;
};

export function renderMarkdown(src: string): string {
  return md.render(src);
}

/** Replace placeholder code blocks inside `root` with highlighted versions. */
export async function highlightCodeBlocks(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLPreElement>('pre.md-code:not([data-done])')];
  for (const pre of blocks) {
    pre.dataset.done = '1';
    const lang = pre.dataset.lang || 'text';
    const code = pre.textContent ?? '';
    try {
      pre.querySelector('code')!.innerHTML = await highlightBlock(code.replace(/\n$/, ''), lang === 'sh' ? 'bash' : lang);
    } catch { /* unknown language: leave plain */ }
  }
}
