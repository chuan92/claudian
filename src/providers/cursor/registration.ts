import type { ProviderModule } from '../../core/providers/types';
import { cursorWorkspaceRegistration } from './app/CursorWorkspaceServices';
import { CursorInlineEditService } from './auxiliary/CursorInlineEditService';
import { CursorInstructionRefineService } from './auxiliary/CursorInstructionRefineService';
import { CursorTaskResultInterpreter } from './auxiliary/CursorTaskResultInterpreter';
import { CursorTitleGenerationService } from './auxiliary/CursorTitleGenerationService';
import { CURSOR_PROVIDER_CAPABILITIES } from './capabilities';
import { cursorSettingsReconciler } from './env/CursorSettingsReconciler';
import { CursorConversationHistoryService } from './history/CursorConversationHistoryService';
import { CursorChatRuntime } from './runtime/CursorChatRuntime';
import { getCursorProviderSettings, updateCursorProviderSettings } from './settings';
import { cursorChatUIConfig } from './ui/CursorChatUIConfig';

export const cursorProviderRegistration: ProviderModule = {
  id: 'cursor',
  blankTabOrder: 12,
  capabilities: CURSOR_PROVIDER_CAPABILITIES,
  chatUIConfig: cursorChatUIConfig,
  createInlineEditService: plugin => new CursorInlineEditService(plugin),
  createInstructionRefineService: plugin => new CursorInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => new CursorChatRuntime(plugin),
  createTitleGenerationService: plugin => new CursorTitleGenerationService(plugin),
  displayName: 'Cursor',
  environmentKeyPatterns: [/^CURSOR_/i],
  historyService: new CursorConversationHistoryService(),
  isEnabled: settings => getCursorProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateCursorProviderSettings(settings, { enabled }),
  settingsReconciler: cursorSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateCursorProviderSettings(target, getCursorProviderSettings(stored));
      return false;
    },
  },
  taskResultInterpreter: new CursorTaskResultInterpreter(),
  workspace: cursorWorkspaceRegistration,
};
