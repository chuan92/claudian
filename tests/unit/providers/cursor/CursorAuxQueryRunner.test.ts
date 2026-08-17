import '@/providers';

import { AcpClientConnection, AcpJsonRpcTransport, AcpSubprocess } from '@/providers/acp';
import { CursorAuxQueryRunner } from '@/providers/cursor/runtime/CursorAuxQueryRunner';

jest.mock('@/providers/acp', () => {
  const actual = jest.requireActual('@/providers/acp');
  return {
    ...actual,
    AcpClientConnection: jest.fn(),
    AcpJsonRpcTransport: jest.fn(),
    AcpSubprocess: jest.fn(),
  };
});

const MockAcpClientConnection = AcpClientConnection as jest.MockedClass<typeof AcpClientConnection>;
const MockAcpJsonRpcTransport = AcpJsonRpcTransport as jest.MockedClass<typeof AcpJsonRpcTransport>;
const MockAcpSubprocess = AcpSubprocess as jest.MockedClass<typeof AcpSubprocess>;

describe('CursorAuxQueryRunner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses an ask-mode ACP session with an isolated system prompt', async () => {
    let notificationListener: ((notification: any) => void | Promise<void>) | null = null;
    const connection = {
      cancel: jest.fn(),
      dispose: jest.fn(),
      initialize: jest.fn().mockResolvedValue({}),
      newSession: jest.fn().mockResolvedValue({
        configOptions: [{
          currentValue: 'default[]',
          id: 'model',
          name: 'Model',
          options: [
            { name: 'Auto', value: 'default[]' },
            { name: 'GPT', value: 'gpt-5.4[reasoning=medium]' },
          ],
          type: 'select',
        }],
        sessionId: 'session-1',
      }),
      onSessionNotification: jest.fn((listener) => {
        notificationListener = listener;
        return jest.fn();
      }),
      prompt: jest.fn().mockImplementation(async () => {
        await notificationListener?.({
          sessionId: 'session-1',
          update: {
            content: { text: 'Generated title', type: 'text' },
            sessionUpdate: 'agent_message_chunk',
          },
        });
        return { stopReason: 'end_turn' };
      }),
      setConfigOption: jest.fn().mockResolvedValue({ configOptions: [] }),
    };
    const subprocess = {
      getStderrSnapshot: jest.fn().mockReturnValue(''),
      isAlive: jest.fn().mockReturnValue(true),
      onClose: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
      start: jest.fn(),
      stdin: {},
      stdout: {},
    };
    const transport = {
      dispose: jest.fn(),
      isClosed: false,
      start: jest.fn(),
    };
    MockAcpClientConnection.mockImplementation(() => connection as any);
    MockAcpJsonRpcTransport.mockImplementation(() => transport as any);
    MockAcpSubprocess.mockImplementation(() => subprocess as any);
    const plugin = {
      app: { vault: { adapter: { basePath: '/vault' } } },
      getResolvedProviderCliPath: jest.fn().mockResolvedValue('/usr/local/bin/cursor-agent'),
      manifest: { version: 'test' },
      settings: {
        model: 'cursor:default[]',
        providerConfigs: { cursor: { enabled: true } },
        settingsProvider: 'cursor',
      },
    } as any;
    const runner = new CursorAuxQueryRunner(plugin);

    await expect(runner.query({
      model: 'cursor:gpt-5.4[reasoning=medium]',
      systemPrompt: 'Return only a title.',
    }, 'Name this chat')).resolves.toBe('Generated title');

    expect(connection.setConfigOption).toHaveBeenCalledWith({
      configId: 'mode',
      sessionId: 'session-1',
      type: 'select',
      value: 'ask',
    });
    expect(connection.setConfigOption).toHaveBeenCalledWith({
      configId: 'model',
      sessionId: 'session-1',
      type: 'select',
      value: 'gpt-5.4[reasoning=medium]',
    });
    expect(connection.initialize).toHaveBeenCalledWith({
      clientCapabilities: {
        _meta: { parameterizedModelPicker: true },
      },
    });
    expect(connection.prompt).toHaveBeenCalledWith({
      prompt: [{
        text: expect.stringContaining(
          '<claudian_system_instructions>\nReturn only a title.\n</claudian_system_instructions>\n\nName this chat',
        ),
        type: 'text',
      }],
      sessionId: 'session-1',
    });
  });
});
