import type { ConversationMeta } from '@/core/types/chat';
import {
  getConversationsLinkedToNote,
  remapConversationNotePath,
} from '@/features/chat/utils/conversationFilters';

function meta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: 'conv',
    providerId: 'claude',
    title: 'T',
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    preview: '',
    ...overrides,
  };
}

describe('getConversationsLinkedToNote', () => {
  it('returns only conversations whose currentNote exactly matches the path', () => {
    const metas = [
      meta({ id: 'a', currentNote: 'folder/note.md' }),
      meta({ id: 'b', currentNote: 'other/note.md' }),
      meta({ id: 'c', currentNote: 'folder/note.md' }),
    ];

    const result = getConversationsLinkedToNote(metas, 'folder/note.md');

    expect(result.map(m => m.id)).toEqual(['a', 'c']);
  });

  it('excludes conversations with no currentNote', () => {
    const metas = [
      meta({ id: 'a', currentNote: 'folder/note.md' }),
      meta({ id: 'b' }),
      meta({ id: 'c', currentNote: undefined }),
    ];

    const result = getConversationsLinkedToNote(metas, 'folder/note.md');

    expect(result.map(m => m.id)).toEqual(['a']);
  });

  it('does not substring-match the note basename — only the full vault-relative path', () => {
    const metas = [
      meta({ id: 'a', currentNote: 'folder/note.md' }),
      meta({ id: 'b', currentNote: 'note.md' }),
      meta({ id: 'c', currentNote: 'deeply/nested/note.md' }),
    ];

    expect(getConversationsLinkedToNote(metas, 'note.md').map(m => m.id)).toEqual(['b']);
    expect(getConversationsLinkedToNote(metas, 'folder/note.md').map(m => m.id)).toEqual(['a']);
  });

  it('returns an empty list for an empty input', () => {
    expect(getConversationsLinkedToNote([], 'note.md')).toEqual([]);
  });

  it('returns an empty list when no note path is given', () => {
    const metas = [meta({ id: 'a', currentNote: 'note.md' })];

    expect(getConversationsLinkedToNote(metas, '')).toEqual([]);
    expect(getConversationsLinkedToNote(metas, null as unknown as string)).toEqual([]);
  });
});

describe('remapConversationNotePath', () => {
  it('renames an exact note association', () => {
    expect(remapConversationNotePath('notes/old.md', 'notes/old.md', 'notes/new.md'))
      .toBe('notes/new.md');
  });

  it('renames associations nested below a folder', () => {
    expect(remapConversationNotePath(
      'projects/old/topic/note.md',
      'projects/old',
      'archive/new',
    )).toBe('archive/new/topic/note.md');
  });

  it('clears exact and nested associations on deletion', () => {
    expect(remapConversationNotePath('notes/deleted.md', 'notes/deleted.md', null)).toBeNull();
    expect(remapConversationNotePath('projects/old/note.md', 'projects/old', null)).toBeNull();
  });

  it('does not change similarly-prefixed or unrelated paths', () => {
    expect(remapConversationNotePath('projects/older/note.md', 'projects/old', 'projects/new'))
      .toBe('projects/older/note.md');
    expect(remapConversationNotePath('notes/other.md', 'notes/old.md', 'notes/new.md'))
      .toBe('notes/other.md');
  });
});
