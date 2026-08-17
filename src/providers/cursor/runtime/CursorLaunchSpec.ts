import * as path from 'node:path';

export interface BuildCursorAcpLaunchSpecParams {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  force: boolean;
  environmentKey?: string;
}

export interface CursorAcpLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  launchKey: string;
}

export function buildCursorAcpLaunchSpec(
  params: BuildCursorAcpLaunchSpecParams,
): CursorAcpLaunchSpec {
  const commandName = path.basename(params.command).toLowerCase().replace(/\.(?:cmd|exe)$/i, '');
  const isIdeLauncher = commandName === 'cursor';
  const args = [
    ...(isIdeLauncher ? ['agent'] : []),
    ...(params.force ? ['--force'] : []),
    'acp',
  ];

  return {
    args,
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    launchKey: JSON.stringify({
      args,
      command: params.command,
      cwd: params.cwd,
      environmentKey: params.environmentKey ?? '',
    }),
  };
}
