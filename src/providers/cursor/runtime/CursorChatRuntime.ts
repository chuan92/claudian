import {
  buildSystemPrompt,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderCapabilities } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  ApprovalDecisionOption,
  AskUserQuestionCallback,
  AutoTurnCallback,
  ChatRewindMode,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  PreparedChatTurn,
  SessionUpdateResult,
} from '../../../core/runtime/types';
import type {
  ApprovalDecision,
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  SlashCommand,
  StreamChunk,
  ToolCallInfo,
} from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
  type AcpSessionModeState,
  type AcpSessionNotification,
  AcpSessionUpdateNormalizer,
  AcpSubprocess,
  type AcpUsage,
  type AcpUsageUpdate,
  buildAcpUsageInfo,
  extractAcpSessionModelState,
  extractAcpSessionModeState,
} from '../../acp';
import { CURSOR_PROVIDER_CAPABILITIES } from '../capabilities';
import {
  extractCursorSessionModelConfig,
  toPersistedCursorModelConfiguration,
} from '../modelConfig';
import {
  CURSOR_SYNTHETIC_MODEL_ID,
  decodeCursorModelId,
  encodeCursorModelId,
  getCursorBaseModelId,
  isCursorModelSelectionId,
  normalizeCursorDiscoveredModels,
  resolveCursorAcpModelId,
} from '../models';
import {
  resolveCursorModeForPermissionMode,
  resolvePermissionModeForCursorMode,
} from '../modes';
import { getCursorProviderSettings, updateCursorProviderSettings } from '../settings';
import { buildCursorPromptBlocks, buildCursorPromptText } from './buildCursorPrompt';
import { CURSOR_ACP_CLIENT_CAPABILITIES } from './CursorAcpCapabilities';
import { buildCursorAcpLaunchSpec, type CursorAcpLaunchSpec } from './CursorLaunchSpec';
import { buildCursorRuntimeEnv } from './CursorRuntimeEnvironment';

interface ActiveTurn {
  cancelled: boolean;
  queue: StreamChunkQueue;
  sessionId: string;
}

class StreamChunkQueue {
  private closed = false;
  private readonly items: StreamChunk[] = [];
  private readonly waiters: Array<(chunk: StreamChunk | null) => void> = [];

  push(chunk: StreamChunk): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(chunk);
    } else {
      this.items.push(chunk);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(null);
    }
  }

  async next(): Promise<StreamChunk | null> {
    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }
    if (this.closed) {
      return null;
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

export class CursorChatRuntime implements ChatRuntime {
  readonly providerId = 'cursor' as const;

  private activeTurn: ActiveTurn | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private connection: AcpClientConnection | null = null;
  private connectionGeneration = 0;
  private contextUsage: AcpUsageUpdate | null = null;
  private conversationGeneration = 0;
  private conversationId: string | null = null;
  private currentConversationModel: string | null = null;
  private currentSessionEffortConfigId: string | null = null;
  private currentSessionEffortValue: string | null = null;
  private currentSessionEffortValues = new Set<string>();
  private currentSessionFastConfigId: string | null = null;
  private currentSessionFastValue: string | null = null;
  private currentSessionFastValues = new Set<string>();
  private currentSessionModelId: string | null = null;
  private currentSessionModeId: string | null = null;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private disposed = false;
  private externalContextPaths: string[] = [];
  private lifecycleGeneration = 0;
  private loadedSessionId: string | null = null;
  private permissionModeSyncCallback: ((mode: string) => void) | null = null;
  private process: AcpSubprocess | null = null;
  private promptUsage: AcpUsage | null = null;
  private readonly readyListeners: Array<(ready: boolean) => void> = [];
  private ready = false;
  private readinessFlight: { key: string; promise: Promise<boolean> } | null = null;
  private restartRequiredAfterCancel = false;
  private sessionId: string | null = null;
  private sessionInvalidated = false;
  private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
  private supportedCommands: SlashCommand[] = [];
  private readonly supportedCommandWaiters: Array<(commands: SlashCommand[]) => void> = [];
  private systemInstructionsPending = true;
  private transport: AcpJsonRpcTransport | null = null;
  private unregisterTransportClose: (() => void) | null = null;

  constructor(private readonly plugin: ProviderHost) {}

  getCapabilities(): Readonly<ProviderCapabilities> {
    return CURSOR_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return {
      isCompact: false,
      mcpMentions: request.enabledMcpServers ?? new Set(),
      persistedContent: '',
      prompt: buildCursorPromptText(request),
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.push(listener);
    return () => {
      const index = this.readyListeners.indexOf(listener);
      if (index >= 0) {
        this.readyListeners.splice(index, 1);
      }
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {}

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    externalContextPaths: string[] = [],
  ): void {
    this.setCurrentConversationModel(conversation?.selectedModel);
    const nextConversationId = conversation?.id ?? null;
    const nextSessionId = conversation?.sessionId ?? null;
    const nextExternalContextPaths = normalizeStringList(externalContextPaths);
    const externalContextChanged = !sameStringList(
      nextExternalContextPaths,
      this.externalContextPaths,
    );
    const targetChanged = nextConversationId !== this.conversationId
      || nextSessionId !== this.sessionId
      || externalContextChanged;

    if (nextSessionId !== this.sessionId) {
      this.resetSessionModelControls();
      this.currentSessionModelId = null;
      this.currentSessionModeId = null;
      this.sessionInvalidated = false;
      this.systemInstructionsPending = !nextSessionId;
      this.setSupportedCommands([]);
    }
    if (externalContextChanged && nextSessionId) {
      this.loadedSessionId = null;
      this.setSupportedCommands([]);
    }
    this.conversationId = nextConversationId;
    this.sessionId = nextSessionId;
    this.externalContextPaths = nextExternalContextPaths;

    if (targetChanged) {
      this.conversationGeneration += 1;
      if (this.readinessFlight) {
        void this.shutdownProcess();
      }
    }
  }

  async reloadMcpServers(): Promise<void> {}

  async warmModelMetadata(model: string): Promise<boolean> {
    const rawModelId = decodeCursorModelId(model);
    if (!rawModelId) {
      return false;
    }
    const baseModelId = getCursorBaseModelId(rawModelId);
    const normalizedModel = encodeCursorModelId(baseModelId);
    this.setCurrentConversationModel(normalizedModel);
    const conversationGeneration = this.conversationGeneration;

    if (!(await this.ensureReady({ allowSessionCreation: true }))) {
      return false;
    }
    if (
      !this.connection
      || !this.sessionId
      || !this.isConversationCurrent(conversationGeneration)
    ) {
      return false;
    }

    await this.applySelectedModel(
      this.sessionId,
      { model: normalizedModel },
      conversationGeneration,
    );
    if (!this.isConversationCurrent(conversationGeneration)) {
      return false;
    }
    return Boolean(
      getCursorProviderSettings(this.plugin.settings).modelConfigurations[baseModelId],
    );
  }

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    if (this.disposed) {
      return false;
    }
    const conversationGeneration = this.conversationGeneration;
    const key = JSON.stringify({ conversationGeneration, options: options ?? {} });
    if (this.readinessFlight) {
      if (this.readinessFlight.key === key) {
        return this.readinessFlight.promise;
      }
      await this.readinessFlight.promise.catch(() => undefined);
      return this.ensureReady(options);
    }

    const lifecycleGeneration = this.lifecycleGeneration;
    const promise = this.ensureReadyInternal(
      options,
      lifecycleGeneration,
      conversationGeneration,
    );
    this.readinessFlight = { key, promise };
    return promise.finally(() => {
      if (this.readinessFlight?.promise === promise) {
        this.readinessFlight = null;
      }
    });
  }

  private async ensureReadyInternal(
    options: ChatRuntimeEnsureReadyOptions | undefined,
    lifecycleGeneration: number,
    conversationGeneration: number,
  ): Promise<boolean> {
    if (!getCursorProviderSettings(this.plugin.settings).enabled) {
      this.setReady(false);
      return false;
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const targetSessionId = this.sessionId;
    const command = await this.plugin.getResolvedProviderCliPath('cursor') ?? 'cursor-agent';
    const projectedSettings = this.getProviderSettings();
    const force = projectedSettings.permissionMode === 'yolo';
    const environmentText = getRuntimeEnvironmentText(this.plugin.settings, 'cursor');
    const launchSpec = buildCursorAcpLaunchSpec({
      command,
      cwd,
      env: buildCursorRuntimeEnv(this.plugin.settings, command),
      environmentKey: environmentText,
      force,
    });
    if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
      return false;
    }

    const shouldRestart = !this.process
      || !this.transport
      || !this.connection
      || !this.process.isAlive()
      || this.transport.isClosed
      || options?.force === true
      || this.restartRequiredAfterCancel
      || this.currentLaunchKey !== launchSpec.launchKey;
    if (shouldRestart) {
      await this.shutdownProcess();
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        return false;
      }
      await this.startProcess(launchSpec);
      if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
        await this.shutdownProcess();
        return false;
      }
      this.currentLaunchKey = launchSpec.launchKey;
      this.loadedSessionId = null;
      this.restartRequiredAfterCancel = false;
      this.setReady(true);
    }

    if (targetSessionId) {
      if (this.loadedSessionId !== targetSessionId) {
        const loaded = await this.loadSession(targetSessionId, cwd, conversationGeneration);
        if (!this.isReadinessCurrent(lifecycleGeneration, conversationGeneration)) {
          await this.shutdownProcess();
          return false;
        }
        if (!loaded) {
          this.sessionInvalidated = true;
          this.clearActiveSession();
        }
      }
      return true;
    }

    if (!this.sessionId && !this.sessionInvalidated) {
      if (options?.allowSessionCreation === false) {
        return true;
      }
      return Boolean(await this.createSession(cwd, conversationGeneration));
    }
    return true;
  }

  private currentLaunchKey: string | null = null;

  async *query(
    turn: PreparedChatTurn,
    conversationHistory: ChatMessage[] = [],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    if (this.activeTurn) {
      yield { type: 'error', content: 'Cursor does not support overlapping turns.' };
      yield { type: 'done' };
      return;
    }
    if (queryOptions?.model) {
      this.setCurrentConversationModel(queryOptions.model);
    }

    const conversationGeneration = this.conversationGeneration;
    const expectedSessionId = this.sessionId;
    let shouldBootstrapHistory = conversationHistory.length > 0
      && (!expectedSessionId || this.sessionInvalidated);

    try {
      if (!(await this.ensureReady())) {
        yield { type: 'error', content: 'Failed to start Cursor. Check the CLI path and login state.' };
        yield { type: 'done' };
        return;
      }
    } catch (error) {
      yield { type: 'error', content: this.formatRuntimeError(error) };
      yield { type: 'done' };
      return;
    }

    if (!this.isConversationCurrent(conversationGeneration)) {
      yield { type: 'error', content: 'Cursor conversation changed before the turn started.' };
      yield { type: 'done' };
      return;
    }
    if (!this.connection) {
      yield { type: 'error', content: 'Cursor runtime is not ready.' };
      yield { type: 'done' };
      return;
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    if (expectedSessionId && !this.sessionId) {
      shouldBootstrapHistory = conversationHistory.length > 0;
    }
    if (!this.sessionId) {
      if (!(await this.createSession(cwd, conversationGeneration))) {
        yield { type: 'error', content: 'Failed to create a Cursor session.' };
        yield { type: 'done' };
        return;
      }
    }

    const sessionId = this.sessionId!;
    const activeTurn: ActiveTurn = {
      cancelled: false,
      queue: new StreamChunkQueue(),
      sessionId,
    };
    this.activeTurn = activeTurn;
    this.contextUsage = null;
    this.currentTurnMetadata = {};
    this.promptUsage = null;
    this.sessionUpdateNormalizer.reset();

    try {
      await this.applySelectedMode(sessionId, conversationGeneration);
      await this.applySelectedModel(sessionId, queryOptions, conversationGeneration);
      await this.applySelectedEffort(sessionId, conversationGeneration);
      await this.applySelectedFast(sessionId, conversationGeneration);
      if (!this.isConversationCurrent(conversationGeneration)) {
        throw new Error('Cursor conversation changed before the turn started.');
      }
    } catch (error) {
      yield { type: 'error', content: this.formatRuntimeError(error) };
      yield { type: 'done' };
      activeTurn.queue.close();
      this.activeTurn = null;
      return;
    }

    const systemInstructions = this.systemInstructionsPending
      ? buildSystemPrompt(this.getSystemPromptSettings(cwd))
      : undefined;
    this.currentTurnMetadata.wasSent = true;
    const promptPromise = this.connection.prompt({
      prompt: buildCursorPromptBlocks(
        turn.request,
        shouldBootstrapHistory ? conversationHistory : [],
        systemInstructions,
      ),
      sessionId,
    }).then((response) => {
      this.systemInstructionsPending = false;
      if (response.userMessageId) {
        this.currentTurnMetadata.userMessageId = response.userMessageId;
      }
      this.promptUsage = response.usage ?? null;
      const usage = buildAcpUsageInfo({
        contextWindow: this.contextUsage,
        model: this.getActiveDisplayModel(queryOptions),
        promptUsage: this.promptUsage,
      });
      if (usage) {
        activeTurn.queue.push({ sessionId, type: 'usage', usage });
      }
      activeTurn.queue.push({ type: 'done' });
      activeTurn.queue.close();
    }).catch((error) => {
      activeTurn.queue.push({ type: 'error', content: this.formatRuntimeError(error) });
      activeTurn.queue.push({ type: 'done' });
      activeTurn.queue.close();
    }).finally(() => {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
      }
    });

    try {
      for (;;) {
        const chunk = await activeTurn.queue.next();
        if (!chunk) {
          break;
        }
        yield chunk;
      }
      if (!activeTurn.cancelled) {
        await promptPromise;
      }
    } finally {
      if (this.activeTurn === activeTurn) {
        this.activeTurn = null;
      }
    }
  }

  cancel(): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.cancelled) {
      return;
    }
    this.connection?.cancel({ sessionId: activeTurn.sessionId });
    this.restartRequiredAfterCancel = true;
    this.settleActiveTurn();
  }

  resetSession(): void {
    this.clearActiveSession();
    this.sessionInvalidated = false;
    this.systemInstructionsPending = true;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  consumeSessionInvalidation(): boolean {
    const invalidated = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return invalidated;
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    if (this.supportedCommands.length > 0) {
      return this.supportedCommands.map(command => ({ ...command }));
    }
    if (!this.sessionId || this.loadedSessionId !== this.sessionId) {
      return [];
    }
    return this.waitForSupportedCommands();
  }

  getAuxiliaryModel(): string | null {
    return this.currentConversationModel ?? this.getActiveDisplayModel() ?? null;
  }

  cleanup(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.activeTurn?.queue.close();
    void this.shutdownProcess();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string | undefined,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    return { canRewind: false };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(_dismisser: (() => void) | null): void {}
  setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}
  setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setAutoTurnCallback(_callback: AutoTurnCallback | null): void {}

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.currentTurnMetadata;
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    return {
      updates: {
        sessionId: params.sessionInvalidated && !this.sessionId ? null : this.sessionId,
      },
    };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    return this.sessionId ?? conversation?.sessionId ?? null;
  }

  async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
    return [];
  }

  async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
    return null;
  }

  private async startProcess(launchSpec: CursorAcpLaunchSpec): Promise<void> {
    this.process = new AcpSubprocess(launchSpec);
    this.process.start();
    this.transport = new AcpJsonRpcTransport({
      input: this.process.stdout,
      onClose: listener => this.process!.onClose(listener),
      output: this.process.stdin,
    });
    const transport = this.transport;
    this.unregisterTransportClose = transport.onClose((error) => {
      if (this.transport === transport) {
        this.setReady(false);
        this.settleActiveTurn(error ?? new Error('Cursor runtime closed'));
      }
    });

    const connectionGeneration = ++this.connectionGeneration;
    this.connection = new AcpClientConnection({
      clientInfo: {
        name: 'claudian',
        version: this.plugin.manifest?.version ?? '0.0.0',
      },
      delegate: {
        onSessionNotification: notification => this.handleSessionNotification(
          notification,
          connectionGeneration,
        ),
        requestPermission: request => this.handlePermissionRequest(request),
      },
      transport,
    });
    transport.start();
    await this.connection.initialize({
      clientCapabilities: CURSOR_ACP_CLIENT_CAPABILITIES,
    });
  }

  private async shutdownProcess(): Promise<void> {
    this.connectionGeneration += 1;
    this.setReady(false);
    this.settleActiveTurn();
    this.resetSessionModelControls();
    this.currentSessionModelId = null;
    this.currentSessionModeId = null;
    this.setSupportedCommands([]);
    this.unregisterTransportClose?.();
    this.unregisterTransportClose = null;
    this.connection?.dispose();
    this.connection = null;
    this.transport?.dispose();
    this.transport = null;
    if (this.process) {
      await this.process.shutdown().catch(() => {});
      this.process = null;
    }
  }

  private async createSession(
    cwd: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<string | null> {
    if (!this.connection) {
      return null;
    }
    try {
      this.setSupportedCommands([]);
      const response = await this.connection.newSession({
        additionalDirectories: this.externalContextPaths,
        cwd,
        mcpServers: [],
      });
      if (!this.isConversationCurrent(conversationGeneration)) {
        return null;
      }
      this.loadedSessionId = response.sessionId;
      this.sessionId = response.sessionId;
      this.systemInstructionsPending = true;
      await this.syncSessionModelState(response, conversationGeneration);
      await this.syncSessionModeState(response, conversationGeneration, false);
      return response.sessionId;
    } catch {
      return null;
    }
  }

  private async loadSession(
    sessionId: string,
    cwd: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<boolean> {
    if (!this.connection) {
      return false;
    }
    try {
      this.setSupportedCommands([]);
      const response = await this.connection.loadSession({
        additionalDirectories: this.externalContextPaths,
        cwd,
        mcpServers: [],
        sessionId,
      });
      if (!this.isConversationCurrent(conversationGeneration)) {
        return false;
      }
      this.loadedSessionId = response.sessionId;
      this.sessionId = response.sessionId;
      this.sessionInvalidated = false;
      this.systemInstructionsPending = false;
      await this.syncSessionModelState(response, conversationGeneration);
      await this.syncSessionModeState(response, conversationGeneration, false);
      return true;
    } catch {
      return false;
    }
  }

  private resolveSelectedRawModelId(queryOptions?: ChatRuntimeQueryOptions): string | null {
    const settings = this.getProviderSettings();
    const selection = typeof queryOptions?.model === 'string'
      ? queryOptions.model
      : typeof settings.model === 'string'
        ? settings.model
        : '';
    const rawId = decodeCursorModelId(selection);
    if (!rawId) {
      return null;
    }
    const discovered = getCursorProviderSettings(settings).discoveredModels;
    return resolveCursorAcpModelId(rawId, discovered);
  }

  private async applySelectedModel(
    sessionId: string,
    queryOptions?: ChatRuntimeQueryOptions,
    conversationGeneration = this.conversationGeneration,
  ): Promise<void> {
    const rawId = this.resolveSelectedRawModelId(queryOptions);
    if (!this.connection || !rawId || rawId === this.currentSessionModelId) {
      return;
    }
    const response = await this.connection.setConfigOption({
      configId: 'model',
      sessionId,
      type: 'select',
      value: rawId,
    });
    if (!this.isConversationCurrent(conversationGeneration)) {
      return;
    }
    this.currentSessionModelId = rawId;
    await this.syncSessionModelState(response, conversationGeneration);
  }

  private async applySelectedEffort(
    sessionId: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<void> {
    const selected = this.getProviderSettings().effortLevel;
    if (
      !this.connection
      || !this.currentSessionEffortConfigId
      || typeof selected !== 'string'
      || selected === this.currentSessionEffortValue
      || !this.currentSessionEffortValues.has(selected)
    ) {
      return;
    }
    const response = await this.connection.setConfigOption({
      configId: this.currentSessionEffortConfigId,
      sessionId,
      type: 'select',
      value: selected,
    });
    if (!this.isConversationCurrent(conversationGeneration)) {
      return;
    }
    this.currentSessionEffortValue = selected;
    await this.syncSessionModelState(response, conversationGeneration);
  }

  private async applySelectedFast(
    sessionId: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<void> {
    const configured = this.getProviderSettings().serviceTier;
    const selected = configured === 'fast' ? 'true' : configured;
    if (
      !this.connection
      || !this.currentSessionFastConfigId
      || typeof selected !== 'string'
      || selected === this.currentSessionFastValue
      || !this.currentSessionFastValues.has(selected)
    ) {
      return;
    }
    const response = await this.connection.setConfigOption({
      configId: this.currentSessionFastConfigId,
      sessionId,
      type: 'select',
      value: selected,
    });
    if (!this.isConversationCurrent(conversationGeneration)) {
      return;
    }
    this.currentSessionFastValue = selected;
    await this.syncSessionModelState(response, conversationGeneration);
  }

  private resolveSelectedModeId(): string {
    return resolveCursorModeForPermissionMode(this.getProviderSettings().permissionMode);
  }

  private async applySelectedMode(
    sessionId: string,
    conversationGeneration = this.conversationGeneration,
  ): Promise<void> {
    const modeId = this.resolveSelectedModeId();
    if (!this.connection || modeId === this.currentSessionModeId) {
      return;
    }
    const response = await this.connection.setConfigOption({
      configId: 'mode',
      sessionId,
      type: 'select',
      value: modeId,
    });
    if (!this.isConversationCurrent(conversationGeneration)) {
      return;
    }
    this.currentSessionModeId = modeId;
    await this.syncSessionModeState(response, conversationGeneration);
  }

  private async syncSessionModelState(
    params: {
      configOptions?: AcpSessionConfigOption[] | null;
      models?: AcpSessionModelState | null;
    },
    conversationGeneration?: number,
  ): Promise<void> {
    if (
      conversationGeneration !== undefined
      && !this.isConversationCurrent(conversationGeneration)
    ) {
      return;
    }
    const state = extractAcpSessionModelState(params);
    const discoveredModels = normalizeCursorDiscoveredModels(state.availableModels);
    const sessionConfiguration = extractCursorSessionModelConfig(params.configOptions);
    const hasModelConfigSnapshot = Boolean(sessionConfiguration.modelId);
    if (hasModelConfigSnapshot) {
      this.currentSessionEffortConfigId = sessionConfiguration.reasoning?.configId ?? null;
      this.currentSessionEffortValue = sessionConfiguration.reasoning?.currentValue ?? null;
      this.currentSessionEffortValues = new Set(
        sessionConfiguration.reasoning?.options.map(option => option.value) ?? [],
      );
      this.currentSessionFastConfigId = sessionConfiguration.fast?.configId ?? null;
      this.currentSessionFastValue = sessionConfiguration.fast?.currentValue ?? null;
      this.currentSessionFastValues = new Set(
        sessionConfiguration.fast?.options.map(option => option.value) ?? [],
      );
    }
    if (state.currentModelId) {
      this.currentSessionModelId = state.currentModelId;
    }

    const settings = getCursorProviderSettings(this.plugin.settings);
    const effectiveDiscoveredModels = discoveredModels.length > 0
      ? discoveredModels
      : settings.discoveredModels;
    const discoveredBaseIds = [...new Set(
      effectiveDiscoveredModels.map(model => getCursorBaseModelId(model.rawId)),
    )];
    const visibleModels = settings.visibleModels.filter(
      rawId => discoveredBaseIds.includes(getCursorBaseModelId(rawId)),
    );
    const discoveryChanged = discoveredModels.length > 0
      && JSON.stringify(discoveredModels) !== JSON.stringify(settings.discoveredModels);
    const visibilityChanged = JSON.stringify(visibleModels) !== JSON.stringify(settings.visibleModels);
    const encodedCurrentModel = state.currentModelId
      ? encodeCursorModelId(getCursorBaseModelId(state.currentModelId))
      : null;
    const explicitConversationModel = this.currentConversationModel
      && this.currentConversationModel !== CURSOR_SYNTHETIC_MODEL_ID
      && decodeCursorModelId(this.currentConversationModel);
    const shouldSeedSelection = encodedCurrentModel && !explicitConversationModel
      ? this.shouldSeedModelSelection(this.plugin.settings, encodedCurrentModel)
      : false;
    const configurationModelId = sessionConfiguration.modelId
      ?? (hasModelConfigSnapshot && this.currentSessionModelId
        ? getCursorBaseModelId(this.currentSessionModelId)
        : null);
    const modelConfigurations = { ...settings.modelConfigurations };
    let configurationChanged = false;
    if (hasModelConfigSnapshot && configurationModelId) {
      const persisted = toPersistedCursorModelConfiguration(sessionConfiguration);
      const hasMetadata = Boolean(
        persisted.contextWindow || persisted.fast || persisted.reasoning,
      );
      const previous = modelConfigurations[configurationModelId];
      if (hasMetadata) {
        modelConfigurations[configurationModelId] = persisted;
        configurationChanged = JSON.stringify(previous) !== JSON.stringify(persisted);
      } else if (previous) {
        delete modelConfigurations[configurationModelId];
        configurationChanged = true;
      }
    }

    if (
      !configurationChanged
      && !discoveryChanged
      && !visibilityChanged
      && !shouldSeedSelection
    ) {
      return;
    }
    await this.plugin.mutateSettings((target) => {
      if (
        conversationGeneration !== undefined
        && !this.isConversationCurrent(conversationGeneration)
      ) {
        return;
      }
      if (configurationChanged || discoveryChanged || visibilityChanged) {
        updateCursorProviderSettings(target, {
          ...(configurationChanged ? { modelConfigurations } : {}),
          ...(discoveryChanged ? { discoveredModels } : {}),
          ...(visibilityChanged ? { visibleModels } : {}),
        });
      }
      if (encodedCurrentModel && shouldSeedSelection) {
        this.seedModelSelection(target, encodedCurrentModel);
      }
    });
    if (
      conversationGeneration === undefined
      || this.isConversationCurrent(conversationGeneration)
    ) {
      this.plugin.refreshModelSelectors?.();
    }
  }

  private async syncSessionModeState(
    params: {
      configOptions?: AcpSessionConfigOption[] | null;
      currentModeId?: string | null;
      modes?: AcpSessionModeState | null;
    },
    conversationGeneration?: number,
    emitPermissionModeSync = true,
  ): Promise<void> {
    if (
      conversationGeneration !== undefined
      && !this.isConversationCurrent(conversationGeneration)
    ) {
      return;
    }
    const state = extractAcpSessionModeState(params);
    const currentModeId = params.currentModeId ?? state.currentModeId;
    if (!currentModeId) {
      return;
    }
    this.currentSessionModeId = currentModeId;
    const currentPermissionMode = this.getProviderSettings().permissionMode === 'yolo'
      ? 'yolo'
      : 'normal';
    const permissionMode = resolvePermissionModeForCursorMode(
      currentModeId,
      currentPermissionMode,
    );
    if (emitPermissionModeSync && permissionMode && this.permissionModeSyncCallback) {
      try {
        this.permissionModeSyncCallback(permissionMode);
      } catch {
        // UI synchronization is best effort.
      }
    }
  }

  private async handleSessionNotification(
    notification: AcpSessionNotification,
    connectionGeneration = this.connectionGeneration,
  ): Promise<void> {
    if (
      connectionGeneration !== this.connectionGeneration
      || notification.sessionId !== this.sessionId
    ) {
      return;
    }
    const normalized = this.sessionUpdateNormalizer.normalize(notification.update);
    if (normalized.type === 'config_options') {
      await this.syncSessionModelState({ configOptions: normalized.configOptions });
      await this.syncSessionModeState({ configOptions: normalized.configOptions });
      return;
    }
    if (normalized.type === 'current_mode') {
      await this.syncSessionModeState({ currentModeId: normalized.currentModeId });
      return;
    }
    if (normalized.type === 'commands') {
      this.setSupportedCommands(normalized.commands);
      return;
    }
    if (!this.activeTurn || this.activeTurn.sessionId !== notification.sessionId) {
      return;
    }

    if (normalized.type === 'message_chunk') {
      if (normalized.role === 'assistant' && normalized.messageId) {
        this.currentTurnMetadata.assistantMessageId = normalized.messageId;
      }
      if (normalized.role === 'user' && normalized.messageId) {
        this.currentTurnMetadata.userMessageId = normalized.messageId;
      }
      for (const chunk of normalized.streamChunks) {
        this.activeTurn.queue.push(chunk);
      }
      return;
    }
    if (normalized.type === 'tool_call' || normalized.type === 'tool_call_update') {
      for (const chunk of normalized.streamChunks) {
        this.activeTurn.queue.push(chunk);
      }
      return;
    }
    if (normalized.type === 'usage') {
      this.contextUsage = normalized.usage;
      const usage = buildAcpUsageInfo({
        contextWindow: normalized.usage,
        model: this.getActiveDisplayModel(),
        promptUsage: this.promptUsage,
      });
      if (usage) {
        this.activeTurn.queue.push({
          sessionId: notification.sessionId,
          type: 'usage',
          usage,
        });
      }
    }
  }

  private async handlePermissionRequest(
    request: AcpRequestPermissionRequest,
  ): Promise<AcpRequestPermissionResponse> {
    const permissionMode = this.getProviderSettings().permissionMode;
    if (permissionMode === 'yolo') {
      return selectPermissionOption(request.options, ['allow_once', 'allow_always']);
    }
    if (!this.approvalCallback) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const input = normalizeApprovalInput(request.toolCall.rawInput);
    const toolName = request.toolCall.title?.trim()
      || request.toolCall.kind?.trim()
      || 'Cursor tool';
    const blockedPath = extractApprovalPath(input, request.toolCall.locations);
    const decision = await this.approvalCallback(
      toolName,
      input,
      `Cursor wants permission to use ${toolName}.`,
      {
        ...(blockedPath ? { blockedPath } : {}),
        decisionOptions: buildApprovalDecisionOptions(request.options),
      },
    );
    return mapApprovalDecision(decision, request.options);
  }

  private getProviderSettings(): Record<string, unknown> {
    const settings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings,
      this.providerId,
    );
    if (this.currentConversationModel) {
      settings.model = this.currentConversationModel;
    }
    return settings;
  }

  private setCurrentConversationModel(model: unknown): void {
    const selection = typeof model === 'string' ? model.trim() : '';
    this.currentConversationModel = selection || null;
  }

  private getActiveDisplayModel(queryOptions?: ChatRuntimeQueryOptions): string | undefined {
    const settings = this.getProviderSettings();
    const selection = typeof queryOptions?.model === 'string'
      ? queryOptions.model
      : typeof settings.model === 'string'
        ? settings.model
        : '';
    if (selection && selection !== CURSOR_SYNTHETIC_MODEL_ID && isCursorModelSelectionId(selection)) {
      return selection;
    }
    return this.currentSessionModelId
      ? encodeCursorModelId(getCursorBaseModelId(this.currentSessionModelId))
      : selection || undefined;
  }

  private getSystemPromptSettings(vaultPath: string): SystemPromptSettings {
    return {
      customPrompt: this.plugin.settings.systemPrompt,
      mediaFolder: this.plugin.settings.mediaFolder,
      userName: this.plugin.settings.userName,
      vaultPath,
    };
  }

  private shouldSeedModelSelection(
    settings: Record<string, unknown>,
    model: string,
  ): boolean {
    const savedModels = isRecord(settings.savedProviderModel)
      ? settings.savedProviderModel
      : {};
    const saved = typeof savedModels.cursor === 'string' ? savedModels.cursor : '';
    const active = typeof settings.model === 'string' ? settings.model : '';
    return !saved
      || saved === CURSOR_SYNTHETIC_MODEL_ID
      || (
        ProviderRegistry.resolveSettingsProviderId(settings) === this.providerId
        && (!active || active === CURSOR_SYNTHETIC_MODEL_ID)
      )
      || model === '';
  }

  private seedModelSelection(settings: Record<string, unknown>, model: string): void {
    const savedModels = isRecord(settings.savedProviderModel)
      ? settings.savedProviderModel
      : (settings.savedProviderModel = {} as Record<string, unknown>);
    if (
      typeof savedModels.cursor !== 'string'
      || !savedModels.cursor
      || savedModels.cursor === CURSOR_SYNTHETIC_MODEL_ID
    ) {
      savedModels.cursor = model;
    }
    if (ProviderRegistry.resolveSettingsProviderId(settings) === this.providerId) {
      const active = typeof settings.model === 'string' ? settings.model : '';
      if (!active || active === CURSOR_SYNTHETIC_MODEL_ID) {
        settings.model = model;
      }
    }
  }

  private setSupportedCommands(commands: SlashCommand[]): void {
    this.supportedCommands = commands.map(command => ({ ...command }));
    for (const waiter of this.supportedCommandWaiters.splice(0)) {
      waiter(this.supportedCommands);
    }
  }

  private waitForSupportedCommands(timeoutMs = 500): Promise<SlashCommand[]> {
    return new Promise(resolve => {
      const waiter = (commands: SlashCommand[]) => {
        window.clearTimeout(timer);
        resolve(commands.map(command => ({ ...command })));
      };
      const timer = window.setTimeout(() => {
        const index = this.supportedCommandWaiters.indexOf(waiter);
        if (index >= 0) {
          this.supportedCommandWaiters.splice(index, 1);
        }
        resolve(this.supportedCommands.map(command => ({ ...command })));
      }, timeoutMs);
      this.supportedCommandWaiters.push(waiter);
    });
  }

  private settleActiveTurn(error?: Error): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.cancelled) {
      return;
    }
    activeTurn.cancelled = true;
    if (error) {
      activeTurn.queue.push({ type: 'error', content: this.formatRuntimeError(error) });
    }
    activeTurn.queue.push({ type: 'done' });
    activeTurn.queue.close();
    if (this.activeTurn === activeTurn) {
      this.activeTurn = null;
    }
  }

  private clearActiveSession(): void {
    this.loadedSessionId = null;
    this.sessionId = null;
    this.resetSessionModelControls();
    this.currentSessionModelId = null;
    this.currentSessionModeId = null;
    this.systemInstructionsPending = true;
    this.setSupportedCommands([]);
  }

  private resetSessionModelControls(): void {
    this.currentSessionEffortConfigId = null;
    this.currentSessionEffortValue = null;
    this.currentSessionEffortValues = new Set<string>();
    this.currentSessionFastConfigId = null;
    this.currentSessionFastValue = null;
    this.currentSessionFastValues = new Set<string>();
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) {
      return;
    }
    this.ready = ready;
    for (const listener of this.readyListeners) {
      listener(ready);
    }
  }

  private isConversationCurrent(generation: number): boolean {
    return generation === this.conversationGeneration;
  }

  private isReadinessCurrent(
    lifecycleGeneration: number,
    conversationGeneration: number,
  ): boolean {
    return !this.disposed
      && lifecycleGeneration === this.lifecycleGeneration
      && this.isConversationCurrent(conversationGeneration);
  }

  private formatRuntimeError(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Cursor request failed';
    const stderr = this.process?.getStderrSnapshot();
    return stderr ? `${message}\n\n${stderr}` : message;
  }
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeApprovalInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : value === undefined ? {} : { value };
}

function extractApprovalPath(
  input: Record<string, unknown>,
  locations?: Array<{ path: string }> | null,
): string | undefined {
  for (const key of ['path', 'filePath', 'filepath', 'cwd']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      return input[key].trim();
    }
  }
  return locations?.find(location => location.path.trim())?.path.trim();
}

function buildApprovalDecisionOptions(
  options: AcpRequestPermissionRequest['options'],
): ApprovalDecisionOption[] {
  return options.map(option => ({
    ...(option.kind === 'allow_once'
      ? { decision: 'allow' as const }
      : option.kind === 'allow_always'
        ? { decision: 'allow-always' as const }
        : {}),
    label: option.name,
    value: option.optionId,
  }));
}

function mapApprovalDecision(
  decision: ApprovalDecision,
  options: AcpRequestPermissionRequest['options'],
): AcpRequestPermissionResponse {
  if (decision === 'allow') {
    return selectPermissionOption(options, ['allow_once', 'allow_always']);
  }
  if (decision === 'allow-always') {
    return selectPermissionOption(options, ['allow_always', 'allow_once']);
  }
  if (decision === 'deny') {
    return selectPermissionOption(options, ['reject_once', 'reject_always']);
  }
  if (typeof decision === 'object' && decision.type === 'select-option') {
    return { outcome: { optionId: decision.value, outcome: 'selected' } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

function selectPermissionOption(
  options: AcpRequestPermissionRequest['options'],
  preferredKinds: Array<AcpRequestPermissionRequest['options'][number]['kind']>,
): AcpRequestPermissionResponse {
  for (const kind of preferredKinds) {
    const option = options.find(entry => entry.kind === kind);
    if (option) {
      return { outcome: { optionId: option.optionId, outcome: 'selected' } };
    }
  }
  return { outcome: { outcome: 'cancelled' } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
