const mockRenderCursorModelPicker = jest.fn();

jest.mock('obsidian', () => ({
  Setting: class MockSetting {
    constructor(_container: unknown) {}

    setName(_name: string) {
      return this;
    }

    setDesc(_description: string) {
      return this;
    }

    setHeading() {
      return this;
    }

    addToggle(callback: (toggle: any) => void) {
      const toggle = {
        setValue: jest.fn().mockReturnThis(),
        onChange: jest.fn().mockReturnThis(),
      };
      callback(toggle);
      return this;
    }

    addText(callback: (text: any) => void) {
      const text = {
        inputEl: { toggleClass: jest.fn() },
        setPlaceholder: jest.fn().mockReturnThis(),
        setValue: jest.fn().mockReturnThis(),
        onChange: jest.fn().mockReturnThis(),
      };
      callback(text);
      return this;
    }
  },
}));

jest.mock('@/providers/cursor/ui/CursorModelPicker', () => ({
  renderCursorModelPicker: (...args: unknown[]) => mockRenderCursorModelPicker(...args),
}));

jest.mock('@/providers/cursor/app/CursorWorkspaceServices', () => ({
  maybeGetCursorWorkspaceServices: jest.fn(() => null),
}));

jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: jest.fn(),
}));

jest.mock('@/utils/env', () => ({
  getHostnameKey: jest.fn(() => 'host-a'),
}));

import { cursorSettingsTabRenderer } from '@/providers/cursor/ui/CursorSettingsTab';

describe('CursorSettingsTab', () => {
  it('renders the shared Cursor model picker in the Models section', () => {
    const container = {
      createDiv: jest.fn(() => ({
        setText: jest.fn(),
        toggleClass: jest.fn(),
      })),
    } as any;
    const context = {
      plugin: {
        settings: {
          providerConfigs: {
            cursor: { enabled: true },
          },
        },
      },
      renderHiddenProviderCommandSetting: jest.fn(),
    } as any;

    cursorSettingsTabRenderer.render(container, context);

    expect(mockRenderCursorModelPicker).toHaveBeenCalledWith(container, context);
  });
});
