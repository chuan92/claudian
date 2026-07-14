import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { SESSION_TRANSCRIPTS_PATH } from '../../../core/bootstrap/StoragePaths';

const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ImportedCodexTranscript {
  imported: boolean;
  sessionFilePath: string;
  transcriptRootPath: string;
}

function isValidSessionId(sessionId: string): boolean {
  return sessionId.length > 0
    && sessionId.length <= 128
    && SAFE_SESSION_ID_PATTERN.test(sessionId);
}

function getPathModule(value: string): typeof path.posix {
  return value.includes('\\') || /^[A-Za-z]:/.test(value)
    ? path.win32
    : path.posix;
}

function getSafeRelativeSegments(sessionFilePath: string, transcriptRootPath: string): string[] | null {
  const pathModule = getPathModule(transcriptRootPath);
  const relativePath = pathModule.relative(
    pathModule.normalize(transcriptRootPath),
    pathModule.normalize(sessionFilePath),
  );
  if (!relativePath || pathModule.isAbsolute(relativePath)) return null;

  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) {
    return null;
  }
  return segments;
}

function isSessionTranscriptFile(fileName: string, sessionId: string): boolean {
  return fileName === `${sessionId}.jsonl` || fileName.endsWith(`-${sessionId}.jsonl`);
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

export function getVaultCodexTranscriptRoot(vaultPath: string, sessionId: string): string {
  return path.join(vaultPath, ...SESSION_TRANSCRIPTS_PATH.split('/'), 'codex', sessionId);
}

export async function exportCodexTranscriptToVault(
  vaultPath: string,
  sessionId: string,
  sessionFilePath: string,
  transcriptRootPath: string,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;

  const relativeSegments = getSafeRelativeSegments(sessionFilePath, transcriptRootPath);
  if (
    !relativeSegments
    || !isSessionTranscriptFile(relativeSegments[relativeSegments.length - 1], sessionId)
  ) {
    return false;
  }

  const nativeSize = await fileSize(sessionFilePath);
  if (nativeSize === null) return false;

  const vaultFile = path.join(
    getVaultCodexTranscriptRoot(vaultPath, sessionId),
    ...relativeSegments,
  );
  const mirroredSize = await fileSize(vaultFile);
  if (mirroredSize !== null && mirroredSize >= nativeSize) return false;

  await copyFile(sessionFilePath, vaultFile);
  return true;
}

async function findMirroredTranscript(
  vaultPath: string,
  sessionId: string,
): Promise<string | null> {
  if (!isValidSessionId(sessionId)) return null;

  const root = getVaultCodexTranscriptRoot(vaultPath, sessionId);
  const pending = [root];
  let best: { filePath: string; size: number } | null = null;
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && isSessionTranscriptFile(entry.name, sessionId)) {
        const size = await fileSize(entryPath);
        if (size !== null && (!best || size > best.size)) {
          best = { filePath: entryPath, size };
        }
      }
    }
  }
  return best?.filePath ?? null;
}

export async function importCodexTranscriptFromVault(
  vaultPath: string,
  sessionId: string,
  localTranscriptRoots: string[],
  existingSessionFilePath?: string | null,
  existingTranscriptRootPath?: string | null,
): Promise<ImportedCodexTranscript | null> {
  if (!isValidSessionId(sessionId) || localTranscriptRoots.length === 0) return null;

  const vaultFile = await findMirroredTranscript(vaultPath, sessionId);
  if (!vaultFile) return null;

  const mirroredSize = await fileSize(vaultFile);
  if (mirroredSize === null) return null;

  const existingSize = existingSessionFilePath
    ? await fileSize(existingSessionFilePath)
    : null;
  if (existingSessionFilePath && existingTranscriptRootPath && existingSize !== null) {
    if (existingSize < mirroredSize) {
      await copyFile(vaultFile, existingSessionFilePath);
    }
    return {
      imported: existingSize < mirroredSize,
      sessionFilePath: existingSessionFilePath,
      transcriptRootPath: existingTranscriptRootPath,
    };
  }

  const vaultRoot = getVaultCodexTranscriptRoot(vaultPath, sessionId);
  const relativeSegments = getSafeRelativeSegments(vaultFile, vaultRoot);
  if (!relativeSegments) return null;

  const transcriptRootPath = localTranscriptRoots[0];
  const sessionFilePath = path.join(transcriptRootPath, ...relativeSegments);
  const localSize = await fileSize(sessionFilePath);
  if (localSize === null || localSize < mirroredSize) {
    await copyFile(vaultFile, sessionFilePath);
  }

  return {
    imported: localSize === null || localSize < mirroredSize,
    sessionFilePath,
    transcriptRootPath,
  };
}

export async function deleteVaultCodexTranscripts(
  vaultPath: string,
  sessionIds: Iterable<string>,
): Promise<void> {
  for (const sessionId of new Set(sessionIds)) {
    if (!isValidSessionId(sessionId)) continue;
    try {
      await fs.rm(getVaultCodexTranscriptRoot(vaultPath, sessionId), {
        force: true,
        recursive: true,
      });
    } catch {
      // Best-effort cleanup.
    }
  }
}
