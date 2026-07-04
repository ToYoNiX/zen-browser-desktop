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

ChromeUtils.defineLazyGetter(lazy, "fxAccounts", () => {
  return ChromeUtils.importESModule(
    "resource://gre/modules/FxAccounts.sys.mjs"
  ).getFxAccountsSingleton();
});

// Minimum delay between "please sync now" pushes to other devices.
const DEVICE_NOTIFY_DEBOUNCE_MS = 10_000;
// How long the push message may be queued for a briefly offline device.
const DEVICE_NOTIFY_TTL_S = 60;

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
      const guid = lazy.ZenSyncStore.guidForUserContextId(c.userContextId, {
        create: true,
      });
      if (guid) {
        ids[`c~${guid}`] = true;
      }
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
        return lazy.ZenSyncStore.userContextIdForGuid(parsed.key) != null;
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
        // The default-container assignment is shipped as a sync GUID; the
        // raw containerTabId is device-local and meaningless elsewhere.
        record.cleartext.containerGuid = lazy.ZenSyncStore.guidForUserContextId(
          rest.containerTabId,
          { create: true }
        );
        delete record.cleartext.containerTabId;
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
        const userContextId = lazy.ZenSyncStore.userContextIdForGuid(
          parsed.key
        );
        const identity = userContextId
          ? lazy.ContextualIdentityService.getPublicIdentityFromId(
              userContextId
            )
          : null;
        const canonical = identity
          ? lazy.ZenSyncStore.guidForUserContextId(userContextId)
          : null;
        if (!identity || canonical !== parsed.key) {
          // Deleted container, legacy record keyed by raw userContextId,
          // or a non-canonical duplicate — clean it off the server.
          record.deleted = true;
          return record;
        }
        let name = identity.name;
        try {
          name =
            lazy.ContextualIdentityService.getUserContextLabel(
              identity.userContextId
            ) || identity.name;
        } catch {
          // Fall back to the raw name for containers without a label.
        }
        record.cleartext = {
          id,
          type: "container",
          guid: parsed.key,
          name,
          icon: identity.icon,
          color: identity.color,
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
        this._collectRemoval(record, removals);
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

    // Mark container records that the merge flagged for server-side cleanup
    // (legacy ids, non-canonical duplicates) so the next upload tombstones
    // them. Must happen after ignoreAll is lifted.
    for (const recordId of lazy.ZenSyncStore.takePendingContainerCleanups()) {
      await this.engine._tracker.addChangedID(recordId);
    }
    return [];
  }

  _collectRemoval(record, removals) {
    const parsed = parseRecordId(record.id);
    if (!parsed) {
      return;
    }
    switch (parsed.type) {
      case "space":
        removals.spaces.push({ uuid: parsed.key });
        break;
      case "tab":
        // The tombstone's server timestamp (seconds) lets the apply side
        // veto deletions of tabs the user interacted with after the close.
        removals.tabs.push({
          zenSyncId: parsed.key,
          tombstoneModified: record.modified || 0,
        });
        break;
      case "folder":
        removals.folders.push({ id: parsed.key });
        break;
      case "container":
        removals.containers.push({ guid: parsed.key });
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
        this._collectRemoval(record, removals);
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
      const userContextId = subject?.wrappedJSObject?.userContextId;
      if (!userContextId) {
        return;
      }
      // Records are keyed by sync GUID, not by the device-local id. Mint a
      // GUID for newly created containers; deleted ones keep their mapping
      // entry so the tombstone can still be uploaded.
      const guid = lazy.ZenSyncStore.guidForUserContextId(userContextId, {
        create: topic !== "contextual-identity-deleted",
      });
      if (guid) {
        await this._trackChange(`c~${guid}`);
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

  static #observingCollectionChanged = false;

  constructor(service) {
    super("Workspaces", service);
    // Liveness, receiving side: when another device pushes
    // "sync:collection_changed", sync this engine right away instead of
    // waiting for the scheduler (~10 min). The FxA server validates the
    // payload against a fixed enum of collection names ("workspaces" is
    // rejected with 400 invalid payload), so our pushes are sent under
    // "clients" — meaning we also react to genuine clients pushes such as
    // send-tab; an extra no-change engine sync is cheap. "workspaces" is
    // handled too in case the server schema ever learns about it.
    if (!ZenWorkspacesEngine.#observingCollectionChanged) {
      ZenWorkspacesEngine.#observingCollectionChanged = true;
      Services.obs.addObserver((subject, topic, data) => {
        if (data?.includes("clients") || data?.includes("workspaces")) {
          this.service
            .sync({ why: "collection_changed", engines: ["workspaces"] })
            .catch(e => {
              this._log.warn("Push-triggered workspaces sync failed", e);
            });
        }
      }, "sync:collection_changed");
    }
  }

  #lastDeviceNotify = 0;

  /**
   * Liveness, sending side: after we upload workspace changes, ping every
   * other device (FxA push, same channel the built-in tabs engine uses) so
   * they pull the changes within seconds. Debounced and best-effort.
   */
  async #notifyOtherDevices() {
    const now = Date.now();
    if (now - this.#lastDeviceNotify < DEVICE_NOTIFY_DEBOUNCE_MS) {
      return;
    }
    this.#lastDeviceNotify = now;
    try {
      const localId = await lazy.fxAccounts.device.getLocalId();
      await lazy.fxAccounts.notifyDevices(
        null,
        localId ? [localId] : [],
        {
          version: 1,
          command: "sync:collection_changed",
          // The FxA server schema only allows a fixed set of collection
          // names; "clients" is what send-tab uses and what both our
          // receiver and Weave.Service listen for.
          data: { collections: ["clients"] },
        },
        DEVICE_NOTIFY_TTL_S
      );
      this._log.debug("Notified other devices about workspace changes");
    } catch (e) {
      this._log.warn("Failed to notify other devices", e);
    }
  }

  async _sync() {
    // Cache the collected sidebar for the whole sync so per-record store
    // calls don't each re-serialize the entire session.
    lazy.ZenSyncStore.beginSyncCache();
    let hadChanges = false;
    try {
      // Drain record marks that were scheduled while no sync was running
      // (e.g. container records minted at save time, or queued while the
      // tracker was ignoring changes during a previous apply).
      for (const recordId of lazy.ZenSyncStore.takePendingContainerCleanups()) {
        await this._tracker.addChangedID(recordId);
      }
      hadChanges = !!Object.keys(await this._tracker.getChangedIDs()).length;
      await super._sync();
    } finally {
      lazy.ZenSyncStore.endSyncCache();
    }
    if (hadChanges) {
      // Only reached when the sync succeeded (finally doesn't swallow).
      this.#notifyOtherDevices();
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
