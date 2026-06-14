import * as fs from 'fs/promises';
import * as path from 'path';

import { SESSION_TRANSCRIPTS_PATH } from '../../../core/bootstrap/StoragePaths';
import { encodeVaultPathForSDK, getSDKProjectsPath, isValidSessionId } from './sdkSessionPaths';

/**
 * Cross-machine transcript sync for Claude.
 *
 * The conversation metadata (`.claudian/sessions/*.meta.json`) lives inside the
 * vault and is carried between machines by the user's sync tool. The actual
 * transcript content lives in `~/.claude/projects/{encode(vaultPath)}/{id}.jsonl`,
 * outside the vault, and the project directory name embeds the absolute vault
 * path (including the username). These helpers bridge the gap:
 *
 * - {@link exportTranscriptToVault} copies the native transcript into the vault.
 * - {@link importTranscriptFromVault} materializes a vault-carried transcript
 *   into THIS machine's native path, keyed by the local vault path so a
 *   different username/path on the source machine is transparently remapped.
 *
 * Transcripts only grow for a given session id (resume appends; forks create a
 * new id), so file size is a clock-independent "which copy is ahead" signal —
 * preferable to mtime comparison across machines with skewed clocks.
 */

function getNativeTranscriptPath(vaultPath: string, sessionId: string): string {
  return path.join(getSDKProjectsPath(), encodeVaultPathForSDK(vaultPath), `${sessionId}.jsonl`);
}

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

/** Copies a native transcript into the vault. No-op when missing or already mirrored. */
export async function exportTranscriptToVault(vaultPath: string, sessionId: string): Promise<boolean> {
  if (!isValidSessionId(sessionId)) {
    return false;
  }

  const nativePath = getNativeTranscriptPath(vaultPath, sessionId);
  const nativeSize = await fileSize(nativePath);
  if (nativeSize === null) {
    return false;
  }

  const vaultFile = getVaultTranscriptPath(vaultPath, sessionId);
  const mirroredSize = await fileSize(vaultFile);
  if (mirroredSize !== null && mirroredSize >= nativeSize) {
    return false;
  }

  await copyFile(nativePath, vaultFile);
  return true;
}

/** Materializes a vault transcript into this machine's native path. No-op when local copy is ahead. */
export async function importTranscriptFromVault(vaultPath: string, sessionId: string): Promise<boolean> {
  if (!isValidSessionId(sessionId)) {
    return false;
  }

  const vaultFile = getVaultTranscriptPath(vaultPath, sessionId);
  const mirroredSize = await fileSize(vaultFile);
  if (mirroredSize === null) {
    return false;
  }

  const nativePath = getNativeTranscriptPath(vaultPath, sessionId);
  const nativeSize = await fileSize(nativePath);
  if (nativeSize !== null && nativeSize >= mirroredSize) {
    return false;
  }

  await copyFile(vaultFile, nativePath);
  return true;
}

function uniqueSessionIds(sessionIds: Iterable<string>): string[] {
  return [...new Set(sessionIds)].filter((id) => !!id);
}

/** Best-effort export for every session id backing a conversation. */
export async function exportTranscripts(vaultPath: string, sessionIds: Iterable<string>): Promise<void> {
  for (const sessionId of uniqueSessionIds(sessionIds)) {
    try {
      await exportTranscriptToVault(vaultPath, sessionId);
    } catch {
      // Best-effort; a single failure must not block the others.
    }
  }
}

/** Best-effort import for every session id backing a conversation. Returns whether any file changed. */
export async function importTranscripts(vaultPath: string, sessionIds: Iterable<string>): Promise<boolean> {
  let imported = false;
  for (const sessionId of uniqueSessionIds(sessionIds)) {
    try {
      if (await importTranscriptFromVault(vaultPath, sessionId)) {
        imported = true;
      }
    } catch {
      // Best-effort; a single failure must not block the others.
    }
  }
  return imported;
}

/** Removes vault-mirrored transcripts when a conversation is deleted, so they don't resurrect via sync. */
export async function deleteVaultTranscripts(vaultPath: string, sessionIds: Iterable<string>): Promise<void> {
  for (const sessionId of uniqueSessionIds(sessionIds)) {
    if (!isValidSessionId(sessionId)) {
      continue;
    }
    try {
      await fs.rm(getVaultTranscriptPath(vaultPath, sessionId), { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
