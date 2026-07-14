import '@/providers';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { Conversation } from '@/core/types';

function conversation(id: string, currentNote?: string): Conversation {
  return {
    id,
    providerId: 'claude',
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    messages: [],
    ...(currentNote ? { currentNote } : {}),
  };
}

function createRepository(settings: Record<string, unknown> = {}) {
  const saveMetadata = jest.fn().mockResolvedValue(undefined);
  const sessions = {
    saveMetadata,
    toSessionMetadata: jest.fn((value: Conversation) => ({
      id: value.id,
      title: value.title,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      currentNote: value.currentNote,
    })),
  };
  const repository = new ConversationRepository({
    getSettings: () => settings,
    getVaultPath: () => '/vault',
    sessions: sessions as any,
    onConversationDeleted: jest.fn().mockResolvedValue(undefined),
  });
  return { repository, saveMetadata, sessions };
}

describe('ConversationRepository note associations', () => {
  it('remaps exact and nested note associations and persists only changed records', async () => {
    const { repository, saveMetadata } = createRepository();
    repository.replaceAll([
      conversation('exact', 'projects/old'),
      conversation('nested', 'projects/old/topic.md'),
      conversation('unrelated', 'projects/older/topic.md'),
    ]);

    const changed = await repository.remapNoteAssociations('projects/old', 'archive/new');

    expect(changed.map(value => value.id)).toEqual(['exact', 'nested']);
    expect(repository.getSync('exact')?.currentNote).toBe('archive/new');
    expect(repository.getSync('nested')?.currentNote).toBe('archive/new/topic.md');
    expect(repository.getSync('unrelated')?.currentNote).toBe('projects/older/topic.md');
    expect(saveMetadata).toHaveBeenCalledTimes(2);
  });

  it('clears exact and nested associations when a vault entry is deleted', async () => {
    const { repository } = createRepository();
    repository.replaceAll([
      conversation('exact', 'notes/deleted.md'),
      conversation('nested', 'notes/deleted.md/child'),
    ]);

    await repository.remapNoteAssociations('notes/deleted.md', null);

    expect(repository.getSync('exact')?.currentNote).toBeUndefined();
    expect(repository.getSync('nested')?.currentNote).toBeUndefined();
  });

  it('attempts every changed record before reporting a persistence failure', async () => {
    const { repository, saveMetadata } = createRepository();
    repository.replaceAll([
      conversation('first', 'old/first.md'),
      conversation('second', 'old/second.md'),
    ]);
    saveMetadata.mockRejectedValueOnce(new Error('write failed'));

    await expect(repository.remapNoteAssociations('old', 'new')).rejects.toThrow(
      'Failed to persist one or more conversation note associations.',
    );
    expect(saveMetadata).toHaveBeenCalledTimes(2);
  });
});

describe('ConversationRepository transcript sharing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('imports provider transcripts before hydration and persists remapped provider state', async () => {
    const { repository, saveMetadata } = createRepository({
      shareSessionsAcrossMachines: true,
    });
    const value = conversation('shared');
    value.sessionId = 'session-1';
    repository.replaceAll([value]);
    const calls: string[] = [];
    const historyService = {
      ensureLocalTranscripts: jest.fn(async (target: Conversation) => {
        calls.push('import');
        target.providerState = { sessionFilePath: '/local/session.jsonl' };
        return true;
      }),
      hydrateConversationHistory: jest.fn(async () => {
        calls.push('hydrate');
      }),
    };
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService')
      .mockReturnValue(historyService as any);

    await repository.getById(value.id);

    expect(calls).toEqual(['import', 'hydrate']);
    expect(saveMetadata).toHaveBeenCalledWith(expect.objectContaining({ id: value.id }));
  });

  it('exports immediately after a transcript-bearing save and flushes the delayed follow-up', async () => {
    const { repository } = createRepository({ shareSessionsAcrossMachines: true });
    const value = conversation('saved');
    repository.replaceAll([value]);
    const historyService = {
      exportTranscripts: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService')
      .mockReturnValue(historyService as any);

    await repository.update(value.id, {
      messages: [{ id: 'message-1', role: 'user', content: 'hello', timestamp: 2 }],
    });
    expect(historyService.exportTranscripts).toHaveBeenCalledTimes(1);

    await repository.flushPendingTranscriptExports();
    expect(historyService.exportTranscripts).toHaveBeenCalledTimes(2);
  });

  it('does not mirror transcripts when sharing is disabled', async () => {
    const { repository } = createRepository({ shareSessionsAcrossMachines: false });
    const value = conversation('local-only');
    repository.replaceAll([value]);
    const historyService = {
      exportTranscripts: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService')
      .mockReturnValue(historyService as any);

    await repository.update(value.id, {
      messages: [{ id: 'message-1', role: 'user', content: 'hello', timestamp: 2 }],
    });
    await repository.flushPendingTranscriptExports();

    expect(historyService.exportTranscripts).not.toHaveBeenCalled();
  });
});
