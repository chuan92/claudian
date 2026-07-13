import { ConversationRepository } from '@/app/conversations/ConversationRepository';
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

function createRepository() {
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
    getSettings: () => ({}),
    getVaultPath: () => '/vault',
    sessions: sessions as any,
    onConversationDeleted: jest.fn().mockResolvedValue(undefined),
  });
  return { repository, saveMetadata };
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
