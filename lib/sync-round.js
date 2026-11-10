// One sync round for pey.sync: plan, apply, finalize, and single-record
// conflict resolution.
//
// A round collects local state and the attributed remote listing (pure
// reads plus the snapshot migration), applies the plan, then advances the
// snapshot on clean completion; single-record conflict resolution
// replays the same shape. Remote files are read once per round (hash
// fill) and the raw contents ride along for pulls and previews. Reads
// storage and the backend, never the UI.
import { syncError } from './error.js';
import { planSync } from './sync-engine.js';
import { collectLocal, withoutIgnored } from './sync-collect.js';
import { contentOf, extensionsOf, remoteHash, serializeRecord, serializerFor } from './sync-scope.js';
import { loadFolderMaps } from './sync-paths.js';
import {
  buildPulledRecord,
  cleanupLegacyArtifacts,
  hashRemoteFile,
  readRemoteListing,
} from './sync-remote.js';
import {
  BACKEND_ID,
  STATE_COLLECTION,
  clearError,
  mergeRoundSnapshot,
  migrateSnapshot,
  publish,
  rememberScope,
  writeSnapshotEntry,
} from './sync-state.js';
import { store } from './sync-store.js';

/**
 * Gathers one round's inputs: local entries, the attributed remote
 * listing with hashes, the migrated snapshot and the pure plan. Pure
 * reads plus the on-the-spot snapshot migration — safe to retry.
 * @param {object} round Round context (storage, configs, adapter,
 *   descriptor, failMapped, report).
 * @returns {Promise<object>} `{ plan, local, listing, snapshot, contents,
 *   revs }`; contents maps remote paths to their raw read text, revs maps
 *   paths to listing revisions.
 * @throws {object} SYNC_PATH_COLLISION when two local records claim one
 *   path — planning stops before any remote write.
 */
async function captureRoundPlan(round) {
  const { storage, configs, adapter, report } = round;
  await rememberScope(storage, configs);
  const local = await collectLocal(storage, configs);
  report.relocated.push(...local.relocated);
  report.skipped.push(...local.skipped.map((item) => ({ collection: item.collection, id: item.id })));
  const listing = await readRemoteListing(adapter, configs, local.folderIgnores, extensionsOf(configs)).catch(round.failMapped);
  report.skipped.push(...listing.foreign.map((item) => ({ collection: null, id: null, path: item.path })));
  const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
  const migrated = await migrateSnapshot(storage, saved.snapshot, listing.legacyManifestRecords);
  // Ignored records are out of the plan's jurisdiction entirely: an
  // entry dropping under a fresh ignore pattern must never read as a
  // local deletion to propagate.
  const snapshot = withoutIgnored(migrated.snapshot, configs, local.folderIgnores, extensionsOf(configs));
  const snapByPath = new Map(snapshot.map((entry) => [entry.path, entry]));
  const remote = [];
  const contents = new Map();
  const revs = new Map();
  for (const item of listing.entries) {
    if (typeof item.rev === 'string') {
      revs.set(item.path, item.rev);
    }
    const before = snapByPath.get(item.path);
    let hash;
    if (typeof item.rev === 'string' && before && typeof before.rev === 'string' && item.rev === before.rev) {
      // Revision shortcut: the listing signature equals the one already
      // hashed last round, so the remote bytes are unchanged.
      hash = before.hash;
    } else {
      const hashed = await hashRemoteFile(adapter, configs, item.collection, item.path, item.rev).catch(round.failMapped);
      if (hashed === null) {
        // Gone mid-round: not a plan entry, reported as skipped and never
        // touched.
        report.skipped.push({ collection: item.collection, id: item.id ?? null, path: item.path });
        continue;
      }
      if (typeof hashed.hash !== 'string') {
        // The file exists but this collection cannot decode it: the round
        // stops before any write or deletion — a corrupt remote file must
        // never read as "remotely deleted".
        throw syncError('SYNC_REMOTE_INVALID', 'The remote file cannot be decoded by this collection serializer', {
          collection: item.collection,
          path: item.path,
        });
      }
      hash = hashed.hash;
      contents.set(item.path, hashed.content);
      if (typeof hashed.rev === 'string') {
        revs.set(item.path, hashed.rev);
      }
    }
    remote.push({
      collection: item.collection,
      id: item.id ?? null,
      path: item.path,
      hash,
      rev: item.rev ?? null,
    });
  }
  const plan = planSync(snapshot, local.entries, remote);
  if (plan.collisions.length > 0) {
    throw syncError('SYNC_PATH_COLLISION', 'Two local records claim the same remote path', {
      collection: plan.collisions[0].collection,
      path: plan.collisions[0].path,
      ids: plan.collisions.map((item) => item.id),
    });
  }
  report.skipped.push(...plan.skipped.map((item) => ({ collection: item?.collection ?? null, id: item?.id ?? null })));
  return { plan, local, listing, snapshot, contents, revs };
}

/**
 * Re-reads one local record for the CAS guard. A failing read reads as a
 * vanished record (null), which never matches the plan-time state.
 * @param {object} storage Storage service.
 * @param {string} collection Record collection.
 * @param {string} id Record id.
 * @returns {Promise<object|null>} Current record or null.
 */
async function currentRecord(storage, collection, id) {
  try {
    return await storage.read(collection, id);
  } catch {
    return null;
  }
}

/**
 * Applies the planned pushes with the CAS guard: the record must still
 * carry the content the plan was built on.
 * @param {object} round Round context.
 * @param {object} context Gathering result.
 * @param {object} outcomes Round outcomes (mutated).
 * @returns {Promise<void>}
 */
async function applyPushes(round, context, outcomes) {
  const { storage, configs, adapter, report, message } = round;
  const { plan, local, revs } = context;
  for (const item of plan.push) {
    const held = local.byKey.get(`${item.collection}::${item.id}`);
    // CAS: the record must still carry the content the plan was built on.
    const current = await currentRecord(storage, item.collection, item.id);
    if (!held || !current || contentOf(configs, item.collection, current) !== contentOf(configs, item.collection, held.record)) {
      report.skipped.push({ collection: item.collection, id: item.id ?? null, path: item.path });
      continue;
    }
    const content = serializeRecord(configs, item, held.record);
    const written = await adapter
      .writeFile(item.path, content, revs.get(item.path) ?? null, { message })
      .catch(round.failMapped);
    if (written?.rev) {
      revs.set(item.path, written.rev);
    }
    outcomes.pushed.push({
      collection: item.collection,
      id: item.id,
      path: item.path,
      hash: item.hash,
      rev: written?.rev ?? revs.get(item.path) ?? null,
    });
    report.pushed.push({ collection: item.collection, id: item.id });
  }
}

/**
 * Applies the planned pulls with the CAS guard: an existing occupant must
 * still match the plan-time state before the pulled content overwrites it.
 * @param {object} round Round context.
 * @param {object} context Gathering result.
 * @param {object} outcomes Round outcomes (mutated).
 * @returns {Promise<void>}
 */
async function applyPulls(round, context, outcomes) {
  const { storage, configs, adapter, report } = round;
  const { plan, local, contents, revs } = context;
  for (const item of plan.pull) {
    let content = contents.get(item.path) ?? null;
    if (typeof content !== 'string') {
      const file = await adapter.readFile(item.path).catch(round.failMapped);
      content = file?.content ?? null;
    }
    if (typeof content !== 'string') {
      report.skipped.push({ collection: item.collection, id: item.id ?? null, path: item.path });
      continue;
    }
    // CAS: an existing occupant must still match the state the plan was
    // built on before its record is overwritten by the pulled content.
    const occupant = item.id != null ? local.byKey.get(`${item.collection}::${item.id}`) : null;
    if (occupant) {
      const current = await currentRecord(storage, item.collection, item.id);
      if (!current || contentOf(configs, item.collection, current) !== contentOf(configs, item.collection, occupant.record)) {
        report.skipped.push({ collection: item.collection, id: item.id ?? null, path: item.path });
        continue;
      }
    }
    // Folder maps reload per item: earlier pulls in this same loop may
    // have just created the folders this path resolves through.
    const folderMaps = await loadFolderMaps(storage, configs);
    const built = await buildPulledRecord(storage, folderMaps, configs, item, content, Date.now());
    if (!built) {
      report.skipped.push({ collection: item.collection, id: item.id ?? null, path: item.path });
      continue;
    }
    await store(storage.write(built.collection, built.record));
    outcomes.pulled.push({
      collection: built.collection,
      id: built.record.id,
      path: item.path,
      hash: item.hash,
      rev: revs.get(item.path) ?? null,
    });
    report.pulled.push({ collection: built.collection, id: built.record.id });
  }
}

/**
 * Applies the planned remote deletions (rev-guarded by the adapter).
 * @param {object} round Round context.
 * @param {object} context Gathering result.
 * @param {object} outcomes Round outcomes (mutated).
 * @returns {Promise<void>}
 */
async function applyRemoteDeletions(round, context, outcomes) {
  const { adapter, report, message } = round;
  for (const item of context.plan.deleteRemote) {
    await adapter.deleteFile(item.path, item.rev ?? null, { message }).catch(round.failMapped);
    outcomes.deleteRemote.push({ collection: item.collection, id: item.id, path: item.path });
    report.deletedRemote.push({ collection: item.collection, id: item.id });
  }
}

/**
 * Applies the planned local deletions with the CAS guard: only propagate
 * while the record still matches the plan-time state.
 * @param {object} round Round context.
 * @param {object} context Gathering result.
 * @param {object} outcomes Round outcomes (mutated).
 * @returns {Promise<void>}
 */
async function applyLocalDeletions(round, context, outcomes) {
  const { storage, configs, report } = round;
  const { plan, local } = context;
  for (const item of plan.deleteLocal) {
    // CAS: only propagate the deletion while the record still matches the
    // state the plan was built on.
    const current = await currentRecord(storage, item.collection, item.id);
    const held = local.byKey.get(`${item.collection}::${item.id}`);
    if (!current || !held || contentOf(configs, item.collection, current) !== contentOf(configs, item.collection, held.record)) {
      report.skipped.push({ collection: item.collection, id: item.id ?? null, path: item.path });
      continue;
    }
    await store(storage.delete(item.collection, item.id));
    outcomes.deleteLocal.push({ collection: item.collection, id: item.id, path: item.path });
    report.deleteLocal.push({ collection: item.collection, id: item.id });
  }
}

/**
 * Applies one planned round: pushes, pulls, propagates deletions, then
 * enriches conflicts with both-side content. Every applied operation first
 * re-reads the local record and compares its content with the state the plan
 * was built on (CAS): a host edit racing the round skips that one operation
 * instead of being silently overwritten or marked synced. No remote metadata
 * writes exist; every remote touch is a planned file. Idempotent per item.
 * @param {object} round Round context (see captureRoundPlan).
 * @param {object} context Gathering result.
 * @returns {Promise<void>}
 */
async function applyRoundPlan(round, context) {
  const outcomes = { pushed: [], pulled: [], deleteRemote: [], deleteLocal: [] };
  await applyPushes(round, context, outcomes);
  await applyPulls(round, context, outcomes);
  await applyRemoteDeletions(round, context, outcomes);
  await applyLocalDeletions(round, context, outcomes);
  context.outcomes = outcomes;
  const enriched = await enrichConflicts(round, context).catch(round.failMapped);
  round.report.conflicts.push(...enriched);
}

/**
 * Enriches conflicts with both-side content for the host prompt, reading
 * remote text straight from the round's own hash-fill reads.
 * @param {object} round Round context.
 * @param {object} context Gathering result.
 * @returns {Promise<Array>} Enriched conflicts shaped `{ collection, id,
 *   title, local: {content, updatedAt}|null, remote: {content}|null }`.
 */
async function enrichConflicts(round, context) {
  const { configs } = round;
  const { plan, local, contents } = context;
  const enriched = [];
  for (const conflict of plan.conflicts) {
    const held = local.byKey.get(`${conflict.collection}::${conflict.id}`);
    const config = configs.find((entry) => entry.collection === conflict.collection);
    const remoteContent = conflict.remote ? (contents.get(conflict.remote.path) ?? '') : '';
    enriched.push({
      collection: conflict.collection,
      id: conflict.id,
      title: titleOf(config, held?.record, conflict.remote),
      local: conflict.local ? {
        updatedAt: held?.record?.[config?.updatedAtField ?? 'updatedAt'] ?? null,
        content: held ? contentOf(configs, conflict.collection, held.record) : '',
      } : null,
      remote: conflict.remote ? {
        content: remoteContent,
      } : null,
    });
  }
  return enriched;
}

/**
 * Picks the display title: the local record's own title, else the remote
 * file name with the serializer extension stripped.
 * @param {object|null} config Normalized collection config.
 * @param {object|null} record Held local record.
 * @param {object|null} remote Remote entry.
 * @returns {string} Display title.
 */
function titleOf(config, record, remote) {
  const name = record?.[config?.titleField ?? 'title'];
  if (typeof name === 'string' && name.length > 0) {
    return name;
  }
  if (remote && typeof remote.path === 'string') {
    const extension = serializerFor(config?.serializer)?.extension;
    if (typeof extension === 'string') {
      const fileName = remote.path.slice(remote.path.lastIndexOf('/') + 1);
      const suffix = `.${extension}`;
      if (fileName.toLowerCase().endsWith(suffix) && fileName.length > suffix.length) {
        return fileName.slice(0, -suffix.length);
      }
    }
    return remote.path.slice(remote.path.lastIndexOf('/') + 1);
  }
  // Unreachable today (a conflict always carries at least one side with a
  // name); an empty title is the honest fallback if that ever changes.
  return '';
}

/**
 * Finalizes one round: advances the snapshot only on clean completion,
 * sweeps the legacy 0.2.0 artifacts, stamps the report and publishes the
 * outcome.
 * @param {object} state Activation state (event bus).
 * @param {object} storage Storage service.
 * @param {object} adapter Backend adapter (legacy artifact sweep).
 * @param {Array} configs Normalized scope.
 * @param {object} context Gathering result.
 * @param {object} report Mutable report.
 * @returns {object} Completed report.
 */
async function finalizeRound(state, storage, adapter, configs, context, report) {
  const clean = context.plan.conflicts.length === 0;
  if (clean) {
    await mergeRoundSnapshot(storage, context.outcomes);
    await clearError(storage);
    await cleanupLegacyArtifacts(adapter, context.listing.legacyManifestRecords);
  }
  report.completed = clean;
  publish(state, 'sync:changed', {
    pushed: report.pushed,
    pulled: report.pulled,
    conflicts: report.conflicts.map((conflict) => ({ collection: conflict.collection, id: conflict.id })),
  });
  if (!clean) {
    publish(state, 'sync:conflicted', {
      conflicts: report.conflicts.map((conflict) => ({ collection: conflict.collection, id: conflict.id })),
    });
  }
  return report;
}

/**
 * Applies the local side of one conflict. For an ordinary conflict this
 * pushes the local record (freeing the old path when the record moved
 * mid-staleness) and pins the snapshot. For a delete-vs-edit conflict the
 * local side is the deletion: choosing it drops the remote file (rev-guarded)
 * and the baseline entry, and the local record stays deleted.
 * @param {object} round Round context.
 * @param {object} context Gathering result.
 * The write re-checks the local record against the plan-time state first
 * (CAS, the same guard the remote path applies): a host edit racing the
 * resolution must not be silently overwritten — the conflict stays open.
 * @param {object} conflict Engine conflict ({collection, id, local, remote}).
 * @returns {Promise<{applied: boolean, pushed: Array, pulled: Array}>} The
 *   outcome; `applied: false` when the CAS guard skipped the resolution.
 * @throws {object} SYNC_INVALID_CONFIG when the record vanished mid-run.
 */
async function applyLocalResolution(round, context, conflict) {
  const { configs, adapter, storage } = round;
  const { collection, id } = conflict;
  const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
  const before = context.snapshot.find((item) => item?.collection === collection && item?.id === id) ?? null;
  // The CAS guard covers BOTH branches of the local choice — push AND the
  // delete-vs-edit deletion: a host edit (or re-creation) racing the window
  // must never be silently overwritten or have the remote file deleted on
  // the strength of a deletion that no longer exists. (For a deletion the
  // held record is null, so a mid-window re-creation reads as "changed".)
  if (!(await localRecordUnchanged(storage, context, configs, collection, id))) {
    return { applied: false, pushed: [], pulled: [] };
  }

  if (!conflict.local) {
    // The local side of a delete-vs-edit conflict is the deletion: keep it.
    if (conflict.remote) {
      await adapter.deleteFile(conflict.remote.path, context.revs.get(conflict.remote.path) ?? null).catch(round.failMapped);
    }
    await writeSnapshotEntry(round.storage, saved, null, { collection, id });
    return { applied: true, pushed: [], pulled: [] };
  }

  const local = context.local;
  const held = local.byKey.get(`${collection}::${id}`);
  const entry = local.entries.find((item) => item.collection === collection && item.id === id);
  if (!entry) {
    throw syncError('SYNC_INVALID_CONFIG', 'Local record vanished mid-resolution', { collection, id });
  }
  const content = serializeRecord(configs, entry, held?.record);
  const written = await adapter.writeFile(entry.path, content, context.revs.get(entry.path) ?? null).catch(round.failMapped);
  if (written?.rev) {
    context.revs.set(entry.path, written.rev);
  }
  if (before && typeof before.path === 'string' && before.path !== entry.path) {
    await adapter.deleteFile(before.path, context.revs.get(before.path) ?? null).catch(round.failMapped);
  }
  await writeSnapshotEntry(round.storage, saved, {
    collection,
    id,
    path: entry.path,
    hash: entry.hash,
    rev: written?.rev ?? context.revs.get(entry.path) ?? null,
  }, { collection, id, path: entry.path });
  return { applied: true, pushed: [{ collection, id, path: entry.path }], pulled: [] };
}

/**
 * Re-reads the local record and compares its content with the state the
 * round was captured on (CAS, the same guard applyRoundPlan uses): a host
 * edit racing the resolution must not be silently overwritten or deleted.
 * @param {object} context Gathering result.
 * @param {object} configs Normalized scope.
 * @param {string} collection Record collection.
 * @param {string} id Record id.
 * @returns {Promise<boolean>} True when the record still matches the
 *   plan-time state (a missing record matches only a plan-time absence).
 */
async function localRecordUnchanged(storage, context, configs, collection, id) {
  const held = context.local.byKey.get(`${collection}::${id}`) ?? null;
  let current = null;
  try {
    current = await storage.read(collection, id);
  } catch {
    // A failing CAS read is NOT "the record vanished" (fail-closed, like
    // currentRecord in applyRoundPlan): the resolution is skipped and the
    // conflict stays open instead of proceeding on unknown state.
    return false;
  }
  const heldContent = held ? contentOf(configs, collection, held.record) : null;
  const currentContent = current ? contentOf(configs, collection, current) : null;
  return currentContent === heldContent;
}

/**
 * Applies the remote side of one conflict: adopts it locally (or drops a
 * vanished path), then pins the snapshot. Both the adoption and the
 * deletion first re-check the local record against the plan-time state
 * (CAS): when the host edited or re-created it mid-window the resolution
 * is skipped and the conflict stays open.
 * @param {object} round Round context.
 * @param {object} context Gathering result.
 * @param {object} conflict Engine conflict with the remote entry.
 * @param {string} collection Record collection.
 * @param {string} id Record id.
 * @returns {Promise<{applied: boolean, pushed: Array, pulled: Array}>} The
 *   outcome; `applied: false` when the CAS guard, a mid-window remote edit
 *   or a non-representable remote file skipped the resolution (the conflict
 *   remains pending).
 */
async function applyRemoteResolution(round, context, conflict, collection, id) {
  const { storage, configs } = round;
  const remote = conflict.remote ?? null;
  if (!(await localRecordUnchanged(storage, context, configs, collection, id))) {
    return { applied: false, pushed: [], pulled: [] };
  }
  const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
  if (!remote) {
    // The remote side of a delete-vs-change conflict is the deletion:
    // choosing it applies the deletion to the local record too. (A local
    // deletion is not representable in the sync:changed payload.)
    await store(storage.delete(conflict.collection, conflict.id));
    await writeSnapshotEntry(storage, saved, null, { collection, id });
    return { applied: true, pushed: [], pulled: [] };
  }
  let content = context.contents.get(remote.path) ?? null;
  if (typeof content !== 'string') {
    const file = await round.adapter.readFile(remote.path).catch(round.failMapped);
    content = file?.content ?? null;
    if (typeof content === 'string'
      && remoteHash(configs, remote.collection, content) !== remote.hash) {
      // The file changed between the plan and this resolution: accepting
      // it would hand the user content they never saw in the prompt. Skip
      // — the next round re-reports the conflict with the fresh content.
      return { applied: false, pushed: [], pulled: [] };
    }
  }
  if (typeof content !== 'string') {
    // The remote content is gone at resolve time (a takeover conflict with
    // a rev shortcut can land here). Pinning an empty baseline while the
    // local record survives would push the local content over the remote
    // deletion next round — inverting the user's "remote" choice. Skip like
    // the unrepresentable path: the conflict stays open, the next round
    // re-asks with fresh state.
    return { applied: false, pushed: [], pulled: [] };
  }
  const folderMaps = await loadFolderMaps(storage, configs);
  const built = await buildPulledRecord(storage, folderMaps, configs, {
    collection: remote.collection,
    id: conflict.id,
    path: remote.path,
  }, content, Date.now());
  if (!built) {
    // The content is readable but not representable as a local record (a
    // foreign file whose payload id disagrees with its path). Adopting
    // nothing while still pinning the baseline would silently invert the
    // user's choice in the next round (overwrite / delete the file they
    // chose "remote" for) — skip instead, like the pull path does: the
    // conflict stays open and the next round re-reports fresh content.
    return { applied: false, pushed: [], pulled: [] };
  }
  await store(storage.write(built.collection, built.record));
  await writeSnapshotEntry(storage, saved, {
    collection,
    id,
    path: remote.path,
    hash: remote.hash,
    rev: remote.rev ?? null,
  }, { collection, id, path: remote.path });
  return { applied: true, pushed: [], pulled: [{ collection: built.collection, id: built.record.id, path: remote.path }] };
}

export {
  applyLocalResolution,
  applyRemoteResolution,
  applyRoundPlan,
  captureRoundPlan,
  finalizeRound,
};
