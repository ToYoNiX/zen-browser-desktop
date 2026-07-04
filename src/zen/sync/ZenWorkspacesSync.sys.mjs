/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  LegacyTracker,
  Store,
  SyncEngine,
} from "resource://services-sync/engines.sys.mjs";
import { CryptoWrapper } from "resource://services-sync/record.sys.mjs";
import { SCORE_INCREMENT_XLARGE } from "resource://services-sync/constants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSyncStore: "resource:///modules/zen/ZenSyncManager.sys.mjs",
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export class ZenWorkspacesRecord extends CryptoWrapper {
  _logName = "Sync.Record.ZenWorkspaces";
}

ZenWorkspacesRecord.prototype.type = "workspaces";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRecordId(id) {
  const sep = id.indexOf("~");
  if (sep === -1) {
    return null;
  }
  const prefix = id.slice(0, sep);
  const key = id.slice(sep + 1);
  const typeMap = {
    s: "space",
    t: "tab",
    f: "folder",
    c: "container",
    meta: "meta",
  };
  return { type: typeMap[prefix] || prefix, key };
}

/**
 * Strips the sync-envelope fields (`id` and `type`) from incoming record data
 * and restores the item's real identity key where needed (e.g. folder `id`).
 *
 * @param data
 */
function stripSyncFields(data) {
  const parsed = parseRecordId(data.id);
  const { id: _recordId, type: _recordType, ...rest } = data;
  // For folders the real `id` is the key portion of the record ID.
  if (parsed?.type === "folder") {
    rest.id = parsed.key;
  }
  return rest;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class ZenWorkspacesStore extends Store {
  constructor(name, engine) {
    super(name, engine);
  }

  async getAllIDs() {
    const ids = {};
    const sidebar = lazy.ZenSyncStore.getCurrentSidebarData();

    for (const space of sidebar.spaces || []) {
      if (space.uuid) {
        ids[`s~${space.uuid}`] = true;
      }
    }

    for (const tab of sidebar.tabs || []) {
      if (tab.zenSyncId) {
        ids[`t~${tab.zenSyncId}`] = true;
      }
    }

    for (const folder of sidebar.folders || []) {
      if (folder.id) {
        ids[`f~${folder.id}`] = true;
      }
    }

    for (const c of lazy.ContextualIdentityService.getPublicIdentities()) {
      ids[`c~${c.userContextId}`] = true;
    }

    return ids;
  }

  async itemExists(id) {
    const parsed = parseRecordId(id);
    if (!parsed) {
      return false;
    }
    const sidebar = lazy.ZenSyncStore.getCurrentSidebarData();

    switch (parsed.type) {
      case "space":
        return (sidebar.spaces || []).some(s => s.uuid === parsed.key);
      case "tab":
        return (sidebar.tabs || []).some(t => t.zenSyncId === parsed.key);
      case "folder":
        return (sidebar.folders || []).some(f => String(f.id) === parsed.key);
      case "container":
        return lazy.ContextualIdentityService.getPublicIdentities().some(
          c => String(c.userContextId) === parsed.key
        );
      default:
        return false;
    }
  }

  async createRecord(id, collection) {
    const record = new ZenWorkspacesRecord(collection, id);
    const parsed = parseRecordId(id);
    if (!parsed) {
      record.deleted = true;
      return record;
    }

    const sidebar = lazy.ZenSyncStore.getCurrentSidebarData();

    switch (parsed.type) {
      case "space": {
        const spaces = sidebar.spaces || [];
        const idx = spaces.findIndex(s => s.uuid === parsed.key);
        if (idx === -1) {
          record.deleted = true;
          return record;
        }
        const { syncStatus: _sx, ...rest } = spaces[idx];
        record.cleartext = { id, type: "space", ...rest, position: idx };
        break;
      }

      case "tab": {
        const tabs = sidebar.tabs || [];
        const idx = tabs.findIndex(t => t.zenSyncId === parsed.key);
        const tab = idx === -1 ? null : tabs[idx];
        if (!tab) {
          record.deleted = true;
          return record;
        }
        const syncableTabData = lazy.ZenSyncStore.createSyncableTabData(tab, {
          position: idx,
          trimHistoryForUnpinned: true,
        });
        record.cleartext = { id, type: "tab", ...syncableTabData };
        break;
      }

      case "folder": {
        const folder = (sidebar.folders || []).find(
          f => String(f.id) === parsed.key
        );
        if (!folder) {
          record.deleted = true;
          return record;
        }
        const { syncStatus: _s, ...rest } = folder;
        record.cleartext = { ...rest, id, type: "folder" };
        break;
      }

      case "container": {
        const container =
          lazy.ContextualIdentityService.getPublicIdentities().find(
            c => String(c.userContextId) === parsed.key
          );
        if (!container) {
          record.deleted = true;
          return record;
        }
        record.cleartext = {
          id,
          type: "container",
          userContextId: container.userContextId,
          name: container.name,
          icon: container.icon,
          color: container.color,
        };
        break;
      }

      case "meta":
        // Groups/split views are no longer synced (they were never applied
        // to the live UI and ping-ponged between devices). Tombstone any
        // meta record still on the server.
        record.deleted = true;
        break;

      default:
        record.deleted = true;
    }

    return record;
  }

  async applyIncomingBatch(records, countTelemetry) {
    // Without a browser window to apply changes into, merging only the
    // on-disk session would be reverted by the next saveState from the
    // still-stale UI — and then pushed back to the server as a "local
    // change". Report every record as failed instead: Weave re-delivers
    // them on the next sync, when a window should exist.
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (!win?.gZenWorkspaces || win.gZenWorkspaces.privateWindowOrDisabled) {
      return records.map(record => record.id);
    }

    const pulled = { spaces: [], tabs: [], folders: [], containers: [] };
    const removals = { spaces: [], tabs: [], folders: [], containers: [] };

    for (const record of records) {
      if (record.deleted) {
        this._collectRemoval(record.id, removals);
        continue;
      }
      const data = record.cleartext;
      if (!data?.type) {
        continue;
      }
      const clean = stripSyncFields(data);
      switch (data.type) {
        case "space":
          pulled.spaces.push(clean);
          break;
        case "tab":
          pulled.tabs.push(clean);
          break;
        case "folder":
          pulled.folders.push(clean);
          break;
        case "container":
          pulled.containers.push(clean);
          break;
        // "meta" records (groups/split views) are ignored: they were never
        // applied to the live UI and only ping-ponged between devices.
      }
    }

    const isFirstSync = !(await this.engine.getLastSync());

    // Suppress change tracking while applying incoming data to prevent
    // feedback loops where applied items get re-uploaded immediately.
    this.engine._tracker.ignoreAll = true;
    try {
      await lazy.ZenSyncStore.applyIncomingBatch(pulled, removals, null, {
        isFirstSync,
      });
    } finally {
      this.engine._tracker.ignoreAll = false;
    }
    return [];
  }

  _collectRemoval(id, removals) {
    const parsed = parseRecordId(id);
    if (!parsed) {
      return;
    }
    switch (parsed.type) {
      case "space":
        removals.spaces.push({ uuid: parsed.key });
        break;
      case "tab":
        removals.tabs.push({ zenSyncId: parsed.key });
        break;
      case "folder":
        removals.folders.push({ id: parsed.key });
        break;
      case "container":
        removals.containers.push({ userContextId: parsed.key });
        break;
    }
  }

  async create(record) {
    await this._applySingle(record);
  }

  async update(record) {
    await this._applySingle(record);
  }

  async _applySingle(record) {
    this.engine._tracker.ignoreAll = true;
    try {
      if (record.deleted) {
        const removals = { spaces: [], tabs: [], folders: [], containers: [] };
        this._collectRemoval(record.id, removals);
        await lazy.ZenSyncStore.applyIncomingBatch(
          { spaces: [], tabs: [], folders: [], containers: [] },
          removals,
          null
        );
        return;
      }
      const data = record.cleartext;
      if (!data?.type) {
        return;
      }
      const clean = stripSyncFields(data);
      const pulled = { spaces: [], tabs: [], folders: [], containers: [] };
      switch (data.type) {
        case "space":
          pulled.spaces.push(clean);
          break;
        case "tab":
          pulled.tabs.push(clean);
          break;
        case "folder":
          pulled.folders.push(clean);
          break;
        case "container":
          pulled.containers.push(clean);
          break;
        // "meta" records are ignored; see applyIncomingBatch.
      }
      await lazy.ZenSyncStore.applyIncomingBatch(
        pulled,
        { spaces: [], tabs: [], folders: [], containers: [] },
        null
      );
    } finally {
      this.engine._tracker.ignoreAll = false;
    }
  }

  async remove() {
    // No-op: never delete user data on wipe
  }

  async wipe() {
    // No-op: never delete user data on wipe
  }

  changeItemID() {
    // No-op
  }
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

// LegacyTracker persists the changed-ID set to disk (weave/changes/),
// so items modified shortly before shutdown still upload after a restart.
class ZenWorkspacesTracker extends LegacyTracker {
  onStart() {
    Services.obs.addObserver(this, "zen-workspace-item-changed");
    Services.obs.addObserver(this, "contextual-identity-created");
    Services.obs.addObserver(this, "contextual-identity-updated");
    Services.obs.addObserver(this, "contextual-identity-deleted");
  }

  onStop() {
    Services.obs.removeObserver(this, "zen-workspace-item-changed");
    Services.obs.removeObserver(this, "contextual-identity-created");
    Services.obs.removeObserver(this, "contextual-identity-updated");
    Services.obs.removeObserver(this, "contextual-identity-deleted");
  }

  async observe(subject, topic, data) {
    if (this.ignoreAll) {
      return;
    }
    if (topic === "zen-workspace-item-changed") {
      await this._trackChange(data);
    } else if (topic.startsWith("contextual-identity-")) {
      const id = subject?.wrappedJSObject?.userContextId;
      if (id) {
        await this._trackChange(`c~${id}`);
      }
    }
  }

  async _trackChange(id) {
    if (await this.addChangedID(id)) {
      this.score += SCORE_INCREMENT_XLARGE;
    }
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ZenWorkspacesEngine extends SyncEngine {
  static get name() {
    return "Workspaces";
  }

  constructor(service) {
    super("Workspaces", service);
  }

  async _sync() {
    // Cache the collected sidebar for the whole sync so per-record store
    // calls don't each re-serialize the entire session.
    lazy.ZenSyncStore.beginSyncCache();
    try {
      await super._sync();
    } finally {
      lazy.ZenSyncStore.endSyncCache();
    }
  }

  get _storeObj() {
    return ZenWorkspacesStore;
  }

  get _trackerObj() {
    return ZenWorkspacesTracker;
  }

  get _recordObj() {
    return ZenWorkspacesRecord;
  }

  get version() {
    return 2;
  }

  get syncPriority() {
    return 6;
  }

  get allowSkippedRecord() {
    return false;
  }
}
