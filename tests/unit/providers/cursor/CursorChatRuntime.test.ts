import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { CursorChatRuntime } from '@/providers/cursor/runtime/CursorChatRuntime';

function createMockPlugin(overrides: Record<string, unknown> = {}): any {
  const plugin: any = {
    settings: {
      permissionMode: 'normal',
      providerConfigs: { cursor: { enabled: true } },
    },
    manifest: { version: '0.0.0-test' },
    getResolvedProviderCliPath: jest.fn().mockReturnValue('/usr/local/bin/cursor-agent'),
    saveSettings: jest.fn().mockResolvedValue(undefined),
    app: { vault: { adapter: { basePath: '/tmp/claudian-test-vault' } } },
    ...overrides,
  };
  plugin.mutateSettings ??= jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  return plugin;
}

describe('CursorChatRuntime', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('captures ACP commands outside an active turn', async () => {
    const runtime = new CursorChatRuntime(createMockPlugin());
    runtime.syncConversationState({ sessionId: 'session-1' });
    (runtime as any).loadedSessionId = 'session-1';

    const commandsPromise = runtime.getSupportedCommands();
    await (runtime as any).handleSessionNotification({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'simplify', description: 'Simplify code' }],
      },
    });

    await expect(commandsPromise).resolves.toEqual([
      expect.objectContaining({ id: 'acp:simplify', name: 'simplify' }),
    ]);
  });

  it('reloads an existing session when external context paths change', () => {
    const runtime = new CursorChatRuntime(createMockPlugin());
    runtime.syncConversationState({ id: 'conversation-1', sessionId: 'session-1' }, ['/one']);
    (runtime as any).loadedSessionId = 'session-1';

    runtime.syncConversationState({ id: 'conversation-1', sessionId: 'session-1' }, ['/two']);

    expect((runtime as any).loadedSessionId).toBeNull();
  });

  it('maps normal, plan, and yolo permission modes to Cursor ACP modes', () => {
    const plugin = createMockPlugin();
    const runtime = new CursorChatRuntime(plugin);
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot')
      .mockImplementation(() => plugin.settings);

    plugin.settings.permissionMode = 'normal';
    expect((runtime as any).resolveSelectedModeId()).toBe('agent');
    plugin.settings.permissionMode = 'plan';
    expect((runtime as any).resolveSelectedModeId()).toBe('plan');
    plugin.settings.permissionMode = 'yolo';
    expect((runtime as any).resolveSelectedModeId()).toBe('agent');
  });

  it('does not overwrite the requested plan mode with a new session default', async () => {
    const plugin = createMockPlugin();
    plugin.settings.permissionMode = 'plan';
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot')
      .mockImplementation(() => plugin.settings);
    const runtime = new CursorChatRuntime(plugin);
    const syncPermissionMode = jest.fn();
    const setConfigOption = jest.fn().mockResolvedValue({ configOptions: [] });
    (runtime as any).connection = {
      newSession: jest.fn().mockResolvedValue({
        modes: {
          availableModes: [
            { id: 'agent', name: 'Agent' },
            { id: 'plan', name: 'Plan' },
          ],
          currentModeId: 'agent',
        },
        sessionId: 'session-1',
      }),
      setConfigOption,
    };
    runtime.setPermissionModeSyncCallback(syncPermissionMode);

    await (runtime as any).createSession('/vault');
    await (runtime as any).applySelectedMode('session-1');

    expect(syncPermissionMode).not.toHaveBeenCalledWith('normal');
    expect(setConfigOption).toHaveBeenCalledWith(expect.objectContaining({
      configId: 'mode',
      value: 'plan',
    }));
  });

  it('auto-allows ACP permissions only in yolo mode', async () => {
    const plugin = createMockPlugin();
    const runtime = new CursorChatRuntime(plugin);
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot')
      .mockImplementation(() => plugin.settings);
    const request = {
      options: [
        { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
      sessionId: 'session-1',
      toolCall: {
        title: 'Shell',
        toolCallId: 'tool-1',
        rawInput: { command: 'pwd' },
      },
    };

    plugin.settings.permissionMode = 'yolo';
    await expect((runtime as any).handlePermissionRequest(request)).resolves.toEqual({
      outcome: { optionId: 'allow', outcome: 'selected' },
    });

    plugin.settings.permissionMode = 'normal';
    const approval = jest.fn().mockResolvedValue('deny');
    runtime.setApprovalCallback(approval);
    await expect((runtime as any).handlePermissionRequest(request)).resolves.toEqual({
      outcome: { optionId: 'reject', outcome: 'selected' },
    });
    expect(approval).toHaveBeenCalled();
  });

  it('applies the selected reasoning effort and fast mode through ACP config options', async () => {
    const plugin = createMockPlugin();
    plugin.settings.effortLevel = 'xhigh';
    plugin.settings.serviceTier = 'true';
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot')
      .mockImplementation(() => plugin.settings);
    const setConfigOption = jest.fn().mockResolvedValue({ configOptions: [] });
    const runtime = new CursorChatRuntime(plugin);
    (runtime as any).connection = { setConfigOption };
    (runtime as any).currentSessionEffortConfigId = 'effort';
    (runtime as any).currentSessionEffortValue = 'high';
    (runtime as any).currentSessionEffortValues = new Set(['low', 'high', 'xhigh']);
    (runtime as any).currentSessionFastConfigId = 'fast';
    (runtime as any).currentSessionFastValue = 'false';
    (runtime as any).currentSessionFastValues = new Set(['false', 'true']);

    await (runtime as any).applySelectedEffort('session-1');
    await (runtime as any).applySelectedFast('session-1');

    expect(setConfigOption).toHaveBeenNthCalledWith(1, {
      configId: 'effort',
      sessionId: 'session-1',
      type: 'select',
      value: 'xhigh',
    });
    expect(setConfigOption).toHaveBeenNthCalledWith(2, {
      configId: 'fast',
      sessionId: 'session-1',
      type: 'select',
      value: 'true',
    });
  });

  it('persists model-scoped controls discovered from a Cursor ACP session', async () => {
    const plugin = createMockPlugin({ refreshModelSelectors: jest.fn() });
    const runtime = new CursorChatRuntime(plugin);
    runtime.syncConversationState({
      selectedModel: 'cursor:gpt-5.4',
      sessionId: 'session-1',
    });

    await (runtime as any).syncSessionModelState({
      configOptions: [
        {
          category: 'model',
          currentValue: 'gpt-5.4',
          id: 'model',
          name: 'Model',
          options: [{ name: 'GPT-5.4', value: 'gpt-5.4' }],
          type: 'select',
        },
        {
          category: 'thought_level',
          currentValue: 'medium',
          id: 'reasoning',
          name: 'Reasoning',
          options: [
            { name: 'None', value: 'none' },
            { name: 'Medium', value: 'medium' },
            { name: 'High', value: 'high' },
          ],
          type: 'select',
        },
        {
          category: 'model_config',
          currentValue: 'false',
          id: 'fast',
          name: 'Fast',
          options: [
            { name: 'Off', value: 'false' },
            { name: 'Fast', value: 'true' },
          ],
          type: 'select',
        },
      ],
    });

    expect((runtime as any).currentSessionEffortConfigId).toBe('reasoning');
    expect((runtime as any).currentSessionFastConfigId).toBe('fast');
    expect(plugin.settings.providerConfigs.cursor.modelConfigurations['gpt-5.4'])
      .toMatchObject({
        fast: { currentValue: 'false' },
        reasoning: { currentValue: 'medium' },
      });
    expect(plugin.refreshModelSelectors).toHaveBeenCalled();
  });

  it('does not add every discovered model to an explicitly empty visible list', async () => {
    const plugin = createMockPlugin({ refreshModelSelectors: jest.fn() });
    plugin.settings.model = 'cursor:gpt-5.4';
    plugin.settings.providerConfigs.cursor.visibleModels = [];
    const runtime = new CursorChatRuntime(plugin);
    runtime.syncConversationState({
      selectedModel: 'cursor:gpt-5.4',
      sessionId: 'session-1',
    });

    await (runtime as any).syncSessionModelState({
      models: {
        availableModels: [
          { modelId: 'gpt-5.4', name: 'GPT-5.4' },
          { modelId: 'claude-opus-5', name: 'Claude Opus 5' },
        ],
        currentModelId: 'gpt-5.4',
      },
    });

    expect(plugin.settings.providerConfigs.cursor.visibleModels).toEqual([]);
  });

  it('bootstraps mirrored history when a session from another machine cannot be loaded', async () => {
    const runtime = new CursorChatRuntime(createMockPlugin());
    runtime.syncConversationState({ id: 'conversation-1', sessionId: 'remote-session' });
    const prompt = jest.fn().mockResolvedValue({});
    const connection = { prompt };
    jest.spyOn(runtime, 'ensureReady').mockImplementation(async () => {
      (runtime as any).sessionInvalidated = true;
      (runtime as any).sessionId = null;
      (runtime as any).connection = connection;
      return true;
    });
    jest.spyOn(runtime as any, 'createSession').mockImplementation(async () => {
      (runtime as any).sessionId = 'local-session';
      (runtime as any).systemInstructionsPending = false;
      return 'local-session';
    });
    jest.spyOn(runtime as any, 'applySelectedMode').mockResolvedValue(undefined);
    jest.spyOn(runtime as any, 'applySelectedModel').mockResolvedValue(undefined);
    jest.spyOn(runtime as any, 'applySelectedEffort').mockResolvedValue(undefined);
    jest.spyOn(runtime as any, 'applySelectedFast').mockResolvedValue(undefined);

    const turn = runtime.prepareTurn({ text: 'Continue here' } as any);
    const chunks = [];
    for await (const chunk of runtime.query(turn, [
      { content: 'Shared prompt', id: 'shared-1', role: 'user', timestamp: 1 },
      { content: 'Shared answer', id: 'shared-2', role: 'assistant', timestamp: 2 },
    ])) {
      chunks.push(chunk);
    }

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: [expect.objectContaining({
        text: 'User: Shared prompt\n\nAssistant: Shared answer\n\nUser: Continue here',
      })],
      sessionId: 'local-session',
    }));
    expect(chunks).toContainEqual({ type: 'done' });
  });
});
