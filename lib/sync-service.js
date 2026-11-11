// pey.sync service: manual backend-neutral sync of storage collections.
//
// Local storage stays the source of truth; the remote is a mirror. Each
// syncNow round captures local state plus the remote listing, plans
// purely, applies, then advances the path-keyed snapshot only on clean
// completion — a partial failure simply retries from the same snapshot
// (all remote operations are idempotent).
//
// Thin assembly over focused modules: scope (validation/shaping), paths,
// collect, remote, round, backend, state. Method bodies orchestrate;
// decisions live in the modules.
import { syncError } from './error.js';
import { collectLocal, withoutIgnored } from './sync-collect.js';
import { snapshotDiff } from './sync-engine.js';
import { extensionsOf, normalizeScope } from './sync-scope.js';
import { descriptorFor, instantiateBackend, mapAdapterError } from './sync-backend.js';
import {
  PROMPTED_CONFLICTS_ID,
  BACKENDS_COLLECTION,
  BACKEND_ID,
  SERVICE_NAME,
  STATE_COLLECTION,
  clearError,
  identityOf,
  mergeRoundSnapshot,
  publish,
  readPromptedConflicts,
  readScopeForResolve,
  recordError,
  reconcileBackendIdentity,
  requireBackend,
  stampSyncedAt,
  writePromptedConflicts,
} from './sync-state.js';
import { requireStorage, store } from './sync-store.js';
import {
  applyLocalResolution,
  applyRemoteResolution,
  applyRoundPlan,
  captureRoundPlan,
  finalizeRound,
} from './sync-round.js';

// Custom commit messages cap at GitHub-practical length; longer input
// truncates instead of failing a whole run over prose.
const SYNC_MESSAGE_MAX = 200;

/**
 * Normalizes the optional custom commit message of one run: trimmed, capped;
 * empty or non-string input means "use the automatic messages".
 * @param {unknown} raw Sync envelope message.
 * @returns {string|null} Message for the round, or null for auto.
 */
function syncMessageOf(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim().slice(0, SYNC_MESSAGE_MAX);
  return text.length > 0 ? text : null;
}

/**
 * Creates the service closing over activation-bound references.
 * @param {object} state References ({ storage, events, fetchFn? }).
 * @returns {object} Service implementation.
 */
function createService(state) {
  const api = {
    async configureBackend(input = {}) {
      const source = input && typeof input === 'object' ? input : {};
      const kind = source.kind;
      const params = source.params && typeof source.params === 'object' ? source.params : {};
      requireStorage(state);
      const descriptor = descriptorFor(state, kind);
      let backend = null;
      let normalized = params;
      try {
        // Echo and storage mirror what the backend will actually use: the
        // descriptor may normalize params (e.g. the gitlab base URL).
        normalized = typeof descriptor.normalizeParams === 'function'
          ? descriptor.normalizeParams(params)
          : params;
        backend = descriptor.create({ kind, ...params }, state.fetchFn ?? globalThis.fetch);
        await backend.open();
      } catch (error) {
        if (error?.code && String(error.code).startsWith('SYNC_')) {
          throw error;
        }
        const mapped = mapAdapterError(descriptor, error);
        try {
          const storage = requireStorage(state);
          await recordError(storage, mapped);
        } catch {
          // Storage outage already reported by its own code path below.
        }
        throw mapped;
      }
      const storage = requireStorage(state);
      const stored = {
        id: BACKEND_ID,
        kind,
        repo: normalized.repo ?? null,
        branch: normalized.branch ?? null,
        token: normalized.token ?? null,
        baseUrl: normalized.baseUrl ?? null,
        updatedAt: Date.now(),
      };
      await store(storage.write(BACKENDS_COLLECTION, stored));
      return { ok: true, kind, repo: stored.repo, branch: stored.branch, baseUrl: stored.baseUrl };
    },

    async removeBackend() {
      const storage = requireStorage(state);
      await store(storage.delete(BACKENDS_COLLECTION, BACKEND_ID));
      await store(storage.delete(STATE_COLLECTION, BACKEND_ID));
      // The prompt pins belong to the removed destination: leaving them
      // would let a later backend accept a resolution for a conflict that
      // was never prompted on IT (the guard trusts presence in the list).
      await store(storage.delete(STATE_COLLECTION, PROMPTED_CONFLICTS_ID));
      return { ok: true };
    },

    async getStatus() {
      const storage = requireStorage(state);
      const backend = await store(storage.read(BACKENDS_COLLECTION, BACKEND_ID));
      const saved = await store(storage.read(STATE_COLLECTION, BACKEND_ID));
      if (!backend) {
        return { configured: false, lastSyncAt: null, lastError: null };
      }
      return {
        configured: true,
        kind: backend.kind,
        repo: backend.repo ?? null,
        branch: backend.branch ?? null,
        baseUrl: backend.baseUrl ?? null,
        lastSyncAt: saved?.lastSyncAt ?? null,
        lastError: saved?.lastError ?? null,
      };
    },

    async hasPendingChanges(input = {}) {
      // Local-only preflight for the dirty dot: the same hash comparison
      // the next syncNow would run, but never any network. Unconfigured
      // means nothing can be pending, never an error.
      const configs = normalizeScope(input?.scope);
      const storage = requireStorage(state);
      const backend = await store(storage.read(BACKENDS_COLLECTION, BACKEND_ID));
      if (!backend) {
        return { pending: false };
      }
      const local = await collectLocal(storage, configs);
      const saved = (await store(storage.read(STATE_COLLECTION, BACKEND_ID))) ?? {};
      const rawSnapshot = Array.isArray(saved.snapshot) ? saved.snapshot : [];
      const snapshot = withoutIgnored(rawSnapshot, configs, local.folderIgnores, extensionsOf(configs));
      const diff = snapshotDiff(snapshot, local.entries);
      return {
        pending: diff.created.length > 0
          || diff.changed.length > 0
          || diff.deleted.length > 0,
      };
    },

    async syncNow(input = {}) {
      const configs = normalizeScope(input?.scope);
      const { backend, storage } = await requireBackend(state);
      // A changed destination starts from a fresh baseline: its emptiness is
      // a first sync, never "everything was remotely deleted".
      await reconcileBackendIdentity(storage, backend);
      const { adapter, descriptor } = instantiateMapped(state, backend);
      const round = buildRound(state, storage, configs, adapter, descriptor, syncMessageOf(input?.message));
      const fail = async (error) => {
        try {
          await recordError(storage, error);
        } catch {
          // Recording the failure must never mask the original one.
        }
        publish(state, 'sync:changed', {
          pushed: round.report.pushed,
          pulled: round.report.pulled,
          conflicts: round.report.conflicts.map((conflict) => ({ collection: conflict.collection, id: conflict.id })),
        });
        throw error;
      };
      try {
        const context = await captureRoundPlan(round);
        await applyRoundPlan(round, context);
        return await finalizeRound(state, storage, adapter, configs, context, round.report);
      } catch (error) {
        if (error?.code && String(error.code).startsWith('SYNC_')) {
          return fail(error);
        }
        return fail(mapAdapterError(descriptor, error));
      }
    },

    async resolveConflict(input = {}) {
      const source = input && typeof input === 'object' ? input : {};
      const { collection, id, choice } = source;
      if (typeof collection !== 'string' || typeof id !== 'string' || (choice !== 'local' && choice !== 'remote')) {
        throw syncError('SYNC_INVALID_CONFIG', 'Conflict resolution needs collection, id and local|remote', {});
      }
      const { backend, storage } = await requireBackend(state);
      await reconcileBackendIdentity(storage, backend);
      const { adapter, descriptor } = instantiateMapped(state, backend);
      const configs = await readScopeForResolve(storage);
      const round = buildRound(state, storage, configs, adapter, descriptor);
      // A failed resolution is a run failure like a failed sync: it lands
      // in lastError and reaches the bus as a partial sync:changed, so a
      // half-applied resolution never goes unreported.
      const fail = async (error) => {
        try {
          await recordError(storage, error);
        } catch {
          // Recording the failure must never mask the original one.
        }
        publish(state, 'sync:changed', {
          pushed: [],
          pulled: [],
          conflicts: context?.plan?.conflicts?.map((item) => ({ collection: item.collection, id: item.id })) ?? [],
        });
        throw error;
      };
      let context;
      try {
        context = await captureRoundPlan(round).catch((error) => {
          if (error?.code && String(error.code).startsWith('SYNC_')) {
            throw error;
          }
          throw mapAdapterError(descriptor, error);
        });
        const matching = context.plan.conflicts.filter((item) => item.collection === collection && item.id === id);
        if (matching.length === 0) {
          throw syncError('SYNC_INVALID_CONFIG', 'No pending conflict for that record', { collection, id });
        }
        if (matching.length > 1) {
          // Two open conflicts sharing one (collection, id) — the record-
          // rename twin (a rename onto an occupied path while the old
          // path's remote was edited) — are not addressable by the
          // documented prompt shape: the host saw two prompts with ONE id
          // and cannot answer them apart. Refuse instead of silently
          // resolving the first one and clearing both (the twin's unseen
          // remote content would die and the round would report complete);
          // the ambiguity clears by itself once the record stops claiming
          // both paths, and the next round re-asks.
          throw syncError('SYNC_INVALID_CONFIG', 'Multiple open conflicts share this collection and id; the ambiguity must clear first (for example the record stops claiming both paths)', { collection, id, count: matching.length });
        }
        const conflict = matching[0];
        let outcome = { applied: true, pushed: [], pulled: [] };
        // The prompt→resolve guard, FAIL-CLOSED, on every branch that
        // destroys remote content: the host may only decide on content a
        // conflict report actually showed it — absence from the pin list
        // means the conflict was never presented (it came to life in this
        // resolve's own capture), and a hash mismatch means the pinned
        // remote changed after the prompt. Both are refused with
        // `applied: false` and the next round re-asks with a fresh prompt.
        // All three destructive shapes run it: the remote resolution, the
        // local choice's deletion branch (delete-vs-change) AND its push
        // branch (overwriting the remote file with the local content — the
        // unseen new remote content would die just the same).
        const pinned = (await readPromptedConflicts(storage)).find((item) => item.collection === collection && item.id === id);
        const remoteHashChanged = (pinned?.remoteHash ?? null) !== (conflict.remote?.hash ?? null);
        const deletionOfShownRemote = choice === 'local' && !conflict.local && conflict.remote;
        const guardFailed = !pinned || remoteHashChanged;
        if (guardFailed && (choice === 'remote' || deletionOfShownRemote || (choice === 'local' && conflict.local))) {
          outcome = { applied: false, pushed: [], pulled: [] };
        } else if (choice === 'local') {
          outcome = await applyLocalResolution(round, context, conflict);
        } else {
          // The remote resolution re-checks the local record first (CAS):
          // when the host edited it mid-window the resolution is skipped
          // and the conflict stays open for another prompt.
          outcome = await applyRemoteResolution(round, context, conflict, collection, id);
        }
        if (outcome.applied) {
          // The resolved conflict's anchor leaves with it; other open
          // conflicts keep their prompt-time pins.
          const rest = (await readPromptedConflicts(storage))
            .filter((item) => !(item.collection === collection && item.id === id));
          await writePromptedConflicts(storage, rest);
        }
        // The event carries the real open set: this resolution clears at
        // most its own conflict; the plan's other conflicts stay pending.
        const openConflicts = context.plan.conflicts
          .filter((item) => !(outcome.applied && item.collection === collection && item.id === id))
          .map((item) => ({ collection: item.collection, id: item.id }));
        const remaining = openConflicts.length;
        if (outcome.applied && remaining === 0) {
          // The resolution pinned its own baseline entry; only the clock moves.
          await stampSyncedAt(storage);
          await clearError(storage);
        }
        // The event items carry the documented `{ collection, id }` shape —
        // the internal `path` bookkeeping of resolution outcomes stays out.
        const toEventItems = (items) => items.map(({ collection: itemCollection, id: itemId }) => ({ collection: itemCollection, id: itemId }));
        publish(state, 'sync:changed', {
          pushed: toEventItems(outcome.pushed),
          pulled: toEventItems(outcome.pulled),
          conflicts: openConflicts,
        });
        return { remaining };
      } catch (error) {
        if (error?.code && String(error.code).startsWith('SYNC_')) {
          return fail(error);
        }
        return fail(mapAdapterError(descriptor, error));
      }
    },
  };

  // Mutating operations run single-flight: overlapping syncNow /
  // resolveConflict / configure / remove calls reject with
  // SYNC_IN_PROGRESS instead of interleaving storage and remote writes.
  let inFlight = null;
  async function runExclusive(operation) {
    if (inFlight) {
      throw syncError('SYNC_IN_PROGRESS', 'Another sync operation is already running', {});
    }
    inFlight = Promise.resolve(operation()).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  const service = {
    configureBackend: (input) => runExclusive(() => api.configureBackend(input)),
    removeBackend: () => runExclusive(() => api.removeBackend()),
    getStatus: (input) => api.getStatus(input),
    hasPendingChanges: (input) => api.hasPendingChanges(input),
    syncNow: (input) => runExclusive(() => api.syncNow(input)),
    resolveConflict: (input) => runExclusive(() => api.resolveConflict(input)),
  };
  return service;
}

/**
 * Instantiates the stored backend inside the error-mapping boundary, so a
 * factory failure (e.g. an invalid stored baseUrl) surfaces as a mapped
 * structured sync error instead of a raw coded error.
 * @param {object} state Activation state.
 * @param {object} backend Stored backend record.
 * @returns {object} `{ adapter, descriptor }`.
 * @throws {object} Mapped structured sync error.
 */
function instantiateMapped(state, backend) {
  const descriptor = descriptorFor(state, backend?.kind);
  try {
    return instantiateBackend(state, backend);
  } catch (error) {
    throw mapAdapterError(descriptor, error);
  }
}

/**
 * Assembles a fresh round context (mutable report included).
 * @param {object} state Activation state.
 * @param {object} storage Storage service.
 * @param {Array} configs Normalized scope.
 * @param {object} adapter Backend adapter.
 * @param {object} descriptor Backend descriptor.
 * @param {string|null} [message] Custom commit message for this run's
 *   remote writes and deletes, or null for the backend's own defaults.
 * @returns {object} Round context.
 */
function buildRound(state, storage, configs, adapter, descriptor, message = null) {
  return {
    state,
    storage,
    configs,
    adapter,
    descriptor,
    message,
    failMapped: (error) => {
      throw mapAdapterError(descriptor, error);
    },
    report: {
      pushed: [],
      pulled: [],
      deletedRemote: [],
      deleteLocal: [],
      relocated: [],
      skipped: [],
      conflicts: [],
      completed: false,
    },
  };
}

export {
  BACKENDS_COLLECTION,
  SERVICE_NAME,
  STATE_COLLECTION,
  createService,
};
