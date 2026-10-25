declare const __KNOWN_EXTENSION_EVIDENCE__: boolean;

declare namespace chrome {
  namespace runtime {
    const id: string;
    const lastError: { message?: string } | undefined;
    function getURL(path: string): string;
    function getManifest(): { version: string };
    function openOptionsPage(): Promise<void>;
    function reload(): void;
    function uninstallSelf(options?: { showConfirmDialog?: boolean }, callback?: () => void): void;
    interface InstalledDetails { reason: 'install' | 'update' | 'chrome_update' | 'shared_module_update' }
    const onInstalled: { addListener(callback: (details: InstalledDetails) => void): void };
    const onStartup: { addListener(callback: () => void): void };
    const onMessage: { addListener(callback: (message: unknown, sender: MessageSender,
      sendResponse: (response: unknown) => void) => boolean | void): void;
      removeListener(callback: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void): void };
    interface MessageSender { id?: string; url?: string; documentId?: string; frameId?: number; origin?: string; documentLifecycle?: string; tab?: tabs.Tab; }
    type ContextType = 'POPUP' | 'TAB' | 'BACKGROUND' | 'OFFSCREEN_DOCUMENT' | 'SIDE_PANEL' | 'DEVELOPER_TOOLS';
    function getContexts(filter: { contextTypes?: ContextType[]; documentIds?: string[]; documentUrls?: string[] }): Promise<{
      contextType: ContextType; documentId?: string; documentUrl?: string;
    }[]>;
    function sendMessage(message: unknown): Promise<unknown>;
    interface Port { name: string; sender?: MessageSender; postMessage(message: unknown): void; disconnect(): void;
      onMessage: { addListener(callback: (message: unknown) => void): void }; onDisconnect: { addListener(callback: () => void): void } }
    function connect(options: { name: string }): Port;
    const onConnect: { addListener(callback: (port: Port) => void): void };
    const onUserScriptMessage: typeof onMessage;
    const onUserScriptConnect: typeof onConnect;
  }
  namespace cookies {
    interface Cookie { name: string; value: string; domain?: string; path: string; secure: boolean; httpOnly: boolean }
    interface CookieChangeInfo { cookie: Cookie; removed: boolean; cause: string }
    function get(details: { url: string; name: string }): Promise<Cookie | null>;
    function set(details: {
      url: string; name: string; value: string; path?: string;
      secure?: boolean; httpOnly?: boolean; sameSite?: 'lax' | 'strict' | 'no_restriction';
      expirationDate?: number;
    }): Promise<Cookie>;
    function remove(details: { url: string; name: string }): Promise<{ url: string; name: string } | null>;
    const onChanged: {
      addListener(callback: (change: CookieChangeInfo) => void): void;
      removeListener(callback: (change: CookieChangeInfo) => void): void;
    };
  }
  namespace storage {
    const local: import('./credential-store.js').StorageArea & AccessControlled;
    const managed: import('./credential-store.js').StorageArea & AccessControlled;
    interface AccessControlled { setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> }
    /**
     * Session storage: cleared when the browser session ends. `setAccessLevel`
     * pins it to `TRUSTED_CONTEXTS`, which excludes CONTENT SCRIPTS — it does
     * NOT exclude the extension's own pages, which Chromium also counts as
     * trusted contexts. `setAccessLevel` is optional so a host without it
     * (tests, older runtimes) still type-checks; the credential area refuses to
     * be used without it in production (see `sw/runtime.ts`).
     */
    const session: import('./credential-store.js').StorageArea & {
      setAccessLevel?(accessOptions: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void>;
    };
    const onChanged: { addListener(callback: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void): void };
  }
  namespace bookmarks {
    interface BookmarkTreeNode { id: string; parentId?: string; index?: number; url?: string; title: string;
      type?: 'bookmark' | 'folder' | 'separator'; unmodifiable?: string; children?: BookmarkTreeNode[];
      dateAdded?: number; dateGroupModified?: number; dateLastUsed?: number;
      folderType?: string; syncing?: boolean; }
    function getTree(): Promise<BookmarkTreeNode[]>;
    function get(id: string | string[]): Promise<BookmarkTreeNode[]>;
    function search(query: { query?: string; url?: string; title?: string }): Promise<BookmarkTreeNode[]>;
    /** The most recently added bookmarks, newest first. */
    function getRecent(numberOfItems: number): Promise<BookmarkTreeNode[]>;
    function getChildren(id: string): Promise<BookmarkTreeNode[]>;
    function getSubTree(id: string): Promise<BookmarkTreeNode[]>;
    function create(bookmark: { parentId?: string; index?: number; title?: string; url?: string;
      type?: 'bookmark' | 'folder' | 'separator' }): Promise<BookmarkTreeNode>;
    function update(id: string, changes: { title?: string; url?: string }): Promise<BookmarkTreeNode>;
    function move(id: string, destination: { parentId?: string; index?: number }): Promise<BookmarkTreeNode>;
    function remove(id: string): Promise<void>;
    function removeTree(id: string): Promise<void>;
    const onCreated: { addListener(callback: (id: string, node: BookmarkTreeNode) => void): void;
      removeListener(callback: (id: string, node: BookmarkTreeNode) => void): void;
      hasListener(callback: (id: string, node: BookmarkTreeNode) => void): boolean };
    const onChanged: { addListener(callback: (id: string, changes: { title?: string; url?: string }) => void): void;
      hasListener(callback: (id: string, changes: { title?: string; url?: string }) => void): boolean };
    const onMoved: { addListener(callback: (id: string, move: { parentId: string; index: number;
      oldParentId: string; oldIndex: number }) => void): void;
      removeListener(callback: (id: string, move: { parentId: string; index: number; oldParentId: string; oldIndex: number }) => void): void;
      hasListener(callback: (id: string, move: { parentId: string; index: number;
        oldParentId: string; oldIndex: number }) => void): boolean };
    const onRemoved: { addListener(callback: (id: string, removal: { parentId: string; index: number;
      node?: BookmarkTreeNode }) => void): void;
      removeListener(callback: (id: string, removal: { parentId: string; index: number; node?: BookmarkTreeNode }) => void): void;
      hasListener(callback: (id: string, removal: { parentId: string; index: number;
        node?: BookmarkTreeNode }) => void): boolean };
    const onChildrenReordered: { addListener(callback: (id: string, reorderInfo: { childIds: string[] }) => void): void;
      removeListener(callback: (id: string, reorderInfo: { childIds: string[] }) => void): void;
      hasListener(callback: (id: string, reorderInfo: { childIds: string[] }) => void): boolean };
    /** The browser's own bookmark import (absent on some platforms). */
    const onImportBegan: { addListener(callback: () => void): void } | undefined;
    const onImportEnded: { addListener(callback: () => void): void } | undefined;
  }
  namespace permissions {
    function contains(permissions: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
    function request(permissions: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
    function remove(permissions: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
    const onAdded: { addListener(callback: (permissions: { permissions?: string[]; origins?: string[] }) => void): void };
    const onRemoved: { addListener(callback: (permissions: { permissions?: string[]; origins?: string[] }) => void): void };
  }
  namespace alarms {
    interface Alarm {
      readonly name: string
      readonly scheduledTime: number
      readonly periodInMinutes?: number
    }
    /** One-shot (`when`) or repeating (`periodInMinutes`, 30s platform floor). */
    function create(name: string, alarmInfo: { when: number } | { periodInMinutes: number }): void;
    /** Resolves `undefined` when no alarm with that name is registered. */
    function get(name: string): Promise<Alarm | undefined>;
    function clear(name: string): Promise<boolean>;
    const onAlarm: { addListener(callback: (alarm: Alarm) => void): void };
  }
  namespace tabs {
    interface Tab {
      readonly id?: number
      readonly title?: string
      readonly url?: string
      readonly favIconUrl?: string
      readonly windowId?: number
      readonly incognito?: boolean
      readonly highlighted?: boolean
    }
    function create(createProperties: { url: string; active?: boolean }): Promise<Tab>;
    function get(tabId: number): Promise<Tab>;
    function query(queryInfo: { url?: string[]; active?: boolean; currentWindow?: boolean; highlighted?: boolean; windowId?: number }): Promise<Tab[]>;
    const onRemoved: { addListener(callback: (tabId: number) => void): void };
  }
  /** Optional permission: present only while it is granted. */
  namespace scripting {
    interface RegisteredContentScript { id: string; js: string[]; matches: string[]; runAt: 'document_start'; world: 'MAIN' | 'ISOLATED'; allFrames: boolean; persistAcrossSessions: boolean }
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function getRegisteredContentScripts(filter: { ids: string[] }): Promise<RegisteredContentScript[]>;
    function unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
    function executeScript<Args extends unknown[] = []>(options: { target: { tabId: number }; world: 'MAIN' | 'ISOLATED'; files?: string[]; func?: (...args: Args) => unknown; args?: Args }): Promise<{ result?: unknown }[]>;
  }
  namespace webNavigation {
    function getFrame(details: { tabId: number; frameId: number }): Promise<{ url: string; documentId: string; documentLifecycle: string } | null>;
    const onHistoryStateUpdated: typeof onCommitted;
    const onReferenceFragmentUpdated: typeof onCommitted;
    interface CommitDetails { readonly tabId: number; readonly frameId: number; readonly url: string; readonly timeStamp: number; readonly documentId?: string; readonly documentLifecycle?: string }
    const onCommitted: {
      addListener(callback: (details: CommitDetails) => void): void;
      removeListener(callback: (details: CommitDetails) => void): void;
      hasListener(callback: (details: CommitDetails) => void): boolean;
    };
  }
  namespace userScripts {
    interface Script { id: string; matches?: string[]; js?: { code: string }[]; world?: 'USER_SCRIPT'; worldId?: string; allFrames?: boolean; runAt?: 'document_start' | 'document_idle' }
    function getScripts(filter?: { ids: string[] }): Promise<Script[]>;
    function register(scripts: Script[]): Promise<void>;
    function unregister(filter: { ids: string[] }): Promise<void>;
    function configureWorld(properties: { worldId: string; messaging: boolean; csp?: string }): Promise<void>;
    function resetWorldConfiguration(worldId: string): Promise<void>;
    function getWorldConfigurations(): Promise<{ worldId?: string; messaging?: boolean; csp?: string }[]>;
    function execute(options: { target: { tabId: number; documentIds: string[] }; world: 'USER_SCRIPT'; worldId: string; js: { code: string }[]; injectImmediately: boolean }): Promise<{ documentId?: string; error?: string; result?: unknown }[]>;
  }
  namespace commands {
    interface Command { readonly name?: string; readonly description?: string; readonly shortcut?: string }
    const onCommand: { addListener(callback: (command: string, tab?: tabs.Tab) => void): void };
    function getAll(): Promise<Command[]>;
  }
  namespace contextMenus {
    interface OnClickData {
      readonly menuItemId: string | number;
      readonly pageUrl?: string;
      readonly frameUrl?: string;
      readonly linkUrl?: string;
      readonly selectionText?: string;
    }
    function create(createProperties: { id?: string; title: string; contexts?: readonly string[] }): void;
    function removeAll(callback?: () => void): void;
    const onClicked: { addListener(callback: (info: OnClickData, tab?: tabs.Tab) => void): void };
  }
  namespace action {
    function setPopup(details: { popup: string }): Promise<void>;
    function openPopup(): Promise<void>;
    /** With `tabId`, for that tab only; `null` there hands the tab back to the global text. */
    function setBadgeText(details: { text: string } | { tabId: number; text: string | null }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
    function setTitle(details: { title: string }): Promise<void>;
    function getBadgeText(details?: { tabId?: number }): Promise<string>;
    const onClicked: { addListener(callback: () => void): void };
  }
}

declare const __KNOWN_EXTENSION_CLASSIFICATION_LOCAL__: boolean;
