import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { CursorCommandCatalog } from '../commands/CursorCommandCatalog';
import { CursorCliResolver } from '../runtime/CursorCliResolver';
import { cursorSettingsTabRenderer } from '../ui/CursorSettingsTab';
import { CursorRuntimeCommandLoader } from './CursorRuntimeCommandLoader';

export interface CursorWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: CursorCommandCatalog;
  cliResolver: CursorCliResolver;
}

export async function createCursorWorkspaceServices(): Promise<CursorWorkspaceServices> {
  return {
    cliResolver: new CursorCliResolver(),
    commandCatalog: new CursorCommandCatalog(),
    runtimeCommandLoader: new CursorRuntimeCommandLoader(),
    settingsTabRenderer: cursorSettingsTabRenderer,
    tabWarmupPolicy: { resolveMode: () => 'none' },
  };
}

export const cursorWorkspaceRegistration: ProviderWorkspaceRegistration<CursorWorkspaceServices> = {
  initialize: async () => createCursorWorkspaceServices(),
};

export function maybeGetCursorWorkspaceServices(): CursorWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('cursor') as CursorWorkspaceServices | null;
}
