import { cursorSettingsReconciler } from '@/providers/cursor/env/CursorSettingsReconciler';

describe('cursorSettingsReconciler', () => {
  it('migrates exploded model selections and their effort and fast values', () => {
    const settings: Record<string, any> = {
      model: 'cursor:gpt-5.4[context=272k,reasoning=high,fast=true]',
      providerConfigs: {
        cursor: {
          discoveredModels: [{
            label: 'GPT-5.4',
            rawId: 'gpt-5.4[context=272k,reasoning=medium,fast=false]',
          }],
          enabled: true,
          modelConfigurations: {
            'gpt-5.4[reasoning=medium]': {
              reasoning: {
                currentValue: 'medium',
                options: [{ label: 'Medium', value: 'medium' }],
              },
            },
          },
          visibleModels: ['gpt-5.4[context=272k,reasoning=medium,fast=false]'],
        },
      },
      savedProviderModel: {
        cursor: 'cursor:claude-opus-5[effort=xhigh,fast=false]',
      },
    };

    expect(cursorSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(settings.model).toBe('cursor:gpt-5.4');
    expect(settings.effortLevel).toBe('high');
    expect(settings.serviceTier).toBe('true');
    expect(settings.savedProviderModel.cursor).toBe('cursor:claude-opus-5');
    expect(settings.savedProviderEffort.cursor).toBe('xhigh');
    expect(settings.savedProviderServiceTier.cursor).toBe('false');
    expect(settings.providerConfigs.cursor.visibleModels).toEqual(['gpt-5.4']);
    expect(settings.providerConfigs.cursor.modelConfigurations['gpt-5.4']).toBeDefined();
  });
});
