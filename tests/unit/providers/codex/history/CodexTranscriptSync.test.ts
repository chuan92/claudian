import type * as fsType from 'fs';
import type * as osType from 'os';
import type * as pathType from 'path';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');

import type { Conversation } from '@/core/types';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';
import {
  deleteVaultCodexTranscripts,
  exportCodexTranscriptToVault,
  getVaultCodexTranscriptRoot,
  importCodexTranscriptFromVault,
} from '@/providers/codex/history/CodexTranscriptSync';

const THREAD_ID = '019abcde-0000-7000-8000-000000000001';

describe('CodexTranscriptSync', () => {
  let tempRoot: string;
  let vaultPath: string;
  let sourceSessions: string;
  let targetSessions: string;
  let sourceFile: string;

  function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-sync-'));
    vaultPath = path.join(tempRoot, 'vault');
    sourceSessions = path.join(tempRoot, 'machine-a', '.codex', 'sessions');
    targetSessions = path.join(tempRoot, 'machine-b', '.codex', 'sessions');
    sourceFile = path.join(
      sourceSessions,
      '2026',
      '07',
      '14',
      `rollout-2026-07-14T10-00-00-${THREAD_ID}.jsonl`,
    );
    fs.mkdirSync(vaultPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves the rollout path relative to sessions when moving between machines', async () => {
    writeFile(sourceFile, 'user\nassistant\n');

    await expect(exportCodexTranscriptToVault(
      vaultPath,
      THREAD_ID,
      sourceFile,
      sourceSessions,
    )).resolves.toBe(true);

    const imported = await importCodexTranscriptFromVault(
      vaultPath,
      THREAD_ID,
      [targetSessions],
    );

    const expectedTarget = path.join(
      targetSessions,
      '2026',
      '07',
      '14',
      path.basename(sourceFile),
    );
    expect(imported).toEqual({
      imported: true,
      sessionFilePath: expectedTarget,
      transcriptRootPath: targetSessions,
    });
    expect(fs.readFileSync(expectedTarget, 'utf-8')).toBe('user\nassistant\n');
  });

  it('does not replace a longer local transcript with an older mirror', async () => {
    writeFile(sourceFile, 'short\n');
    await exportCodexTranscriptToVault(vaultPath, THREAD_ID, sourceFile, sourceSessions);
    const localFile = path.join(targetSessions, 'existing', path.basename(sourceFile));
    writeFile(localFile, 'longer\nlocal\ncopy\n');

    const imported = await importCodexTranscriptFromVault(
      vaultPath,
      THREAD_ID,
      [targetSessions],
      localFile,
      targetSessions,
    );

    expect(imported?.imported).toBe(false);
    expect(fs.readFileSync(localFile, 'utf-8')).toBe('longer\nlocal\ncopy\n');
  });

  it('remaps synced provider paths to the local CODEX_HOME', async () => {
    writeFile(sourceFile, 'shared codex transcript\n');
    const sourceConversation: Conversation = {
      id: 'conv-codex-sync',
      providerId: 'codex',
      title: 'Shared Codex thread',
      createdAt: 1,
      updatedAt: 1,
      sessionId: THREAD_ID,
      providerState: {
        threadId: THREAD_ID,
        sessionFilePath: sourceFile,
        transcriptRootPath: sourceSessions,
      },
      messages: [],
    };
    const service = new CodexConversationHistoryService();
    await service.exportTranscripts(sourceConversation, vaultPath, {
      environment: { CODEX_HOME: path.dirname(sourceSessions), HOME: tempRoot },
    });

    const syncedConversation: Conversation = {
      ...sourceConversation,
      providerState: { ...sourceConversation.providerState },
    };
    const changed = await service.ensureLocalTranscripts(syncedConversation, vaultPath, {
      environment: { CODEX_HOME: path.dirname(targetSessions), HOME: tempRoot },
    });

    expect(changed).toBe(true);
    expect(syncedConversation.providerState).toMatchObject({
      threadId: THREAD_ID,
      transcriptRootPath: targetSessions,
    });
    const localPath = (syncedConversation.providerState as Record<string, string>).sessionFilePath;
    expect(localPath.startsWith(targetSessions)).toBe(true);
    expect(fs.readFileSync(localPath, 'utf-8')).toBe('shared codex transcript\n');
  });

  it('cleans the provider-owned vault mirror without deleting native history', async () => {
    writeFile(sourceFile, 'keep native\n');
    await exportCodexTranscriptToVault(vaultPath, THREAD_ID, sourceFile, sourceSessions);

    await deleteVaultCodexTranscripts(vaultPath, [THREAD_ID]);

    expect(fs.existsSync(getVaultCodexTranscriptRoot(vaultPath, THREAD_ID))).toBe(false);
    expect(fs.readFileSync(sourceFile, 'utf-8')).toBe('keep native\n');
  });

  it('rejects traversal-like thread ids and out-of-root source paths', async () => {
    writeFile(sourceFile, 'content\n');
    await expect(exportCodexTranscriptToVault(
      vaultPath,
      '../escape',
      sourceFile,
      sourceSessions,
    )).resolves.toBe(false);
    await expect(exportCodexTranscriptToVault(
      vaultPath,
      THREAD_ID,
      sourceFile,
      path.join(sourceSessions, 'unrelated-root'),
    )).resolves.toBe(false);
  });
});
