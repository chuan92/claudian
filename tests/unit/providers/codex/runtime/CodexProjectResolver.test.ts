import { resolveCodexProjectId } from '@/providers/codex/runtime/CodexProjectResolver';
import type { CodexRpcTransport } from '@/providers/codex/runtime/CodexRpcTransport';

describe('resolveCodexProjectId', () => {
  const request = jest.fn();
  const transport = { request } as unknown as CodexRpcTransport;

  beforeEach(() => request.mockReset());

  it('matches a saved project root instead of its display name', async () => {
    request.mockResolvedValue({ data: [
      { id: 'wrong', name: 'Main', roots: [{ path: '/other' }] },
      { id: 'main', name: 'Notes', roots: [{ path: '/vault/' }] },
    ] });
    await expect(resolveCodexProjectId(transport, '/vault')).resolves.toBe('main');
  });

  it('searches all pages and supports Windows target paths', async () => {
    request.mockResolvedValueOnce({ data: [], nextCursor: 'next' })
      .mockResolvedValueOnce({ data: [{ id: 'win', roots: [{ path: 'C:\\Notes\\Main' }] }] });
    await expect(resolveCodexProjectId(transport, 'c:/notes/main/')).resolves.toBe('win');
    expect(request).toHaveBeenLastCalledWith('project/list', { cursor: 'next', limit: 100 }, 3000);
  });

  it('does not guess between projects sharing a root', async () => {
    request.mockResolvedValue({ data: [
      { id: 'one', roots: [{ path: '/vault' }] },
      { id: 'two', roots: [{ path: '/vault' }] },
    ] });
    await expect(resolveCodexProjectId(transport, '/vault')).resolves.toBeUndefined();
  });

  it('does not match unrelated or parent folders', async () => {
    request.mockResolvedValue({ data: [{ id: 'parent', roots: [{ path: '/vault' }] }] });
    await expect(resolveCodexProjectId(transport, '/vault/other')).resolves.toBeUndefined();
  });

  it('allows chat to continue when the runtime does not support projects', async () => {
    request.mockRejectedValue(new Error('Method not found'));
    await expect(resolveCodexProjectId(transport, '/vault')).resolves.toBeUndefined();
  });
});
