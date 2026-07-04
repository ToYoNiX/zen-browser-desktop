/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  Store,
  SyncEngine,
  Tracker,
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

    ids["meta~global"] = true;
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
      case "meta":
        return true;
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

      case "meta": {
        record.cleartext = {
          id,
          type: "meta",
          groups: sidebar.groups || [],
          splitViewData: sidebar.splitViewData || [],
        };
        break;
      }

      default:
        record.deleted = true;
    }

    return record;
  }

  async applyIncomingBatch(records, countTelemetry) {
    const pulled = { spaces: [], tabs: [], folders: [], containers: [] };
    const removals = { spaces: [], tabs: [], folders: [], containers: [] };
    let meta = null;

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
        case "meta":
          meta = {
            groups: data.groups || [],
            splitViewData: data.splitViewData || [],
          };
          break;
      }
    }

    // Suppress change tracking while applying incoming data to prevent
    // feedback loops where applied items get re-uploaded immediately.
    this.engine._tracker.ignoreAll = true;
    try {
      await lazy.ZenSyncStore.applyIncomingBatch(pulled, removals, meta);
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
      let meta = null;
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
        case "meta":
          meta = {
            groups: data.groups || [],
            splitViewData: data.splitViewData || [],
          };
          break;
      }
      await lazy.ZenSyncStore.applyIncomingBatch(
        pulled,
        { spaces: [], tabs: [], folders: [], containers: [] },
        meta
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

class ZenWorkspacesTracker extends Tracker {
  _changedIDs = {};
  _ignoreAll = false;

  get ignoreAll() {
    return this._ignoreAll;
  }

  set ignoreAll(value) {
    this._ignoreAll = value;
  }

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

  observe(subject, topic, data) {
    if (this._ignoreAll) {
      return;
    }
    if (topic === "zen-workspace-item-changed") {
      this._trackChange(data);
    } else if (topic.startsWith("contextual-identity-")) {
      const id = subject?.wrappedJSObject?.userContextId;
      if (id) {
        this._trackChange(`c~${id}`);
      }
    }
  }

  _trackChange(id) {
    this._changedIDs[id] = Date.now() / 1000;
    this.score += SCORE_INCREMENT_XLARGE;
  }

  async getChangedIDs() {
    return { ...this._changedIDs };
  }

  async addChangedID(id, when) {
    this._changedIDs[id] = when;
    return true;
  }

  async removeChangedID(...ids) {
    for (const id of ids) {
      delete this._changedIDs[id];
    }
    return true;
  }

  clearChangedIDs() {
    this._changedIDs = {};
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
