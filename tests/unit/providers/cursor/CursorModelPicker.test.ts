import type { ProviderModelPickerOptions } from '@/shared/settings/ProviderModelPicker';

const mockRenderProviderModelPicker = jest.fn();
const mockEnsureReady = jest.fn().mockResolvedValue(true);
const mockSyncConversationState = jest.fn();
const mockCleanup = jest.fn();

jest.mock('@/shared/settings/ProviderModelPicker', () => ({
  renderProviderModelPicker: (options: ProviderModelPickerOptions) => {
    mockRenderProviderModelPicker(options);
    return { refresh: jest.fn() };
  },
}));

jest.mock('@/providers/cursor/runtime/CursorChatRuntime', () => ({
  CursorChatRuntime: class MockCursorChatRuntime {
    constructor(readonly plugin: unknown) {}

    syncConversationState(...args: unknown[]) {
      return mockSyncConversationState(...args);
    }

    ensureReady(...args: unknown[]) {
      return mockEnsureReady(this.plugin, ...args);
    }

    cleanup() {
      return mockCleanup();
    }
  },
}));

import { getCursorProviderSettings } from '@/providers/cursor/settings';
import { renderCursorModelPicker } from '@/providers/cursor/ui/CursorModelPicker';

function createPlugin() {
  const plugin: any = {
    settings: {
      providerConfigs: {
        cursor: {
          discoveredModels: [
            {
              description: 'General model',
              label: 'GPT-5.4',
              rawId: 'gpt-5.4[reasoning=medium]',
            },
            {
              label: 'GPT-5.4 High',
              rawId: 'gpt-5.4[reasoning=high]',
            },
            {
              label: 'Claude Opus 5',
              rawId: 'claude-opus-5',
            },
          ],
          enabled: true,
          modelAliases: { 'gpt-5.4': 'GPT' },
          visibleModels: ['gpt-5.4'],
        },
      },
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
  };
  plugin.mutateSettings = jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  return plugin;
}

function createContext(plugin: ReturnType<typeof createPlugin>) {
  return {
    plugin,
    refreshModelSelectors: jest.fn(),
  } as any;
}

function getPickerOptions(): ProviderModelPickerOptions {
  const options = mockRenderProviderModelPicker.mock.calls[0]?.[0];
  if (!options) {
    throw new Error('Expected Cursor model picker options');
  }
  return options;
}

describe('CursorModelPicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureReady.mockResolvedValue(true);
  });

  it('collapses parameterized variants and exposes only the saved visible models', () => {
    const plugin = createPlugin();

    renderCursorModelPicker({} as HTMLElement, createContext(plugin));

    expect(getPickerOptions().getState()).toEqual({
      aliases: { 'gpt-5.4': 'GPT' },
      discoveredCount: 2,
      models: [
        {
          description: 'General model',
          id: 'gpt-5.4',
          isAvailable: true,
          name: 'GPT-5.4',
        },
        {
          description: '',
          id: 'claude-opus-5',
          isAvailable: true,
          name: 'Claude Opus 5',
        },
      ],
      selectedIds: ['gpt-5.4'],
    });
  });

  it('persists model visibility and aliases through the shared picker', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    renderCursorModelPicker({} as HTMLElement, context);
    const options = getPickerOptions();

    await options.onSelectedIdsChange(['claude-opus-5']);
    await options.onAliasesChange({ 'claude-opus-5': 'Opus' });

    expect(getCursorProviderSettings(plugin.settings).visibleModels).toEqual(['claude-opus-5']);
    expect(getCursorProviderSettings(plugin.settings).modelAliases).toEqual({
      'claude-opus-5': 'Opus',
    });
    expect(context.refreshModelSelectors).toHaveBeenCalledTimes(2);
  });

  it('can explicitly discover the Cursor catalog without sending a prompt', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    renderCursorModelPicker({} as HTMLElement, context);

    await expect(getPickerOptions().loadCatalog(true)).resolves.toBe('loaded');

    expect(mockSyncConversationState).toHaveBeenCalledWith({
      selectedModel: 'cursor',
      sessionId: null,
    });
    expect(mockEnsureReady).toHaveBeenCalledWith(
      plugin,
      { allowSessionCreation: true, force: true },
    );
    expect(mockCleanup).toHaveBeenCalledTimes(1);
    expect(context.refreshModelSelectors).toHaveBeenCalledTimes(1);
  });
});
