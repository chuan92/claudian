import { cursorChatUIConfig } from '@/providers/cursor/ui/CursorChatUIConfig';

function createSettings(): Record<string, unknown> {
  return {
    effortLevel: 'medium',
    model: 'cursor:gpt-5.4',
    providerConfigs: {
      cursor: {
        discoveredModels: [{ label: 'GPT-5.4', rawId: 'gpt-5.4' }],
        enabled: true,
        modelConfigurations: {
          'gpt-5.4': {
            contextWindow: 272_000,
            fast: {
              currentValue: 'false',
              description: '2x more expensive, but faster.',
              options: [
                { label: 'Off', value: 'false' },
                { label: 'Fast', value: 'true' },
              ],
            },
            reasoning: {
              currentValue: 'medium',
              options: [
                { label: 'None', value: 'none' },
                { label: 'Medium', value: 'medium' },
                { label: 'High', value: 'high' },
              ],
            },
          },
        },
        visibleModels: ['gpt-5.4'],
      },
    },
    serviceTier: 'false',
  };
}

describe('cursorChatUIConfig', () => {
  it('exposes Cursor reasoning effort and fast controls', () => {
    const settings = createSettings();

    expect(cursorChatUIConfig.isAdaptiveReasoningModel('cursor:gpt-5.4', settings)).toBe(true);
    expect(cursorChatUIConfig.getReasoningOptions('cursor:gpt-5.4', settings)).toEqual([
      { label: 'None', value: 'none' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ]);
    expect(cursorChatUIConfig.getDefaultReasoningValue('cursor:gpt-5.4', settings)).toBe('medium');
    expect(cursorChatUIConfig.getServiceTierToggle?.(settings)).toEqual({
      activeLabel: 'Fast',
      activeValue: 'true',
      description: '2x more expensive, but faster.',
      inactiveLabel: 'Off',
      inactiveValue: 'false',
    });
    expect(cursorChatUIConfig.getContextWindowSize('cursor:gpt-5.4', undefined, settings))
      .toBe(272_000);
  });

  it('normalizes previously stored exploded model ids to the base model', () => {
    const settings = createSettings();
    const legacy = 'cursor:gpt-5.4[context=272k,reasoning=high,fast=true]';

    expect(cursorChatUIConfig.normalizeModelVariant(legacy, settings)).toBe('cursor:gpt-5.4');
    cursorChatUIConfig.applyModelDefaults(legacy, settings);

    expect(settings.model).toBe('cursor:gpt-5.4');
    expect(settings.effortLevel).toBe('high');
    expect(settings.serviceTier).toBe('true');
  });

  it('defers uncached model metadata discovery to the active Cursor runtime', () => {
    expect(cursorChatUIConfig.prepareModelMetadata).toBeUndefined();
  });

  it('keeps the current model pinned without showing every discovered model', () => {
    const settings = createSettings();
    (settings.providerConfigs as any).cursor.discoveredModels.push({
      label: 'Claude Opus 5',
      rawId: 'claude-opus-5',
    });
    (settings.providerConfigs as any).cursor.visibleModels = [];

    expect(cursorChatUIConfig.getModelOptions(settings)).toEqual([
      expect.objectContaining({ label: 'GPT-5.4', value: 'cursor:gpt-5.4' }),
    ]);
  });
});
