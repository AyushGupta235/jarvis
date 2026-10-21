import type { SessionInfo } from '@jarvis/protocol';
import { terminals } from './TerminalView';
import { flashError, focusTerminal, rpc } from './store';

/**
 * Reply to something the agent said: take the current selection (xterm ⌥-drag selection, else the text you
 * just dragged in tmux) and paste it into the agent's prompt as a quote, ready for you to type below it.
 */
export async function quoteSelection(s: SessionInfo, since = 0): Promise<boolean> {
  const t = terminals.get(s.id);
  let text = t?.term.getSelection() ?? '';
  if (!text.trim()) {
    const b = await rpc<{ text: string | null; created: number | null }>('tmux.lastBuffer', { id: s.id });
    if (b.text && b.created && b.created >= since - 1500 && Date.now() - b.created < 10 * 60_000) text = b.text;
  }
  if (!text.trim()) {
    flashError("Select some of the agent's output first (drag over it), then ⌘' to quote it.");
    return false;
  }
  const quoted = `${text.replace(/\s+$/, '').split('\n').map((l) => `> ${l.trimEnd()}`).join('\n')}\n\n`;
  await rpc('sessions.paste', { id: s.id, text: quoted });
  t?.term.clearSelection();
  focusTerminal();
  return true;
}
