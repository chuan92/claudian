import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../../core/types';

export class CursorCommandCatalog implements ProviderCommandCatalog {
  private runtimeCommands: SlashCommand[] = [];

  setRuntimeCommands(commands: SlashCommand[]): void {
    const seen = new Set<string>();
    this.runtimeCommands = commands.flatMap((command) => {
      const name = command.name.trim().replace(/^\/+/, '');
      const key = name.toLowerCase();
      if (!name || seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [{ ...command, name }];
    });
  }

  async listDropdownEntries(): Promise<ProviderCommandEntry[]> {
    return this.runtimeCommands.map(command => ({
      agent: command.agent,
      allowedTools: command.allowedTools,
      argumentHint: command.argumentHint,
      content: command.content,
      context: command.context,
      description: command.description,
      disableModelInvocation: command.disableModelInvocation,
      displayPrefix: '/',
      hooks: command.hooks,
      id: command.id,
      insertPrefix: '/',
      isDeletable: false,
      isEditable: false,
      kind: command.kind ?? 'command',
      model: command.model,
      name: command.name,
      providerId: 'cursor',
      scope: 'runtime',
      source: command.source ?? 'sdk',
      userInvocable: command.userInvocable,
    }));
  }

  async listVaultEntries(): Promise<ProviderCommandEntry[]> {
    return [];
  }

  async saveVaultEntry(): Promise<void> {
    throw new Error('Cursor runtime commands are not editable from Claudian.');
  }

  async deleteVaultEntry(): Promise<void> {
    throw new Error('Cursor runtime commands are not deletable from Claudian.');
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      builtInPrefix: '/',
      commandPrefix: '/',
      providerId: 'cursor',
      skillPrefix: '/',
      triggerChars: ['/'],
    };
  }

  async refresh(): Promise<void> {}
}
