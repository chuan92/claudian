import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { getVaultPath } from '../../../utils/path';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpRequestPermissionResponse,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  extractAcpSessionModelState,
} from '../../acp';
import {
  CURSOR_SYNTHETIC_MODEL_ID,
  decodeCursorModelId,
  getCursorBaseModelId,
  normalizeCursorDiscoveredModels,
  resolveCursorAcpModelId,
} from '../models';
import { wrapCursorPromptWithSystemInstructions } from './buildCursorPrompt';
import { CURSOR_ACP_CLIENT_CAPABILITIES } from './CursorAcpCapabilities';
import { buildCursorAcpLaunchSpec } from './CursorLaunchSpec';
import { buildCursorRuntimeEnv } from './CursorRuntimeEnvironment';

export class CursorAuxQueryRunner implements AuxQueryRunner {
  private availableModels = normalizeCursorDiscoveredModels([]);
  private availableModelIds = new Set<string>();
  private connection: AcpClientConnection | null = null;
  private currentLaunchKey: string | null = null;
  private currentModelId: string | null = null;
  private process: AcpSubprocess | null = null;
  private sessionId: string | null = null;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  private systemInstructionsPending = true;
  private transport: AcpJsonRpcTransport | null = null;

  constructor(private readonly plugin: ProviderHost) {}

  async query(config: AuxQueryConfig, prompt: string): Promise<string> {
    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    await this.ensureReady(cwd);
    if (!this.connection) {
      throw new Error('Cursor runtime is not ready.');
    }
    if (!this.sessionId) {
      await this.createSession(cwd);
    }

    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new Error('Failed to create a Cursor session.');
    }

    await this.applyModel(sessionId, this.resolveSelectedRawModel(config.model));
    this.sessionUpdateNormalizer.reset();
    let accumulatedText = '';
    const removeListener = this.connection.onSessionNotification((notification) => {
      if (notification.sessionId !== sessionId) {
        return;
      }
      const normalized = this.sessionUpdateNormalizer.normalize(notification.update);
      if (normalized.type !== 'message_chunk' || normalized.role !== 'assistant') {
        return;
      }
      for (const chunk of normalized.streamChunks) {
        if (chunk.type === 'text') {
          accumulatedText += chunk.content;
          config.onTextChunk?.(accumulatedText);
        }
      }
    });
    const abortHandler = () => this.connection?.cancel({ sessionId });
    config.abortController?.signal.addEventListener('abort', abortHandler, { once: true });

    try {
      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }
      const text = this.systemInstructionsPending
        ? wrapCursorPromptWithSystemInstructions(config.systemPrompt, prompt)
        : prompt;
      await this.connection.prompt({
        prompt: [{ type: 'text', text }],
        sessionId,
      });
      this.systemInstructionsPending = false;
      if (config.abortController?.signal.aborted) {
        throw new Error('Cancelled');
      }
      return accumulatedText;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cursor request failed';
      const stderr = this.process?.getStderrSnapshot();
      throw new Error(
        stderr ? `${message}\n\n${stderr}` : message,
        error instanceof Error ? { cause: error } : undefined,
      );
    } finally {
      config.abortController?.signal.removeEventListener('abort', abortHandler);
      removeListener();
    }
  }

  reset(): void {
    this.availableModels = [];
    this.availableModelIds.clear();
    this.connection?.dispose();
    this.connection = null;
    this.currentLaunchKey = null;
    this.currentModelId = null;
    this.sessionId = null;
    this.sessionUpdateNormalizer.reset();
    this.systemInstructionsPending = true;
    this.transport?.dispose();
    this.transport = null;
    if (this.process) {
      void this.process.shutdown().catch(() => {});
      this.process = null;
    }
  }

  private async ensureReady(cwd: string): Promise<void> {
    const command = await this.plugin.getResolvedProviderCliPath('cursor') ?? 'cursor-agent';
    const environmentText = getRuntimeEnvironmentText(this.plugin.settings, 'cursor');
    const launchSpec = buildCursorAcpLaunchSpec({
      command,
      cwd,
      env: buildCursorRuntimeEnv(this.plugin.settings, command),
      environmentKey: environmentText,
      force: false,
    });
    const shouldRestart = !this.process
      || !this.connection
      || !this.transport
      || !this.process.isAlive()
      || this.transport.isClosed
      || this.currentLaunchKey !== launchSpec.launchKey;
    if (!shouldRestart) {
      return;
    }

    this.reset();
    this.process = new AcpSubprocess(launchSpec);
    this.process.start();
    this.transport = new AcpJsonRpcTransport({
      input: this.process.stdout,
      onClose: listener => this.process!.onClose(listener),
      output: this.process.stdin,
    });
    this.connection = new AcpClientConnection({
      clientInfo: {
        name: 'claudian-aux',
        version: this.plugin.manifest?.version ?? '0.0.0',
      },
      delegate: {
        requestPermission: request => Promise.resolve(rejectPermission(request.options)),
      },
      transport: this.transport,
    });
    this.transport.start();
    await this.connection.initialize({
      clientCapabilities: CURSOR_ACP_CLIENT_CAPABILITIES,
    });
    this.currentLaunchKey = launchSpec.launchKey;
  }

  private async createSession(cwd: string): Promise<void> {
    if (!this.connection) {
      return;
    }
    const response = await this.connection.newSession({ cwd, mcpServers: [] });
    this.sessionId = response.sessionId;
    this.syncSessionModelState(response);
    const modeResponse = await this.connection.setConfigOption({
      configId: 'mode',
      sessionId: response.sessionId,
      type: 'select',
      value: 'ask',
    });
    this.syncSessionModelState(modeResponse);
  }

  private async applyModel(sessionId: string, modelId: string | null): Promise<void> {
    if (
      !this.connection
      || !modelId
      || modelId === this.currentModelId
      || (this.availableModelIds.size > 0 && !this.availableModelIds.has(modelId))
    ) {
      return;
    }
    const response = await this.connection.setConfigOption({
      configId: 'model',
      sessionId,
      type: 'select',
      value: modelId,
    });
    this.currentModelId = modelId;
    this.syncSessionModelState(response);
  }

  private resolveSelectedRawModel(explicitModel?: string): string | null {
    const settings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings,
      'cursor',
    );
    const selection = explicitModel?.trim()
      || (typeof settings.model === 'string' ? settings.model.trim() : '');
    if (!selection || selection === CURSOR_SYNTHETIC_MODEL_ID) {
      return null;
    }
    const rawId = decodeCursorModelId(selection) ?? selection;
    return resolveCursorAcpModelId(getCursorBaseModelId(rawId), this.availableModels);
  }

  private syncSessionModelState(params: Parameters<typeof extractAcpSessionModelState>[0]): void {
    const state = extractAcpSessionModelState(params);
    if (state.currentModelId) {
      this.currentModelId = state.currentModelId;
    }
    const availableModels = normalizeCursorDiscoveredModels(state.availableModels);
    if (availableModels.length > 0) {
      this.availableModels = availableModels;
      this.availableModelIds = new Set(this.availableModels.map(model => model.rawId));
    }
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
