import { type ChildProcess, spawn as defaultSpawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { findNodeExecutable } from '../../../utils/env';
import { CursorCliResolver } from '../runtime/CursorCliResolver';

interface SqliteDatabase {
  close(): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

interface SqliteModule {
  DatabaseSync: new (
    location: string,
    options?: Record<string, unknown>,
  ) => SqliteDatabase;
  backup?: (sourceDb: SqliteDatabase, destination: string) => Promise<number>;
}

export interface CursorSqliteSnapshotDependencies {
  requireSqliteModule?: () => SqliteModule | null;
  resolveExternalNodePaths?: (
    context?: ProviderHistoryPathContext,
  ) => Promise<string[]>;
  spawn?: typeof defaultSpawn;
}

const SQLITE_HELPER_TIMEOUT_MS = 60_000;
const SQLITE_HELPER_SCRIPT = `
const { backup, DatabaseSync } = require('node:sqlite');
const [operation, databasePath, destinationPath] = process.argv.slice(1);
let database;
async function main() {
  database = new DatabaseSync(databasePath, { readonly: true });
  if (operation === 'backup') {
    await backup(database, destinationPath);
    return;
  }
  if (operation === 'check') {
    const result = database.prepare('PRAGMA quick_check').get();
    if (!result || !Object.values(result).includes('ok')) process.exitCode = 2;
    return;
  }
  process.exitCode = 2;
}
main()
  .catch(() => { process.exitCode = 1; })
  .finally(() => { if (database) database.close(); });
`.trim();

export async function createCursorSqliteSnapshot(
  sourceDatabasePath: string,
  destinationPath: string,
  context?: ProviderHistoryPathContext,
  dependencies: CursorSqliteSnapshotDependencies = {},
): Promise<boolean> {
  const resolved = resolveDependencies(dependencies);
  if (await createWithCurrentProcess(
    sourceDatabasePath,
    destinationPath,
    resolved.requireSqliteModule,
  )) {
    return true;
  }

  await fs.rm(destinationPath, { force: true }).catch(() => {});
  const nodePaths = await resolved.resolveExternalNodePaths(context);
  for (const nodePath of nodePaths) {
    if (await runSqliteHelper(
      nodePath,
      ['backup', sourceDatabasePath, destinationPath],
      context,
      resolved.spawn,
    )) {
      return true;
    }
    await fs.rm(destinationPath, { force: true }).catch(() => {});
  }
  return false;
}

export async function validateCursorSqliteDatabase(
  databasePath: string,
  context?: ProviderHistoryPathContext,
  dependencies: CursorSqliteSnapshotDependencies = {},
): Promise<boolean> {
  const resolved = resolveDependencies(dependencies);
  const sqlite = resolved.requireSqliteModule();
  if (sqlite && validateWithCurrentProcess(databasePath, sqlite)) {
    return true;
  }

  const nodePaths = await resolved.resolveExternalNodePaths(context);
  for (const nodePath of nodePaths) {
    if (await runSqliteHelper(
      nodePath,
      ['check', databasePath],
      context,
      resolved.spawn,
    )) {
      return true;
    }
  }
  return false;
}

function resolveDependencies(
  dependencies: CursorSqliteSnapshotDependencies,
): Required<CursorSqliteSnapshotDependencies> {
  return {
    requireSqliteModule,
    resolveExternalNodePaths,
    spawn: defaultSpawn,
    ...dependencies,
  };
}

async function createWithCurrentProcess(
  sourceDatabasePath: string,
  destinationPath: string,
  requireSqlite: () => SqliteModule | null,
): Promise<boolean> {
  const sqlite = requireSqlite();
  if (!sqlite || !sqlite.backup) {
    return false;
  }

  let database: SqliteDatabase | null = null;
  try {
    database = new sqlite.DatabaseSync(sourceDatabasePath, { readonly: true });
    await sqlite.backup(database, destinationPath);
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

function validateWithCurrentProcess(
  databasePath: string,
  sqlite: SqliteModule,
): boolean {
  let database: SqliteDatabase | null = null;
  try {
    database = new sqlite.DatabaseSync(databasePath, { readonly: true });
    const result = database.prepare('PRAGMA quick_check').get();
    return result !== undefined && Object.values(result).includes('ok');
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

async function resolveExternalNodePaths(
  context?: ProviderHistoryPathContext,
): Promise<string[]> {
  const nodePaths: string[] = [];
  const cliPath = new CursorCliResolver().resolveFromSettings(context?.settings ?? {});
  if (cliPath) {
    const realCliPath = await fs.realpath(cliPath).catch(() => cliPath);
    const nodeName = (context?.hostPlatform ?? process.platform) === 'win32'
      ? 'node.exe'
      : 'node';
    const bundledNodePath = path.join(path.dirname(realCliPath), nodeName);
    if (await isRegularFile(bundledNodePath)) {
      nodePaths.push(bundledNodePath);
    }
  }

  const systemNodePath = findNodeExecutable(context?.environment.PATH);
  if (systemNodePath) {
    nodePaths.push(systemNodePath);
  }
  return [...new Set(nodePaths)];
}

function requireSqliteModule(): SqliteModule | null {
  try {
    if (typeof module === 'undefined' || typeof module.require !== 'function') {
      return null;
    }
    const sqlite = module.require('node:sqlite') as unknown;
    return isRecord(sqlite)
      && typeof sqlite.DatabaseSync === 'function'
      ? sqlite as unknown as SqliteModule
      : null;
  } catch {
    return null;
  }
}

function runSqliteHelper(
  nodePath: string,
  args: string[],
  context: ProviderHistoryPathContext | undefined,
  spawn: typeof defaultSpawn,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let timer: number | null = null;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(nodePath, ['-e', SQLITE_HELPER_SCRIPT, ...args], {
        env: context?.environment ?? process.env,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }

    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0));
    timer = window.setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, SQLITE_HELPER_TIMEOUT_MS);
  });
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
