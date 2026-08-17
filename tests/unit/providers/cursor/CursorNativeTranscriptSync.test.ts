import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ProviderHistoryPathContext } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import {
  deleteVaultCursorNativeSession,
  exportCursorNativeSessionToVault,
  getCursorNativeSessionDbPath,
  getVaultCursorNativeSessionDbPath,
  importCursorNativeSessionFromVault,
} from '@/providers/cursor/history/CursorNativeTranscriptSync';

const SESSION_ID = 'c214a991-2f9d-4db0-af17-fad5c8913985';

function createConversation(updatedAt = 100): Conversation {
  return {
    createdAt: 1,
    id: 'conversation-1',
    messages: [],
    providerId: 'cursor',
    sessionId: SESSION_ID,
    title: 'Shared Cursor session',
    updatedAt,
  };
}

function createPathContext(home: string, vaultPath: string): ProviderHistoryPathContext {
  return {
    environment: { HOME: home },
    hostPlatform: 'darwin',
    vaultPath,
  };
}

function createNativeSession(
  home: string,
  vaultPath: string,
  value: string,
): { database: DatabaseSync; databasePath: string } {
  const context = createPathContext(home, vaultPath);
  const databasePath = getCursorNativeSessionDbPath(SESSION_ID, context)!;
  const sessionRoot = path.dirname(databasePath);
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, 'meta.json'), JSON.stringify({
    schemaVersion: 1,
    cwd: vaultPath,
    title: 'Native Cursor title',
  }));

  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  database.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  database.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  database.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run('conversation', value);
  return { database, databasePath };
}

function readNativeValue(databasePath: string): string {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare('SELECT data FROM blobs WHERE id = ?')
      .get('conversation') as { data: Uint8Array | string };
    return Buffer.from(row.data).toString('utf8');
  } finally {
    database.close();
  }
}

describe('CursorNativeTranscriptSync', () => {
  let tempRoot: string;
  let vaultPath: string;
  let sourceHome: string;
  let targetHome: string;
  const openDatabases: DatabaseSync[] = [];

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-cursor-native-sync-'));
    vaultPath = path.join(tempRoot, 'vault');
    sourceHome = path.join(tempRoot, 'machine-a');
    targetHome = path.join(tempRoot, 'machine-b');
    fs.mkdirSync(vaultPath, { recursive: true });
  });

  afterEach(() => {
    for (const database of openDatabases.splice(0)) {
      database.close();
    }
    fs.rmSync(tempRoot, { force: true, recursive: true });
  });

  it('exports a consistent native snapshot while Cursor has uncheckpointed WAL data', async () => {
    const source = createNativeSession(sourceHome, vaultPath, 'native history');
    openDatabases.push(source.database);
    expect(fs.existsSync(`${source.databasePath}-wal`)).toBe(true);

    await expect(exportCursorNativeSessionToVault(
      vaultPath,
      createConversation(),
      createPathContext(sourceHome, vaultPath),
    )).resolves.toBe(true);

    const snapshotPath = getVaultCursorNativeSessionDbPath(vaultPath, 'conversation-1')!;
    expect(readNativeValue(snapshotPath)).toBe('native history');
    const snapshot = new DatabaseSync(snapshotPath);
    try {
      expect(snapshot.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
    } finally {
      snapshot.close();
    }
  });

  it('materializes the same session id and rewrites cwd for a relocated vault', async () => {
    const source = createNativeSession(sourceHome, vaultPath, 'shared native history');
    openDatabases.push(source.database);
    const conversation = createConversation();
    await exportCursorNativeSessionToVault(
      vaultPath,
      conversation,
      createPathContext(sourceHome, vaultPath),
    );
    const targetVaultPath = path.join(tempRoot, 'relocated-vault');
    fs.cpSync(
      path.join(vaultPath, '.claudian'),
      path.join(targetVaultPath, '.claudian'),
      { recursive: true },
    );

    const imported = await importCursorNativeSessionFromVault(
      targetVaultPath,
      conversation,
      createPathContext(targetHome, targetVaultPath),
    );

    const targetPath = getCursorNativeSessionDbPath(
      SESSION_ID,
      createPathContext(targetHome, targetVaultPath),
    )!;
    expect(imported).toBe(true);
    expect(readNativeValue(targetPath)).toBe('shared native history');
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(targetPath), 'meta.json'), 'utf8')))
      .toEqual({
        schemaVersion: 1,
        cwd: targetVaultPath,
        title: conversation.title,
      });
  });

  it('refreshes an older local native session from a newer shared snapshot', async () => {
    const target = createNativeSession(targetHome, vaultPath, 'stale local history');
    target.database.close();
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(target.databasePath, oldTime, oldTime);

    const source = createNativeSession(sourceHome, vaultPath, 'new remote history');
    openDatabases.push(source.database);
    const conversation = createConversation();
    await exportCursorNativeSessionToVault(
      vaultPath,
      conversation,
      createPathContext(sourceHome, vaultPath),
    );

    await expect(importCursorNativeSessionFromVault(
      vaultPath,
      conversation,
      createPathContext(targetHome, vaultPath),
    )).resolves.toBe(true);
    expect(readNativeValue(target.databasePath)).toBe('new remote history');
  });

  it('does not overwrite a local native session changed after the shared snapshot', async () => {
    const source = createNativeSession(sourceHome, vaultPath, 'older shared history');
    openDatabases.push(source.database);
    const conversation = createConversation();
    await exportCursorNativeSessionToVault(
      vaultPath,
      conversation,
      createPathContext(sourceHome, vaultPath),
    );

    const target = createNativeSession(targetHome, vaultPath, 'newer local history');
    target.database.close();
    const futureTime = new Date(Date.now() + 60_000);
    fs.utimesSync(target.databasePath, futureTime, futureTime);

    await expect(importCursorNativeSessionFromVault(
      vaultPath,
      conversation,
      createPathContext(targetHome, vaultPath),
    )).resolves.toBe(false);
    expect(readNativeValue(target.databasePath)).toBe('newer local history');
  });

  it('rejects a corrupted shared database and cleans only the vault snapshot', async () => {
    const source = createNativeSession(sourceHome, vaultPath, 'native history');
    openDatabases.push(source.database);
    const conversation = createConversation();
    await exportCursorNativeSessionToVault(
      vaultPath,
      conversation,
      createPathContext(sourceHome, vaultPath),
    );
    const snapshotPath = getVaultCursorNativeSessionDbPath(vaultPath, conversation.id)!;
    fs.writeFileSync(snapshotPath, 'corrupt');

    await expect(importCursorNativeSessionFromVault(
      vaultPath,
      conversation,
      createPathContext(targetHome, vaultPath),
    )).resolves.toBe(false);
    const targetPath = getCursorNativeSessionDbPath(
      SESSION_ID,
      createPathContext(targetHome, vaultPath),
    )!;
    expect(fs.existsSync(targetPath)).toBe(false);

    await deleteVaultCursorNativeSession(vaultPath, conversation.id);
    expect(fs.existsSync(path.dirname(snapshotPath))).toBe(false);
    expect(fs.existsSync(source.databasePath)).toBe(true);
  });

  it('rejects traversal-like session and conversation ids', () => {
    const context = createPathContext(sourceHome, vaultPath);
    expect(getCursorNativeSessionDbPath('../escape', context)).toBeNull();
    expect(getVaultCursorNativeSessionDbPath(vaultPath, '../escape')).toBeNull();
  });
});
