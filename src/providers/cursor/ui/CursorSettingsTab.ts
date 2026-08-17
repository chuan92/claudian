import * as fs from 'node:fs';

import { Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetCursorWorkspaceServices } from '../app/CursorWorkspaceServices';
import { getCursorProviderSettings, updateCursorProviderSettings } from '../settings';
import { renderCursorModelPicker } from './CursorModelPicker';

export const cursorSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settings = getCursorProviderSettings(context.plugin.settings);
    const hostname = getHostnameKey();
    const workspace = maybeGetCursorWorkspaceServices();

    new Setting(container).setName('Setup').setHeading();
    new Setting(container)
      .setName('Enable Cursor')
      .setDesc('Launch Cursor Agent as an ACP provider using `cursor-agent acp` or `cursor agent acp`.')
      .addToggle(toggle => toggle
        .setValue(settings.enabled)
        .onChange(async (enabled) => {
          await context.plugin.mutateSettings((target) => {
            ProviderSettingsCoordinator.applyProviderEnablement(target, 'cursor', enabled);
          });
          context.refreshModelSelectors();
          context.refreshTitleGenerationModelOptions();
        }));

    const validation = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
    const cliPathsByHost = { ...settings.cliPathsByHost };
    let inputElement: HTMLInputElement | null = null;
    const validate = (value: string): boolean => {
      const error = validateCliPath(value);
      validation.setText(error ?? '');
      validation.toggleClass('claudian-hidden', !error);
      inputElement?.toggleClass('claudian-input-error', Boolean(error));
      return !error;
    };
    const persistCliPath = async (value: string): Promise<void> => {
      if (!validate(value)) {
        return;
      }
      const path = value.trim();
      if (path) {
        cliPathsByHost[hostname] = path;
      } else {
        delete cliPathsByHost[hostname];
      }
      await context.plugin.mutateSettings((target) => {
        updateCursorProviderSettings(target, {
          cliPathsByHost: { ...cliPathsByHost },
          discoveredModels: [],
          modelConfigurations: {},
          visibleModels: [],
        });
      });
      workspace?.cliResolver?.reset();
      await context.plugin.recycleProviderRuntimes?.('cursor');
      context.refreshModelSelectors();
    };

    new Setting(container)
      .setName('CLI path')
      .setDesc('Optional path to `cursor-agent`, `agent`, or the Cursor IDE launcher. Leave empty to search PATH.')
      .addText(text => {
        const value = settings.cliPathsByHost[hostname] ?? '';
        text
          .setPlaceholder(process.platform === 'win32'
            ? 'C:\\Users\\you\\.local\\bin\\cursor-agent.exe'
            : '~/.local/bin/cursor-agent')
          .setValue(value)
          .onChange(value => void persistCliPath(value));
        inputElement = text.inputEl;
        validate(value);
      });

    new Setting(container).setName('Models').setHeading();
    renderCursorModelPicker(container, context);

    new Setting(container).setName('Commands and skills').setHeading();
    context.renderHiddenProviderCommandSetting(container, 'cursor', {
      name: 'Hidden Commands and Skills',
      desc: 'Hide Cursor runtime commands and skills from the dropdown, one name per line.',
      placeholder: 'simplify\ncreate-rule',
    });

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to Cursor Agent.',
      heading: 'Environment',
      name: 'Cursor environment variables',
      placeholder: 'CURSOR_API_KEY=...\nCURSOR_API_ENDPOINT=https://api2.cursor.sh',
      plugin: context.plugin,
      scope: 'provider:cursor',
    });
  },
};

function validateCliPath(value: string): string | null {
  const path = value.trim();
  if (!path) {
    return null;
  }
  const expanded = expandHomePath(path);
  if (!fs.existsSync(expanded)) {
    return 'Path does not exist';
  }
  if (!fs.statSync(expanded).isFile()) {
    return 'Path must point to a file';
  }
  return null;
}
