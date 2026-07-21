import '@/providers';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { Conversation } from '@/core/types';

function createConversation(id = 'conversation-1', currentNote?: string): Conversation {
  return {
    id,
    providerId: 'claude',
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionId: 'session-1',
    messages: [],
    ...(currentNote ? { currentNote } : {}),
  };
}

function createRepository(options: {
  conversation?: Conversation;
  settings?: Record<string, unknown>;
} = {}) {
  const saveMetadata = jest.fn().mockResolvedValue(undefined);
  const sessions = {
    saveMetadata,
    deleteMetadata: jest.fn().mockResolvedValue(undefined),
    toSessionMetadata: jest.fn((value: Conversation) => ({
      id: value.id,
      title: value.title,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      currentNote: value.currentNote,
    })),
  };
  const repository = new ConversationRepository({
    getSettings: () => options.settings ?? {},
    getVaultPath: () => '/vault',
    sessions: sessions as any,
    onConversationDeleted: jest.fn().mockResolvedValue(undefined),
  });
  if (options.conversation) {
    repository.replaceAll([options.conversation]);
  }
  return { repository, saveMetadata, sessions };
}

describe('ConversationRepository note associations', () => {
  it('remaps exact and nested note associations and persists only changed records', async () => {
    const { repository, saveMetadata } = createRepository();
    repository.replaceAll([
      createConversation('exact', 'projects/old'),
      createConversation('nested', 'projects/old/topic.md'),
      createConversation('unrelated', 'projects/older/topic.md'),
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
      createConversation('exact', 'notes/deleted.md'),
      createConversation('nested', 'notes/deleted.md/child'),
    ]);

    await repository.remapNoteAssociations('notes/deleted.md', null);

    expect(repository.getSync('exact')?.currentNote).toBeUndefined();
    expect(repository.getSync('nested')?.currentNote).toBeUndefined();
  });

  it('attempts every changed record before reporting a persistence failure', async () => {
    const { repository, saveMetadata } = createRepository();
    repository.replaceAll([
      createConversation('first', 'old/first.md'),
      createConversation('second', 'old/second.md'),
    ]);
    saveMetadata.mockRejectedValueOnce(new Error('write failed'));

    await expect(repository.remapNoteAssociations('old', 'new')).rejects.toThrow(
      'Failed to persist one or more conversation note associations.',
    );
    expect(saveMetadata).toHaveBeenCalledTimes(2);
  });

  it('exposes note associations through lightweight metadata for filtering and search', () => {
    const value = createConversation('linked', 'projects/linked.md');
    const { repository } = createRepository({ conversation: value });

    expect(repository.getMetadata(value.id)?.currentNote).toBe('projects/linked.md');
    expect(repository.list()).toEqual([
      expect.objectContaining({ id: value.id, currentNote: 'projects/linked.md' }),
    ]);
  });
});

describe('ConversationRepository transcript sharing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('imports provider transcripts before hydration and persists remapped provider state', async () => {
    const { repository, saveMetadata } = createRepository({
      settings: { shareSessionsAcrossMachines: true },
    });
    const value = createConversation('shared');
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
    const { repository } = createRepository({
      settings: { shareSessionsAcrossMachines: true },
    });
    const value = createConversation('saved');
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
    const { repository } = createRepository({
      settings: { shareSessionsAcrossMachines: false },
    });
    const value = createConversation('local-only');
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

describe('ConversationRepository hydration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns cached metadata without hydrating provider history', () => {
    const hydrateConversationHistory = jest.fn();
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository({ conversation });

    expect(repository.getCachedConversation(conversation.id)).toBe(conversation);
    expect(hydrateConversationHistory).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent hydration and does not reread an empty transcript', async () => {
    let release!: () => void;
    const hydrateConversationHistory = jest.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository({ conversation });

    const first = repository.ensureHydrated(conversation.id);
    const second = repository.ensureHydrated(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(hydrateConversationHistory).toHaveBeenCalledTimes(1);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([conversation, conversation]);
    await repository.ensureHydrated(conversation.id);

    expect(hydrateConversationHistory).toHaveBeenCalledTimes(1);
  });

  it('allows hydration to retry after a provider history failure', async () => {
    const hydrateConversationHistory = jest.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(undefined);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository({ conversation });

    await expect(repository.ensureHydrated(conversation.id)).rejects.toThrow('temporary failure');
    await expect(repository.ensureHydrated(conversation.id)).resolves.toBe(conversation);

    expect(hydrateConversationHistory).toHaveBeenCalledTimes(2);
  });

  it('does not return a conversation deleted while hydration is in flight', async () => {
    let releaseHydration!: () => void;
    const hydrateConversationHistory = jest.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseHydration = resolve;
      });
    });
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository, sessions } = createRepository({ conversation });

    const hydration = repository.ensureHydrated(conversation.id);
    await Promise.resolve();
    await Promise.resolve();
    const deletion = repository.delete(conversation.id, { deleteProviderSession: false });

    releaseHydration();

    await expect(hydration).resolves.toBeNull();
    await expect(deletion).resolves.toBeUndefined();
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
    expect(sessions.deleteMetadata).toHaveBeenCalledWith(conversation.id);
  });

  it('does not return an already hydrated conversation deleted while model reconciliation is in flight', async () => {
    let markReconciliationStarted!: () => void;
    let releaseReconciliation!: () => void;
    const reconciliationStarted = new Promise<void>((resolve) => {
      markReconciliationStarted = resolve;
    });
    const reconciliationRelease = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const conversation = createConversation();
    conversation.messages = [{ id: 'message-1', role: 'user', content: 'kept', timestamp: 1 }];
    const { repository, sessions } = createRepository({ conversation });
    jest.spyOn(repository as any, 'ensureSelectedModel').mockImplementation(async () => {
      markReconciliationStarted();
      await reconciliationRelease;
    });

    const hydration = repository.ensureHydrated(conversation.id);
    await reconciliationStarted;
    const deletion = repository.delete(conversation.id, { deleteProviderSession: false });
    releaseReconciliation();

    await expect(hydration).resolves.toBeNull();
    await expect(deletion).resolves.toBeUndefined();
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
    expect(sessions.deleteMetadata).toHaveBeenCalledWith(conversation.id);
  });

  it('restarts hydration when provider session identity changes in flight', async () => {
    let markFirstHydrationStarted!: () => void;
    let releaseFirstHydration!: () => void;
    const firstHydrationStarted = new Promise<void>((resolve) => {
      markFirstHydrationStarted = resolve;
    });
    const firstHydrationRelease = new Promise<void>((resolve) => {
      releaseFirstHydration = resolve;
    });
    const hydrateConversationHistory = jest.fn()
      .mockImplementationOnce(async () => {
        markFirstHydrationStarted();
        await firstHydrationRelease;
      })
      .mockResolvedValueOnce(undefined);
    jest.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
      hydrateConversationHistory,
    } as any);
    const conversation = createConversation();
    const { repository } = createRepository({ conversation });

    const staleHydration = repository.ensureHydrated(conversation.id);
    await firstHydrationStarted;
    await repository.update(conversation.id, { sessionId: 'session-2' });
    releaseFirstHydration();

    await expect(staleHydration).resolves.toBeNull();
    await expect(repository.ensureHydrated(conversation.id)).resolves.toBe(conversation);
    expect(hydrateConversationHistory).toHaveBeenCalledTimes(2);
  });

  it('merges background metadata without replacing an already hydrated conversation', () => {
    const existing = createConversation('existing');
    existing.messages = [{ id: 'message-1', role: 'user', content: 'kept', timestamp: 1 }];
    const { repository } = createRepository({ conversation: existing });
    const duplicate = createConversation('existing');
    const added = createConversation('added');
    added.updatedAt = 2;

    const merged = repository.mergeMetadataConversations([duplicate, added]);

    expect(merged).toEqual([added]);
    expect(repository.getCachedConversation('existing')).toBe(existing);
    expect(repository.getCachedConversation('existing')?.messages).toHaveLength(1);
    expect(repository.getAll().map(conversation => conversation.id)).toEqual(['added', 'existing']);
  });

  it('does not resurrect a deleted conversation from a late background metadata batch', async () => {
    const conversation = createConversation('deleted');
    const { repository } = createRepository({ conversation });
    await repository.delete(conversation.id, { deleteProviderSession: false });

    const merged = repository.mergeMetadataConversations([
      createConversation(conversation.id),
    ]);

    expect(merged).toEqual([]);
    expect(repository.getCachedConversation(conversation.id)).toBeNull();
  });
});
