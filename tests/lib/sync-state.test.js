// Verifies local persistence helpers over the shared memory fake.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearError,
  mergeRoundSnapshot,
  migrateSnapshot,
  publish,
  readScopeForResolve,
  recordError,
  rememberScope,
  requireBackend,
  stampSyncedAt,
  writeSnapshotEntry,
} from '../../lib/sync-state.js';
import { requireStorage } from '../../lib/sync-store.js';
import { memoryStorage } from './fake-storage.js';

const SCOPE = [{ collection: 'docs', serializer: 'markdown', idField: 'id', updatedAtField: 'updatedAt', titleField: 'title', contentField: 'content', ignore: [], folders: null }];

test('should_guard_storage_access_when_called', async () => {
  const failing = { async read() { throw new Error('down'); } };
  const missing = (() => {
    try {
      requireStorage({ storage: null });
    } catch (caught) {
      return caught;
    }
    return null;
  })();
  assert.equal(missing?.code, 'SYNC_STORAGE_UNAVAILABLE');
  const broken = await requireBackend({ storage: failing }).catch((caught) => caught);
  assert.equal(broken?.code, 'SYNC_STORAGE_UNAVAILABLE');
  const fresh = await requireBackend({ storage: memoryStorage() }).catch((caught) => caught);
  assert.equal(fresh?.code, 'SYNC_NOT_CONFIGURED');
});

test('should_remember_scope_and_resolve_it_when_stored', async () => {
  const storage = memoryStorage();
  await rememberScope(storage, SCOPE);
  const resolved = await readScopeForResolve(storage);
  assert.equal(resolved[0].basePath, '');
  assert.equal(resolved[0].serializer, 'markdown');
  const empty = await readScopeForResolve(memoryStorage()).catch((caught) => caught);
  assert.equal(empty?.code, 'SYNC_INVALID_CONFIG');
});

test('should_merge_round_outcomes_into_the_baseline_when_completed', async () => {
  const storage = memoryStorage();
  await storage.write('sync_state', {
    id: 'active',
    snapshot: [
      { collection: 'docs', id: 'keep', path: 'keep.md', hash: 'h0', rev: 'r0' },
      { collection: 'docs', id: 'gone', path: 'gone.md', hash: 'h1', rev: 'r1' },
      { collection: 'docs', id: 'displaced', path: 'new.md', hash: 'h4', rev: 'r4' },
    ],
  });
  await mergeRoundSnapshot(storage, {
    pushed: [{ collection: 'docs', id: 'new', path: 'new.md', hash: 'h2', rev: 'r2' }],
    pulled: [{ collection: 'docs', id: 'keep', path: 'keep.md', hash: 'h3', rev: 'r3' }],
    deleteRemote: [{ collection: 'docs', id: 'gone', path: 'gone.md' }],
    deleteLocal: [],
  });
  const saved = await storage.read('sync_state', 'active');
  assert.deepEqual(saved.snapshot.map(({ path, hash, rev }) => [path, hash, rev]), [
    ['new.md', 'h2', 'r2'],
    ['keep.md', 'h3', 'r3'],
  ]);
  assert.equal(typeof saved.lastSyncAt, 'number');
});

test('should_stamp_synced_at_without_touching_the_baseline_when_the_round_settles', async () => {
  const storage = memoryStorage();
  await storage.write('sync_state', {
    id: 'active',
    snapshot: [{ collection: 'docs', id: 'd1', path: 'a.md', hash: 'h', rev: null }],
  });
  await stampSyncedAt(storage);
  const saved = await storage.read('sync_state', 'active');
  assert.equal(saved.snapshot.length, 1);
  assert.equal(typeof saved.lastSyncAt, 'number');
});

test('should_migrate_legacy_snapshots_from_manifest_hashes_when_seeded', async () => {
  const storage = memoryStorage();
  const legacy = [
    { collection: 'docs', id: 'd1', updatedAt: 1, path: 'a.md' },
    { collection: 'docs', id: 'd2', updatedAt: 2, path: 'b.md' },
  ];
  await storage.write('sync_state', { id: 'active', snapshot: legacy });
  const { snapshot } = await migrateSnapshot(storage, legacy, [
    { collection: 'docs', id: 'd1', path: 'a.md', hash: 'seeded' },
    { collection: 'docs', id: 'other', path: 'c.md', hash: 'foreign' },
  ]);
  assert.deepEqual(snapshot[0], { collection: 'docs', id: 'd1', path: 'a.md', hash: 'seeded', rev: null });
  assert.deepEqual(snapshot[1], { collection: 'docs', id: 'd2', path: 'b.md', hash: null, rev: null });
  const persisted = await storage.read('sync_state', 'active');
  assert.deepEqual(persisted.snapshot, snapshot);
  // Already-versioned entries pass through unchanged.
  const v2 = [{ collection: 'docs', id: 'd1', path: 'a.md', hash: 'h', rev: 'r' }];
  const { snapshot: untouched } = await migrateSnapshot(storage, v2, []);
  assert.deepEqual(untouched, v2);
  // Malformed entries drop instead of haunting the plan.
  const { snapshot: cleaned } = await migrateSnapshot(storage, [null, { collection: 'docs', id: 'x' }], []);
  assert.deepEqual(cleaned, []);
  // Fully-versioned snapshots (even after two passes) never rewrite.
  const { seeded: secondRun } = await migrateSnapshot(storage, v2, []);
  assert.equal(secondRun, false);
});

test('should_upsert_and_drop_snapshot_entries_when_written', async () => {
  const storage = memoryStorage();
  const saved = {};
  const first = { collection: 'docs', id: 'd1', path: 'a.md', hash: 'h', rev: null };
  await writeSnapshotEntry(storage, saved, first, null);
  await writeSnapshotEntry(storage, await storage.read('sync_state', 'active'), { ...first, hash: 'h2' }, null);
  await writeSnapshotEntry(storage, await storage.read('sync_state', 'active'), null, { collection: 'docs', id: 'd1' });
  assert.deepEqual((await storage.read('sync_state', 'active')).snapshot, []);
});

test('should_drop_stale_path_owner_when_resolution_pins_a_winner', async () => {
  const storage = memoryStorage();
  const saved = {};
  await writeSnapshotEntry(storage, saved, { collection: 'docs', id: 'old', path: 'a.md', hash: 'h0', rev: null }, null);
  // A takeover resolution pins the new owner; the displaced entry must go,
  // or the same conflict re-fires on the next round.
  await writeSnapshotEntry(
    storage,
    await storage.read('sync_state', 'active'),
    { collection: 'docs', id: 'new', path: 'a.md', hash: 'h1', rev: null },
    { collection: 'docs', id: 'new', path: 'a.md' },
  );
  assert.deepEqual((await storage.read('sync_state', 'active')).snapshot, [
    { collection: 'docs', id: 'new', path: 'a.md', hash: 'h1', rev: null },
  ]);
});

test('should_record_and_clear_errors_without_bus_when_called', async () => {
  const storage = memoryStorage();
  const events = { calls: [], publish(type, data) { this.calls.push({ type, data }); } };
  await recordError(storage, { code: 'SYNC_X', message: 'boom' });
  assert.equal((await storage.read('sync_state', 'active')).lastError.code, 'SYNC_X');
  publish({ storage, events: null }, 'sync:changed', {});
  publish({ storage, events }, 'sync:changed', { ok: true });
  assert.deepEqual(events.calls, [{ type: 'sync:changed', data: { ok: true } }]);
  await clearError(storage);
  assert.equal((await storage.read('sync_state', 'active')).lastError, null);
});
