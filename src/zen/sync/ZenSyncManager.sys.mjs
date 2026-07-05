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

    if (!entries.length && !tabData._zenPinnedInitialState?.entry?.url) {
      // A record with no history and no pinned URL is unrestorable — the
      // receiving side could only materialize it as a blank tab. Don't
      // sync it (this happens for lazy tabs whose state was collected
      // before their session data landed).
      return null;
    }

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
    // Relative ordering link, assigned by #normalizeSidebarForSync;
    // preserved here so re-normalizing an already-normalized tab keeps it.
    if (tabData.afterId !== undefined) {
      syncTabData.afterId = tabData.afterId;
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

  async applyIncomingBatch(pulled, removals, meta) {
    try {
      let sidebar = lazy.ZenSessionStore.getSidebarData();

      this.#applyIncomingContainers(
        pulled.containers || [],
        removals.containers || []
      );
      this.#translateIncomingTabContainers(pulled.tabs || []);
      this.#translateIncomingSpaceContainers(pulled.spaces || []);
      this.#sanitizeStoredSpaceContainers(sidebar);
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

  // ---------------------------------------------------------------------
  // Container GUID mapping
  // ---------------------------------------------------------------------

  #containerMap = null;

  #containerGuids() {
    if (!this.#containerMap) {
      this.#containerMap = new lazy.JSONFile({
        path: PathUtils.join(PathUtils.profileDir, CONTAINER_MAP_FILE),
      });
    }
    this.#containerMap.ensureDataReady();
    const data = this.#containerMap.data;
    data.guids ??= {};
    if (!data.scheduledInitialUpload) {
      // One-time migration: GUIDs minted before upload scheduling existed
      // (see #scheduleContainerRecordUpload) never had their container
      // records uploaded — mark them all now.
      data.scheduledInitialUpload = true;
      for (const guid of Object.keys(data.guids)) {
        this.#scheduleContainerRecordUpload(guid);
      }
      this.#saveContainerGuids();
    }
    return data.guids;
  }

  /**
   * Ensures a record id gets marked as changed. Notifies the tracker
   * directly (works outside a sync, but is swallowed while the tracker
   * ignores changes during an incoming apply) AND persists the id into the
   * map file, where the engine drains it at the start of every sync — so
   * a mark can never be lost to timing or a restart.
   */
  #scheduleRecordMark(recordId) {
    const data = this.#containerMap.data;
    data.pendingUploads ??= [];
    if (!data.pendingUploads.includes(recordId)) {
      data.pendingUploads.push(recordId);
    }
    this.#saveContainerGuids();
    Services.obs.notifyObservers(
      null,
      "zen-workspace-item-changed",
      recordId
    );
  }

  #scheduleContainerRecordUpload(guid) {
    this.#scheduleRecordMark(`c~${guid}`);
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
    // Pre-existing containers (e.g. the built-in Personal/Work/Banking/
    // Shopping) never fire contextual-identity-created, so nothing else
    // would ever upload their record — schedule it here at mint time.
    this.#scheduleContainerRecordUpload(guid);
    return guid;
  }

  userContextIdForGuid(guid) {
    return this.#containerGuids()[guid] ?? null;
  }

  /**
   * Returns (and clears) the persisted record IDs waiting to be marked as
   * changed: container records scheduled for upload, non-canonical
   * duplicates and legacy records to tombstone. The engine drains this at
   * sync start and after each incoming apply.
   */
  takePendingContainerCleanups() {
    this.#containerGuids();
    const data = this.#containerMap.data;
    const pending = data.pendingUploads || [];
    data.pendingUploads = [];
    if (pending.length) {
      this.#saveContainerGuids();
    }
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
          this.#scheduleRecordMark(`c~${container.userContextId}`);
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
          this.#scheduleRecordMark(`c~${guid}`);
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
   * Rewrites incoming space records' default-container assignment from the
   * sync GUID to this device's userContextId. An explicit null GUID means
   * "no container"; an unknown GUID (its container record hasn't arrived
   * yet) keeps whatever the local space already has.
   */
  #translateIncomingSpaceContainers(spaces) {
    for (const space of spaces) {
      if (!("containerGuid" in space)) {
        continue;
      }
      if (space.containerGuid == null) {
        space.containerTabId = 0;
      } else {
        const userContextId = this.userContextIdForGuid(space.containerGuid);
        if (userContextId != null) {
          space.containerTabId = userContextId;
        } else {
          // Unknown container: let the shallow merge keep the local value.
          delete space.containerTabId;
        }
      }
      delete space.containerGuid;
    }
  }

  /**
   * Self-heals spaces that carry a raw containerGuid persisted into the
   * session by an older build (which merged incoming records without
   * translating them): resolve it against the map if possible, then strip
   * the field — it must never live in local data.
   */
  #sanitizeStoredSpaceContainers(sidebar) {
    for (const space of sidebar.spaces || []) {
      if (!("containerGuid" in space)) {
        continue;
      }
      if (space.containerGuid != null) {
        const userContextId = this.userContextIdForGuid(space.containerGuid);
        if (userContextId != null) {
          space.containerTabId = userContextId;
        }
      }
      delete space.containerGuid;
    }
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

  /**
   * ONE rule, nothing clever: a tab deletion is vetoed only when the user
   * demonstrably ACTED on the tab after the remote close — they clicked /
   * switched to it (TabSelect stamps _zenLastUserInteraction). Merely being
   * the selected tab is NOT interaction: Firefox's own close-remote-tab
   * closes selected tabs too, and every looser rule field-tested so far
   * made kept tabs fight the incoming order links and resurrect endlessly.
   * A vetoed tab is re-uploaded — deliberate resurrection everywhere.
   */
  #shouldVetoTabRemoval(zenSyncId, tombstoneModifiedMs) {
    if (!tombstoneModifiedMs) {
      return false;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const tab = win.document?.getElementById(zenSyncId);
      if (
        tab &&
        win.gBrowser?.isTab(tab) &&
        (tab._zenLastUserInteraction || 0) > tombstoneModifiedMs
      ) {
        return true;
      }
    }
    return false;
  }

  #removeDeletedItems(sidebar, removals) {
    const removedSpaceIds = new Set((removals.spaces || []).map(s => s.uuid));
    const removedFolderIds = new Set(
      (removals.folders || []).map(f => String(f.id))
    );

    const removedTabIds = new Set();
    const vetoedTabIds = new Set();
    for (const removal of removals.tabs || []) {
      if (!removal.zenSyncId) {
        continue;
      }
      const local = (sidebar.tabs || []).find(
        tab => tab.zenSyncId === removal.zenSyncId
      );
      const tombstoneMs = (removal.tombstoneModified || 0) * 1000;
      if (local && this.#shouldVetoTabRemoval(removal.zenSyncId, tombstoneMs)) {
        vetoedTabIds.add(removal.zenSyncId);
        this.#scheduleRecordMark(`t~${removal.zenSyncId}`);
      } else {
        removedTabIds.add(removal.zenSyncId);
      }
    }
    if (vetoedTabIds.size) {
      console.info(
        "ZenSyncManager: Vetoed remote deletion of recently used tabs",
        [...vetoedTabIds]
      );
      // Don't let the live-apply side remove them either.
      removals.tabs = removals.tabs.filter(
        removal => !vetoedTabIds.has(removal.zenSyncId)
      );
    }

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
      // Merge incoming tabs into the LOCAL order using their relative
      // afterId anchors, instead of re-sorting everything by absolute
      // position (positions from different devices interleave arbitrarily
      // and tear the order apart).
      const order = [...(sidebar.tabs || [])];
      const byId = new Map();
      for (const tab of order) {
        if (tab.zenSyncId) {
          byId.set(tab.zenSyncId, tab);
        }
      }

      // Resolve chains: when an incoming tab's anchor is itself incoming,
      // place the anchor first (same trick as #getOrderedIncomingFolders).
      const incoming = pulled.tabs.filter(tab => tab.zenSyncId);
      const incomingById = new Map(incoming.map(tab => [tab.zenSyncId, tab]));
      const chained = [];
      const seen = new Set();
      const visit = tab => {
        if (seen.has(tab.zenSyncId)) {
          return;
        }
        seen.add(tab.zenSyncId);
        const anchor = tab.afterId && incomingById.get(tab.afterId);
        if (anchor) {
          visit(anchor);
        }
        chained.push(tab);
      };
      incoming.forEach(visit);

      for (const tab of chained) {
        const existing = byId.get(tab.zenSyncId);
        const merged = existing ? { ...existing, ...tab } : tab;
        byId.set(tab.zenSyncId, merged);

        const oldIndex = existing ? order.indexOf(existing) : -1;
        if (oldIndex !== -1) {
          order.splice(oldIndex, 1);
        }

        let insertIndex = -1;
        if (tab.afterId === null) {
          insertIndex = 0;
        } else if (tab.afterId) {
          const anchorTab = byId.get(tab.afterId);
          const anchorIndex = anchorTab ? order.indexOf(anchorTab) : -1;
          if (anchorIndex !== -1) {
            insertIndex = anchorIndex + 1;
          }
        }
        if (insertIndex === -1) {
          // Legacy record or unknown anchor: fall back to the absolute
          // position when plausible, otherwise keep/append at the end.
          insertIndex =
            oldIndex !== -1
              ? oldIndex
              : typeof tab.position === "number" &&
                  tab.position >= 0 &&
                  tab.position <= order.length
                ? tab.position
                : order.length;
        }
        order.splice(insertIndex, 0, merged);
      }

      sidebar.tabs = order;
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
    // Mint container GUIDs for workspace assignments at collection time, so
    // when a space record is uploaded its container record is already
    // tracked and travels in the same batch (the receiving side applies
    // containers before it translates spaces).
    for (const space of sidebar.spaces || []) {
      this.guidForUserContextId(space.containerTabId, { create: true });
    }
    const tabs = this.#getStableSyncTabOrder(sidebar)
      .map(tab => this.createSyncableTabData(tab))
      .filter(Boolean);
    // Relative ordering: each tab links to its predecessor in the canonical
    // order. A move/insert/close only changes the hashes of the affected
    // tabs and their immediate followers instead of every tab below them.
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].afterId = i ? tabs[i - 1].zenSyncId : null;
    }
    return {
      ...sidebar,
      tabs,
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
    for (const tab of sidebar.tabs || []) {
      if (tab.zenSyncId && !(tab.zenIsEmpty && !tab.groupId)) {
        // No absolute position in the hash: ordering is captured by each
        // tab's afterId link, so reorders only mark the affected tabs.
        tabs.set(tab.zenSyncId, JSON.stringify(tab));
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
