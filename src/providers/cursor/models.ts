export interface CursorDiscoveredModel {
  description?: string;
  label: string;
  rawId: string;
}

export interface CursorParameterizedModelId {
  baseId: string;
  parameters: Record<string, string>;
}

export const CURSOR_SYNTHETIC_MODEL_ID = 'cursor';
export const CURSOR_MODEL_PREFIX = 'cursor:';

export function isCursorModelSelectionId(model: string): boolean {
  return model === CURSOR_SYNTHETIC_MODEL_ID || decodeCursorModelId(model) !== null;
}

export function encodeCursorModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  return normalized ? `${CURSOR_MODEL_PREFIX}${normalized}` : CURSOR_SYNTHETIC_MODEL_ID;
}

export function decodeCursorModelId(model: string): string | null {
  if (!model.startsWith(CURSOR_MODEL_PREFIX)) {
    return null;
  }

  const rawModelId = model.slice(CURSOR_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function parseCursorParameterizedModelId(rawModelId: string): CursorParameterizedModelId {
  const normalized = rawModelId.trim();
  const match = normalized.match(/^(.+?)\[([^\]]*)\]$/);
  if (!match) {
    return { baseId: normalized, parameters: {} };
  }

  const parameters: Record<string, string> = {};
  for (const segment of match[2].split(',')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = segment.slice(0, separator).trim().toLowerCase();
    const value = segment.slice(separator + 1).trim();
    if (key && value) {
      parameters[key] = value;
    }
  }

  return {
    baseId: match[1].trim(),
    parameters,
  };
}

export function getCursorBaseModelId(rawModelId: string): string {
  return parseCursorParameterizedModelId(rawModelId).baseId;
}

export function buildCursorBaseModels(
  discoveredModels: CursorDiscoveredModel[],
): CursorDiscoveredModel[] {
  const baseModels = new Map<string, CursorDiscoveredModel>();
  for (const model of discoveredModels) {
    const baseId = getCursorBaseModelId(model.rawId);
    if (!baseId || baseModels.has(baseId)) {
      continue;
    }
    baseModels.set(baseId, {
      ...(model.description ? { description: model.description } : {}),
      label: model.label,
      rawId: baseId,
    });
  }
  return [...baseModels.values()];
}

export function resolveCursorAcpModelId(
  selectedModelId: string,
  discoveredModels: CursorDiscoveredModel[],
): string | null {
  const normalized = selectedModelId.trim();
  if (!normalized) {
    return null;
  }

  const exact = discoveredModels.find(model => model.rawId === normalized);
  if (exact) {
    return exact.rawId;
  }

  const baseId = getCursorBaseModelId(normalized);
  return discoveredModels.find(model => getCursorBaseModelId(model.rawId) === baseId)?.rawId
    ?? (discoveredModels.length === 0 ? baseId : null);
}

export function normalizeCursorDiscoveredModels(value: unknown): CursorDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const models: CursorDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const rawId = firstString(entry.rawId, entry.modelId, entry.id)?.trim() ?? '';
    if (!rawId || seen.has(rawId)) {
      continue;
    }

    seen.add(rawId);
    const label = firstString(entry.name, entry.label)?.trim() || rawId;
    const description = firstString(entry.description)?.trim();
    models.push({
      ...(description ? { description } : {}),
      label,
      rawId,
    });
  }

  return models;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
