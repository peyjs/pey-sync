// Local persistence for pey.sync: guards, run errors, scope memory,
// legacy-snapshot migration and the last-synced snapshot (version 2:
// path-keyed `{collection, id, path, hash, rev}`). Reads and writes the
// plugin's own stores through the storage outage guard; knows record
// shapes, never the network or the sync plan.
import { syncError } from './error.js';
import { normalizeScope } from './sync-scope.js';
import { requireStorage, store } from './sync-store.js';

const SERVICE_NAME = 'pey.sync.service';
const BACKENDS_COLLECTION = 'sync_backends';
const STATE_COLLECTION = 'sync_state';
const BACKEND_ID = 'active';
const PROMPTED_CONFLICTS_ID = 'prompted-conflicts';

/**
 * Pins the conflicts the host was just asked about, with each remote side's
 * prompt-time hash: the anchor for the prompt-to-resolve guard in
 * resolveConflict. An empty list clears the pin.
 * @param {object} storage Storage service.
 * @param {Array<{collection: string, id: string, remoteHash: string|null}>} conflicts Open conflicts.
 * @returns {Promise<void>}
 */
export async function writePromptedConflicts(storage, conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) {
    await store(storage.delete(STATE_COLLECTION, PROMPTED_CONFLICTS_ID));
    return;
  }
  await store(storage.write(STATE_COLLECTION, {
    id: PROMPTED_CONFLICTS_ID,
    conflicts,
  }));
}

/**
 * Reads the pinned prompt-time conflicts, or an empty list.
 * @param {object} storage Storage service.
 * @returns {Promise<Array<{collection: string, id: string, remoteHash: string|null}>>} Pinned conflicts.
 */
export async function readPromptedConflicts(storage) {
  const record = await store(storage.read(STATE_COLLECTION, PROMPTED_CONFLICTS_ID));
  return Array.isArray(record?.conflicts) ? record.conflicts : [];
}

/**
 * Requires a configured backend.
 * @param {object} state Activation state.
 * @returns {object} `{ backend, storage }`.
 * @throws {object} SYNC_NOT_CONFIGURED.
 */
async function requireBackend(state) {
  const storage = requireStorage(state);
  const backend = await store(storage.read(BACKENDS_COLLECTION, BACKEND_ID));
  if (!backend) {
    throw syncError('SYNC_NOT_CONFIGURED', 'No sync backend configured', {});
  }
  return { backend, storage };
}

/**
 * Publishes a sync event when the bus exists. Bus failures never fail a run.
 * @param {object} state Activation state.
 * @param {string} type Event type.
 * @param {object} data Event data.
 * @returns {void}
 */
function publish(state, type, data) {
  try {
    state.events?.publish(type, data);
  } catch {
    // Event bus issues never fail a sync.
  }
}

/**
 * Builds the stable identity of a backend destination: kind plus the
 * normalized coordinates, deliberately excluding the token (a token change
 * is the same destination; a repo/branch/URL change is a new one).
 * @param {object} backend Stored backend record.
 * @returns {string} Identity key.
 */
function identityOf(backend) {
  return [backend?.kind, backend?.baseUrl ?? '', backend?.repo ?? '', backend?.branch ?? ''].join('::');
}

/**
 * Reconciles the stored baseline with the current destination before any
 * round. A KNOWN changed destination resets the snapshot so the next round
 * behaves like a first sync — everything pushes and nothing can read as
 * "remotely deleted"; this is what keeps switching destinations from ever
 * deleting local data. An UNKNOWN identity (legacy state, first round after
 * an upgrade) is adopted as-is: the upgrade never rewrites a baseline it
 * cannot judge.
 * @param {object} storage Storage service.
 * @param {object} backend Stored backend record.
 * @returns {Promise} Stored state.
 */
async function reconcileBackendIdentity(storage, backend) {
  const identity = identityOf(backend);
  const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
  if (saved.backendIdentity === identity) {
    return saved;
  }
  if (saved.backendIdentity === undefined || saved.backendIdentity === null) {
    return store(storage.write(STATE_COLLECTION, { ...saved, id: BACKEND_ID, backendIdentity: identity }));
  }
  // A different known identity means the destination changed: the prompt
  // pins belong to the OLD destination, so clearing them keeps the
  // fail-closed guard honest on the new one — the first round there builds
  // fresh pins from its own prompts.
  await writePromptedConflicts(storage, []);
  return store(storage.write(STATE_COLLECTION, { ...saved, id: BACKEND_ID, snapshot: [], backendIdentity: identity }));
}

/**
 * Records a run failure for status display.
 * @param {object} storage Storage service.
 * @param {object} error Structured error.
 * @returns {Promise} Stored state.
 */
async function recordError(storage, error) {
  const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
  return store(storage.write(STATE_COLLECTION, {
    ...saved,
    id: BACKEND_ID,
    lastError: { code: error?.code ?? 'UNKNOWN', message: error?.message ?? '', at: Date.now() },
  }));
}

/**
 * Clears the stored run error after clean completion.
 * @param {object} storage Storage service.
 * @returns {Promise} Stored state.
 */
async function clearError(storage) {
  const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
  return store(storage.write(STATE_COLLECTION, { ...saved, id: BACKEND_ID, lastError: null }));
}

/**
 * Persists the scope that produced the current snapshot, so conflict
 * resolution replays the same field mapping without caller input.
 * @param {object} storage Storage service.
 * @param {Array} configs Normalized scope.
 * @returns {Promise} Stored state.
 */
async function rememberScope(storage, configs) {
  const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
  return store(storage.write(STATE_COLLECTION, { ...saved, id: BACKEND_ID, scope: configs }));
}

/**
 * Upgrades a stored snapshot to version 2 on the spot: path-keyed entries
 * gain a content hash and a revision. Hashes are seeded from the legacy
 * manifest when it is still readable — one traversal serves both migration
 * and planning, so no extra remote reads happen now.
 * @param {object} storage Storage service.
 * @param {Array} previous Stored snapshot in any shape.
 * @param {Array|null} legacyManifestRecords Legacy manifest records.
 * @returns {Promise<object>} `{ snapshot, seeded }` — entries normalized
 *   to version 2, `seeded` false only when nothing changed.
 */
async function migrateSnapshot(storage, previous, legacyManifestRecords) {
  const twins = new Map();
  for (const record of legacyManifestRecords ?? []) {
    if (record
      && typeof record.collection === 'string'
      && typeof record.id === 'string'
      && typeof record.hash === 'string'
      && record.hash.length > 0) {
      twins.set(`${record.collection}::${record.id}`, record);
    }
  }
  let seeded = false;
  const snapshot = [];
  for (const entry of Array.isArray(previous) ? previous : []) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      seeded = true;
      continue;
    }
    if (typeof entry.hash === 'string' && entry.hash.length > 0) {
      snapshot.push({
        collection: entry.collection,
        id: entry.id,
        path: entry.path,
        hash: entry.hash,
        rev: typeof entry.rev === 'string' ? entry.rev : null,
      });
      continue;
    }
    seeded = true;
    const twin = twins.get(`${entry?.collection ?? ''}::${entry?.id ?? ''}`);
    const twinHash = typeof twin?.path === 'string' && twin.path === entry.path ? twin.hash : null;
    snapshot.push({
      collection: entry.collection,
      id: entry.id,
      path: entry.path,
      hash: twinHash,
      rev: null,
    });
  }
  if (seeded) {
    const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
    await store(storage.write(STATE_COLLECTION, {
      ...saved,
      id: BACKEND_ID,
      snapshot,
    }));
  }
  return { snapshot, seeded };
}

/**
 * Merges one clean round's verified outcomes into the stored baseline: only
 * the paths this round actually wrote or deleted change — every other entry
 * keeps its previous shape, so a host edit racing the round stays dirty
 * instead of being marked synced without ever being pushed. One record one
 * path: an upserted entry displaces any baseline entry at its path.
 * @param {object} storage Storage service.
 * @param {object} outcomes Round outcomes ({pushed, pulled, deleteRemote,
 *   deleteLocal} with {collection, id, path, hash?, rev?} entries, plus
 *   gonePaths: plain-string paths of this round's dead claims — snapshot
 *   entries with neither side alive and not among the unattributed
 *   ("foreign") paths — dropped from the baseline at the clean advance).
 * @returns {Promise} Stored state.
 */
async function mergeRoundSnapshot(storage, outcomes) {
  const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
  const previous = Array.isArray(saved.snapshot) ? saved.snapshot : [];
  // Baseline paths both sides lost (round 13) come as plain STRINGS: no
  // outcome will ever target them, so without this drop they pin the dirty
  // dot forever.
  const dropPaths = new Set([
    ...outcomes.deleteRemote,
    ...outcomes.deleteLocal,
  ].map((item) => item.path).concat(outcomes.gonePaths ?? []));
  const droppedIds = new Set(outcomes.deleteLocal.map((item) => `${item.collection}::${item.id}`));
  const upserts = [...outcomes.pushed, ...outcomes.pulled];
  const upsertKeys = new Set(upserts.map((entry) => `${entry.collection}::${entry.id}`));
  const upsertPaths = new Set(upserts.map((entry) => entry.path));
  const snapshot = [];
  const seen = new Set();
  for (const entry of previous) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      continue;
    }
    const key = `${entry.collection}::${entry.id}`;
    if (upsertKeys.has(key) || droppedIds.has(key) || dropPaths.has(entry.path) || upsertPaths.has(entry.path)) {
      continue;
    }
    if (seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    snapshot.push(entry);
  }
  for (const entry of upserts) {
    if (seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    snapshot.push({ collection: entry.collection, id: entry.id, path: entry.path, hash: entry.hash, rev: entry.rev ?? null });
  }
  return store(storage.write(STATE_COLLECTION, { ...saved, id: BACKEND_ID, lastSyncAt: Date.now(), snapshot }));
}

/**
 * Stamps the last-sync time without touching the baseline (used when a
 * conflict-resolution round closes the last conflict: the resolution itself
 * already pinned its own baseline entry).
 * @param {object} storage Storage service.
 * @returns {Promise} Stored state.
 */
async function stampSyncedAt(storage) {
  const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
  return store(storage.write(STATE_COLLECTION, { ...saved, id: BACKEND_ID, lastSyncAt: Date.now() }));
}

/**
 * Reads the stored scope for conflict resolution (recorded per run).
 * @param {object} storage Storage service.
 * @returns {Array} Normalized scope.
 * @throws {object} SYNC_INVALID_CONFIG when no scope was ever recorded.
 */
async function readScopeForResolve(storage) {
  const saved = await store(storage.read(STATE_COLLECTION, BACKEND_ID));
  if (!saved || !Array.isArray(saved.scope) || saved.scope.length === 0) {
    throw syncError('SYNC_INVALID_CONFIG', 'No recorded sync scope for this conflict', {});
  }
  return normalizeScope({ collections: saved.scope });
}

/**
 * Upserts or drops one snapshot entry (identity: collection + id). When the
 * drop carries a `path`, any other snapshot entry still sitting at that path
 * is stale too (one record one path: a resolution pins its winner there) and
 * is removed, so a displaced previous owner cannot re-fire its conflict.
 * @param {object} storage Storage service.
 * @param {object} saved State record.
 * @param {object|null} entry Entry to upsert, or null.
 * @param {object|null} drop Entry to drop, or null; `drop.path` frees the path.
 * @returns {Promise} Stored state.
 */
async function writeSnapshotEntry(storage, saved, entry, drop) {
  const previous = Array.isArray(saved.snapshot) ? saved.snapshot : [];
  const snapshot = previous.filter((item) => {
    if (!item) {
      return false;
    }
    if (drop && item.collection === drop.collection && item.id === drop.id) {
      return false;
    }
    if (entry && typeof drop?.path === 'string'
      && item.path === drop.path
      && !(item.collection === entry.collection && item.id === entry.id)) {
      return false;
    }
    return !(entry && item.collection === entry.collection && item.id === entry.id);
  });
  if (entry) {
    snapshot.push(entry);
  }
  return store(storage.write(STATE_COLLECTION, { ...saved, id: BACKEND_ID, snapshot }));
}

export {
  BACKENDS_COLLECTION,
  BACKEND_ID,
  PROMPTED_CONFLICTS_ID,
  SERVICE_NAME,
  STATE_COLLECTION,
  clearError,
  identityOf,
  mergeRoundSnapshot,
  migrateSnapshot,
  publish,
  readScopeForResolve,
  recordError,
  reconcileBackendIdentity,
  rememberScope,
  requireBackend,
  stampSyncedAt,
  writeSnapshotEntry,
};
