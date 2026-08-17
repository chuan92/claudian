import { extractCursorSessionModelConfig } from '@/providers/cursor/modelConfig';

describe('extractCursorSessionModelConfig', () => {
  it('prefers granular effort over the separate thinking toggle', () => {
    const result = extractCursorSessionModelConfig([
      {
        category: 'model',
        currentValue: 'claude-opus-5',
        id: 'model',
        name: 'Model',
        options: [{ name: 'Claude Opus 5', value: 'claude-opus-5' }],
        type: 'select',
      },
      {
        category: 'thought_level',
        currentValue: 'true',
        id: 'thinking',
        name: 'Thinking',
        options: [
          { name: 'Off', value: 'false' },
          { name: 'On', value: 'true' },
        ],
        type: 'select',
      },
      {
        category: 'thought_level',
        currentValue: 'high',
        description: 'Reasoning effort.',
        id: 'effort',
        name: 'Effort',
        options: [
          { name: 'Low', value: 'low' },
          { name: 'High', value: 'high' },
          { name: 'Extra High', value: 'xhigh' },
        ],
        type: 'select',
      },
      {
        category: 'model_config',
        currentValue: 'true',
        description: 'Faster but consumes more usage.',
        id: 'fast',
        name: 'Fast',
        options: [
          { name: 'Off', value: 'false' },
          { name: 'Fast\u200b\u200b', value: 'true' },
        ],
        type: 'select',
      },
      {
        category: 'model_config',
        currentValue: '300k',
        id: 'context',
        name: 'Context',
        options: [{ name: '300K', value: '300k' }],
        type: 'select',
      },
    ]);

    expect(result).toEqual({
      contextWindow: 300_000,
      fast: {
        configId: 'fast',
        currentValue: 'true',
        description: 'Faster but consumes more usage.',
        options: [
          { label: 'Off', value: 'false' },
          { label: 'Fast', value: 'true' },
        ],
      },
      modelId: 'claude-opus-5',
      reasoning: {
        configId: 'effort',
        currentValue: 'high',
        description: 'Reasoning effort.',
        options: [
          { label: 'Low', value: 'low' },
          { label: 'High', value: 'high' },
          { label: 'Extra High', value: 'xhigh' },
        ],
      },
    });
  });
});
