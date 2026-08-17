import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Conversation } from '@/core/types';
import { CursorConversationHistoryService } from '@/providers/cursor/history/CursorConversationHistoryService';
import { getCursorNativeSessionDbPath } from '@/providers/cursor/history/CursorNativeTranscriptSync';

function createConversation(): Conversation {
  return {
    createdAt: 1,
    id: 'conversation-1',
    messages: [{ content: 'Local fallback', id: 'local-1', role: 'user', timestamp: 1 }],
    providerId: 'cursor',
    sessionId: 'session-1',
    title: 'Cursor chat',
    updatedAt: 1,
  };
}

describe('CursorConversationHistoryService', () => {
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-cursor-history-'));
  });

  afterEach(async () => {
    await fs.rm(vaultPath, { force: true, recursive: true });
  });

  it('hydrates a conversation from Cursor ACP replay', async () => {
    const replayed = [
      { content: 'Native prompt', id: 'native-1', role: 'user' as const, timestamp: 2 },
      { content: 'Native answer', id: 'native-2', role: 'assistant' as const, timestamp: 3 },
    ];
    const loader = jest.fn().mockResolvedValue(replayed);
    const service = new CursorConversationHistoryService(loader);
    const conversation = createConversation();

    await service.hydrateConversationHistory(conversation, '/vault', {
      environment: { PATH: '/bin' },
      settings: { providerConfigs: { cursor: { enabled: true } } },
    });

    expect(conversation.messages).toEqual(replayed);
    expect(loader).toHaveBeenCalledWith('session-1', expect.objectContaining({
      environment: { PATH: '/bin' },
      vaultPath: '/vault',
    }));
  });

  it('preserves local messages when Cursor cannot replay the session', async () => {
    const service = new CursorConversationHistoryService(jest.fn().mockResolvedValue([]));
    const conversation = createConversation();

    await service.hydrateConversationHistory(conversation, '/vault');

    expect(conversation.messages).toEqual([
      { content: 'Local fallback', id: 'local-1', role: 'user', timestamp: 1 },
    ]);
  });

  it('restores a vault-mirrored transcript when the native Cursor session is unavailable', async () => {
    const service = new CursorConversationHistoryService(jest.fn().mockResolvedValue([]));
    const source = createConversation();
    source.messages = [
      { content: 'Shared prompt', id: 'shared-1', role: 'user', timestamp: 2 },
      { content: 'Shared answer', id: 'shared-2', role: 'assistant', timestamp: 3 },
    ];
    await service.exportTranscripts(source, vaultPath);

    const restored = createConversation();
    restored.messages = [];
    await service.ensureLocalTranscripts(restored, vaultPath);
    await service.hydrateConversationHistory(restored, vaultPath);

    expect(restored.messages).toEqual(source.messages);
    expect(restored.sessionId).toBe('session-1');
  });

  it('materializes a vault-mirrored native session before ACP history replay', async () => {
    const sourceHome = path.join(vaultPath, 'machine-a');
    const targetHome = path.join(vaultPath, 'machine-b');
    const sourceContext = {
      environment: { HOME: sourceHome },
      vaultPath,
    };
    const targetContext = {
      environment: { HOME: targetHome },
      vaultPath,
    };
    const sourcePath = getCursorNativeSessionDbPath('session-1', sourceContext)!;
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const database = new DatabaseSync(sourcePath);
    database.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
    database.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    database.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run('history', 'native');
    database.close();

    const source = createConversation();
    const loader = jest.fn(async () => {
      const targetPath = getCursorNativeSessionDbPath('session-1', targetContext)!;
      await fs.access(targetPath);
      return [{ content: 'Native replay', id: 'native-1', role: 'assistant' as const, timestamp: 2 }];
    });
    const service = new CursorConversationHistoryService(loader);
    await service.exportTranscripts(source, vaultPath, sourceContext);

    const restored = { ...source, messages: [] };
    await expect(service.ensureLocalTranscripts(restored, vaultPath, targetContext))
      .resolves.toBe(true);
    await service.hydrateConversationHistory(restored, vaultPath, targetContext);

    expect(restored.sessionId).toBe('session-1');
    expect(restored.messages).toEqual([
      { content: 'Native replay', id: 'native-1', role: 'assistant', timestamp: 2 },
    ]);
  });

  it('removes only the matching Cursor mirror when a conversation is deleted', async () => {
    const service = new CursorConversationHistoryService(jest.fn().mockResolvedValue([]));
    const first = createConversation();
    const second = { ...createConversation(), id: 'conversation-2' };
    await service.exportTranscripts(first, vaultPath);
    await service.exportTranscripts(second, vaultPath);

    await service.deleteConversationSession(first, vaultPath);
    const restoredFirst = { ...first, messages: [] };
    const restoredSecond = { ...second, messages: [] };
    await service.ensureLocalTranscripts(restoredFirst, vaultPath);
    await service.ensureLocalTranscripts(restoredSecond, vaultPath);

    expect(restoredFirst.messages).toEqual([]);
    expect(restoredSecond.messages).toEqual(second.messages);
  });
});
