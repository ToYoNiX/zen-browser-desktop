/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
});

// Maps sync GUIDs to local userContextIds. Container userContextIds are
// device-local (two devices independently create "container #6" for
// unrelated things), so sync records are keyed by GUID and translated to
// local ids on each device.
const CONTAINER_MAP_FILE = "zen-sync-containers.json";

class ZenSyncManager {
  _lastSnapshot = null;

  /**
   * While a sync is running, the sidebar data is cached so that
   * getAllIDs/itemExists/createRecord don't re-collect and deep-clone the
   * entire session (hundreds of tabs) once per record.
   */
  #syncCacheActive = false;
  #cachedSidebarData = null;

  beginSyncCache() {
    this.#syncCacheActive = true;
    this.#cachedSidebarData = null;
  }

  endSyncCache() {
    this.#syncCacheActive = false;
    this.#cachedSidebarData = null;
  }

  invalidateSyncCache() {
    this.#cachedSidebarData = null;
  }

  getCurrentSidebarData() {
    if (this.#syncCacheActive && this.#cachedSidebarData) {
      return this.#cachedSidebarData;
    }
    const data = this.#normalizeSidebarForSync(
      lazy.ZenSessionStore.getCurrentSidebarData()
    );
    if (this.#syncCacheActive) {
      this.#cachedSidebarData = data;
    }
    return data;
  }

  createSyncableTabData(
    tabData,
    { position, trimHistoryForUnpinned = false } = {},
  ) {
    if (
      !tabData?.zenSyncId ||
      tabData.zenIsEmpty ||
      tabData.zenLiveFolderItemId
    ) {
      return null;
    }

    const pinned = !!tabData.pinned;
    let entries = Array.isArray(tabData.entries) ? [...tabData.entries] : [];
    let index = typeof tabData.index === "number" ? tabData.index : 1;

    if (trimHistoryForUnpinned && !pinned && entries.length) {
      const entryIndex = Math.max(0, index - 1);
      const entry = entries[entryIndex] || entries[0];
      entries = entry ? [entry] : [];
      index = 1;
    }

    const isEssential = !!tabData.zenEssential;
    const syncTabData = {
      entries,
      groupId: tabData.groupId || null,
      image: typeof tabData.image === "string" ? tabData.image : "",
      index,
      pinned,
      userContextId: parseInt(tabData.userContextId, 10) || 0,
      zenDefaultUserContextId: !!tabData.zenDefaultUserContextId,
      zenEssential: isEssential,
      zenHasStaticIcon: !!tabData.zenHasStaticIcon,
      zenSyncId: tabData.zenSyncId,
      zenWorkspace: isEssential ? null : tabData.zenWorkspace || null,
    };

    const containerGuid = this.guidForUserContextId(
      syncTabData.userContextId,
      { create: true }
    );
    if (containerGuid) {
      syncTabData.containerGuid = containerGuid;
    }

    if (typeof tabData.zenStaticLabel === "string") {
      syncTabData.zenStaticLabel = tabData.zenStaticLabel;
    }
    if (tabData._zenPinnedInitialState) {
      syncTabData._zenPinnedInitialState = tabData._zenPinnedInitialState;
    }
    if (typeof position === "number") {
      syncTabData.position = position;
    }

    return syncTabData;
  }

  seedSnapshot(sidebar) {
    this._lastSnapshot = this.#buildSnapshot(
      this.#normalizeSidebarForSync(sidebar || {}),
    );
  }

  noteSidebarDataChanged(sidebar) {
    const snapshot = this.#buildSnapshot(
      this.#normalizeSidebarForSync(sidebar || {}),
    );
    const prev = this._lastSnapshot;

    if (prev) {
      for (const [uuid, hash] of snapshot.spaces) {
        if (prev.spaces.get(uuid) !== hash) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `s~${uuid}`
          );
        }
      }

      for (const uuid of prev.spaces.keys()) {
        if (!snapshot.spaces.has(uuid)) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `s~${uuid}`
          );
        }
      }

      for (const [id, hash] of snapshot.tabs) {
        const prevHash = prev.tabs.get(id);
        if (prevHash !== hash) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `t~${id}`
          );
        }
      }

      for (const id of prev.tabs.keys()) {
        if (!snapshot.tabs.has(id)) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `t~${id}`
          );
        }
      }

      for (const [id, hash] of snapshot.folders) {
        if (prev.folders.get(id) !== hash) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `f~${id}`
          );
        }
      }

      for (const id of prev.folders.keys()) {
        if (!snapshot.folders.has(id)) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `f~${id}`
          );
        }
      }
    }

    this._lastSnapshot = snapshot;
  }

  async applyIncomingBatch(
    pulled,
    removals,
    meta,
    { isFirstSync = false } = {}
  ) {
    try {
      let sidebar = lazy.ZenSessionStore.getSidebarData();

      if (isFirstSync) {
        await this.#maybeAdoptRemoteSpaces(sidebar, pulled, removals);
      }

      this.#applyIncomingContainers(
        pulled.containers || [],
        removals.containers || []
      );
      this.#translateIncomingTabContainers(pulled.tabs || []);
      this.#removeDeletedItems(sidebar, removals);
      this.#mergeIncomingItems(sidebar, pulled);

      if (meta) {
        sidebar.groups = meta.groups;
        sidebar.splitViewData = meta.splitViewData;
      }

      lazy.ZenSessionStore.replaceSidebarData(sidebar, true);
      this.seedSnapshot(sidebar);

      const win = Services.wm.getMostRecentWindow("navigator:browser");
      if (win?.gZenWorkspaces && !win.gZenWorkspaces.privateWindowOrDisabled) {
        await win.gZenWorkspaces._applySyncChanges(pulled, removals);
      }
    } catch (e) {
      console.error("ZenSyncManager: Failed to apply incoming sync data:", e);
    } finally {
      // The sidebar changed under the sync cache; the upload phase that
      // follows must serialize the post-merge state.
      this.invalidateSyncCache();
    }
  }

  /**
   * First-sync adoption: a brand-new profile auto-creates its own default
   * space before it ever syncs, so joining an existing account would union
   * that empty default with the real remote spaces — one junk space per
   * device. When the local sidebar is pristine and remote spaces exist,
   * drop the local auto-created space and adopt the remote layout instead.
   *
   * Deliberately conservative — this must never destroy user data:
   *   - only called on the engine's very first sync (lastSync == 0);
   *   - requires ≥1 incoming remote space (fresh accounts adopt nothing
   *     and upload the local default as the seed);
   *   - requires a pristine local sidebar: exactly one space, no folders,
   *     no pinned/essential tabs, nothing but empty tabs;
   *   - only ever removes the LOCAL auto-created space, via the same
   *     removals path a remote space deletion takes;
   *   - a session-file backup is written right before adopting.
   */
  async #maybeAdoptRemoteSpaces(sidebar, pulled, removals) {
    const localSpaces = sidebar.spaces || [];
    const incomingSpaces = (pulled.spaces || []).filter(space => space.uuid);
    if (localSpaces.length !== 1 || !incomingSpaces.length) {
      return;
    }
    const defaultSpace = localSpaces[0];
    if (incomingSpaces.some(space => space.uuid === defaultSpace.uuid)) {
      // The remote already knows our space; nothing to adopt.
      return;
    }
    // Loose unpinned tabs do NOT count as user data: signing in to the
    // Mozilla account itself opens a tab, and extensions may open onboarding
    // pages during setup — those must not block adoption. They are rehomed
    // into the adopted primary space below instead of being destroyed with
    // the default space's element.
    const hasUserData =
      (sidebar.folders || []).length ||
      (sidebar.tabs || []).some(
        tab =>
          !tab.zenIsEmpty && (tab.pinned || tab.zenEssential || tab.groupId)
      );
    if (hasUserData) {
      return;
    }
    const targetSpace = [...incomingSpaces].sort(
      (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity)
    )[0];
    await lazy.ZenSessionStore.createAdHocBackup("pre-space-adoption");
    console.info(
      "ZenSyncManager: First sync on a pristine profile — adopting remote spaces, dropping the local default space and rehoming its tabs",
      { dropped: defaultSpace.uuid, rehomeTo: targetSpace.uuid }
    );
    for (const tab of sidebar.tabs || []) {
      if (tab.zenWorkspace === defaultSpace.uuid) {
        tab.zenWorkspace = targetSpace.uuid;
      }
    }
    removals.spaces = [...(removals.spaces || []), { uuid: defaultSpace.uuid }];
    // Consumed by gZenWorkspaces._applySyncChanges to move live tabs out of
    // the doomed space before its element (and everything in it) is removed.
    removals.adoptionRehome = {
      fromUuid: defaultSpace.uuid,
      toUuid: targetSpace.uuid,
    };
  }

  // ---------------------------------------------------------------------
  // Container GUID mapping
  // ---------------------------------------------------------------------

  #containerMap = null;
  #pendingContainerCleanups = [];

  #containerGuids() {
    if (!this.#containerMap) {
      this.#containerMap = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, CONTAINER_MAP_FILE),
      });
    }
    this.#containerMap.ensureDataReady();
    this.#containerMap.data.guids ??= {};
    return this.#containerMap.data.guids;
  }

  #saveContainerGuids() {
    this.#containerMap.saveSoon();
  }

  #guidsForUserContextId(userContextId) {
    const guids = this.#containerGuids();
    return Object.keys(guids)
      .filter(guid => guids[guid] === userContextId)
      .sort();
  }

  /**
   * Returns the canonical sync GUID for a local container: the
   * lexicographically smallest known GUID, so all devices converge on the
   * same record for a shared container. With `create`, mints and persists
   * a new GUID for a container that has none yet.
   */
  guidForUserContextId(userContextId, { create = false } = {}) {
    userContextId = parseInt(userContextId, 10) || 0;
    if (!userContextId) {
      // The default (no) container is never synced as a container.
      return null;
    }
    const known = this.#guidsForUserContextId(userContextId);
    if (known.length) {
      return known[0];
    }
    if (
      !create ||
      !lazy.ContextualIdentityService.getPublicIdentityFromId(userContextId)
    ) {
      return null;
    }
    const guid = Services.uuid.generateUUID().toString().slice(1, -1);
    this.#containerGuids()[guid] = userContextId;
    this.#saveContainerGuids();
    return guid;
  }

  userContextIdForGuid(guid) {
    return this.#containerGuids()[guid] ?? null;
  }

  /**
   * Returns (and clears) the record IDs of container records that should be
   * tombstoned on the server: non-canonical duplicates discovered while
   * merging, and legacy records keyed by raw userContextId. The engine
   * marks them as changed after apply so the next upload cleans them up.
   */
  takePendingContainerCleanups() {
    const pending = this.#pendingContainerCleanups;
    this.#pendingContainerCleanups = [];
    return pending;
  }

  #containerLabel(userContextId) {
    try {
      return lazy.ContextualIdentityService.getUserContextLabel(userContextId);
    } catch {
      return "";
    }
  }

  #applyIncomingContainers(pulledContainers, removedContainers) {
    const guids = this.#containerGuids();

    for (const container of pulledContainers) {
      if (!container.guid) {
        // Legacy record keyed by raw userContextId — meaningless across
        // devices. Schedule a server-side cleanup and ignore it.
        if (container.userContextId != null) {
          this.#pendingContainerCleanups.push(`c~${container.userContextId}`);
        }
        continue;
      }
      if (!container.name) {
        continue;
      }

      let userContextId = guids[container.guid];
      let identity = userContextId
        ? lazy.ContextualIdentityService.getPublicIdentityFromId(userContextId)
        : null;

      if (!identity) {
        // Unknown GUID: match an existing local container by display name so
        // containers created independently on both devices merge instead of
        // duplicating (or worse, overwriting an unrelated container that
        // happens to share a numeric id).
        identity = lazy.ContextualIdentityService.getPublicIdentities().find(
          c => this.#containerLabel(c.userContextId) === container.name
        );
      }

      if (identity) {
        guids[container.guid] = identity.userContextId;
        lazy.ContextualIdentityService.update(
          identity.userContextId,
          container.name,
          container.icon,
          container.color
        );
        // If this container now has several GUIDs, tombstone the
        // non-canonical ones so all devices converge on a single record.
        const all = this.#guidsForUserContextId(identity.userContextId);
        for (const guid of all.slice(1)) {
          this.#pendingContainerCleanups.push(`c~${guid}`);
        }
      } else {
        const created = lazy.ContextualIdentityService.create(
          container.name,
          container.icon,
          container.color
        );
        guids[container.guid] = created.userContextId;
      }
    }

    for (const container of removedContainers) {
      if (!container.guid) {
        continue;
      }
      const userContextId = guids[container.guid];
      if (!userContextId) {
        continue;
      }
      const all = this.#guidsForUserContextId(userContextId);
      delete guids[container.guid];
      if (all[0] === container.guid) {
        // Canonical tombstone → the user really deleted this container.
        // A non-canonical tombstone is just cross-device record cleanup.
        for (const guid of all) {
          delete guids[guid];
        }
        try {
          lazy.ContextualIdentityService.remove(userContextId);
        } catch {
          // Container may already be gone locally.
        }
      }
    }

    this.#saveContainerGuids();
  }

  /**
   * Rewrites incoming tab records' container references from sync GUIDs to
   * this device's userContextIds. Must run after #applyIncomingContainers
   * so freshly created containers are already in the map.
   */
  #translateIncomingTabContainers(tabs) {
    for (const tab of tabs) {
      if (!tab.containerGuid) {
        continue;
      }
      const userContextId = this.userContextIdForGuid(tab.containerGuid);
      // An unknown container maps to the default one rather than to
      // whatever local container happens to own the remote numeric id.
      tab.userContextId = userContextId ?? 0;
    }
  }

  #removeDeletedItems(sidebar, removals) {
    const removedSpaceIds = new Set((removals.spaces || []).map(s => s.uuid));
    const removedTabIds = new Set((removals.tabs || []).map(t => t.zenSyncId));
    const removedFolderIds = new Set(
      (removals.folders || []).map(f => String(f.id))
    );

    if (removedSpaceIds.size) {
      sidebar.spaces = (sidebar.spaces || []).filter(
        space => !removedSpaceIds.has(space.uuid)
      );
    }

    if (removedTabIds.size) {
      sidebar.tabs = (sidebar.tabs || []).filter(
        tab => !removedTabIds.has(tab.zenSyncId)
      );
    }

    if (removedFolderIds.size) {
      sidebar.folders = (sidebar.folders || []).filter(
        folder => !removedFolderIds.has(String(folder.id))
      );
    }
  }

  #mergeIncomingItems(sidebar, pulled) {
    if (pulled.spaces?.length) {
      const spaceMap = new Map(
        (sidebar.spaces || []).map(space => [space.uuid, space])
      );
      for (const space of pulled.spaces) {
        if (!space.uuid) {
          continue;
        }
        const existing = spaceMap.get(space.uuid);
        spaceMap.set(space.uuid, existing ? { ...existing, ...space } : space);
      }
      sidebar.spaces = Array.from(spaceMap.values());
      sidebar.spaces.sort(
        (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity)
      );
    }

    if (pulled.tabs?.length) {
      const tabMap = new Map();
      const noIdTabs = [];

      for (const tab of sidebar.tabs || []) {
        if (tab.zenSyncId) {
          tabMap.set(tab.zenSyncId, tab);
        } else {
          noIdTabs.push(tab);
        }
      }

      for (const tab of pulled.tabs) {
        if (!tab.zenSyncId) {
          continue;
        }
        const existing = tabMap.get(tab.zenSyncId);
        tabMap.set(tab.zenSyncId, existing ? { ...existing, ...tab } : tab);
      }

      const syncedTabs = Array.from(tabMap.values());
      syncedTabs.sort((a, b) => {
        const aPosition =
          typeof a.position === "number"
            ? a.position
            : Number.POSITIVE_INFINITY;
        const bPosition =
          typeof b.position === "number"
            ? b.position
            : Number.POSITIVE_INFINITY;
        return aPosition - bPosition;
      });
      sidebar.tabs = [...noIdTabs, ...syncedTabs];
    }

    if (pulled.folders?.length) {
      const folderMap = new Map(
        (sidebar.folders || []).map(folder => [String(folder.id), folder])
      );
      for (const folder of pulled.folders) {
        if (!folder.id) {
          continue;
        }
        const existing = folderMap.get(String(folder.id));
        folderMap.set(
          String(folder.id),
          existing ? { ...existing, ...folder } : folder
        );
      }
      sidebar.folders = Array.from(folderMap.values());
    }
  }

  #normalizeSidebarForSync(sidebar) {
    return {
      ...sidebar,
      tabs: this.#getStableSyncTabOrder(sidebar)
        .map(tab => this.createSyncableTabData(tab))
        .filter(Boolean),
    };
  }

  #getStableSyncTabOrder(sidebar) {
    const tabs = [...(sidebar.tabs || [])];
    if (!tabs.length) {
      return tabs;
    }

    const folderWorkspaceIds = new Map(
      (sidebar.folders || [])
        .filter(folder => folder?.id)
        .map(folder => [String(folder.id), folder.workspaceId || null]),
    );

    const workspaceOrder = new Map(
      [...(sidebar.spaces || [])]
        .map((space, index) => ({ space, index }))
        .sort((a, b) => {
          const aPosition =
            typeof a.space?.position === "number"
              ? a.space.position
              : Number.POSITIVE_INFINITY;
          const bPosition =
            typeof b.space?.position === "number"
              ? b.space.position
              : Number.POSITIVE_INFINITY;
          return aPosition - bPosition || a.index - b.index;
        })
        .map(({ space }, index) => [space.uuid, index]),
    );

    const getTabSection = tab => {
      if (tab.zenEssential) {
        return 0;
      }
      if (tab.pinned) {
        return 1;
      }
      return 2;
    };

    const getTabWorkspaceOrder = tab => {
      const workspaceId =
        tab.zenWorkspace ||
        (tab.groupId ? folderWorkspaceIds.get(String(tab.groupId)) : null);
      return workspaceOrder.get(workspaceId) ?? Number.POSITIVE_INFINITY;
    };

    return tabs
      .map((tab, index) => ({
        tab,
        index,
        section: getTabSection(tab),
        workspaceOrder: getTabWorkspaceOrder(tab),
      }))
      .sort((a, b) => {
        return (
          a.section - b.section ||
          a.workspaceOrder - b.workspaceOrder ||
          a.index - b.index
        );
      })
      .map(({ tab }) => tab);
  }

  #buildSnapshot(sidebar) {
    const spaces = new Map();
    const spaceList = sidebar.spaces || [];
    for (let i = 0; i < spaceList.length; i++) {
      const space = spaceList[i];
      if (space.uuid) {
        spaces.set(space.uuid, JSON.stringify({ ...space, _pos: i }));
      }
    }

    const tabs = new Map();
    const tabList = sidebar.tabs || [];
    for (let i = 0; i < tabList.length; i++) {
      const tab = tabList[i];
      if (tab.zenSyncId && !(tab.zenIsEmpty && !tab.groupId)) {
        tabs.set(tab.zenSyncId, JSON.stringify({ ...tab, _pos: i }));
      }
    }

    const folders = new Map();
    for (const folder of sidebar.folders || []) {
      if (folder.id) {
        const { syncStatus: _ignored, ...rest } = folder;
        folders.set(String(folder.id), JSON.stringify(rest));
      }
    }

    return { spaces, tabs, folders };
  }
}

export const ZenSyncStore = new ZenSyncManager();
