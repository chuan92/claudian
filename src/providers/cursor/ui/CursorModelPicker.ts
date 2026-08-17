import type { ProviderSettingsTabRendererContext } from '../../../core/providers/types';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import {
  buildCursorBaseModels,
  CURSOR_SYNTHETIC_MODEL_ID,
  type CursorDiscoveredModel,
} from '../models';
import { CursorChatRuntime } from '../runtime/CursorChatRuntime';
import {
  getCursorProviderSettings,
  normalizeCursorVisibleModels,
  updateCursorProviderSettings,
} from '../settings';

export function renderCursorModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
): void {
  const settingsBag = context.plugin.settings;

  const getState = (): ProviderModelPickerState => {
    const current = getCursorProviderSettings(settingsBag);
    const baseModels = buildCursorBaseModels(current.discoveredModels);
    return {
      aliases: current.modelAliases,
      discoveredCount: baseModels.length,
      models: buildCursorPickerModels(baseModels, current.visibleModels),
      selectedIds: current.visibleModels,
    };
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: 'Start Cursor once or click Discover to load the models available to this account.',
    failedCatalogText: 'Could not load the Cursor model catalog. Check the CLI path and login state, then try again.',
    getState,
    initiallyOpen: getCursorProviderSettings(settingsBag).discoveredModels.length === 0,
    async loadCatalog(force) {
      const runtime = new CursorChatRuntime(context.plugin);
      try {
        runtime.syncConversationState({
          selectedModel: CURSOR_SYNTHETIC_MODEL_ID,
          sessionId: null,
        });
        const loaded = await runtime.ensureReady({
          allowSessionCreation: true,
          ...(force ? { force: true } : {}),
        });
        if (!loaded) {
          return 'failed';
        }
        context.refreshModelSelectors();
        return getCursorProviderSettings(settingsBag).discoveredModels.length > 0
          ? 'loaded'
          : 'empty';
      } catch {
        return 'failed';
      } finally {
        runtime.cleanup();
      }
    },
    loadingCatalogText: 'Loading the Cursor model catalog...',
    modifier: 'cursor',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateCursorProviderSettings(settings, { modelAliases });
      });
      context.refreshModelSelectors();
    },
    async onSelectedIdsChange(visibleModels) {
      const current = getCursorProviderSettings(settingsBag);
      const normalized = normalizeCursorVisibleModels(
        visibleModels,
        current.discoveredModels,
      );
      if (sameStringList(current.visibleModels, normalized)) {
        return;
      }

      await context.plugin.mutateSettings((settings) => {
        updateCursorProviderSettings(settings, { visibleModels: normalized });
      });
      context.refreshModelSelectors();
    },
    providerName: 'Cursor',
    searchPlaceholder: 'Filter by model name, description, or ID...',
    settingDescription: 'Choose which Cursor models appear in the chat selector. The current session model stays pinned even when hidden here.',
  });
}

function buildCursorPickerModels(
  discoveredModels: CursorDiscoveredModel[],
  visibleModels: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = discoveredModels.map(model => ({
    description: model.description ?? '',
    id: model.rawId,
    isAvailable: true,
    name: model.label || model.rawId,
  }));
  const discoveredIds = new Set(models.map(model => model.id));

  for (const modelId of visibleModels) {
    if (discoveredIds.has(modelId)) {
      continue;
    }
    models.push({
      id: modelId,
      isAvailable: false,
      name: modelId,
      unavailableMessage: 'Not currently reported by Cursor',
    });
  }
  return models;
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
