import { buildCursorAcpLaunchSpec } from '@/providers/cursor/runtime/CursorLaunchSpec';

describe('buildCursorAcpLaunchSpec', () => {
  it('launches the standalone Cursor Agent binary directly', () => {
    expect(buildCursorAcpLaunchSpec({
      command: '/Users/me/.local/bin/cursor-agent',
      cwd: '/vault',
      env: { PATH: '/bin' },
      force: false,
    })).toEqual(expect.objectContaining({
      args: ['acp'],
      command: '/Users/me/.local/bin/cursor-agent',
      cwd: '/vault',
    }));
  });

  it('routes the Cursor IDE launcher through its agent subcommand', () => {
    expect(buildCursorAcpLaunchSpec({
      command: '/usr/local/bin/cursor',
      cwd: '/vault',
      env: {},
      force: true,
    }).args).toEqual(['agent', '--force', 'acp']);
  });

  it('includes force mode in the launch key', () => {
    const base = {
      command: 'cursor-agent',
      cwd: '/vault',
      env: {},
    };

    expect(buildCursorAcpLaunchSpec({ ...base, force: false }).launchKey)
      .not.toBe(buildCursorAcpLaunchSpec({ ...base, force: true }).launchKey);
  });
});
