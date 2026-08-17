import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { SESSION_TRANSCRIPTS_PATH } from '../../../core/bootstrap/StoragePaths';
import type { ChatMessage, Conversation } from '../../../core/types';

const CURSOR_TRANSCRIPT_VERSION = 1;
const SAFE_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface CursorPortableTranscript {
  conversationId: string;
  exportedAt: number;
  messages: ChatMessage[];
  sessionId: string | null;
  version: number;
}

export function getVaultCursorTranscriptPath(
  vaultPath: string,
  conversationId: string,
): string | null {
  if (!isValidConversationId(conversationId)) {
    return null;
  }
  return path.join(
    vaultPath,
    ...SESSION_TRANSCRIPTS_PATH.split('/'),
    'cursor',
    `${conversationId}.json`,
  );
}

export async function exportCursorTranscriptToVault(
  vaultPath: string,
  conversation: Conversation,
): Promise<boolean> {
  const transcriptPath = getVaultCursorTranscriptPath(vaultPath, conversation.id);
  if (!transcriptPath || conversation.messages.length === 0) {
    return false;
  }

  const transcript: CursorPortableTranscript = {
    conversationId: conversation.id,
    exportedAt: Date.now(),
    messages: conversation.messages,
    sessionId: conversation.sessionId,
    version: CURSOR_TRANSCRIPT_VERSION,
  };
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const temporaryPath = `${transcriptPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(transcript), 'utf8');
    await fs.rename(temporaryPath, transcriptPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return true;
}

export async function importCursorTranscriptFromVault(
  vaultPath: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  const transcriptPath = getVaultCursorTranscriptPath(vaultPath, conversationId);
  if (!transcriptPath) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(await fs.readFile(transcriptPath, 'utf8'));
    if (
      !isRecord(parsed)
      || parsed.version !== CURSOR_TRANSCRIPT_VERSION
      || parsed.conversationId !== conversationId
      || !Array.isArray(parsed.messages)
    ) {
      return [];
    }
    const messages = parsed.messages.map(normalizeChatMessage);
    return messages.every((message): message is ChatMessage => message !== null)
      ? messages
      : [];
  } catch {
    return [];
  }
}

export async function deleteVaultCursorTranscript(
  vaultPath: string,
  conversationId: string,
): Promise<void> {
  const transcriptPath = getVaultCursorTranscriptPath(vaultPath, conversationId);
  if (!transcriptPath) {
    return;
  }
  try {
    await fs.rm(transcriptPath, { force: true });
  } catch {
    // Mirror cleanup is best-effort and must not block conversation deletion.
  }
}

function normalizeChatMessage(value: unknown): ChatMessage | null {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !value.id
    || (value.role !== 'user' && value.role !== 'assistant')
    || typeof value.content !== 'string'
    || typeof value.timestamp !== 'number'
    || !Number.isFinite(value.timestamp)
  ) {
    return null;
  }
  return { ...value } as unknown as ChatMessage;
}

function isValidConversationId(value: string): boolean {
  return value.length <= 200
    && SAFE_CONVERSATION_ID_PATTERN.test(value)
    && value !== '.'
    && value !== '..';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
