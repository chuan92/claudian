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

const SID = 'abc12345-0000-4000-8000-000000000001';

describe('ClaudeTranscriptSync', () => {
  let homeDirSpy: jest.SpyInstance<string, []>;
  let tempHome: string;
  let tempRoot: string;
  // Two distinct vault paths simulate two machines with different usernames.
  let vaultA: string;
  let vaultB: string;

  function nativePath(vault: string, sessionId: string): string {
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
    vaultA = path.join(tempRoot, 'Users-huangzhenchuan-Main');
    vaultB = path.join(tempRoot, 'Users-huangzc-Main');
    fs.mkdirSync(vaultA, { recursive: true });
    fs.mkdirSync(vaultB, { recursive: true });
    homeDirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    homeDirSpy.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('exports a native transcript into the vault', async () => {
    writeFile(nativePath(vaultA, SID), 'line1\nline2\n');

    const exported = await exportTranscriptToVault(vaultA, SID);

    expect(exported).toBe(true);
    const vaultFile = getVaultTranscriptPath(vaultA, SID);
    expect(fs.existsSync(vaultFile)).toBe(true);
    expect(fs.readFileSync(vaultFile, 'utf-8')).toBe('line1\nline2\n');
  });

  it('is a no-op on export when the mirror already matches', async () => {
    writeFile(nativePath(vaultA, SID), 'line1\nline2\n');
    await exportTranscriptToVault(vaultA, SID);

    const second = await exportTranscriptToVault(vaultA, SID);

    expect(second).toBe(false);
  });

  it('returns false on export when the native transcript is missing', async () => {
    const exported = await exportTranscriptToVault(vaultA, SID);
    expect(exported).toBe(false);
  });

  it('re-exports when the native transcript grows after the first export', async () => {
    // The provider SDK flushes the final assistant message slightly after the
    // turn-completion save, so the first export can lag a couple of lines.
    writeFile(nativePath(vaultA, SID), 'user\ntool_result\n');
    await exportTranscriptToVault(vaultA, SID);

    fs.appendFileSync(nativePath(vaultA, SID), 'thinking\nfinal reply\n');
    const reexported = await exportTranscriptToVault(vaultA, SID);

    expect(reexported).toBe(true);
    expect(fs.readFileSync(getVaultTranscriptPath(vaultA, SID), 'utf-8')).toBe(
      'user\ntool_result\nthinking\nfinal reply\n',
    );
  });

  it('imports a vault transcript into THIS machine\'s native path (remapped encoding)', async () => {
    // Machine A produces and exports the transcript.
    writeFile(nativePath(vaultA, SID), 'shared\ncontent\n');
    await exportTranscriptToVault(vaultA, SID);

    // Syncthing delivers the vault file into machine B's view of the same vault.
    const fromA = getVaultTranscriptPath(vaultA, SID);
    const intoB = getVaultTranscriptPath(vaultB, SID);
    writeFile(intoB, fs.readFileSync(fromA, 'utf-8'));

    const imported = await importTranscriptFromVault(vaultB, SID);

    expect(imported).toBe(true);
    expect(encodeVaultPathForSDK(vaultA)).not.toBe(encodeVaultPathForSDK(vaultB));
    const nativeB = nativePath(vaultB, SID);
    expect(fs.existsSync(nativeB)).toBe(true);
    expect(fs.readFileSync(nativeB, 'utf-8')).toBe('shared\ncontent\n');
  });

  it('is a no-op on import when the local native transcript already matches', async () => {
    writeFile(getVaultTranscriptPath(vaultB, SID), 'shared\ncontent\n');
    await importTranscriptFromVault(vaultB, SID);

    const second = await importTranscriptFromVault(vaultB, SID);

    expect(second).toBe(false);
  });

  it('refreshes the local transcript when the vault copy has grown', async () => {
    writeFile(nativePath(vaultB, SID), 'one\n');
    writeFile(getVaultTranscriptPath(vaultB, SID), 'one\ntwo\nthree\n');

    const imported = await importTranscriptFromVault(vaultB, SID);

    expect(imported).toBe(true);
    expect(fs.readFileSync(nativePath(vaultB, SID), 'utf-8')).toBe('one\ntwo\nthree\n');
  });

  it('does not clobber a longer local transcript with a shorter vault copy', async () => {
    writeFile(nativePath(vaultB, SID), 'one\ntwo\nthree\n');
    writeFile(getVaultTranscriptPath(vaultB, SID), 'one\n');

    const imported = await importTranscriptFromVault(vaultB, SID);

    expect(imported).toBe(false);
    expect(fs.readFileSync(nativePath(vaultB, SID), 'utf-8')).toBe('one\ntwo\nthree\n');
  });

  it('rejects unsafe session ids without touching the filesystem', async () => {
    await expect(importTranscriptFromVault(vaultB, '../escape')).resolves.toBe(false);
    await expect(exportTranscriptToVault(vaultB, '../escape')).resolves.toBe(false);
  });
});
