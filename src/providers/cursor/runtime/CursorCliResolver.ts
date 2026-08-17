import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { findCliBinaryPath, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { getCursorProviderSettings } from '../settings';

export class CursorCliResolver {
  private readonly hostname = getHostnameKey();
  private lastCacheKey = '';
  private resolvedPath: string | null = null;

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const cursorSettings = getCursorProviderSettings(settings);
    const environmentText = getRuntimeEnvironmentText(settings, 'cursor');
    const cacheKey = JSON.stringify({
      cliPath: cursorSettings.cliPath,
      environmentText,
      hostnamePath: cursorSettings.cliPathsByHost[this.hostname] ?? '',
    });
    if (cacheKey === this.lastCacheKey) {
      return this.resolvedPath;
    }

    this.lastCacheKey = cacheKey;
    this.resolvedPath = this.resolve(
      cursorSettings.cliPathsByHost,
      cursorSettings.cliPath,
      environmentText,
    );
    return this.resolvedPath;
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    environmentText = '',
  ): string | null {
    const hostnamePath = (hostnamePaths?.[this.hostname] ?? '').trim();
    const customPath = parseEnvironmentVariables(environmentText).PATH;
    return resolveConfiguredCliPath(hostnamePath)
      ?? resolveConfiguredCliPath(legacyPath.trim())
      ?? findCliBinaryPath('cursor-agent', customPath)
      ?? findCliBinaryPath('cursor', customPath)
      ?? findCliBinaryPath('agent', customPath);
  }

  reset(): void {
    this.lastCacheKey = '';
    this.resolvedPath = null;
  }
}
