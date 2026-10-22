// Text handling for `!` shell commands (no UI, so it can be tested on its own).

export interface ShellRun {
  id: string;
  command: string;
  output: string;
  state: 'running' | 'done' | 'stopped';
  exitCode: number | null;
}

/** What a terminal printed, as text: colour codes gone, and a carriage return overwriting its line like a progress bar does. */
export function cleanShellOutput(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split('\n').map((l) => (l.includes('\r') ? l.split('\r').filter(Boolean).pop() ?? '' : l)).join('\n');
}

const ATTACH_TAIL = 12_000;

/** The text that carries finished `!` commands to Claude with your next message. */
export function shellContext(runs: ShellRun[]): string {
  return runs.map((r) => {
    const out = cleanShellOutput(r.output).trimEnd();
    const body = out.length > ATTACH_TAIL ? `(earlier output cut)\n${out.slice(-ATTACH_TAIL)}` : out;
    const how = r.state === 'stopped' ? ' (I stopped it)' : r.exitCode != null ? ` (exit code ${r.exitCode})` : '';
    return `I ran this in my shell${how}:\n$ ${r.command}\n${body || '(no output)'}`;
  }).join('\n\n');
}

