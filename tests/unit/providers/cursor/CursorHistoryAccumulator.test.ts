import { CursorHistoryAccumulator } from '@/providers/cursor/history/CursorHistoryAccumulator';

describe('CursorHistoryAccumulator', () => {
  it('separates replayed turns without relying on ACP message ids', () => {
    const accumulator = new CursorHistoryAccumulator('session-1', 1_000);

    accumulator.push({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'First question' },
    });
    accumulator.push({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking' },
    });
    accumulator.push({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'First answer' },
    });
    accumulator.push({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Second question' },
    });
    accumulator.push({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Second answer' },
    });

    expect(accumulator.toMessages()).toEqual([
      expect.objectContaining({ role: 'user', content: 'First question' }),
      expect.objectContaining({
        role: 'assistant',
        content: 'First answer',
        contentBlocks: [
          { type: 'thinking', content: 'Thinking' },
          { type: 'text', content: 'First answer' },
        ],
      }),
      expect.objectContaining({ role: 'user', content: 'Second question' }),
      expect.objectContaining({ role: 'assistant', content: 'Second answer' }),
    ]);
  });

  it('strips Claudian system instructions from the replayed first user prompt', () => {
    const accumulator = new CursorHistoryAccumulator('session-1', 1_000);
    accumulator.push({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'text',
        text: '<claudian_system_instructions>internal</claudian_system_instructions>\n\nVisible prompt',
      },
    });

    expect(accumulator.toMessages()[0].content).toBe('Visible prompt');
  });

  it('hydrates tool calls and their final output into the assistant message', () => {
    const accumulator = new CursorHistoryAccumulator('session-1', 1_000);
    accumulator.push({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Inspect package.json' },
    });
    accumulator.push({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Read package.json',
      kind: 'read',
      rawInput: { path: 'package.json' },
      status: 'in_progress',
    });
    accumulator.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      rawOutput: '{"name":"claudian"}',
    });
    accumulator.push({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The package is Claudian.' },
    });

    expect(accumulator.toMessages()[1]).toEqual(expect.objectContaining({
      contentBlocks: [
        { type: 'tool_use', toolId: 'tool-1' },
        { type: 'text', content: 'The package is Claudian.' },
      ],
      toolCalls: [expect.objectContaining({
        id: 'tool-1',
        input: { path: 'package.json' },
        name: 'Read package.json',
        result: '{"name":"claudian"}',
        status: 'completed',
      })],
    }));
  });
});
