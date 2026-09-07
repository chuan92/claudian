import type { CodexRpcTransport } from './CodexRpcTransport';

interface ProjectListResult {
  data: Array<{ id: string; roots: Array<{ path: string }> }>;
  nextCursor?: string | null;
}

function normalizeRoot(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

/** Project identity is separate from cwd in current Codex desktop clients. */
export async function resolveCodexProjectId(
  transport: CodexRpcTransport,
  cwd: string | undefined,
): Promise<string | undefined> {
  if (!cwd) return undefined;
  const matches = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const result = await transport.request<ProjectListResult>(
        'project/list', { cursor, limit: 100 }, 3000,
      );
      for (const project of result.data) {
        if (project.roots.some(root => normalizeRoot(root.path) === normalizeRoot(cwd))) {
          matches.add(project.id);
        }
      }
      cursor = result.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) return undefined;
      if (cursor) cursors.add(cursor);
    } while (cursor);
  } catch {
    // Older app servers do not expose project APIs; chat remains usable.
    return undefined;
  }
  return matches.size === 1 ? matches.values().next().value : undefined;
}
