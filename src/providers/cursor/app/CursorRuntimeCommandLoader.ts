import type {
  ProviderRuntimeCommandLoader,
  ProviderRuntimeCommandLoaderContext,
} from '../../../core/providers/types';
import { CursorChatRuntime } from '../runtime/CursorChatRuntime';
import { getCursorProviderSettings } from '../settings';

export class CursorRuntimeCommandLoader implements ProviderRuntimeCommandLoader {
  isAvailable(settings: Record<string, unknown>): boolean {
    return getCursorProviderSettings(settings).enabled;
  }

  async loadCommands(context: ProviderRuntimeCommandLoaderContext) {
    const hasSession = Boolean(context.conversation?.sessionId);
    const canReuseRuntime = context.runtime?.providerId === 'cursor' && context.runtime.isReady();
    if (!hasSession && !canReuseRuntime) {
      return [];
    }

    const runtime = canReuseRuntime
      ? context.runtime!
      : new CursorChatRuntime(context.plugin);
    try {
      if (context.conversation) {
        runtime.syncConversationState(context.conversation, context.externalContextPaths);
      }
      if (!(await runtime.ensureReady({ allowSessionCreation: false }))) {
        return [];
      }
      return await runtime.getSupportedCommands();
    } finally {
      if (runtime !== context.runtime) {
        runtime.cleanup();
      }
    }
  }
}
