import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';

export function buildCursorRuntimeEnv(
  settings: Record<string, unknown>,
  cliPath: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environmentText = getRuntimeEnvironmentText(settings, 'cursor');
  const environmentVariables = parseEnvironmentVariables(environmentText);
  return {
    ...baseEnvironment,
    ...environmentVariables,
    PATH: getEnhancedPath(environmentVariables.PATH, cliPath || undefined),
  };
}
