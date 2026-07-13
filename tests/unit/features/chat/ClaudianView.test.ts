import { createMockEl } from '@test/helpers/mockElement';
import { Platform, Scope } from 'obsidian';

import { ClaudianView } from '@/features/chat/ClaudianView';

const MockScope = Scope as typeof Scope & { instances: Scope[] };

function createViewHarness(options: {
  canCreateTab: boolean;
  tabBarPosition?: 'input' | 'header';
  tabCount?: number;
}): {
  newTabButtonEl: ReturnType<typeof createMockEl>;
  view: any;
} {
  const newTabButtonEl = createMockEl();
  const view = Object.create(ClaudianView.prototype) as any;

  view.plugin = {
    settings: {
      tabBarPosition: options.tabBarPosition ?? 'input',
    },
  };
  view.tabManager = {
    canCreateTab: jest.fn().mockReturnValue(options.canCreateTab),
    getTabCount: jest.fn().mockReturnValue(options.tabCount ?? 1),
  };
  view.tabBarContainerEl = createMockEl();
  view.logoEl = createMockEl();
  view.titleTextEl = createMockEl();
  view.newTabButtonEl = newTabButtonEl;

  return { newTabButtonEl, view };
}

describe('ClaudianView tab controls', () => {
  it('hides the new-tab button when the tab manager is at capacity', () => {
    const { newTabButtonEl, view } = createViewHarness({ canCreateTab: false });

    view.refreshTabControls();

    expect(newTabButtonEl.hasClass('claudian-hidden')).toBe(true);
    expect(newTabButtonEl.getAttribute('aria-disabled')).toBe('true');
    expect(newTabButtonEl.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the new-tab button when another tab can be created', () => {
    const { newTabButtonEl, view } = createViewHarness({ canCreateTab: true });
    newTabButtonEl.addClass('claudian-hidden');
    newTabButtonEl.setAttribute('aria-disabled', 'true');
    newTabButtonEl.setAttribute('aria-hidden', 'true');

    view.refreshTabControls();

    expect(newTabButtonEl.hasClass('claudian-hidden')).toBe(false);
    expect(newTabButtonEl.getAttribute('aria-disabled')).toBeNull();
    expect(newTabButtonEl.getAttribute('aria-hidden')).toBeNull();
  });
});

describe('ClaudianView Escape handling', () => {
  beforeEach(() => {
    MockScope.instances.length = 0;
  });

  function createEscapeHarness(options: {
    isStreaming: boolean;
  }): {
    cancelStreaming: jest.Mock;
    eventRefs: unknown[];
    view: any;
  } {
    const cancelStreaming = jest.fn();
    const eventRefs: unknown[] = [];
    const parentScope = new Scope();
    const view = Object.create(ClaudianView.prototype) as any;

    view.app = { scope: parentScope };
    view.containerEl = createMockEl();
    view.historyDropdown = createMockEl();
    view.registerDomEvent = jest.fn();
    view.registerEvent = jest.fn();
    view.eventRefs = eventRefs;
    view.plugin = {
      app: {
        vault: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
        workspace: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
      },
    };
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        state: { isStreaming: options.isStreaming },
        controllers: {
          inputController: { cancelStreaming },
        },
        ui: {
          fileContextManager: {
            markFileCacheDirty: jest.fn(),
            markFolderCacheDirty: jest.fn(),
            handleFileOpen: jest.fn(),
            handleClickOutside: jest.fn(),
          },
        },
      }),
    };

    return { cancelStreaming, eventRefs, view };
  }

  function createScopedSendHarness(options: {
    inputFocused: boolean;
  }): {
    inputEl: HTMLTextAreaElement;
    sendMessage: jest.Mock;
    view: any;
  } {
    const sendMessage = jest.fn();
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    Object.defineProperty(inputEl.ownerDocument, 'activeElement', {
      configurable: true,
      get: () => options.inputFocused ? inputEl : null,
    });
    const eventRefs: unknown[] = [];
    const parentScope = new Scope();
    const view = Object.create(ClaudianView.prototype) as any;

    view.app = { scope: parentScope };
    view.containerEl = createMockEl();
    view.historyDropdown = createMockEl();
    view.registerDomEvent = jest.fn();
    view.registerEvent = jest.fn();
    view.eventRefs = eventRefs;
    view.plugin = {
      app: {
        vault: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
        workspace: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
      },
    };
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        state: { isStreaming: false },
        dom: { inputEl },
        controllers: {
          inputController: { sendMessage },
        },
        ui: {
          fileContextManager: {
            markFileCacheDirty: jest.fn(),
            markFolderCacheDirty: jest.fn(),
            handleFileOpen: jest.fn(),
            handleClickOutside: jest.fn(),
          },
        },
      }),
    };

    return { inputEl, sendMessage, view };
  }

  it('registers Escape on the Obsidian view scope instead of document keydown capture', () => {
    const { view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();

    expect(view.scope).toBeInstanceOf(Scope);
    expect(view.scope.parent).toBe(view.app.scope);
    expect(view.scope.register).toHaveBeenCalledWith([], 'Escape', expect.any(Function));
    expect(view.registerDomEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      'keydown',
      expect.any(Function),
      { capture: true }
    );
  });

  it('cancels streaming and consumes scoped Escape', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(cancelStreaming).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it('consumes scoped Escape without cancelling when not streaming', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: false });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(cancelStreaming).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('consumes already handled scoped Escape without cancelling again', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({
      key: 'Escape',
      isComposing: false,
      defaultPrevented: true,
    } as KeyboardEvent);

    expect(cancelStreaming).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('sends from focused composer through scoped Mod+Enter', () => {
    Platform.isMacOS = true;
    const { sendMessage, view } = createScopedSendHarness({ inputFocused: true });

    view.wireEventHandlers();
    const sendHandler = view.scope.handlers.find(
      (handler: any) => handler.key === 'Enter' && handler.modifiers?.includes('Mod')
    );
    const event = {
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
    } as unknown as KeyboardEvent;
    const result = sendHandler.func(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it('ignores scoped Mod+Enter when composer is not focused', () => {
    Platform.isMacOS = true;
    const { sendMessage, view } = createScopedSendHarness({ inputFocused: false });

    view.wireEventHandlers();
    const sendHandler = view.scope.handlers.find(
      (handler: any) => handler.key === 'Enter' && handler.modifiers?.includes('Mod')
    );
    const event = {
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
    } as unknown as KeyboardEvent;
    const result = sendHandler.func(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

describe('ClaudianView peek banner', () => {
  function createPeekBannerHarness(options: {
    activeNote: string | null;
    conversations: Array<{
      id: string;
      currentNote?: string;
    }>;
    noteFilter?: string | null;
    consumedNote?: string | null;
  }): {
    view: any;
  } {
    const view = Object.create(ClaudianView.prototype) as any;

    view.peekBannerEl = createMockEl();
    view.peekBannerTextEl = createMockEl();
    view.historyDropdown = createMockEl();
    view.noteFilter = options.noteFilter ?? null;
    view.peekConsumedNote = options.consumedNote ?? null;

    view.getActiveNotePath = jest.fn().mockReturnValue(options.activeNote);
    view.plugin = {
      getConversationList: jest.fn().mockReturnValue(options.conversations),
    };

    view.tabManager = {
      openConversation: jest.fn().mockResolvedValue(undefined),
    };

    view.updateHistoryDropdown = jest.fn();
    view.updatePeekBanner = (ClaudianView.prototype as any).updatePeekBanner.bind(view);
    view.openHistoryConversation = (ClaudianView.prototype as any).openHistoryConversation.bind(view);
    view.openHistoryConversationInNewTab = (ClaudianView.prototype as any).openHistoryConversationInNewTab.bind(view);

    return { view };
  }

  function makeMeta(id: string, currentNote?: string): any {
    return {
      id,
      providerId: 'claude',
      title: `Conversation ${id}`,
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0,
      preview: '',
      ...(currentNote && { currentNote }),
    };
  }

  it('shows the banner when a single conversation is linked and the note is fresh', () => {
    const { view } = createPeekBannerHarness({
      activeNote: 'note-a.md',
      conversations: [makeMeta('c1', 'note-a.md')],
    });

    view.updatePeekBanner();

    expect(view.peekBannerEl.hasClass('visible')).toBe(true);
  });

  it('hides the banner when a single linked conversation has already been opened from the banner', () => {
    const { view } = createPeekBannerHarness({
      activeNote: 'note-a.md',
      conversations: [makeMeta('c1', 'note-a.md')],
      consumedNote: 'note-a.md',
    });

    view.updatePeekBanner();

    expect(view.peekBannerEl.hasClass('visible')).toBe(false);
  });

  it('shows the banner when multiple conversations are linked even after consumption', () => {
    const { view } = createPeekBannerHarness({
      activeNote: 'note-a.md',
      conversations: [
        makeMeta('c1', 'note-a.md'),
        makeMeta('c2', 'note-a.md'),
      ],
      consumedNote: 'note-a.md',
    });

    view.updatePeekBanner();

    expect(view.peekBannerEl.hasClass('visible')).toBe(true);
  });

  it('resets consumption when the active note changes', () => {
    const { view } = createPeekBannerHarness({
      activeNote: 'note-b.md',
      conversations: [makeMeta('c1', 'note-b.md')],
      consumedNote: 'note-a.md',
    });

    view.updatePeekBanner();

    expect(view.peekConsumedNote).toBeNull();
    expect(view.peekBannerEl.hasClass('visible')).toBe(true);
  });

  it('consumes the note when opening a linked conversation from the peek banner', async () => {
    const { view } = createPeekBannerHarness({
      activeNote: 'note-a.md',
      conversations: [makeMeta('c1', 'note-a.md')],
      noteFilter: 'note-a.md',
    });

    await view.openHistoryConversation('c1');

    expect(view.peekConsumedNote).toBe('note-a.md');
    expect(view.historyDropdown.hasClass('visible')).toBe(false);
  });

  it('does not consume the note when opening a conversation from the unfiltered history list', async () => {
    const { view } = createPeekBannerHarness({
      activeNote: 'note-a.md',
      conversations: [makeMeta('c1', 'note-a.md')],
      noteFilter: null,
    });

    await view.openHistoryConversation('c1');

    expect(view.peekConsumedNote).toBeNull();
  });

  it('consumes the note when opening a linked conversation in a new tab from the peek banner', async () => {
    const { view } = createPeekBannerHarness({
      activeNote: 'note-a.md',
      conversations: [makeMeta('c1', 'note-a.md')],
      noteFilter: 'note-a.md',
    });

    await view.openHistoryConversationInNewTab('c1');

    expect(view.peekConsumedNote).toBe('note-a.md');
    expect(view.tabManager.openConversation).toHaveBeenCalledWith('c1', {
      preferNewTab: true,
      activate: true,
    });
  });
});
