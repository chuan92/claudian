import type {
  ProviderConversationHistoryService,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { ChatMessage, Conversation } from '../../../core/types';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpRequestPermissionResponse,
  AcpSubprocess,
} from '../../acp';
import { CURSOR_ACP_CLIENT_CAPABILITIES } from '../runtime/CursorAcpCapabilities';
import { CursorCliResolver } from '../runtime/CursorCliResolver';
import { buildCursorAcpLaunchSpec } from '../runtime/CursorLaunchSpec';
import { buildCursorRuntimeEnv } from '../runtime/CursorRuntimeEnvironment';
import { CursorHistoryAccumulator } from './CursorHistoryAccumulator';
import {
  deleteVaultCursorNativeSession,
  exportCursorNativeSessionToVault,
  importCursorNativeSessionFromVault,
} from './CursorNativeTranscriptSync';
import {
  deleteVaultCursorTranscript,
  exportCursorTranscriptToVault,
  importCursorTranscriptFromVault,
} from './CursorTranscriptSync';

export interface CursorHistoryLoadContext {
  environment: NodeJS.ProcessEnv;
  settings: Record<string, unknown>;
  vaultPath: string | null;
}

export type CursorHistoryLoader = (
  sessionId: string,
  context: CursorHistoryLoadContext,
) => Promise<ChatMessage[]>;

export class CursorConversationHistoryService implements ProviderConversationHistoryService {
  private readonly hydratedKeys = new Map<string, string>();

  constructor(private readonly loader: CursorHistoryLoader = loadCursorSessionMessages) {}

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const sessionId = conversation.sessionId;
    if (!sessionId) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const resolvedVaultPath = vaultPath ?? pathContext?.vaultPath ?? null;
    const hydrationKey = `${sessionId}::${resolvedVaultPath ?? ''}`;
    if (
      conversation.messages.length > 0
      && this.hydratedKeys.get(conversation.id) === hydrationKey
    ) {
      return;
    }

    const messages = await this.loader(sessionId, {
      environment: pathContext?.environment ?? process.env,
      settings: pathContext?.settings ?? {},
      vaultPath: resolvedVaultPath,
    });
    if (messages.length === 0) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    conversation.messages = messages;
    this.hydratedKeys.set(conversation.id, hydrationKey);
  }

  async ensureLocalTranscripts(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<boolean> {
    if (!vaultPath) {
      return false;
    }

    const [nativeImport, portableImport] = await Promise.allSettled([
      importCursorNativeSessionFromVault(vaultPath, conversation, pathContext),
      importCursorTranscriptFromVault(vaultPath, conversation.id),
    ]);
    if (
      portableImport.status === 'fulfilled'
      && portableImport.value.length > conversation.messages.length
    ) {
      conversation.messages = portableImport.value;
    }
    return nativeImport.status === 'fulfilled' && nativeImport.value;
  }

  async exportTranscripts(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    if (vaultPath) {
      await Promise.allSettled([
        exportCursorNativeSessionToVault(vaultPath, conversation, pathContext),
        exportCursorTranscriptToVault(vaultPath, conversation),
      ]);
    }
  }

  async deleteConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void> {
    this.hydratedKeys.delete(conversation.id);
    if (vaultPath) {
      await Promise.allSettled([
        deleteVaultCursorNativeSession(vaultPath, conversation.id),
        deleteVaultCursorTranscript(vaultPath, conversation.id),
      ]);
    }
    // Removing Claudian metadata must never delete Cursor's native session.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  buildForkProviderState(
    _sourceSessionId: string,
    _resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {};
  }
}

export async function loadCursorSessionMessages(
  sessionId: string,
  context: CursorHistoryLoadContext,
): Promise<ChatMessage[]> {
  const cwd = context.vaultPath ?? process.cwd();
  const command = new CursorCliResolver().resolveFromSettings(context.settings)
    ?? 'cursor-agent';
  const launchSpec = buildCursorAcpLaunchSpec({
    command,
    cwd,
    env: buildCursorRuntimeEnv(context.settings, command, context.environment),
    force: false,
  });
  const subprocess = new AcpSubprocess(launchSpec);
  const accumulator = new CursorHistoryAccumulator(sessionId);
  let transport: AcpJsonRpcTransport | null = null;
  let connection: AcpClientConnection | null = null;

  try {
    subprocess.start();
    transport = new AcpJsonRpcTransport({
      input: subprocess.stdout,
      onClose: listener => subprocess.onClose(listener),
      output: subprocess.stdin,
    });
    connection = new AcpClientConnection({
      clientInfo: { name: 'claudian-history', version: '1.0.0' },
      delegate: {
        onSessionNotification(notification) {
          if (notification.sessionId === sessionId) {
            accumulator.push(notification.update);
          }
        },
        requestPermission: request => Promise.resolve(rejectPermission(request.options)),
      },
      transport,
    });
    transport.start();
    await connection.initialize({
      clientCapabilities: CURSOR_ACP_CLIENT_CAPABILITIES,
    });
    await connection.loadSession({ cwd, mcpServers: [], sessionId });
    return accumulator.toMessages();
  } catch {
    return [];
  } finally {
    connection?.dispose();
    transport?.dispose();
    await subprocess.shutdown().catch(() => {});
  }
}

function rejectPermission(
  options: Array<{ kind: string; optionId: string }>,
): AcpRequestPermissionResponse {
  const option = options.find(entry => entry.kind === 'reject_once')
    ?? options.find(entry => entry.kind === 'reject_always');
  return option
    ? { outcome: { optionId: option.optionId, outcome: 'selected' } }
    : { outcome: { outcome: 'cancelled' } };
}
