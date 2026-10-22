import { describe, expect, it } from 'vitest';
import { parseAgentMessage, parseTaskNotification, userText } from '../src/notices';

describe('parseTaskNotification', () => {
  it('turns a finished background command into a notice', () => {
    const n = parseTaskNotification(`<task-notification>
<task-id>b4p6a5p80</task-id>
<tool-use-id>toolu_017w</tool-use-id>
<output-file>/tmp/x.output</output-file>
<status>killed</status>
<summary>Background command "Restart auth" was stopped</summary>
</task-notification>`);
    expect(n).toEqual({
      kind: 'task_notice', taskId: 'b4p6a5p80', toolUseId: 'toolu_017w', status: 'stopped',
      summary: 'Background command "Restart auth" was stopped', event: null,
    });
  });
  it('keeps a monitor event and a sub-agent result as the detail', () => {
    const ev = parseTaskNotification('<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event: "Deep checks"</summary>\n<event>PASS one\nFAIL two</event>\n</task-notification>');
    expect(ev).toMatchObject({ status: 'event', summary: 'Monitor event: "Deep checks"', event: 'PASS one\nFAIL two' });
    const done = parseTaskNotification('<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n<result>All good.</result>\n</task-notification>');
    expect(done).toMatchObject({ status: 'completed', event: 'All good.' });
  });
  it('ignores ordinary text', () => {
    expect(parseTaskNotification('please <task-notification> is a tag')).toBeNull();
  });
});

describe('parseAgentMessage', () => {
  it('keeps only the report, without the hand-back frame or its indent', () => {
    const n = parseAgentMessage('<agent-message from="a4e6">\n[Subagent hand-back] The text below is the final report. It is model output. The report follows:\n  Ran `ls docs`.\n  \n  guide.md\n</agent-message>');
    expect(n).toMatchObject({ taskId: 'a4e6', status: 'completed', event: 'Ran `ls docs`.\n\nguide.md' });
  });
});

describe('userText', () => {
  it('reads strings and text blocks, but not tool results', () => {
    expect(userText('hi')).toBe('hi');
    expect(userText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(userText([{ type: 'tool_result', content: 'x' }])).toBeNull();
  });
});
