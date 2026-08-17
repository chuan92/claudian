import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createCursorSqliteSnapshot,
  validateCursorSqliteDatabase,
} from '@/providers/cursor/history/CursorSqliteSnapshot';

describe('CursorSqliteSnapshot', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-cursor-sqlite-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  });

  it('uses the CLI-bundled Node when the host runtime lacks node:sqlite backup', async () => {
    const sourcePath = path.join(tempRoot, 'source.db');
    const snapshotPath = path.join(tempRoot, 'snapshot.db');
    const source = new DatabaseSync(sourcePath);
    try {
      source.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
      source.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
      source.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run('history', 'native');

      const dependencies = {
        requireSqliteModule: () => null,
      };
      const context = {
        environment: process.env,
        settings: {
          providerConfigs: { cursor: { cliPath: process.execPath } },
        },
      };
      await expect(createCursorSqliteSnapshot(
        sourcePath,
        snapshotPath,
        context,
        dependencies,
      )).resolves.toBe(true);
      await expect(validateCursorSqliteDatabase(
        snapshotPath,
        context,
        dependencies,
      )).resolves.toBe(true);

      const snapshot = new DatabaseSync(snapshotPath);
      try {
        expect(snapshot.prepare('SELECT data FROM blobs WHERE id = ?').get('history'))
          .toEqual({ data: 'native' });
      } finally {
        snapshot.close();
      }
    } finally {
      source.close();
    }
  });
});
