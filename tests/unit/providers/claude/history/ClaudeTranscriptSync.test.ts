import type * as fsType from 'fs';
import type * as osType from 'os';
import type * as pathType from 'path';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');

import {
  exportTranscriptToVault,
  getVaultTranscriptPath,
  importTranscriptFromVault,
} from '@/providers/claude/history/ClaudeTranscriptSync';
import { encodeVaultPathForSDK } from '@/providers/claude/history/sdkSessionPaths';

const SESSION_ID = 'abc12345-0000-4000-8000-000000000001';

describe('ClaudeTranscriptSync', () => {
  let homeDirSpy: jest.SpyInstance<string, []>;
  let tempHome: string;
  let tempRoot: string;
  let vaultA: string;
  let vaultB: string;

  function nativePath(vault: string, sessionId = SESSION_ID): string {
    return path.join(
      tempHome,
      '.claude',
      'projects',
      encodeVaultPathForSDK(vault),
      `${sessionId}.jsonl`,
    );
  }

  function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-transcript-home-'));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-transcript-vault-'));
    vaultA = path.join(tempRoot, 'machine-a', 'vault');
    vaultB = path.join(tempRoot, 'machine-b', 'vault');
    fs.mkdirSync(vaultA, { recursive: true });
    fs.mkdirSync(vaultB, { recursive: true });
    homeDirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    homeDirSpy.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('exports the native JSONL into the vault mirror', async () => {
    writeFile(nativePath(vaultA), 'line1\nline2\n');

    await expect(exportTranscriptToVault(vaultA, SESSION_ID)).resolves.toBe(true);
    expect(fs.readFileSync(getVaultTranscriptPath(vaultA, SESSION_ID), 'utf-8'))
      .toBe('line1\nline2\n');
  });

  it('imports into the project directory encoded from this machine vault path', async () => {
    writeFile(nativePath(vaultA), 'shared\ncontent\n');
    await exportTranscriptToVault(vaultA, SESSION_ID);
    writeFile(
      getVaultTranscriptPath(vaultB, SESSION_ID),
      fs.readFileSync(getVaultTranscriptPath(vaultA, SESSION_ID), 'utf-8'),
    );

    await expect(importTranscriptFromVault(vaultB, SESSION_ID)).resolves.toBe(true);
    expect(encodeVaultPathForSDK(vaultA)).not.toBe(encodeVaultPathForSDK(vaultB));
    expect(fs.readFileSync(nativePath(vaultB), 'utf-8')).toBe('shared\ncontent\n');
  });

  it('refreshes a shorter local transcript but preserves a longer local copy', async () => {
    writeFile(getVaultTranscriptPath(vaultB, SESSION_ID), 'one\ntwo\nthree\n');
    writeFile(nativePath(vaultB), 'one\n');

    await expect(importTranscriptFromVault(vaultB, SESSION_ID)).resolves.toBe(true);
    expect(fs.readFileSync(nativePath(vaultB), 'utf-8')).toBe('one\ntwo\nthree\n');

    writeFile(nativePath(vaultB), 'one\ntwo\nthree\nfour\n');
    await expect(importTranscriptFromVault(vaultB, SESSION_ID)).resolves.toBe(false);
    expect(fs.readFileSync(nativePath(vaultB), 'utf-8')).toBe('one\ntwo\nthree\nfour\n');
  });

  it('honors CLAUDE_CONFIG_DIR from the provider path context', async () => {
    const configDir = path.join(tempHome, 'custom-claude');
    const context = { environment: { CLAUDE_CONFIG_DIR: configDir }, vaultPath: vaultB };
    writeFile(getVaultTranscriptPath(vaultB, SESSION_ID), 'custom home\n');

    await expect(importTranscriptFromVault(vaultB, SESSION_ID, context)).resolves.toBe(true);
    expect(fs.readFileSync(
      path.join(configDir, 'projects', encodeVaultPathForSDK(vaultB), `${SESSION_ID}.jsonl`),
      'utf-8',
    )).toBe('custom home\n');
  });

  it('rejects unsafe session ids', async () => {
    await expect(importTranscriptFromVault(vaultB, '../escape')).resolves.toBe(false);
    await expect(exportTranscriptToVault(vaultB, '../escape')).resolves.toBe(false);
  });
});
