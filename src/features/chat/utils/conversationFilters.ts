import type { ConversationMeta } from '@/core/types/chat';

export { remapConversationNotePath } from '../../../core/conversations/noteAssociation';

/**
 * Conversations linked to a vault note — exact match on `ConversationMeta.currentNote`
 * (the vault-relative path persisted on first send). Used by the peek banner (count)
 * and the history dropdown's note-filter mode. Substring/basename matching is intentionally
 * avoided here; the history search box handles free-text, while this filter is an explicit
 * "linked to THIS note" join.
 */
export function getConversationsLinkedToNote(
  metas: ConversationMeta[],
  notePath: string,
): ConversationMeta[] {
  if (!notePath) return [];
  return metas.filter(meta => meta.currentNote === notePath);
}
