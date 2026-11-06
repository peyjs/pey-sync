// Tests for lib/sync-round.js — single-record conflict resolution (with the
// CAS guard against mid-window host edits) and round finalization events.
// Fake storage + fake adapter; no network.

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRemoteResolution, finalizeRound } from '../../lib/sync-round.js';
import { normalizeScope } from '../../lib/sync-scope.js';
import { memoryStorage } from './fake-storage.js';

const SCOPE = {
  collections: [
    { collection: 'docs', serializer: 'markdown', titleField: 'title' },
  ],
};

function makeContext({ heldRecord = null, storedRecord = null, contents = new Map() } = {}) {
  const byKey = new Map();
  if (heldRecord) {
    byKey.set(`docs::${heldRecord.id}`, { record: heldRecord });
  }
  const storage = memoryStorage({ docs: storedRecord ? [storedRecord] : [] });
  return {
    storage,
    context: {
      local: { byKey },
      contents,
      revs: new Map(),
      snapshot: [],
      plan: { conflicts: [], push: [], pull: [], deleteRemote: [], deleteLocal: [] },
      listing: { legacyManifestRecords: null },
    },
  };
}

function makeRound(storage, bus) {
  return {
    storage,
    configs: normalizeScope(SCOPE),
    adapter: {
      async readFile() {
        return null;
      },
      async deleteFile() {
        return { ok: true };
      },
      async writeFile() {
        return { rev: 'rev-1' };
      },
    },
    descriptor: { errorMap: {} },
    message: null,
    failMapped: (error) => {
      throw error;
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
    state: { events: bus },
  };
}

test('should_delete_local_record_when_remote_side_of_conflict_is_the_deletion', async () => {
  const { storage, context } = makeContext({
    heldRecord: { id: 'd1', title: 'a', content: 'نسخه من', updatedAt: 1 },
    storedRecord: { id: 'd1', title: 'a', content: 'نسخه من', updatedAt: 1 },
  });
  const round = makeRound(storage, { publish() {} });

  const applied = await applyRemoteResolution(round, context, {
    collection: 'docs',
    id: 'd1',
    local: context.local.byKey.get('docs::d1').record,
    remote: null,
  }, 'docs', 'd1');

  assert.equal(applied.applied, true);
  assert.equal(await storage.read('docs', 'd1'), null, 'the deletion must reach the record');
});

test('should_skip_remote_resolution_when_host_edited_the_record_mid_window', async () => {
  const { storage, context } = makeContext({
    heldRecord: { id: 'd1', title: 'a', content: 'نسخه زمان برنامه', updatedAt: 1 },
    storedRecord: { id: 'd1', title: 'a', content: 'ویرایش تازه میزبان', updatedAt: 2 },
  });
  const round = makeRound(storage, { publish() {} });

  const applied = await applyRemoteResolution(round, context, {
    collection: 'docs',
    id: 'd1',
    local: context.local.byKey.get('docs::d1').record,
    remote: null,
  }, 'docs', 'd1');

  assert.equal(applied.applied, false, 'the CAS guard must keep the conflict open');
  const kept = await storage.read('docs', 'd1');
  assert.equal(kept.content, 'ویرایش تازه میزبان', 'the host edit must survive untouched');
  assert.deepEqual(context.snapshot, [], 'no baseline may be pinned on a skipped resolution');
});

test('should_adopt_remote_content_when_resolution_chooses_the_remote_side', async () => {
  const { storage, context } = makeContext({
    heldRecord: { id: 'd1', title: 'a', content: 'نسخه من', updatedAt: 1 },
    storedRecord: { id: 'd1', title: 'a', content: 'نسخه من', updatedAt: 1 },
    contents: new Map([['docs/d1.md', 'متن ریموت']]),
  });
  const round = makeRound(storage, { publish() {} });

  const applied = await applyRemoteResolution(round, context, {
    collection: 'docs',
    id: 'd1',
    local: context.local.byKey.get('docs::d1').record,
    remote: { collection: 'docs', path: 'docs/d1.md', hash: 'abcd1234', rev: 'rev-remote' },
  }, 'docs', 'd1');

  assert.equal(applied.applied, true);
  assert.deepEqual(applied.pulled, [{ collection: 'docs', id: 'd1', path: 'docs/d1.md' }], 'the adoption is reported for the bus');
  const adopted = await storage.read('docs', 'd1');
  assert.equal(adopted.content, 'متن ریموت');
  // The resolution pins its own baseline entry in the persisted snapshot.
  const saved = await storage.read('sync_state', 'active');
  assert.equal(saved.snapshot.length, 1);
  assert.equal(saved.snapshot[0].path, 'docs/d1.md');
  assert.equal(saved.snapshot[0].hash, 'abcd1234');
});

test('should_skip_adoption_when_host_recreated_the_record_mid_window', async () => {
  // Plan-time the record was locally deleted (held: none); a mid-window
  // re-creation must not be silently overwritten by the adoption.
  const { storage, context } = makeContext({
    storedRecord: { id: 'd1', title: 'a', content: 'بازآفرینی میزبان', updatedAt: 2 },
  });
  const round = makeRound(storage, { publish() {} });

  const applied = await applyRemoteResolution(round, context, {
    collection: 'docs',
    id: 'd1',
    local: null,
    remote: { collection: 'docs', path: 'docs/d1.md', hash: 'abcd1234', rev: 'rev-remote' },
  }, 'docs', 'd1');

  assert.equal(applied.applied, false);
  const kept = await storage.read('docs', 'd1');
  assert.equal(kept.content, 'بازآفرینی میزبان');
});

test('should_publish_changed_always_and_conflicted_only_when_conflicts_remain', async () => {
  const seen = [];
  const bus = { publish: (type, data) => seen.push({ type, data }) };
  const storage = memoryStorage();
  const round = makeRound(storage, bus);
  const context = {
    plan: { conflicts: [{ collection: 'docs', id: 'd1', local: null, remote: null }] },
    outcomes: { pushed: [], pulled: [], deleteRemote: [], deleteLocal: [] },
    listing: { legacyManifestRecords: null },
  };

  await finalizeRound(round.state, storage, round.adapter, round.configs, context, round.report);
  assert.deepEqual(seen.map((event) => event.type), ['sync:changed', 'sync:conflicted']);

  seen.length = 0;
  context.plan.conflicts = [];
  await finalizeRound(round.state, storage, round.adapter, round.configs, context, round.report);
  assert.deepEqual(seen.map((event) => event.type), ['sync:changed'], 'a clean round publishes no conflicted event');
  assert.equal(round.report.completed, true);
});
