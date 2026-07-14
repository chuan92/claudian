import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { SESSION_TRANSCRIPTS_PATH } from '../../../core/bootstrap/StoragePaths';
import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { getSDKSessionPath, isValidSessionId } from './sdkSessionPaths';

/** Vault-carried mirror used to bridge Claude's machine-specific project path. */
export function getVaultTranscriptPath(vaultPath: string, sessionId: string): string {
  return path.join(vaultPath, ...SESSION_TRANSCRIPTS_PATH.split('/'), `${sessionId}.jsonl`);
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

async function copyFile(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

/** Copies a native transcript into the vault when the native copy is ahead. */
export async function exportTranscriptToVault(
  vaultPath: string,
  sessionId: string,
  pathContext?: ProviderHistoryPathContext,
  sourcePath?: string,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;

  const nativePath = sourcePath ?? getSDKSessionPath(vaultPath, sessionId, pathContext);
  const nativeSize = await fileSize(nativePath);
  if (nativeSize === null) return false;

  const vaultFile = getVaultTranscriptPath(vaultPath, sessionId);
  const mirroredSize = await fileSize(vaultFile);
  if (mirroredSize !== null && mirroredSize >= nativeSize) return false;

  await copyFile(nativePath, vaultFile);
  return true;
}

/** Materializes a vault transcript in this machine's Claude project directory. */
export async function importTranscriptFromVault(
  vaultPath: string,
  sessionId: string,
  pathContext?: ProviderHistoryPathContext,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;

  const vaultFile = getVaultTranscriptPath(vaultPath, sessionId);
  const mirroredSize = await fileSize(vaultFile);
  if (mirroredSize === null) return false;

  const nativePath = getSDKSessionPath(vaultPath, sessionId, pathContext);
  const nativeSize = await fileSize(nativePath);
  if (nativeSize !== null && nativeSize >= mirroredSize) return false;

  await copyFile(vaultFile, nativePath);
  return true;
}

function uniqueSessionIds(sessionIds: Iterable<string>): string[] {
  return [...new Set(sessionIds)].filter(Boolean);
}

export async function exportTranscripts(
  vaultPath: string,
  sessionIds: Iterable<string>,
  pathContext?: ProviderHistoryPathContext,
  sourcePaths: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  for (const sessionId of uniqueSessionIds(sessionIds)) {
    try {
      await exportTranscriptToVault(
        vaultPath,
        sessionId,
        pathContext,
        sourcePaths.get(sessionId),
      );
    } catch {
      // Best-effort; one inaccessible transcript must not block the others.
    }
  }
}

export async function importTranscripts(
  vaultPath: string,
  sessionIds: Iterable<string>,
  pathContext?: ProviderHistoryPathContext,
): Promise<boolean> {
  let imported = false;
  for (const sessionId of uniqueSessionIds(sessionIds)) {
    try {
      imported = await importTranscriptFromVault(vaultPath, sessionId, pathContext) || imported;
    } catch {
      // Best-effort; one inaccessible transcript must not block the others.
    }
  }
  return imported;
}

export async function deleteVaultTranscripts(
  vaultPath: string,
  sessionIds: Iterable<string>,
): Promise<void> {
  for (const sessionId of uniqueSessionIds(sessionIds)) {
    if (!isValidSessionId(sessionId)) continue;
    try {
      await fs.rm(getVaultTranscriptPath(vaultPath, sessionId), { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
