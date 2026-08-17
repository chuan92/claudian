import {
  CURSOR_SYNTHETIC_MODEL_ID,
  decodeCursorModelId,
  encodeCursorModelId,
  getCursorBaseModelId,
  isCursorModelSelectionId,
  normalizeCursorDiscoveredModels,
  parseCursorParameterizedModelId,
  resolveCursorAcpModelId,
} from '@/providers/cursor/models';

describe('Cursor models', () => {
  it('round-trips ACP model ids without interpreting parameter overrides', () => {
    const rawId = 'claude-opus-4-8[context=300k,effort=high,fast=false]';

    expect(encodeCursorModelId(rawId)).toBe(`cursor:${rawId}`);
    expect(decodeCursorModelId(`cursor:${rawId}`)).toBe(rawId);
    expect(isCursorModelSelectionId(CURSOR_SYNTHETIC_MODEL_ID)).toBe(true);
    expect(isCursorModelSelectionId(`cursor:${rawId}`)).toBe(true);
    expect(isCursorModelSelectionId('opencode:model')).toBe(false);
  });

  it('normalizes Cursor modelId fields and legacy ACP id fields', () => {
    expect(normalizeCursorDiscoveredModels([
      { modelId: 'default[]', name: 'Auto' },
      { id: 'gpt-5.4[reasoning=medium]', name: 'GPT-5.4' },
      { modelId: 'default[]', name: 'Duplicate' },
      { name: 'Missing id' },
    ])).toEqual([
      { rawId: 'default[]', label: 'Auto' },
      { rawId: 'gpt-5.4[reasoning=medium]', label: 'GPT-5.4' },
    ]);
  });

  it('separates a Cursor model from its legacy bracket parameters', () => {
    const parsed = parseCursorParameterizedModelId(
      'claude-opus-5[thinking=true,context=300k,effort=xhigh,fast=false]',
    );

    expect(parsed).toEqual({
      baseId: 'claude-opus-5',
      parameters: {
        context: '300k',
        effort: 'xhigh',
        fast: 'false',
        thinking: 'true',
      },
    });
    expect(getCursorBaseModelId('default[]')).toBe('default');
  });

  it('falls back to an advertised exploded variant for older Cursor ACP builds', () => {
    const models = normalizeCursorDiscoveredModels([
      { modelId: 'gpt-5.4[context=272k,reasoning=medium,fast=false]', name: 'GPT-5.4' },
    ]);

    expect(resolveCursorAcpModelId('gpt-5.4', models))
      .toBe('gpt-5.4[context=272k,reasoning=medium,fast=false]');
  });
});
