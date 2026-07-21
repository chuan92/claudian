import { createMockEl } from '@test/helpers/mockElement';
import { Platform, Scope } from 'obsidian';

import { ClaudianView } from '@/features/chat/ClaudianView';

const MockScope = Scope as typeof Scope & { instances: Scope[] };

function createViewHarness(options: {
  canCreateTab: boolean;
  tabCount?: number;
}): {
  newTabButtonEl: ReturnType<typeof createMockEl>;
  view: any;
} {
  const newTabButtonEl = createMockEl();
  const view = Object.create(ClaudianView.prototype) as any;

  view.plugin = {
    settings: {},
  };
  view.tabManager = {
    canCreateTab: jest.fn().mockReturnValue(options.canCreateTab),
    getTabCount: jest.fn().mockReturnValue(options.tabCount ?? 1),
  };
  view.tabBarContainerEl = createMockEl();
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

  it('shows the conversation title for a single tab and hides it when tab badges are visible', () => {
    const { view } = createViewHarness({ canCreateTab: true, tabCount: 1 });
    const conversationTitleEl = createMockEl();
    view.conversationTitleEl = conversationTitleEl;

    view.updateTabBarVisibility();
    expect(conversationTitleEl.hasClass('claudian-hidden')).toBe(false);

    view.tabManager.getTabCount.mockReturnValue(2);
    view.updateTabBarVisibility();
    expect(conversationTitleEl.hasClass('claudian-hidden')).toBe(true);
  });

  it('syncs the compact conversation title from the active tab', () => {
    const conversationTitleEl = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;
    view.conversationTitleEl = conversationTitleEl;
    view.plugin = {
      getConversationSync: jest.fn().mockReturnValue({ title: 'Repository migration' }),
    };
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({ conversationId: 'conversation-1' }),
    };

    view.syncConversationTitle();

    expect(conversationTitleEl.textContent).toBe('Repository migration');
  });

  it('keeps tab controls in the view-owned input row', () => {
    const navRowContent = createMockEl();
    const inputNavRowHostEl = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;

    view.containerEl = createMockEl();
    view.navRowContent = navRowContent;
    view.inputNavRowHostEl = inputNavRowHostEl;
    view.tabBar = {
      captureScrollPosition: jest.fn(),
      restoreScrollPosition: jest.fn(),
    };

    view.attachNavRowContentToInputFooter();

    expect(inputNavRowHostEl.children).toContain(navRowContent);
    expect(view.tabBar.captureScrollPosition).toHaveBeenCalledTimes(1);
    expect(view.tabBar.restoreScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('moves only the active tab input into the stable input slot', () => {
    const activeInputSlotEl = createMockEl();
    const tab1 = {
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    };
    const tab2 = {
      id: 'tab-2',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    };
    const view = Object.create(ClaudianView.prototype) as any;

    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn()
        .mockReturnValueOnce(tab1)
        .mockReturnValueOnce(tab2),
      getTab: jest.fn((id: string) => id === 'tab-1' ? tab1 : tab2),
    };

    view.updateInputLocation();
    view.updateInputLocation();

    expect(activeInputSlotEl.children).toContain(tab2.dom.inputComposerEl);
    expect(activeInputSlotEl.children).not.toContain(tab1.dom.inputComposerEl);
    expect(tab1.dom.contentEl.children).toContain(tab1.dom.inputComposerEl);
  });

  it('preserves active pending prompt siblings during same-tab input updates', () => {
    const activeInputSlotEl = createMockEl();
    const inputComposerEl = activeInputSlotEl.createDiv();
    const pendingPromptEl = inputComposerEl.createDiv({ cls: 'claudian-ask-question-inline' });
    const tab = {
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl,
        inputContainerEl: inputComposerEl.createDiv({ cls: 'claudian-input-container' }),
      },
    };
    const view = Object.create(ClaudianView.prototype) as any;

    Object.defineProperty(inputComposerEl, 'parentElement', {
      configurable: true,
      get: () => activeInputSlotEl,
    });
    view.activeInputTabId = 'tab-1';
    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(tab),
      getTab: jest.fn().mockReturnValue(tab),
    };

    view.updateInputLocation();

    expect(activeInputSlotEl.children).toContain(inputComposerEl);
    expect(inputComposerEl.children).toContain(pendingPromptEl);
  });

  it('clears the stable input slot when no tab is active', () => {
    const activeInputSlotEl = createMockEl();
    const staleInputEl = activeInputSlotEl.createDiv();
    const view = Object.create(ClaudianView.prototype) as any;

    view.activeInputTabId = 'tab-1';
    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
    };

    view.updateInputLocation();

    expect(activeInputSlotEl.children).not.toContain(staleInputEl);
    expect(view.activeInputTabId).toBeNull();
  });

  it('toggles the history dropdown when the history button is clicked', () => {
    const historyDropdown = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;

    view.historyDropdown = historyDropdown;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
    };

    view.toggleHistoryDropdown();

    expect(historyDropdown.hasClass('visible')).toBe(true);

    view.toggleHistoryDropdown();

    expect(historyDropdown.hasClass('visible')).toBe(false);
  });

  it('defers hidden history rendering and coalesces invalidations until the dropdown opens', () => {
    const historyDropdown = createMockEl();
    const renderHistoryDropdown = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;

    view.historyDropdown = historyDropdown;
    view.historyDropdownDirty = true;
    view.historyDropdownRendered = false;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        controllers: {
          conversationController: { renderHistoryDropdown },
        },
      }),
    };

    view.updateHistoryDropdown();
    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).not.toHaveBeenCalled();

    view.toggleHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(1);
    const firstRenderSignal = renderHistoryDropdown.mock.calls[0][1].signal as AbortSignal;
    expect(firstRenderSignal.aborted).toBe(false);

    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(2);

    view.toggleHistoryDropdown();
    expect(firstRenderSignal.aborted).toBe(true);
    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(2);
  });

  it('persists expanded title tab ids with the tab layout snapshot', () => {
    const view = Object.create(ClaudianView.prototype) as any;

    view.tabManager = {
      getPersistedState: jest.fn().mockReturnValue({
        openTabs: [
          { tabId: 'tab-1', conversationId: null },
          { tabId: 'tab-2', conversationId: 'conv-2' },
        ],
        activeTabId: 'tab-2',
      }),
    };
    view.tabBar = {
      getExpandedTitleTabIds: jest.fn().mockReturnValue(['tab-2', 'closed-tab']),
    };

    expect(view.getPersistedTabState()).toEqual({
      openTabs: [
        { tabId: 'tab-1', conversationId: null },
        { tabId: 'tab-2', conversationId: 'conv-2' },
      ],
      activeTabId: 'tab-2',
      expandedTitleTabIds: ['tab-2'],
    });
  });

  it('restores expanded title tab ids after restoring tabs', async () => {
    const persistedState = {
      openTabs: [{ tabId: 'tab-1', conversationId: null }],
      activeTabId: 'tab-1',
      expandedTitleTabIds: ['tab-1'],
    };
    const view = Object.create(ClaudianView.prototype) as any;

    view.plugin = {
      storage: {
        getTabManagerState: jest.fn().mockResolvedValue(persistedState),
      },
    };
    view.tabManager = {
      restoreState: jest.fn().mockResolvedValue(undefined),
      createTab: jest.fn(),
    };
    view.tabBar = {
      setExpandedTitleTabIds: jest.fn(),
    };
    view.updateTabBar = jest.fn();

    await view.restoreOrCreateTabs();

    expect(view.tabManager.restoreState).toHaveBeenCalledWith(persistedState);
    expect(view.tabBar.setExpandedTitleTabIds).toHaveBeenCalledWith(['tab-1']);
    expect(view.updateTabBar).toHaveBeenCalledTimes(1);
    expect(view.tabManager.createTab).not.toHaveBeenCalled();
  });
});

describe('ClaudianView composer input', () => {
  function createComposerHarness(existingContent: string): {
    inputEl: HTMLTextAreaElement;
    inputHandler: jest.Mock;
    view: any;
  } {
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    const inputHandler = jest.fn();
    inputEl.value = existingContent;
    inputEl.selectionStart = 0;
    inputEl.selectionEnd = 0;
    inputEl.focus = jest.fn();
    inputEl.addEventListener('input', inputHandler);

    const view = Object.create(ClaudianView.prototype) as any;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({ dom: { inputEl } }),
    };

    return { inputEl, inputHandler, view };
  }

  it('appends text after existing composer content', () => {
    const { inputEl, inputHandler, view } = createComposerHarness('Review this note');

    const appended = view.appendToActiveInput('@projects/plan.md ');

    expect(appended).toBe(true);
    expect(inputEl.value).toBe('Review this note @projects/plan.md ');
    expect(inputEl.selectionStart).toBe(inputEl.value.length);
    expect(inputEl.selectionEnd).toBe(inputEl.value.length);
    expect(inputHandler).toHaveBeenCalledTimes(1);
    expect(inputEl.focus).toHaveBeenCalledTimes(1);
  });

  it('does not add another separator when existing content ends in whitespace', () => {
    const { inputEl, view } = createComposerHarness('Review this note\n');

    view.appendToActiveInput('@projects/plan.md ');

    expect(inputEl.value).toBe('Review this note\n@projects/plan.md ');
  });

  it('returns false when there is no active composer', () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
    };

    expect(view.appendToActiveInput('@projects/plan.md ')).toBe(false);
  });
});

describe('ClaudianView shutdown', () => {
  it('disposes view resources when the final tab-state flush fails', async () => {
    const error = new Error('disk full');
    const view = Object.create(ClaudianView.prototype) as any;
    const destroy = jest.fn().mockResolvedValue(undefined);
    const tabBarDestroy = jest.fn();
    const persistenceDispose = jest.fn();

    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      eventRefs: [],
      mentionCacheCoordinator: {},
      pendingTabBarUpdate: null,
      persistTabStateImmediate: jest.fn().mockRejectedValue(error),
      plugin: { app: { vault: { offref: jest.fn() } } },
      restoreActiveInputToTabContent: jest.fn(),
      scope: {},
      tabBar: { destroy: tabBarDestroy },
      tabManager: { destroy },
      tabStatePersistence: { dispose: persistenceDispose },
    });

    await expect(view.onClose()).resolves.toBeUndefined();

    expect(persistenceDispose).toHaveBeenCalledTimes(1);
    expect(view.restoreActiveInputToTabContent).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(tabBarDestroy).toHaveBeenCalledTimes(1);
    expect(view.tabManager).toBeNull();
    expect(view.scope).toBeNull();
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
    view.schedulePeekRefresh = jest.fn();
    view.updatePeekBanner = (ClaudianView.prototype as any).updatePeekBanner.bind(view);
    view.openHistoryConversation = (ClaudianView.prototype as any).openHistoryConversation.bind(view);
    view.openHistoryConversationInNewTab = (ClaudianView.prototype as any).openHistoryConversationInNewTab.bind(view);
    view.handlePeekClick = (ClaudianView.prototype as any).handlePeekClick.bind(view);
    view.refreshConversationNoteAssociations = (
      ClaudianView.prototype as any
    ).refreshConversationNoteAssociations.bind(view);

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

  it('opens and renders note-filtered history when the peek banner is clicked', () => {
    const { view } = createPeekBannerHarness({
      activeNote: 'note-a.md',
      conversations: [makeMeta('c1', 'note-a.md')],
    });
    view.updateHistoryDropdown.mockImplementation(() => {
      expect(view.historyDropdown.hasClass('visible')).toBe(true);
    });
    const event = { stopPropagation: jest.fn() } as unknown as MouseEvent;

    view.handlePeekClick(event);

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(view.noteFilter).toBe('note-a.md');
    expect(view.updateHistoryDropdown).toHaveBeenCalledTimes(1);
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

  it('remaps active note filters and refreshes a visible history dropdown after a folder rename', () => {
    const { view } = createPeekBannerHarness({
      activeNote: 'archive/new/note.md',
      conversations: [makeMeta('c1', 'archive/new/note.md')],
      noteFilter: 'projects/old/note.md',
      consumedNote: 'projects/old/note.md',
    });
    view.historyDropdown.addClass('visible');

    view.refreshConversationNoteAssociations('projects/old', 'archive/new');

    expect(view.noteFilter).toBe('archive/new/note.md');
    expect(view.peekConsumedNote).toBe('archive/new/note.md');
    expect(view.updateHistoryDropdown).toHaveBeenCalledTimes(1);
    expect(view.schedulePeekRefresh).toHaveBeenCalledTimes(1);
  });
});
