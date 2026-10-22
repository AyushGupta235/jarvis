import type { RichEvent } from '@jarvis/protocol';

type Notice = Extract<RichEvent, { kind: 'task_notice' }>;

const tag = (text: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1]!.trim() : null;
};

/**
 * Claude Code injects a finished or reporting background task into the conversation as a user message made of
 * `<task-notification>` tags. This turns it into something the view can draw instead of the raw tags.
 */
export function parseTaskNotification(text: string): Notice | null {
  const body = text.trim();
  if (!body.startsWith('<task-notification>')) return null;
  const raw = tag(body, 'status');
  const events = [...body.matchAll(/<event>([\s\S]*?)<\/event>/g)].map((m) => m[1]!.trim());
  return {
    kind: 'task_notice',
    taskId: tag(body, 'task-id') ?? '',
    toolUseId: tag(body, 'tool-use-id'),
    status: raw === 'failed' ? 'failed' : raw === 'killed' || raw === 'stopped' ? 'stopped' : raw === 'completed' ? 'completed' : 'event',
    summary: tag(body, 'summary') ?? '',
    event: events.length ? events.join('\n') : tag(body, 'result'),
  };
}

/**
 * A sub-agent's final report comes back to Claude as an `<agent-message from="ID">` prompt, wrapped in a notice
 * that it is model output and not from you. The view wants only the report, attached to that agent.
 */
export function parseAgentMessage(text: string): Notice | null {
  const m = /^<agent-message from="([^"]+)">\s*([\s\S]*?)\s*<\/agent-message>\s*$/.exec(text.trim());
  if (!m) return null;
  const body = m[2]!;
  const at = body.indexOf('The report follows:');
  const report = (at >= 0 ? body.slice(at + 'The report follows:'.length) : body)
    .split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n').trim();
  return { kind: 'task_notice', taskId: m[1]!, toolUseId: null, status: 'completed', summary: 'Sub-agent report', event: report || null };
}

export const COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation';

/** The text of a user message, whether Claude stored it as a string or as text blocks. */
export function userText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return null;
  const t = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return t || null;
}
