import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderServiceTierToggleConfig,
  ProviderUIOption,
} from '../../../core/providers/types';
import type { CursorModelConfiguration } from '../modelConfig';
import {
  buildCursorBaseModels,
  CURSOR_SYNTHETIC_MODEL_ID,
  decodeCursorModelId,
  encodeCursorModelId,
  getCursorBaseModelId,
  isCursorModelSelectionId,
  parseCursorParameterizedModelId,
} from '../models';
import { getCursorProviderSettings } from '../settings';

const CURSOR_PERMISSION_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'Plan',
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

export const cursorChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const cursorSettings = getCursorProviderSettings(settings);
    const baseModels = buildCursorBaseModels(cursorSettings.discoveredModels);
    const discovered = new Map(baseModels.map(model => [
      model.rawId,
      {
        description: model.description ?? 'Cursor ACP model',
        label: cursorSettings.modelAliases[model.rawId] ?? model.label,
        value: encodeCursorModelId(model.rawId),
      },
    ] as const));
    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();

    for (const rawId of [...cursorSettings.visibleModels].reverse()) {
      const baseId = getCursorBaseModelId(rawId);
      pushOption(options, seen, discovered.get(baseId) ?? {
        description: 'Configured Cursor model',
        label: cursorSettings.modelAliases[baseId] ?? baseId,
        value: encodeCursorModelId(baseId),
      });
    }

    const savedProviderModel = isRecord(settings.savedProviderModel)
      ? settings.savedProviderModel.cursor
      : null;
    for (const selection of [settings.model, savedProviderModel]) {
      if (typeof selection !== 'string') {
        continue;
      }
      const rawId = decodeCursorModelId(selection);
      if (!rawId) {
        continue;
      }
      const baseId = getCursorBaseModelId(rawId);
      pushOption(options, seen, discovered.get(baseId) ?? {
        description: 'Selected in an existing Cursor session',
        label: cursorSettings.modelAliases[baseId] ?? baseId,
        value: encodeCursorModelId(baseId),
      });
    }

    return options.length > 0 ? options : [{
      description: 'Models are discovered when Cursor starts an ACP session',
      label: 'Cursor (Auto)',
      value: CURSOR_SYNTHETIC_MODEL_ID,
    }];
  },

  getDefaultModel(settings): string {
    const cursorSettings = getCursorProviderSettings(settings);
    const rawId = cursorSettings.visibleModels[0];
    return rawId
      ? encodeCursorModelId(getCursorBaseModelId(rawId))
      : CURSOR_SYNTHETIC_MODEL_ID;
  },

  ownsModel(model): boolean {
    return isCursorModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model, settings): boolean {
    return Boolean(getModelConfiguration(model, settings)?.reasoning?.options.length);
  },

  getReasoningOptions(model, settings): ProviderReasoningOption[] {
    return getModelConfiguration(model, settings)?.reasoning?.options.map(option => ({
      ...(option.description ? { description: option.description } : {}),
      label: option.label,
      value: option.value,
    })) ?? [];
  },

  getDefaultReasoningValue(model, settings): string {
    return getModelConfiguration(model, settings)?.reasoning?.currentValue ?? 'off';
  },

  getContextWindowSize(model, customLimits, settings): number {
    return customLimits?.[model]
      ?? (settings ? getModelConfiguration(model, settings)?.contextWindow : undefined)
      ?? parseContextWindow(decodeCursorModelId(model))
      ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model): boolean {
    return isCursorModelSelectionId(model);
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings) || !isCursorModelSelectionId(model)) {
      return;
    }
    const rawId = decodeCursorModelId(model);
    if (!rawId) {
      return;
    }
    const parsed = parseCursorParameterizedModelId(rawId);
    const normalizedModel = encodeCursorModelId(parsed.baseId);
    const configuration = getModelConfiguration(normalizedModel, settings);
    const reasoning = parsed.parameters.effort
      ?? parsed.parameters.reasoning
      ?? resolveSupportedParameter(parsed.parameters.thinking, configuration?.reasoning);
    const fast = resolveSupportedParameter(parsed.parameters.fast, configuration?.fast);

    settings.model = normalizedModel;
    if (reasoning) {
      settings.effortLevel = reasoning;
    } else if (configuration?.reasoning) {
      settings.effortLevel = configuration.reasoning.currentValue;
    }
    if (fast) {
      settings.serviceTier = fast;
    } else if (configuration?.fast) {
      settings.serviceTier = configuration.fast.currentValue;
    }
  },

  normalizeModelVariant(model): string {
    const rawId = decodeCursorModelId(model);
    return rawId ? encodeCursorModelId(getCursorBaseModelId(rawId)) : model;
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return CURSOR_PERMISSION_TOGGLE;
  },

  resolvePermissionMode(settings): string | null {
    return settings.permissionMode === 'normal'
      || settings.permissionMode === 'plan'
      || settings.permissionMode === 'yolo'
      ? settings.permissionMode
      : null;
  },

  applyPermissionMode(value, settings): void {
    if (isRecord(settings)) {
      settings.permissionMode = value;
    }
  },

  getServiceTierToggle(settings): ProviderServiceTierToggleConfig | null {
    const model = typeof settings.model === 'string' ? settings.model : '';
    const fast = getModelConfiguration(model, settings)?.fast;
    if (!fast) {
      return null;
    }
    const inactive = fast.options.find(option => option.value === 'false');
    const active = fast.options.find(option => option.value === 'true');
    if (!inactive || !active) {
      return null;
    }
    return {
      activeLabel: active.label,
      activeValue: active.value,
      ...(fast.description ? { description: fast.description } : {}),
      inactiveLabel: inactive.label,
      inactiveValue: inactive.value,
    };
  },

  getModeSelector(): null {
    return null;
  },
};

function getModelConfiguration(
  model: string,
  settings: Record<string, unknown>,
): CursorModelConfiguration | null {
  const rawId = decodeCursorModelId(model);
  if (!rawId) {
    return null;
  }
  return getCursorProviderSettings(settings).modelConfigurations[getCursorBaseModelId(rawId)]
    ?? null;
}

function resolveSupportedParameter(
  value: string | undefined,
  control: CursorModelConfiguration['reasoning'],
): string | null {
  if (!value) {
    return null;
  }
  return !control || control.options.some(option => option.value === value) ? value : null;
}

function pushOption(
  options: ProviderUIOption[],
  seen: Set<string>,
  option: ProviderUIOption,
): void {
  if (!seen.has(option.value)) {
    seen.add(option.value);
    options.push(option);
  }
}

function parseContextWindow(rawId: string | null): number | null {
  const match = rawId?.match(/(?:^|,|\[)context=(\d+(?:\.\d+)?)([km])?(?:[,\]])/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === 'm'
    ? 1_000_000
    : match[2]?.toLowerCase() === 'k'
      ? 1_000
      : 1;
  const tokens = Math.round(value * multiplier);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
