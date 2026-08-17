import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import {
  type CursorModelConfiguration,
  normalizeCursorModelConfigurations,
} from './modelConfig';
import {
  type CursorDiscoveredModel,
  getCursorBaseModelId,
  normalizeCursorDiscoveredModels,
} from './models';

export interface CursorProviderSettings {
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  discoveredModels: CursorDiscoveredModel[];
  enabled: boolean;
  environmentHash: string;
  environmentVariables: string;
  modelAliases: Record<string, string>;
  modelConfigurations: Record<string, CursorModelConfiguration>;
  visibleModels: string[];
}

export const DEFAULT_CURSOR_PROVIDER_SETTINGS: Readonly<CursorProviderSettings> = Object.freeze({
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: false,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  modelConfigurations: {},
  visibleModels: [],
});

export function getCursorProviderSettings(
  settings: Record<string, unknown>,
): CursorProviderSettings {
  const config = getProviderConfig(settings, 'cursor');
  const normalizedCliPaths = normalizeHostnameCliPaths(config.cliPathsByHost);
  const cliPathsByHost = Object.keys(normalizedCliPaths).length > 0
    ? migrateLegacyHostnameKeyedMap(
      normalizedCliPaths,
      getHostnameKey(),
      getLegacyHostnameKey(),
    )
    : normalizedCliPaths;
  const discoveredModels = normalizeCursorDiscoveredModels(config.discoveredModels);
  const knownModelIds = discoveredModels.map(model => getCursorBaseModelId(model.rawId));

  return {
    cliPath: typeof config.cliPath === 'string'
      ? config.cliPath
      : DEFAULT_CURSOR_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    discoveredModels,
    enabled: typeof config.enabled === 'boolean'
      ? config.enabled
      : DEFAULT_CURSOR_PROVIDER_SETTINGS.enabled,
    environmentHash: typeof config.environmentHash === 'string'
      ? config.environmentHash
      : DEFAULT_CURSOR_PROVIDER_SETTINGS.environmentHash,
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : getProviderEnvironmentVariables(settings, 'cursor')
        ?? DEFAULT_CURSOR_PROVIDER_SETTINGS.environmentVariables,
    modelAliases: normalizeCursorModelAliases(config.modelAliases),
    modelConfigurations: normalizeCursorModelConfigurations(
      config.modelConfigurations,
      knownModelIds,
    ),
    visibleModels: normalizeCursorVisibleModels(config.visibleModels, discoveredModels),
  };
}

export function updateCursorProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<CursorProviderSettings>,
): CursorProviderSettings {
  const current = getCursorProviderSettings(settings);
  const discoveredModels = normalizeCursorDiscoveredModels(
    updates.discoveredModels ?? current.discoveredModels,
  );
  const visibleModels = normalizeCursorVisibleModels(
    updates.visibleModels ?? current.visibleModels,
    discoveredModels,
  );
  const modelConfigurations = normalizeCursorModelConfigurations(
    updates.modelConfigurations ?? current.modelConfigurations,
    discoveredModels.map(model => getCursorBaseModelId(model.rawId)),
  );
  const cliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let cliPath = 'cliPathsByHost' in updates
    ? (typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '')
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const path = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (path) {
      cliPathsByHost[getHostnameKey()] = path;
    } else {
      delete cliPathsByHost[getHostnameKey()];
    }
    cliPath = '';
  }

  const next: CursorProviderSettings = {
    ...current,
    ...updates,
    cliPath,
    cliPathsByHost,
    discoveredModels,
    environmentVariables: typeof updates.environmentVariables === 'string'
      ? updates.environmentVariables
      : current.environmentVariables,
    modelAliases: normalizeCursorModelAliases(updates.modelAliases ?? current.modelAliases),
    modelConfigurations,
    visibleModels,
  };

  setProviderConfig(settings, 'cursor', {
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentHash: next.environmentHash,
    environmentVariables: next.environmentVariables,
    modelAliases: next.modelAliases,
    modelConfigurations: next.modelConfigurations,
    visibleModels: next.visibleModels,
  });
  return next;
}

export function normalizeCursorVisibleModels(
  value: unknown,
  discoveredModels: CursorDiscoveredModel[] = [],
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const known = new Set(discoveredModels.map(model => getCursorBaseModelId(model.rawId)));
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const rawId = typeof entry === 'string' ? getCursorBaseModelId(entry.trim()) : '';
    if (!rawId || seen.has(rawId) || (known.size > 0 && !known.has(rawId))) {
      return [];
    }
    seen.add(rawId);
    return [rawId];
  });
}

function normalizeHostnameCliPaths(value: unknown): HostnameCliPaths {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([hostname, path]) => (
      typeof path === 'string' && path.trim() ? [[hostname, path.trim()]] : []
    )),
  );
}

function normalizeCursorModelAliases(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([rawId, alias]) => {
      const normalizedId = getCursorBaseModelId(rawId.trim());
      const normalizedAlias = typeof alias === 'string' ? alias.trim() : '';
      return normalizedId && normalizedAlias ? [[normalizedId, normalizedAlias]] : [];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
