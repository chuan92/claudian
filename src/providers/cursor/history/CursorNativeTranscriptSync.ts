import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { SESSION_TRANSCRIPTS_PATH } from '../../../core/bootstrap/StoragePaths';
import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import {
  createCursorSqliteSnapshot,
  validateCursorSqliteDatabase,
} from './CursorSqliteSnapshot';

const CURSOR_NATIVE_TRANSCRIPT_VERSION = 1;
const CURSOR_NATIVE_DATABASE_NAME = 'store.db';
const CURSOR_NATIVE_META_NAME = 'meta.json';
const CURSOR_NATIVE_MANIFEST_NAME = 'manifest.json';
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface CursorNativeTranscriptManifest {
  conversationId: string;
  conversationUpdatedAt: number;
  cursorSchemaVersion: number;
  databaseSha256: string;
  databaseSize: number;
  exportedAt: number;
  sessionId: string;
  version: number;
}

interface MovedFile {
  backupPath: string;
  originalPath: string;
}

export function getCursorNativeSessionDbPath(
  sessionId: string,
  context?: ProviderHistoryPathContext,
): string | null {
  if (!isSafeId(sessionId)) {
    return null;
  }

  const home = resolveHomeDirectory(context);
  return home
    ? path.join(home, '.cursor', 'acp-sessions', sessionId, CURSOR_NATIVE_DATABASE_NAME)
    : null;
}

export function getVaultCursorNativeSessionDbPath(
  vaultPath: string,
  conversationId: string,
): string | null {
  const sessionRoot = getVaultCursorNativeSessionRoot(vaultPath, conversationId);
  return sessionRoot ? path.join(sessionRoot, CURSOR_NATIVE_DATABASE_NAME) : null;
}

export async function exportCursorNativeSessionToVault(
  vaultPath: string,
  conversation: Conversation,
  pathContext?: ProviderHistoryPathContext,
): Promise<boolean> {
  try {
    return await exportCursorNativeSession(vaultPath, conversation, pathContext);
  } catch {
    return false;
  }
}

export async function importCursorNativeSessionFromVault(
  vaultPath: string,
  conversation: Conversation,
  pathContext?: ProviderHistoryPathContext,
): Promise<boolean> {
  try {
    return await importCursorNativeSession(vaultPath, conversation, pathContext);
  } catch {
    return false;
  }
}

export async function deleteVaultCursorNativeSession(
  vaultPath: string,
  conversationId: string,
): Promise<void> {
  const sessionRoot = getVaultCursorNativeSessionRoot(vaultPath, conversationId);
  if (!sessionRoot) {
    return;
  }

  try {
    await fs.rm(sessionRoot, { force: true, recursive: true });
  } catch {
    // Mirror cleanup is best-effort and must not touch Cursor's native store.
  }
}

async function exportCursorNativeSession(
  vaultPath: string,
  conversation: Conversation,
  pathContext?: ProviderHistoryPathContext,
): Promise<boolean> {
  const sessionId = conversation.sessionId;
  if (!sessionId || !isSafeId(sessionId)) {
    return false;
  }

  const sourceDatabasePath = getCursorNativeSessionDbPath(sessionId, pathContext);
  const snapshotPath = getVaultCursorNativeSessionDbPath(vaultPath, conversation.id);
  if (!sourceDatabasePath || !snapshotPath || !await isRegularFile(sourceDatabasePath)) {
    return false;
  }

  const sessionRoot = path.dirname(snapshotPath);
  const manifestPath = path.join(sessionRoot, CURSOR_NATIVE_MANIFEST_NAME);
  const existingManifest = await readManifest(manifestPath, conversation.id);
  if (
    existingManifest
    && existingManifest.conversationUpdatedAt > conversation.updatedAt
  ) {
    return false;
  }

  await fs.mkdir(sessionRoot, { recursive: true });
  const token = randomUUID();
  const temporarySnapshotPath = `${snapshotPath}.${token}.tmp`;
  const temporaryManifestPath = `${manifestPath}.${token}.tmp`;
  try {
    if (!await createCursorSqliteSnapshot(
      sourceDatabasePath,
      temporarySnapshotPath,
      pathContext,
    )) {
      return false;
    }
    if (!await validateCursorSqliteDatabase(temporarySnapshotPath, pathContext)) {
      return false;
    }

    const snapshotStat = await fs.stat(temporarySnapshotPath);
    const sourceMeta = await readJsonRecord(
      path.join(path.dirname(sourceDatabasePath), CURSOR_NATIVE_META_NAME),
    );
    const manifest: CursorNativeTranscriptManifest = {
      conversationId: conversation.id,
      conversationUpdatedAt: conversation.updatedAt,
      cursorSchemaVersion: readCursorSchemaVersion(sourceMeta),
      databaseSha256: await hashFile(temporarySnapshotPath),
      databaseSize: snapshotStat.size,
      exportedAt: Date.now(),
      sessionId,
      version: CURSOR_NATIVE_TRANSCRIPT_VERSION,
    };
    await fs.writeFile(temporaryManifestPath, JSON.stringify(manifest), 'utf8');

    await replaceFile(temporarySnapshotPath, snapshotPath);
    await replaceFile(temporaryManifestPath, manifestPath);
    return true;
  } finally {
    await Promise.all([
      fs.rm(temporarySnapshotPath, { force: true }).catch(() => {}),
      fs.rm(temporaryManifestPath, { force: true }).catch(() => {}),
    ]);
  }
}

async function importCursorNativeSession(
  vaultPath: string,
  conversation: Conversation,
  pathContext?: ProviderHistoryPathContext,
): Promise<boolean> {
  const sessionId = conversation.sessionId;
  const snapshotPath = getVaultCursorNativeSessionDbPath(vaultPath, conversation.id);
  const targetDatabasePath = sessionId
    ? getCursorNativeSessionDbPath(sessionId, pathContext)
    : null;
  if (!sessionId || !snapshotPath || !targetDatabasePath) {
    return false;
  }

  const manifestPath = path.join(path.dirname(snapshotPath), CURSOR_NATIVE_MANIFEST_NAME);
  const manifest = await readManifest(manifestPath, conversation.id, sessionId);
  if (!manifest || !await validateSnapshot(snapshotPath, manifest, pathContext)) {
    return false;
  }

  const targetExists = await isRegularFile(targetDatabasePath);
  if (targetExists) {
    const localHash = await snapshotAndHashLocalDatabase(targetDatabasePath, pathContext);
    if (localHash === manifest.databaseSha256) {
      return ensureCursorNativeMeta(
        targetDatabasePath,
        manifest.cursorSchemaVersion,
        vaultPath,
        conversation.title,
      );
    }

    if (conversation.updatedAt > manifest.conversationUpdatedAt) {
      return false;
    }
    const localMtime = await getNativeSessionDataMtime(targetDatabasePath);
    if (localMtime !== null && localMtime > manifest.exportedAt) {
      return false;
    }
  }

  await installNativeSession(
    snapshotPath,
    targetDatabasePath,
    manifest.cursorSchemaVersion,
    vaultPath,
    conversation.title,
  );
  return true;
}

async function validateSnapshot(
  snapshotPath: string,
  manifest: CursorNativeTranscriptManifest,
  pathContext?: ProviderHistoryPathContext,
): Promise<boolean> {
  if (!await isRegularFile(snapshotPath)) {
    return false;
  }

  const stat = await fs.stat(snapshotPath);
  if (stat.size !== manifest.databaseSize) {
    return false;
  }
  if (await hashFile(snapshotPath) !== manifest.databaseSha256) {
    return false;
  }
  return validateCursorSqliteDatabase(snapshotPath, pathContext);
}

async function snapshotAndHashLocalDatabase(
  databasePath: string,
  pathContext?: ProviderHistoryPathContext,
): Promise<string | null> {
  const temporaryPath = `${databasePath}.${randomUUID()}.compare.tmp`;
  try {
    if (!await createCursorSqliteSnapshot(databasePath, temporaryPath, pathContext)) {
      return null;
    }
    return await hashFile(temporaryPath);
  } catch {
    return null;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function installNativeSession(
  snapshotPath: string,
  targetDatabasePath: string,
  cursorSchemaVersion: number,
  vaultPath: string,
  title: string,
): Promise<void> {
  const sessionRoot = path.dirname(targetDatabasePath);
  const metaPath = path.join(sessionRoot, CURSOR_NATIVE_META_NAME);
  const token = randomUUID();
  const pendingDatabasePath = `${targetDatabasePath}.${token}.tmp`;
  const pendingMetaPath = `${metaPath}.${token}.tmp`;
  const movedFiles: MovedFile[] = [];
  const installedFiles: string[] = [];

  await fs.mkdir(sessionRoot, { recursive: true });
  try {
    await fs.copyFile(snapshotPath, pendingDatabasePath);
    const existingMeta = await readJsonRecord(metaPath);
    await fs.writeFile(
      pendingMetaPath,
      JSON.stringify(buildCursorMeta(existingMeta, cursorSchemaVersion, vaultPath, title)),
      'utf8',
    );

    for (const originalPath of [
      targetDatabasePath,
      `${targetDatabasePath}-wal`,
      `${targetDatabasePath}-shm`,
      metaPath,
    ]) {
      const backupPath = `${originalPath}.${token}.bak`;
      if (await moveFileIfPresent(originalPath, backupPath)) {
        movedFiles.push({ backupPath, originalPath });
      }
    }

    await fs.rename(pendingDatabasePath, targetDatabasePath);
    installedFiles.push(targetDatabasePath);
    await fs.rename(pendingMetaPath, metaPath);
    installedFiles.push(metaPath);
  } catch (error) {
    for (const installedPath of installedFiles.reverse()) {
      await fs.rm(installedPath, { force: true }).catch(() => {});
    }
    for (const moved of movedFiles.reverse()) {
      await fs.rename(moved.backupPath, moved.originalPath).catch(() => {});
    }
    throw error;
  } finally {
    await Promise.all([
      fs.rm(pendingDatabasePath, { force: true }).catch(() => {}),
      fs.rm(pendingMetaPath, { force: true }).catch(() => {}),
    ]);
  }

  await Promise.all(movedFiles.map(moved => (
    fs.rm(moved.backupPath, { force: true }).catch(() => {})
  )));
}

async function ensureCursorNativeMeta(
  targetDatabasePath: string,
  cursorSchemaVersion: number,
  vaultPath: string,
  title: string,
): Promise<boolean> {
  const metaPath = path.join(path.dirname(targetDatabasePath), CURSOR_NATIVE_META_NAME);
  const existingMeta = await readJsonRecord(metaPath);
  const nextMeta = buildCursorMeta(existingMeta, cursorSchemaVersion, vaultPath, title);
  if (existingMeta && JSON.stringify(existingMeta) === JSON.stringify(nextMeta)) {
    return false;
  }

  const temporaryPath = `${metaPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(nextMeta), 'utf8');
    await replaceFile(temporaryPath, metaPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return true;
}

function buildCursorMeta(
  existingMeta: Record<string, unknown> | null,
  cursorSchemaVersion: number,
  vaultPath: string,
  title: string,
): Record<string, unknown> {
  return {
    ...existingMeta,
    schemaVersion: cursorSchemaVersion,
    cwd: vaultPath,
    title,
  };
}

async function replaceFile(sourcePath: string, targetPath: string): Promise<void> {
  const backupPath = `${targetPath}.${randomUUID()}.bak`;
  const movedTarget = await moveFileIfPresent(targetPath, backupPath);
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (movedTarget) {
      await fs.rename(backupPath, targetPath).catch(() => {});
    }
    throw error;
  }
  if (movedTarget) {
    await fs.rm(backupPath, { force: true }).catch(() => {});
  }
}

async function moveFileIfPresent(sourcePath: string, targetPath: string): Promise<boolean> {
  try {
    await fs.rename(sourcePath, targetPath);
    return true;
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

async function getNativeSessionDataMtime(databasePath: string): Promise<number | null> {
  const mtimes = await Promise.all([
    getFileMtime(databasePath),
    getFileMtime(`${databasePath}-wal`),
  ]);
  const existingMtimes = mtimes.filter((mtime): mtime is number => mtime !== null);
  return existingMtimes.length > 0 ? Math.max(...existingMtimes) : null;
}

async function getFileMtime(filePath: string): Promise<number | null> {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function readManifest(
  manifestPath: string,
  conversationId: string,
  sessionId?: string,
): Promise<CursorNativeTranscriptManifest | null> {
  const value = await readJsonRecord(manifestPath);
  if (
    !value
    || value.version !== CURSOR_NATIVE_TRANSCRIPT_VERSION
    || value.conversationId !== conversationId
    || (sessionId !== undefined && value.sessionId !== sessionId)
    || typeof value.sessionId !== 'string'
    || !isSafeId(value.sessionId)
    || !isFiniteNumber(value.conversationUpdatedAt)
    || !isFiniteNumber(value.exportedAt)
    || typeof value.cursorSchemaVersion !== 'number'
    || !Number.isSafeInteger(value.cursorSchemaVersion)
    || value.cursorSchemaVersion < 1
    || typeof value.databaseSize !== 'number'
    || !Number.isSafeInteger(value.databaseSize)
    || value.databaseSize < 1
    || typeof value.databaseSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.databaseSha256)
  ) {
    return null;
  }
  return value as unknown as CursorNativeTranscriptManifest;
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readCursorSchemaVersion(meta: Record<string, unknown> | null): number {
  const value = meta?.schemaVersion;
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : 1;
}

function getVaultCursorNativeSessionRoot(
  vaultPath: string,
  conversationId: string,
): string | null {
  if (!isSafeId(conversationId)) {
    return null;
  }
  return path.join(
    vaultPath,
    ...SESSION_TRANSCRIPTS_PATH.split('/'),
    'cursor',
    'native',
    conversationId,
  );
}

function resolveHomeDirectory(context?: ProviderHistoryPathContext): string | null {
  const environment = context?.environment ?? process.env;
  const platform = context?.hostPlatform ?? process.platform;
  const windowsHome = [
    environment.USERPROFILE,
    environment.HOMEDRIVE && environment.HOMEPATH
      ? `${environment.HOMEDRIVE}${environment.HOMEPATH}`
      : undefined,
  ];
  const candidates = platform === 'win32'
    ? [...windowsHome, environment.HOME, os.homedir()]
    : [environment.HOME, environment.USERPROFILE, os.homedir()];
  return candidates
    .map(candidate => candidate?.trim())
    .find((candidate): candidate is string => Boolean(candidate))
    ?? null;
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isSafeId(value: string): boolean {
  return value.length <= 200
    && SAFE_ID_PATTERN.test(value)
    && value !== '.'
    && value !== '..';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isErrnoException(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
