/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

class ZenSyncManager {
  _lastSnapshot = null;

  getCurrentSidebarData() {
    return this.#normalizeSidebarForSync(
      lazy.ZenSessionStore.getCurrentSidebarData(),
    );
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

      if (prev.metaHash !== snapshot.metaHash) {
        Services.obs.notifyObservers(
          null,
          "zen-workspace-item-changed",
          "meta~global"
        );
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
    }
  }

  #applyIncomingContainers(pulledContainers, removedContainers) {
    const localContainers =
      lazy.ContextualIdentityService.getPublicIdentities();

    for (const container of pulledContainers) {
      if (!container.name) {
        continue;
      }

      const existsLocally = localContainers.some(
        c => String(c.userContextId) === String(container.userContextId)
      );

      if (existsLocally) {
        lazy.ContextualIdentityService.update(
          container.userContextId,
          container.name,
          container.icon,
          container.color
        );
        continue;
      }

      const createdIdentity = lazy.ContextualIdentityService.create(
        container.name,
        container.icon,
        container.color,
        container.userContextId
      );
      if (
        createdIdentity &&
        String(createdIdentity.userContextId) !==
          String(container.userContextId)
      ) {
        console.warn("ZenSyncManager: Container sync created unexpected ID", {
          requestedId: container.userContextId,
          createdId: createdIdentity.userContextId,
          name: container.name,
        });
      }
    }

    for (const container of removedContainers) {
      try {
        lazy.ContextualIdentityService.remove(container.userContextId);
      } catch {
        // Container may already be gone locally.
      }
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

    const metaHash = JSON.stringify({
      g: sidebar.groups || [],
      sv: sidebar.splitViewData || [],
    });

    return { spaces, tabs, folders, metaHash };
  }
}

export const ZenSyncStore = new ZenSyncManager();
