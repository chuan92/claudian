import {
  type AcpSessionConfigOption,
  extractAcpSessionModelState,
  flattenAcpSessionConfigSelectOptions,
} from '../acp';
import { getCursorBaseModelId } from './models';

export interface CursorModelConfigChoice {
  description?: string;
  label: string;
  value: string;
}

export interface CursorModelControl {
  currentValue: string;
  description?: string;
  options: CursorModelConfigChoice[];
}

export interface CursorSessionModelControl extends CursorModelControl {
  configId: string;
}

export interface CursorModelConfiguration {
  contextWindow?: number;
  fast?: CursorModelControl;
  reasoning?: CursorModelControl;
}

export interface CursorSessionModelConfiguration extends CursorModelConfiguration {
  fast?: CursorSessionModelControl;
  modelId: string | null;
  reasoning?: CursorSessionModelControl;
}

export function extractCursorSessionModelConfig(
  configOptions: AcpSessionConfigOption[] | null | undefined,
): CursorSessionModelConfiguration {
  const modelState = extractAcpSessionModelState({ configOptions });
  const reasoningOption = findReasoningOption(configOptions);
  const fastOption = findSelectOption(configOptions, ['fast']);
  const contextOption = findSelectOption(configOptions, ['context']);
  const contextWindow = parseTokenCount(contextOption?.currentValue);

  return {
    ...(contextWindow !== null ? { contextWindow } : {}),
    ...(fastOption ? { fast: toSessionControl(fastOption) } : {}),
    modelId: modelState.currentModelId
      ? getCursorBaseModelId(modelState.currentModelId)
      : null,
    ...(reasoningOption ? { reasoning: toSessionControl(reasoningOption) } : {}),
  };
}

export function toPersistedCursorModelConfiguration(
  configuration: CursorSessionModelConfiguration,
): CursorModelConfiguration {
  return {
    ...(configuration.contextWindow ? { contextWindow: configuration.contextWindow } : {}),
    ...(configuration.fast ? { fast: omitConfigId(configuration.fast) } : {}),
    ...(configuration.reasoning ? { reasoning: omitConfigId(configuration.reasoning) } : {}),
  };
}

export function normalizeCursorModelConfigurations(
  value: unknown,
  knownModelIds: string[] = [],
): Record<string, CursorModelConfiguration> {
  if (!isRecord(value)) {
    return {};
  }

  const known = new Set(knownModelIds.map(getCursorBaseModelId).filter(Boolean));
  const result: Record<string, CursorModelConfiguration> = {};
  for (const [rawModelId, rawConfiguration] of Object.entries(value)) {
    const modelId = getCursorBaseModelId(rawModelId);
    if (!modelId || (known.size > 0 && !known.has(modelId)) || !isRecord(rawConfiguration)) {
      continue;
    }

    const contextWindow = normalizeContextWindow(rawConfiguration.contextWindow);
    const reasoning = normalizeControl(rawConfiguration.reasoning);
    const fast = normalizeControl(rawConfiguration.fast);
    if (!contextWindow && !reasoning && !fast) {
      continue;
    }
    result[modelId] = {
      ...(contextWindow ? { contextWindow } : {}),
      ...(fast ? { fast } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  }
  return result;
}

function findReasoningOption(
  configOptions: AcpSessionConfigOption[] | null | undefined,
): Extract<AcpSessionConfigOption, { type: 'select' }> | null {
  const candidates = (configOptions ?? []).filter(
    (option): option is Extract<AcpSessionConfigOption, { type: 'select' }> => (
      option.type === 'select'
      && (
        normalizeKey(option.category) === 'thought_level'
        || ['effort', 'reasoning', 'thinking'].includes(normalizeKey(option.id))
      )
    ),
  );
  return candidates.sort((left, right) => reasoningPriority(right) - reasoningPriority(left))[0]
    ?? null;
}

function reasoningPriority(option: Extract<AcpSessionConfigOption, { type: 'select' }>): number {
  const id = normalizeKey(option.id);
  if (id === 'effort') return 30;
  if (id === 'reasoning') return 20;
  if (id === 'thinking') return 10;
  return 15;
}

function findSelectOption(
  configOptions: AcpSessionConfigOption[] | null | undefined,
  ids: string[],
): Extract<AcpSessionConfigOption, { type: 'select' }> | null {
  const expected = new Set(ids.map(normalizeKey));
  return (configOptions ?? []).find(
    (option): option is Extract<AcpSessionConfigOption, { type: 'select' }> => (
      option.type === 'select'
      && (expected.has(normalizeKey(option.id)) || expected.has(normalizeKey(option.name)))
    ),
  ) ?? null;
}

function toSessionControl(
  option: Extract<AcpSessionConfigOption, { type: 'select' }>,
): CursorSessionModelControl {
  return {
    configId: option.id,
    currentValue: option.currentValue,
    ...(option.description?.trim() ? { description: sanitizeLabel(option.description) } : {}),
    options: flattenAcpSessionConfigSelectOptions(option.options).map(entry => ({
      ...(entry.description?.trim() ? { description: sanitizeLabel(entry.description) } : {}),
      label: sanitizeLabel(entry.name) || entry.value,
      value: entry.value,
    })),
  };
}

function omitConfigId(control: CursorSessionModelControl): CursorModelControl {
  return {
    currentValue: control.currentValue,
    ...(control.description ? { description: control.description } : {}),
    options: control.options.map(option => ({ ...option })),
  };
}

function normalizeControl(value: unknown): CursorModelControl | null {
  if (!isRecord(value) || !Array.isArray(value.options)) {
    return null;
  }
  const options: CursorModelConfigChoice[] = [];
  const seen = new Set<string>();
  for (const rawOption of value.options) {
    if (!isRecord(rawOption)) continue;
    const optionValue = typeof rawOption.value === 'string' ? rawOption.value.trim() : '';
    if (!optionValue || seen.has(optionValue)) continue;
    seen.add(optionValue);
    const label = typeof rawOption.label === 'string'
      ? sanitizeLabel(rawOption.label)
      : optionValue;
    const description = typeof rawOption.description === 'string'
      ? sanitizeLabel(rawOption.description)
      : '';
    options.push({
      ...(description ? { description } : {}),
      label: label || optionValue,
      value: optionValue,
    });
  }
  if (options.length === 0) {
    return null;
  }
  const currentValue = typeof value.currentValue === 'string'
    && seen.has(value.currentValue.trim())
    ? value.currentValue.trim()
    : options[0].value;
  const description = typeof value.description === 'string'
    ? sanitizeLabel(value.description)
    : '';
  return {
    currentValue,
    ...(description ? { description } : {}),
    options,
  };
}

function parseTokenCount(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!match) {
    return null;
  }
  const multiplier = match[2]?.toLowerCase() === 'm'
    ? 1_000_000
    : match[2]?.toLowerCase() === 'k'
      ? 1_000
      : 1;
  return normalizeContextWindow(Number(match[1]) * multiplier);
}

function normalizeContextWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function sanitizeLabel(value: string): string {
  return value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
}

function normalizeKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
