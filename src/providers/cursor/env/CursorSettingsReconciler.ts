import { createHash } from 'node:crypto';

import { getProviderConfig } from '../../../core/providers/providerConfig';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { parseEnvironmentVariables } from '../../../utils/env';
import {
  CURSOR_SYNTHETIC_MODEL_ID,
  decodeCursorModelId,
  encodeCursorModelId,
  getCursorBaseModelId,
  isCursorModelSelectionId,
  parseCursorParameterizedModelId,
} from '../models';
import {
  getCursorProviderSettings,
  normalizeCursorVisibleModels,
  updateCursorProviderSettings,
} from '../settings';

const CURSOR_ENV_HASH_KEYS = ['CURSOR_API_ENDPOINT', 'CURSOR_API_KEY'] as const;

export const cursorSettingsReconciler: ProviderSettingsReconciler = {
  handleEnvironmentChange(settings): boolean {
    const current = getCursorProviderSettings(settings);
    if (
      current.discoveredModels.length === 0
      && Object.keys(current.modelConfigurations).length === 0
    ) {
      return false;
    }
    updateCursorProviderSettings(settings, {
      discoveredModels: [],
      modelConfigurations: {},
    });
    return true;
  },

  invalidateConversationSessions(conversations): Conversation[] {
    const invalidated: Conversation[] = [];
    for (const conversation of conversations) {
      if (conversation.providerId === 'cursor' && conversation.sessionId) {
        conversation.sessionId = null;
        conversation.providerState = undefined;
        invalidated.push(conversation);
      }
    }
    return invalidated;
  },

  reconcileModelWithEnvironment(settings, conversations) {
    const environmentHash = computeCursorEnvironmentHash(
      getRuntimeEnvironmentText(settings, 'cursor'),
    );
    if (environmentHash === getCursorProviderSettings(settings).environmentHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = this.invalidateConversationSessions(conversations);
    updateCursorProviderSettings(settings, { environmentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings): boolean {
    let changed = false;
    const normalizeSelection = (value: unknown): string | null => {
      if (typeof value !== 'string' || !isCursorModelSelectionId(value)) {
        return null;
      }
      if (value === CURSOR_SYNTHETIC_MODEL_ID) {
        return value;
      }
      const rawId = decodeCursorModelId(value);
      return rawId
        ? encodeCursorModelId(getCursorBaseModelId(rawId))
        : CURSOR_SYNTHETIC_MODEL_ID;
    };

    const activeParameters = getSelectionParameters(settings.model);

    const model = normalizeSelection(settings.model);
    if (model && settings.model !== model) {
      settings.model = model;
      changed = true;
    }
    const activeEffort = activeParameters?.effort ?? activeParameters?.reasoning;
    if (activeEffort && settings.effortLevel !== activeEffort) {
      settings.effortLevel = activeEffort;
      changed = true;
    }
    if (activeParameters?.fast && settings.serviceTier !== activeParameters.fast) {
      settings.serviceTier = activeParameters.fast;
      changed = true;
    }
    const titleModel = normalizeSelection(settings.titleGenerationModel);
    if (titleModel && settings.titleGenerationModel !== titleModel) {
      settings.titleGenerationModel = titleModel;
      changed = true;
    }

    if (isRecord(settings.savedProviderModel)) {
      const savedParameters = getSelectionParameters(settings.savedProviderModel.cursor);
      const savedModel = normalizeSelection(settings.savedProviderModel.cursor);
      if (savedModel && settings.savedProviderModel.cursor !== savedModel) {
        settings.savedProviderModel.cursor = savedModel;
        changed = true;
      }
      const savedEffort = savedParameters?.effort ?? savedParameters?.reasoning;
      if (savedEffort) {
        const savedEfforts = ensureRecord(settings, 'savedProviderEffort');
        if (savedEfforts.cursor !== savedEffort) {
          savedEfforts.cursor = savedEffort;
          changed = true;
        }
      }
      if (savedParameters?.fast) {
        const savedServiceTiers = ensureRecord(settings, 'savedProviderServiceTier');
        if (savedServiceTiers.cursor !== savedParameters.fast) {
          savedServiceTiers.cursor = savedParameters.fast;
          changed = true;
        }
      }
    }

    const current = getCursorProviderSettings(settings);
    const visibleModels = normalizeCursorVisibleModels(
      current.visibleModels,
      current.discoveredModels,
    );
    const storedConfig = getProviderConfig(settings, 'cursor');
    if (Object.keys(storedConfig).length > 0) {
      const before = JSON.stringify(storedConfig);
      updateCursorProviderSettings(settings, { ...current, visibleModels });
      if (JSON.stringify(getProviderConfig(settings, 'cursor')) !== before) {
        changed = true;
      }
    }
    return changed;
  },
};

function getSelectionParameters(value: unknown): Record<string, string> | null {
  if (typeof value !== 'string') {
    return null;
  }
  const rawId = decodeCursorModelId(value);
  return rawId ? parseCursorParameterizedModelId(rawId).parameters : null;
}

function ensureRecord(
  settings: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  if (isRecord(settings[key])) {
    return settings[key];
  }
  const record: Record<string, unknown> = {};
  settings[key] = record;
  return record;
}

function computeCursorEnvironmentHash(environmentText: string): string {
  const environment = parseEnvironmentVariables(environmentText);
  const entries = CURSOR_ENV_HASH_KEYS
    .filter(key => environment[key])
    .map(key => `${key}=${environment[key]}`)
    .sort();
  return entries.length > 0
    ? createHash('sha256').update(entries.join('|')).digest('hex')
    : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
