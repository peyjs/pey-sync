// Verifies the sync service: fake storage, fake GitHub over injected
// fetch, recording event bus. Never the network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { hashRecord } from '../../lib/sync-engine.js';
import { createService } from '../../lib/sync-service.js';
import { memoryStorage } from './fake-storage.js';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decode(payload) {
  return Buffer.from(String(payload ?? '').replace(/\s/g, ''), 'base64').toString('utf8');
}

function fakeGitHub({ files = {}, failOpen = null } = {}) {
  const store = new Map(Object.entries(files));
  let revCounter = 0;
  const calls = [];
  const ok = (payload) => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => payload });
  const fail = (status) => ({ status, ok: false, headers: { get: () => null }, json: async () => ({}) });
  const listDirectory = (prefix) => {
    const seen = new Map();
    for (const [key, file] of store) {
      if (prefix !== '' && key !== prefix && !key.startsWith(`${prefix}/`)) {
        continue;
      }
      const rest = prefix === '' ? key : key.slice(prefix.length + 1);
      if (rest === '') {
        continue;
      }
      const slash = rest.indexOf('/');
      if (slash < 0) {
        seen.set(key, { path: key, type: 'file', sha: file.rev });
      } else {
        const dir = prefix === '' ? rest.slice(0, slash) : `${prefix}/${rest.slice(0, slash)}`;
        seen.set(dir, { path: dir, type: 'dir', sha: null });
      }
    }
    return [...seen.values()];
  };
  const fetchFn = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ method, url, body: options.body });
    if (url.includes('/repos/u/r') && !url.includes('/contents') && !url.includes('/branches')) {
      if (failOpen) {
        throw failOpen;
      }
      return ok({});
    }
    if (url.includes('/branches/')) {
      return ok({});
    }
    const match = url.match(/\/contents\/?(.*?)(\?.*)?$/);
    const path = decodeURIComponent(match?.[1] ?? '');
    if (method === 'PUT') {
      const body = JSON.parse(options.body);
      const hit = store.get(path);
      if (body.sha !== undefined && hit && hit.rev !== body.sha) {
        return fail(409);
      }
      if (body.sha === undefined && hit) {
        return fail(422);
      }
      const rev = `rev-${++revCounter}`;
      store.set(path, { content: body.content, rev });
      return { status: 201, ok: true, headers: { get: () => null }, json: async () => ({ content: { sha: rev } }) };
    }
    if (method === 'DELETE') {
      store.delete(path);
      return ok({});
    }
    if (store.has(path)) {
      const hit = store.get(path);
      return ok({ sha: hit.rev, content: hit.content });
    }
    const children = listDirectory(path);
    if (children.length > 0) {
      return ok(children);
    }
    return fail(404);
  };
  return {
    fetchFn,
    calls,
    reads: () => calls.filter((call) => call.method === 'GET' && call.url.includes('/contents/')),
    writes: () => calls.filter((call) => call.method === 'PUT' || call.method === 'DELETE'),
    files: store,
  };
}

function events() {
  const seen = [];
  return {
    seen,
    publish(type, data) {
      seen.push({ type, data: JSON.parse(JSON.stringify(data)) });
    },
  };
}

const SCOPE = {
  collections: [
    {
      collection: 'docs',
      serializer: 'markdown',
      titleField: 'title',
      folders: { collection: 'folders', nameField: 'name' },
    },
  ],
};

const JSON_SCOPE = {
  collections: [{ collection: 'notes', serializer: 'json', idField: 'key', updatedAtField: 'mtime', contentField: 'text' }],
};

function setup({ storageData = {}, files = {}, eventsBus = events(), options = {} } = {}) {
  const storage = memoryStorage(storageData);
  const remote = fakeGitHub({ files, ...options });
  const service = createService({ storage, events: eventsBus, fetchFn: remote.fetchFn });
  return { service, storage, remote, events: eventsBus };
}

async function configure(service) {
  return service.configureBackend({
    kind: 'git',
    params: { repo: 'u/r', branch: 'main', token: 'tok' },
  });
}

test('should_store_redacted_backend_when_configured', async () => {
  const { service, storage } = setup();
  const result = await configure(service);
  assert.deepEqual(result, { ok: true, kind: 'git', repo: 'u/r', branch: 'main', baseUrl: null });
  const stored = await storage.read('sync_backends', 'active');
  assert.equal(stored.token, 'tok');
  assert.equal(JSON.stringify(result).includes('tok'), false);
});

test('should_store_and_echo_base_url_when_gitlab_configured', async () => {
  const storage = memoryStorage();
  const service = createService({
    storage,
    events: events(),
    fetchFn: async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) }),
  });
  const result = await service.configureBackend({
    kind: 'gitlab',
    params: { repo: 'u/r', branch: 'main', token: 'tok', baseUrl: 'https://git.self.test/' },
  });
  assert.deepEqual(result, { ok: true, kind: 'gitlab', repo: 'u/r', branch: 'main', baseUrl: 'https://git.self.test' });
  const stored = await storage.read('sync_backends', 'active');
  assert.equal(stored.kind, 'gitlab');
  assert.equal(stored.baseUrl, 'https://git.self.test');
  const status = await service.getStatus();
  assert.equal(status.kind, 'gitlab');
  assert.equal(status.baseUrl, 'https://git.self.test');
});

test('should_reject_unknown_backend_when_configured', async () => {
  const { service } = setup();
  const error = await service.configureBackend({ kind: 'ftp', params: {} }).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_INVALID_CONFIG');
});

test('should_map_auth_failure_when_configured', async () => {
  const storage = memoryStorage();
  const service = createService({
    storage,
    events: events(),
    fetchFn: async () => ({ status: 401, ok: false, headers: { get: () => null }, json: async () => ({}) }),
  });
  const error = await configure(service).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_AUTH_FAILED');
  assert.equal(await storage.read('sync_backends', 'active'), null);
});

test('should_report_unavailable_storage_when_configured', async () => {
  const service = createService({ storage: null, events: events(), fetchFn: async () => ({}) });
  const error = await configure(service).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_STORAGE_UNAVAILABLE');
});

test('should_clear_backend_when_removed', async () => {
  const { service, storage } = setup();
  await configure(service);
  assert.deepEqual(await service.removeBackend(), { ok: true });
  assert.equal(await storage.read('sync_backends', 'active'), null);
  assert.deepEqual(await service.removeBackend(), { ok: true });
});

test('should_report_unconfigured_status_when_fresh', async () => {
  const { service } = setup();
  assert.deepEqual(await service.getStatus(), { configured: false, lastSyncAt: null, lastError: null });
});

test('should_report_redacted_status_when_configured', async () => {
  const { service } = setup();
  await configure(service);
  const status = await service.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.kind, 'git');
  assert.equal(status.repo, 'u/r');
  assert.equal(JSON.stringify(status).includes('tok'), false);
});

test('should_report_no_pending_changes_when_unconfigured', async () => {
  const { service } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'سلام', folderId: null, updatedAt: 20 }],
    },
  });
  assert.deepEqual(await service.hasPendingChanges({ scope: SCOPE }), { pending: false });
});

test('should_report_pending_local_news_without_network_when_checked', async () => {
  const { service, remote } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'سلام', folderId: null, updatedAt: 20 }],
    },
  });
  await configure(service);
  const before = remote.calls.length;
  assert.deepEqual(await service.hasPendingChanges({ scope: SCOPE }), { pending: true });
  assert.equal(remote.calls.length, before, 'expected no network for the check');
});

test('should_report_clean_after_completed_sync_when_checked', async () => {
  const { service, remote } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'سلام', folderId: null, updatedAt: 20 }],
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
  const before = remote.calls.length;
  assert.deepEqual(await service.hasPendingChanges({ scope: SCOPE }), { pending: false });
  assert.equal(remote.calls.length, before, 'expected no network for the check');
});

test('should_push_everything_on_first_sync_when_synced', async () => {
  const { service, remote, events: bus } = setup({
    storageData: {
      folders: [{ id: 'f1', name: 'کار', parentId: null, updatedAt: 10 }],
      docs: [{ id: 'd1', title: 'یادداشت', content: 'سلام', folderId: 'f1', updatedAt: 20 }],
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
  assert.deepEqual(report.pushed.map((item) => item.id), ['d1']);
  assert.deepEqual(report.conflicts, []);
  assert.ok(remote.files.has('کار/یادداشت.md'));
  assert.equal(decode(remote.files.get('کار/یادداشت.md').content), 'سلام');
  const status = await service.getStatus();
  assert.equal(typeof status.lastSyncAt, 'number');
  assert.equal(status.lastError, null);
  assert.ok(bus.seen.some((event) => event.type === 'sync:changed' && event.data.pushed.length === 1));
  assert.ok(!bus.seen.some((event) => event.type === 'sync:conflicted'));
});

test('should_stamp_custom_message_on_this_runs_writes_when_supplied', async () => {
  const { service, remote } = setup({
    storageData: {
      folders: [{ id: 'f1', name: 'کار', parentId: null, updatedAt: 10 }],
      docs: [{ id: 'd1', title: 'یادداشت', content: 'سلام', folderId: 'f1', updatedAt: 20 }],
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE, message: 'پیام من' });
  assert.equal(report.completed, true);
  assert.ok(remote.files.has('کار/یادداشت.md'));
  const putBodies = remote.calls
    .filter((call) => call.method === 'PUT')
    .map((call) => JSON.parse(call.body));
  assert.ok(putBodies.length > 0);
  assert.ok(putBodies.every((body) => body.message === 'پیام من'));
});

test('should_keep_automatic_messages_when_no_custom_message_is_supplied', async () => {
  const { service, remote } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'سلام', folderId: null, updatedAt: 20 }],
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE, message: '   ' });
  assert.equal(report.completed, true);
  const putBodies = remote.calls
    .filter((call) => call.method === 'PUT')
    .map((call) => JSON.parse(call.body));
  assert.deepEqual(putBodies.map((body) => body.message), ['pey.sync write یادداشت.md']);
});

test('should_cap_long_custom_messages_instead_of_failing_when_an_error_message_exceeds_the_limit', async () => {
  const { service, remote } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'سلام', folderId: null, updatedAt: 20 }],
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE, message: 'ت'.repeat(300) });
  assert.equal(report.completed, true);
  const putBodies = remote.calls
    .filter((call) => call.method === 'PUT')
    .map((call) => JSON.parse(call.body));
  assert.equal(putBodies[0].message.length, 200);
});

test('should_rest_without_reads_or_writes_on_repeat_sync_when_synced', async () => {
  const { service, remote } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'سلام', folderId: null, updatedAt: 20 }],
    },
  });
  await configure(service);
  const first = await service.syncNow({ scope: SCOPE });
  assert.equal(first.completed, true);
  const second = await service.syncNow({ scope: SCOPE });
  assert.equal(second.completed, true);
  assert.deepEqual(second.pushed, []);
  assert.deepEqual(second.pulled, []);
  assert.equal(remote.writes().length, 1, 'expected only the first round to write');
  assert.equal(remote.reads().length, 2, 'expected root lists only, no per-file hash reads');
});

test('should_pull_remote_tree_when_synced', async () => {
  const { service, storage } = setup({
    files: {
      'کار/یادداشت.md': { content: Buffer.from('سلام از راه دور').toString('base64'), rev: 'd1' },
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
  assert.equal(report.pulled.length, 1);
  const docs = await storage.query('docs');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].content, 'سلام از راه دور');
  assert.equal(docs[0].title, 'یادداشت');
  const folders = await storage.query('folders');
  assert.equal(folders.length, 1);
  assert.equal(folders[0].name, 'کار');
  assert.equal(docs[0].folderId, folders[0].id);
});

test('should_mint_local_ids_for_new_remote_documents_when_pulled', async () => {
  const { service, storage } = setup({
    files: {
      'README.md': { content: Buffer.from('توضیح پروژه').toString('base64'), rev: 'r1' },
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
  assert.equal(report.pulled.length, 1);
  const docs = await storage.query('docs');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, 'README');
  assert.equal(typeof docs[0].id, 'string');
  assert.ok(docs[0].id.length > 0, 'expected a minted storage key for the pulled document');
  assert.deepEqual(await service.hasPendingChanges({ scope: SCOPE }), { pending: false });
  const second = await service.syncNow({ scope: SCOPE });
  assert.equal(second.completed, true);
  assert.deepEqual(second.pulled, []);
  assert.deepEqual(second.pushed, []);
});

test('should_pull_minting_folder_chain_when_synced', async () => {
  const { service, storage } = setup({
    storageData: {
      folders: [{ id: 'f2', name: 'پروژه', parentId: null, updatedAt: 1 }],
      docs: [{ id: 'd9', title: 'همسایه', content: 'x', folderId: 'f2', updatedAt: 2 }],
    },
    files: {
      'پروژه/ویسنامه.md': { content: Buffer.from('تازه').toString('base64'), rev: 'a1' },
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
  const docs = await storage.query('docs');
  const pulled = docs.find((record) => record.title === 'ویسنامه');
  const known = await storage.query('folders');
  const parent = known.find((record) => record.name === 'پروژه');
  assert.equal(pulled.folderId, parent?.id ?? null);
});

function scopeWithIgnore(patterns) {
  return {
    collections: [
      {
        collection: 'docs',
        serializer: 'markdown',
        titleField: 'title',
        folders: { collection: 'folders', nameField: 'name' },
        ignore: patterns,
      },
    ],
  };
}

test('should_skip_ignored_documents_and_folders_when_synced', async () => {
  const { service, remote } = setup({
    storageData: {
      folders: [{ id: 'f1', name: 'کار', parentId: null, updatedAt: 10 }],
      docs: [
        { id: 'd1', title: 'یادداشت', content: 'سلام', folderId: 'f1', updatedAt: 20 },
        { id: 'd2', title: 'پیش‌نویس', content: 'موقت', folderId: null, updatedAt: 20 },
      ],
    },
  });
  await configure(service);
  const scope = scopeWithIgnore(['پیش‌نویس', 'کار/']);
  const report = await service.syncNow({ scope });
  assert.equal(report.completed, true);
  assert.deepEqual(report.pushed, []);
  assert.deepEqual(report.pulled, []);
  assert.equal(remote.writes().length, 0, 'expected nothing pushed');
  assert.deepEqual(await service.hasPendingChanges({ scope }), { pending: false });
});

test('should_leave_ignored_remote_files_alone_when_synced', async () => {
  const { service, remote, events: bus } = setup({
    files: {
      'پیش‌نویس.md': { content: Buffer.from('متن').toString('base64'), rev: 'd1' },
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: scopeWithIgnore(['پیش‌نویس']) });
  assert.equal(report.completed, true);
  assert.deepEqual(report.pulled, []);
  assert.deepEqual(report.deletedRemote, []);
  assert.ok(remote.files.has('پیش‌نویس.md'), 'expected the ignored file untouched');
  assert.ok(bus.seen.some((event) => event.type === 'sync:changed' && event.data.conflicts.length === 0));
});

test('should_not_delete_previously_synced_when_ignored', async () => {
  const { service, remote, storage } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'سلام', folderId: null, updatedAt: 20 }],
    },
  });
  await configure(service);
  const first = await service.syncNow({ scope: SCOPE });
  assert.equal(first.completed, true);
  assert.ok(remote.files.has('یادداشت.md'));
  assert.ok(await storage.read('docs', 'd1'), 'expected the local doc alive');
  const second = await service.syncNow({ scope: scopeWithIgnore(['یادداشت']) });
  assert.equal(second.completed, true);
  assert.deepEqual(second.deletedRemote, []);
  assert.deepEqual(second.deleteLocal, []);
  assert.deepEqual(second.pushed, []);
  assert.ok(remote.files.has('یادداشت.md'), 'expected the ignored file kept');
  assert.ok(await storage.read('docs', 'd1'), 'expected the ignored doc kept');
  assert.deepEqual(await service.hasPendingChanges({ scope: scopeWithIgnore(['یادداشت']) }), { pending: false });
});

test('should_reject_bad_ignore_when_synced', async () => {
  const { service } = setup();
  await configure(service);
  const error = await service.syncNow({
    scope: { collections: [{ collection: 'docs', serializer: 'markdown', ignore: 'nope' }] },
  }).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_INVALID_CONFIG');
});

test('should_relocate_dangling_folder_links_when_synced', async () => {
  const { service, storage } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'متن', folderId: 'vanished', updatedAt: 20 }],
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
  assert.deepEqual(report.relocated.map((item) => [item.collection, item.id, item.path]), [
    ['docs', 'd1', 'یادداشت.md'],
  ]);
  const doc = await storage.read('docs', 'd1');
  assert.equal(doc.folderId, 'vanished', 'expected the link preserved, only the path moved');
});

test('should_propagate_deletes_both_ways_when_synced', async () => {
  const { service, storage, remote } = setup({
    storageData: {
      docs: [
        { id: 'keep', title: 'ماندنی', content: 'x', folderId: null, updatedAt: 20 },
        { id: 'gone-local', title: 'رفتنی', content: 'x', folderId: null, updatedAt: 20 },
      ],
    },
  });
  await configure(service);
  const first = await service.syncNow({ scope: SCOPE });
  assert.equal(first.completed, true);
  assert.ok(remote.files.has('رفتنی.md'));
  await storage.delete('docs', 'gone-local');
  const second = await service.syncNow({ scope: SCOPE });
  assert.ok(second.deletedRemote.some((item) => item.id === 'gone-local'));
  assert.ok(!remote.files.has('رفتنی.md'));
  remote.files.delete('ماندنی.md');
  const third = await service.syncNow({ scope: SCOPE });
  assert.ok(third.deleteLocal.some((item) => item.id === 'keep'));
  assert.equal(await storage.read('docs', 'keep'), null);
});

test('should_fail_on_local_path_collision_when_synced', async () => {
  const { service, remote, events: bus } = setup({
    storageData: {
      docs: [
        { id: 'd1', title: 'همسنگ', content: 'نخست', folderId: null, updatedAt: 1 },
        { id: 'd2', title: 'همسنگ', content: 'دوم', folderId: null, updatedAt: 1 },
      ],
    },
  });
  await configure(service);
  const error = await service.syncNow({ scope: SCOPE }).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_PATH_COLLISION');
  assert.deepEqual(remote.writes(), [], 'expected no remote touch while locals collide');
  const status = await service.getStatus();
  assert.equal(status.lastError?.code, 'SYNC_PATH_COLLISION');
  assert.ok(bus.seen.some((event) => event.type === 'sync:changed'));
});

test('should_tolerate_corrupt_legacy_manifest_when_synced', async () => {
  const { service, remote, storage } = setup({
    storageData: { docs: [{ id: 'd1', title: 'x', content: 'y', folderId: null, updatedAt: 1 }] },
    files: { 'sync-manifest.json': { content: Buffer.from('nope').toString('base64'), rev: 'm' } },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
  assert.ok(remote.files.has('sync-manifest.json'), 'expected an unreadable manifest left in place (never parsed, never swept)');
  assert.ok(await storage.read('docs', 'd1'));
});

test('should_migrate_legacy_state_and_clean_artifacts_when_synced', async () => {
  const legacyManifest = {
    version: 1,
    records: [
      { collection: 'docs', id: 'd1', path: 'یادداشت.md', updatedAt: 10, hash: hashRecord('محتوای قدیم'), title: 'یادداشت' },
      { collection: 'folders', id: 'f1', path: 'folders/f1.json', updatedAt: 1, hash: 'x', title: null },
    ],
  };
  const { service, remote } = setup({
    storageData: {
      'sync_state': [{ id: 'active', snapshot: [{ collection: 'docs', id: 'd1', path: 'یادداشت.md', updatedAt: 10 }] }],
      docs: [{ id: 'd1', title: 'یادداشت', content: 'محتوای تازه', folderId: null, updatedAt: 50 }],
    },
    files: {
      'sync-manifest.json': { content: Buffer.from(JSON.stringify(legacyManifest)).toString('base64'), rev: 'm1' },
      'یادداشت.md': { content: Buffer.from('محتوای قدیم').toString('base64'), rev: 'f1' },
      'folders/f1.json': { content: Buffer.from('{"id":"f1","name":"x"}').toString('base64'), rev: 'f2' },
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.pushed.map((item) => item.id), ['d1'], 'expected a seeded hash to read the local edit as a push');
  assert.equal(decode(remote.files.get('یادداشت.md').content), 'محتوای تازه');
  assert.ok(!remote.files.has('sync-manifest.json'), 'expected the legacy manifest swept');
  assert.ok(remote.files.has('folders/f1.json'), 'expected the stale folder file left in place (deletion trusts only the known manifest path)');
  assert.deepEqual(await service.hasPendingChanges({ scope: SCOPE }), { pending: false });
});

test('should_sync_custom_id_fields_when_synced', async () => {
  const { service, remote } = setup({
    storageData: { notes: [{ key: 'n1', text: 'hi', mtime: 5 }] },
  });
  await configure(service);
  const report = await service.syncNow({ scope: JSON_SCOPE });
  assert.equal(report.completed, true);
  assert.deepEqual(report.pushed.map((item) => item.id), ['n1']);
  assert.ok(remote.files.has('notes/n1.json'));
  assert.deepEqual(await service.hasPendingChanges({ scope: JSON_SCOPE }), { pending: false });
});

test('should_pull_json_records_when_synced', async () => {
  const { service, storage } = setup({
    files: {
      'notes/n1.json': {
        content: Buffer.from(JSON.stringify({ key: 'n1', text: 'سلام', mtime: 1 })).toString('base64'),
        rev: 'n1',
      },
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: JSON_SCOPE });
  assert.equal(report.completed, true);
  const record = await storage.read('notes', 'n1');
  assert.equal(record.text, 'سلام');
  assert.equal(typeof record.mtime, 'number');
});

test('should_skip_json_identity_mismatch_when_synced', async () => {
  const { service, storage } = setup({
    files: {
      'notes/wrongname.json': {
        content: Buffer.from(JSON.stringify({ key: ' kidnapper', text: 'x', mtime: 1 })).toString('base64'),
        rev: 'w1',
      },
    },
  });
  await configure(service);
  const report = await service.syncNow({ scope: JSON_SCOPE });
  assert.equal(report.completed, true);
  assert.deepEqual(report.pulled, []);
  assert.ok(report.skipped.some((item) => item.path === 'notes/wrongname.json'));
  assert.equal(await storage.read('notes', 'kidnapper'), null);
});

test('should_skip_idless_records_without_crashing_when_synced', async () => {
  const { service, remote } = setup({
    storageData: { docs: [{ title: 'بی‌شناسه', content: 'x', folderId: null, updatedAt: 1 }] },
  });
  await configure(service);
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
  assert.deepEqual(report.pushed, []);
  assert.ok(report.skipped.some((item) => item.collection === 'docs' && item.id === null));
  assert.equal(remote.writes().length, 0);
});

test('should_stop_on_conflict_when_synced', async () => {
  const { service, storage, remote, events: bus } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }],
    },
  });
  await configure(service);
  const first = await service.syncNow({ scope: SCOPE });
  assert.equal(first.completed, true);
  remote.files.set('یادداشت.md', {
    content: Buffer.from('نسخه طرف').toString('base64'),
    rev: 'd2',
  });
  await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'نسخه تازه من', folderId: null, updatedAt: 40 });
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].collection, 'docs');
  assert.equal(report.conflicts[0].id, 'd1');
  assert.equal(report.conflicts[0].local.content, 'نسخه تازه من');
  assert.equal(report.conflicts[0].remote.content, 'نسخه طرف');
  assert.ok(report.conflicts[0].title === undefined || typeof report.conflicts[0].title === 'string');
  assert.ok(bus.seen.some((event) => event.type === 'sync:conflicted'));
  assert.ok(await storage.read('docs', 'd1'), 'expected nothing deleted mid-conflict');
});

test('should_resolve_conflict_via_local_when_resolved', async () => {
  const { service, storage, remote } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }],
    },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت.md', {
    content: Buffer.from('نسخه طرف').toString('base64'),
    rev: 'd2',
  });
  await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'نسخه تازه من', folderId: null, updatedAt: 40 });
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  const resolved = await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'local' });
  assert.equal(resolved.remaining, 0);
  assert.equal(decode(remote.files.get('یادداشت.md').content), 'نسخه تازه من');
  assert.equal((await storage.read('docs', 'd1')).content, 'نسخه تازه من');
  const status = await service.getStatus();
  assert.equal(typeof status.lastSyncAt, 'number');
  assert.equal(status.lastError, null);
  const done = await service.syncNow({ scope: SCOPE });
  assert.equal(done.completed, true);
  assert.deepEqual(done.conflicts, []);
});

test('should_resolve_conflict_via_remote_when_resolved', async () => {
  const { service, storage, remote } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }],
    },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت.md', {
    content: Buffer.from('نسخه طرف').toString('base64'),
    rev: 'd2',
  });
  await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'نسخه تازه من', folderId: null, updatedAt: 40 });
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  const resolved = await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'remote' });
  assert.equal(resolved.remaining, 0);
  assert.equal((await storage.read('docs', 'd1')).content, 'نسخه طرف');
  assert.equal(typeof (await service.getStatus()).lastSyncAt, 'number');
  const done = await service.syncNow({ scope: SCOPE });
  assert.equal(done.completed, true);
});

test('should_apply_remote_deletion_when_delete_conflict_resolves_remote', async () => {
  // Delete-vs-change conflict: choosing the remote side adopts the
  // deletion — the local record must go, not survive to be pushed again.
  const { service, storage, remote } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }],
    },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.delete('یادداشت.md');
  await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'نسخه تازه من', folderId: null, updatedAt: 40 });
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  assert.deepEqual(report.conflicts.map((item) => item.id), ['d1']);
  const resolved = await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'remote' });
  assert.equal(resolved.remaining, 0);
  assert.equal(await storage.read('docs', 'd1'), null);
  const done = await service.syncNow({ scope: SCOPE });
  assert.equal(done.completed, true);
  assert.deepEqual(done.pushed, []);
});


test('should_fail_with_remote_invalid_when_remote_json_is_corrupt', async () => {
  // F3: a corrupt remote file must block the round, never read as
  // "remotely deleted".
  const { service, storage, remote } = setup({
    storageData: { notes: [{ key: 'n1', text: 'نسخه محلی', mtime: 10 }] },
  });
  await configure(service);
  await service.syncNow({ scope: JSON_SCOPE });
  remote.files.set('notes/n1.json', { content: Buffer.from('invalid json').toString('base64'), rev: 'r2' });
  const report = await service.syncNow({ scope: JSON_SCOPE }).catch((caught) => caught);
  assert.equal(report?.code, 'SYNC_REMOTE_INVALID');
  assert.equal(report?.detail?.path, 'notes/n1.json');
  assert.ok(await storage.read('notes', 'n1'), 'expected the local record intact');
});

test('should_delete_remote_file_when_delete_conflict_resolves_local', async () => {
  // F4: delete-vs-edit — the local side is the deletion, so choosing it
  // drops the remote file.
  const { service, storage, remote } = setup({
    storageData: { docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }] },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت.md', { content: Buffer.from('نسخه طرف').toString('base64'), rev: 'd2' });
  await storage.delete('docs', 'd1');
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  assert.deepEqual(report.conflicts.map((item) => item.id), ['d1']);
  const resolved = await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'local' });
  assert.equal(resolved.remaining, 0);
  assert.equal(remote.files.has('یادداشت.md'), false, 'choosing the local side of a delete conflict applies the deletion');
  const done = await service.syncNow({ scope: SCOPE });
  assert.equal(done.completed, true);
});

test('should_reset_baseline_when_backend_identity_changes', async () => {
  // F2: switching destinations starts from a fresh baseline — a new empty
  // target is a first sync, never "everything was remotely deleted".
  const storage = memoryStorage({
    docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه', folderId: null, updatedAt: 10 }],
  });
  const first = fakeGitHub({});
  const second = fakeGitHub({});
  let target = first;
  const service = createService({
    storage,
    events: events(),
    fetchFn: async (url, options = {}) => target.fetchFn(url, options),
  });
  await service.configureBackend({ kind: 'git', params: { repo: 'u/r', branch: 'main', token: 'tok' } });
  await service.syncNow({ scope: SCOPE });
  assert.ok(first.files.has('یادداشت.md'));
  target = second;
  await service.configureBackend({ kind: 'git', params: { repo: 'u/r', branch: 'release', token: 'tok' } });
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
  assert.deepEqual(report.deleteLocal, []);
  assert.deepEqual(report.pushed.map((item) => item.id), ['d1']);
  assert.ok(await storage.read('docs', 'd1'), 'expected local data untouched by the switch');
  assert.ok(second.files.has('یادداشت.md'), 'expected the record pushed to the new destination');
});

test('should_keep_host_edits_dirty_when_they_race_the_round', async () => {
  // F1: a host edit landing after capture must stay dirty, not be marked
  // synced behind a push of stale content.
  const storage = memoryStorage({
    docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه اول', folderId: null, updatedAt: 10 }],
  });
  const remote = fakeGitHub({});
  let edited = false;
  const service = createService({
    storage,
    events: events(),
    fetchFn: async (url, options = {}) => {
      const response = await remote.fetchFn(url, options);
      if (!edited && (options.method ?? 'GET') === 'GET' && String(url).includes('/contents/?')) {
        edited = true;
        await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'ویرایش هم‌زمان', folderId: null, updatedAt: 11 });
      }
      return response;
    },
  });
  await service.configureBackend({ kind: 'git', params: { repo: 'u/r', branch: 'main', token: 'tok' } });
  await service.syncNow({ scope: SCOPE });
  assert.equal(remote.files.has('یادداشت.md'), false, 'expected the stale-content push to be skipped');
  const pending = await service.hasPendingChanges({ scope: SCOPE });
  assert.deepEqual(pending, { pending: true }, 'the mid-round edit must not be marked synced');
  const second = await service.syncNow({ scope: SCOPE });
  assert.equal(second.completed, true);
  assert.ok(second.pushed.some((item) => item.id === 'd1'), 'expected the edit to push on the next round');
});

test('should_keep_other_records_dirty_when_a_conflict_resolves', async () => {
  // F1 (R4): resolving the last conflict pins only its own baseline entry —
  // an unrelated record edited meanwhile stays dirty.
  const { service, storage, remote } = setup({
    storageData: { docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }] },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت.md', { content: Buffer.from('نسخه طرف').toString('base64'), rev: 'd2' });
  await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'نسخه تازه من', folderId: null, updatedAt: 40 });
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  await storage.write('docs', { id: 'd2', title: 'دیگر', content: 'کار دیگر', folderId: null, updatedAt: 50 });
  const resolved = await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'local' });
  assert.equal(resolved.remaining, 0);
  const pending = await service.hasPendingChanges({ scope: SCOPE });
  assert.deepEqual(pending, { pending: true }, 'the unrelated edit must stay dirty after the resolution');
});

test('should_record_finalize_failures_as_run_errors_when_the_round_cannot_settle', async () => {
  // F6: a rejection inside finalizeRound must ride the mapped run-error
  // path (recorded + published), not escape raw past the catch.
  const base = memoryStorage({
    docs: [{ id: 'd1', title: 'یادداشت', content: 'x', folderId: null, updatedAt: 10 }],
  });
  const storage = {
    async query(collection) {
      return base.query(collection, {});
    },
    async read(collection, key) {
      return base.read(collection, key);
    },
    async write(collection, record) {
      // Fail exactly the baseline-merge write of the finalize step.
      if (collection === 'sync_state' && record.snapshot && record.lastError === undefined) {
        throw new Error('state down');
      }
      return base.write(collection, record);
    },
    async delete(collection, key) {
      return base.delete(collection, key);
    },
  };
  const service = createService({ storage, events: events(), fetchFn: fakeGitHub({}).fetchFn });
  await service.configureBackend({ kind: 'git', params: { repo: 'u/r', branch: 'main', token: 'tok' } });
  const report = await service.syncNow({ scope: SCOPE }).catch((caught) => caught);
  assert.equal(report?.code, 'SYNC_STORAGE_UNAVAILABLE', 'expected the finalize failure mapped, not raw');
  const status = await service.getStatus();
  assert.equal(status.lastError?.code, 'SYNC_STORAGE_UNAVAILABLE');
});

test('should_reject_overlapping_sync_operations_when_one_is_running', async () => {
  const { service } = setup({
    storageData: { docs: [{ id: 'd1', title: 'یادداشت', content: 'x', folderId: null, updatedAt: 10 }] },
  });
  await configure(service);
  const first = service.syncNow({ scope: SCOPE });
  const second = await service.syncNow({ scope: SCOPE }).catch((caught) => caught);
  assert.equal(second?.code, 'SYNC_IN_PROGRESS');
  await first;
});

test('should_fail_when_root_listing_is_missing_and_destination_is_gone', async () => {
  // S1: a 404 root listing with a vanished destination is not "everything
  // was remotely deleted".
  const storage = memoryStorage({
    docs: [{ id: 'd1', title: 'یادداشت', content: 'x', folderId: null, updatedAt: 10 }],
  });
  let repoGone = false;
  const remote = fakeGitHub({});
  const service = createService({
    storage,
    events: events(),
    fetchFn: async (url, options = {}) => {
      if (repoGone && String(url).includes('/repos/u/r')) {
        return { status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) };
      }
      return remote.fetchFn(url, options);
    },
  });
  await service.configureBackend({ kind: 'git', params: { repo: 'u/r', branch: 'main', token: 'tok' } });
  repoGone = true;
  const report = await service.syncNow({ scope: SCOPE }).catch((caught) => caught);
  assert.equal(report?.code, 'SYNC_REPO_NOT_FOUND');
  assert.ok(await storage.read('docs', 'd1'), 'expected local data untouched');
});

test('should_reject_unknown_conflict_when_resolved', async () => {
  const { service } = setup();
  await configure(service);
  const error = await service.resolveConflict({ collection: 'docs', id: 'x', choice: 'local' }).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_INVALID_CONFIG');
  const bad = await service.resolveConflict({ collection: 'docs', id: 'x', choice: 'both' }).catch((caught) => caught);
  assert.equal(bad?.code, 'SYNC_INVALID_CONFIG');
  const missing = await service.resolveConflict({ collection: null, id: 4, choice: 'local' }).catch((caught) => caught);
  assert.equal(missing?.code, 'SYNC_INVALID_CONFIG');
});

test('should_reject_resolve_without_backend_when_resolved', async () => {
  const { service } = setup();
  const error = await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'local' }).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_NOT_CONFIGURED');
});

test('should_reject_bad_scope_and_unconfigured_when_synced', async () => {
  const { service } = setup();
  await configure(service);
  const empty = await service.syncNow({ scope: { collections: [] } }).catch((caught) => caught);
  assert.equal(empty?.code, 'SYNC_INVALID_CONFIG');
  const bad = await service.syncNow({ scope: { collections: [{ collection: 'docs', serializer: 'yaml' }] } }).catch((caught) => caught);
  assert.equal(bad?.code, 'SYNC_INVALID_CONFIG');
  const fresh = setup();
  const missing = await fresh.service.syncNow({ scope: SCOPE }).catch((caught) => caught);
  assert.equal(missing?.code, 'SYNC_NOT_CONFIGURED');
});

test('should_reject_bad_scope_and_missing_storage_when_checked', async () => {
  const { service } = setup();
  await configure(service);
  const bad = await service.hasPendingChanges({ scope: { collections: [] } }).catch((caught) => caught);
  assert.equal(bad?.code, 'SYNC_INVALID_CONFIG');
  const offline = createService({ storage: null, events: events(), fetchFn: async () => ({}) });
  const missing = await offline.hasPendingChanges({ scope: SCOPE }).catch((caught) => caught);
  assert.equal(missing?.code, 'SYNC_STORAGE_UNAVAILABLE');
});

test('should_fail_status_check_when_storage_is_missing', async () => {
  const service = createService({ storage: null, events: events(), fetchFn: async () => ({}) });
  const error = await service.getStatus().catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_STORAGE_UNAVAILABLE');
});

test('should_fail_backend_removal_when_storage_is_missing', async () => {
  const service = createService({ storage: null, events: events(), fetchFn: async () => ({}) });
  const error = await service.removeBackend().catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_STORAGE_UNAVAILABLE');
});

test('should_tolerate_missing_bus_when_synced', async () => {
  const storage = memoryStorage({ docs: [{ id: 'd1', title: 'x', content: 'y', folderId: null, updatedAt: 1 }] });
  const remote = fakeGitHub({});
  const service = createService({ storage, events: null, fetchFn: remote.fetchFn });
  await service.configureBackend({ kind: 'git', params: { repo: 'u/r', branch: 'main', token: 't' } });
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true);
});

test('should_keep_local_data_when_backend_is_removed', async () => {
  const { service, storage } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'سلام', folderId: null, updatedAt: 1 }],
    },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  assert.deepEqual(await service.removeBackend(), { ok: true });
  assert.deepEqual(await storage.read('docs', 'd1'), { id: 'd1', title: 'یادداشت', content: 'سلام', folderId: null, updatedAt: 1 });
});

function midRunFetch(contents) {
  return async (url, options = {}) => {
    if (!url.includes('/contents')) {
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) };
    }
    return contents(url, options);
  };
}

test('should_map_midrun_network_failure_and_report_when_synced', async () => {
  const storage = memoryStorage({
    docs: [{ id: 'd1', title: 'x', content: 'y', folderId: null, updatedAt: 1 }],
  });
  const bus = events();
  const service = createService({
    storage,
    events: bus,
    fetchFn: midRunFetch(async () => { throw new TypeError('fetch failed'); }),
  });
  await configure(service);
  const error = await service.syncNow({ scope: SCOPE }).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_NETWORK_FAILED');
  assert.equal((await service.getStatus()).lastError?.code, 'SYNC_NETWORK_FAILED');
  assert.ok(bus.seen.some((event) => event.type === 'sync:changed'));
  assert.ok(!bus.seen.some((event) => event.type === 'sync:conflicted'));
});

test('should_map_midrun_rate_limit_when_synced', async () => {
  const storage = memoryStorage({
    docs: [{ id: 'd1', title: 'x', content: 'y', folderId: null, updatedAt: 1 }],
  });
  const service = createService({
    storage,
    events: events(),
    fetchFn: midRunFetch(async () => ({
      status: 403,
      ok: false,
      headers: { get: (name) => (name.toLowerCase() === 'x-ratelimit-remaining' ? '0' : null) },
      json: async () => ({}),
    })),
  });
  await configure(service);
  const error = await service.syncNow({ scope: SCOPE }).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_RATE_LIMITED');
});

test('should_map_midrun_auth_failure_when_synced', async () => {
  const storage = memoryStorage({
    docs: [{ id: 'd1', title: 'x', content: 'y', folderId: null, updatedAt: 1 }],
  });
  const service = createService({
    storage,
    events: events(),
    fetchFn: midRunFetch(async () => ({
      status: 401, ok: false, headers: { get: () => null }, json: async () => ({}),
    })),
  });
  await configure(service);
  const error = await service.syncNow({ scope: SCOPE }).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_AUTH_FAILED');
});

test('should_map_missing_repo_and_network_when_configured', async () => {
  const missing = createService({
    storage: memoryStorage(),
    events: events(),
    fetchFn: async () => ({ status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) }),
  });
  const notFound = await missing.configureBackend({ kind: 'git', params: { repo: 'u/r', branch: 'main', token: 't' } }).catch((caught) => caught);
  assert.equal(notFound?.code, 'SYNC_REPO_NOT_FOUND');
  const offline = createService({
    storage: memoryStorage(),
    events: events(),
    fetchFn: async () => { throw new TypeError('fetch failed'); },
  });
  const unreachable = await offline.configureBackend({ kind: 'git', params: { repo: 'u/r', branch: 'main', token: 't' } }).catch((caught) => caught);
  assert.equal(unreachable?.code, 'SYNC_NETWORK_FAILED');
});

test('should_resume_after_midrun_failure_when_synced', async () => {
  const storage = memoryStorage({
    docs: [
      { id: 'd1', title: 'اول', content: 'x', folderId: null, updatedAt: 10 },
      { id: 'd2', title: 'دوم', content: 'y', folderId: null, updatedAt: 20 },
    ],
  });
  const remote = fakeGitHub({});
  let failPuts = true;
  const service = createService({
    storage,
    events: events(),
    fetchFn: async (url, options = {}) => {
      if ((options.method ?? 'GET') === 'PUT' && failPuts) {
        throw new TypeError('fetch failed');
      }
      return remote.fetchFn(url, options);
    },
  });
  await configure(service);
  const first = await service.syncNow({ scope: SCOPE }).catch((caught) => caught);
  assert.equal(first?.code, 'SYNC_NETWORK_FAILED');
  failPuts = false;
  const second = await service.syncNow({ scope: SCOPE });
  assert.equal(second.completed, true);
  assert.ok(remote.files.has('اول.md'));
  assert.ok(remote.files.has('دوم.md'));
  assert.deepEqual(await service.hasPendingChanges({ scope: SCOPE }), { pending: false });
});

test('should_keep_clock_and_report_remaining_when_one_conflict_of_several_is_resolved', async () => {
  const { service, storage, remote, events } = setup({
    storageData: {
      docs: [
        { id: 'd1', title: 'یادداشت یک', content: 'نسخه من یک', folderId: null, updatedAt: 30 },
        { id: 'd2', title: 'یادداشت دو', content: 'نسخه من دو', folderId: null, updatedAt: 30 },
      ],
    },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت یک.md', { content: encode('نسخه طرف یک'), rev: 'd2' });
  remote.files.set('یادداشت دو.md', { content: encode('نسخه طرف دو'), rev: 'd3' });
  await storage.write('docs', { id: 'd1', title: 'یادداشت یک', content: 'نسخه تازه یک', folderId: null, updatedAt: 40 });
  await storage.write('docs', { id: 'd2', title: 'یادداشت دو', content: 'نسخه تازه دو', folderId: null, updatedAt: 40 });
  await service.syncNow({ scope: SCOPE });
  const stampedAt = (await service.getStatus()).lastSyncAt;
  assert.equal(typeof stampedAt, 'number', 'the first clean round stamped the clock');
  events.seen.length = 0;

  const first = await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'local' });

  assert.equal(first.remaining, 1, 'the other conflict must stay pending');
  assert.equal((await service.getStatus()).lastSyncAt, stampedAt, 'the clock must not advance while conflicts remain');
  const changed = events.seen.find((event) => event.type === 'sync:changed');
  assert.deepEqual(changed.data.conflicts, [{ collection: 'docs', id: 'd2' }], 'the event must carry the open conflict');

  const second = await service.resolveConflict({ collection: 'docs', id: 'd2', choice: 'local' });
  assert.equal(second.remaining, 0);
  assert.ok((await service.getStatus()).lastSyncAt > stampedAt, 'the clock advances when the last conflict clears');
});

test('should_keep_conflict_open_when_host_edits_the_record_mid_resolution', async () => {
  const { service, storage, remote } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }],
    },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت.md', { content: encode('نسخه طرف'), rev: 'd2' });
  await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'نسخه تازه من', folderId: null, updatedAt: 40 });
  await service.syncNow({ scope: SCOPE });

  // The CAS re-read inside the resolution sees a newer host edit than the
  // state the plan was captured on (collectLocal's query view).
  const innerRead = storage.read.bind(storage);
  storage.read = async (collection, key) => {
    const record = await innerRead(collection, key);
    if (collection === 'docs' && key === 'd1' && record) {
      return { ...record, content: 'ویرایش هم‌زمان میزبان', updatedAt: 50 };
    }
    return record;
  };

  const resolved = await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'remote' });

  assert.equal(resolved.remaining, 1, 'the CAS guard must keep the conflict open');
  assert.equal((await innerRead('docs', 'd1')).content, 'نسخه تازه من', 'the plan-time record must survive untouched');
  assert.equal(decode(remote.files.get('یادداشت.md').content), 'نسخه طرف', 'the remote side must stay untouched');
});

test('should_keep_the_conflict_open_when_the_host_edits_the_record_before_the_local_resolution', async () => {
  // The local choice writes the remote file too — it runs the same CAS the
  // remote choice applies, or a host edit racing the resolution would be
  // silently overwritten on the backend.
  const { service, storage, remote } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }],
    },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت.md', { content: encode('نسخه طرف'), rev: 'd2' });
  await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'نسخه تازه من', folderId: null, updatedAt: 40 });
  await service.syncNow({ scope: SCOPE });

  const innerRead = storage.read.bind(storage);
  storage.read = async (collection, key) => {
    const record = await innerRead(collection, key);
    if (collection === 'docs' && key === 'd1' && record) {
      return { ...record, content: 'ویرایش هم‌زمان میزبان', updatedAt: 50 };
    }
    return record;
  };

  const resolved = await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'local' });

  assert.equal(resolved.remaining, 1, 'the CAS guard must keep the conflict open');
  assert.equal((await innerRead('docs', 'd1')).content, 'نسخه تازه من', 'the plan-time record must survive untouched');
  assert.equal(decode(remote.files.get('یادداشت.md').content), 'نسخه طرف', 'the remote file must not carry the stale plan content');
});

test('should_keep_the_conflict_open_when_the_chosen_remote_file_cannot_shape_into_a_record', async () => {
  // A remote file whose payload id disagrees with its path is not
  // representable locally: resolving "remote" must adopt nothing and pin
  // no baseline — otherwise the next round would invert the user's choice
  // (overwrite or delete the file they explicitly kept).
  const { service, storage, remote } = setup({
    storageData: {
      notes: [{ key: 'n1', text: 'نسخه من', mtime: 10 }],
    },
  });
  await configure(service);
  await service.syncNow({ scope: JSON_SCOPE });
  remote.files.set('notes/n1.json', {
    content: Buffer.from(JSON.stringify({ key: 'n2', text: 'نسخه طرف', mtime: 20 })).toString('base64'),
    rev: 'r2',
  });
  await storage.write('notes', { key: 'n1', text: 'نسخه تازه من', mtime: 40 });
  const report = await service.syncNow({ scope: JSON_SCOPE });
  assert.equal(report.completed, false);

  const resolved = await service.resolveConflict({ collection: 'notes', id: 'n1', choice: 'remote' });

  assert.equal(resolved.remaining, 1, 'the unrepresentable remote file keeps the conflict open');
  assert.equal((await storage.read('notes', 'n1')).text, 'نسخه تازه من', 'the local record was not touched');
  await service.syncNow({ scope: JSON_SCOPE });
  const kept = JSON.parse(Buffer.from(remote.files.get('notes/n1.json').content, 'base64').toString('utf8'));
  assert.equal(kept.text, 'نسخه طرف', 'the next round must not push the local content over the chosen remote file');
});

test('should_reject_a_remote_resolution_when_the_remote_changed_between_prompt_and_resolve', async () => {
  // The prompt→resolve window: the host decided on the content the report
  // showed. A remote change before resolve means the user would accept
  // content they never saw — the resolution is skipped and the next round
  // re-asks with the fresh content.
  const { service, storage, remote } = setup({
    storageData: { docs: [{ id: 'a', title: 'یادداشت', content: 'نسخه اولیه', folderId: null, updatedAt: 30 }] },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت.md', { content: encode('نسخه طرف'), rev: 'd2' });
  await storage.delete('docs', 'a');
  await storage.write('docs', { id: 'b', title: 'یادداشت', content: 'بازنویسی', folderId: null, updatedAt: 40 });
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  assert.equal(report.conflicts[0].remote.content, 'نسخه طرف', 'the prompt showed this version');

  // Outside the plugin, the remote file changes after the prompt.
  remote.files.set('یادداشت.md', { content: encode('نسخه مخفی'), rev: 'd3' });

  const resolved = await service.resolveConflict({ collection: 'docs', id: 'b', choice: 'remote' });
  assert.equal(resolved.remaining, 1, 'the stale-content resolution is refused');
  assert.equal((await storage.read('docs', 'b')).content, 'بازنویسی', 'the local record was not overwritten with unseen content');

  // The next round re-asks with the fresh content; resolving then works.
  const report2 = await service.syncNow({ scope: SCOPE });
  assert.equal(report2.completed, false);
  assert.equal(report2.conflicts[0].remote.content, 'نسخه مخفی', 'the fresh content is what the next prompt shows');
  const resolved2 = await service.resolveConflict({ collection: 'docs', id: 'b', choice: 'remote' });
  assert.equal(resolved2.remaining, 0);
  assert.equal((await storage.read('docs', 'b')).content, 'نسخه مخفی');
});

test('should_apply_the_factory_default_branch_when_the_backend_was_configured_without_one', async () => {
  // `branch` is documented optional with the main default: a configure that
  // omits it must not leave a `branch: null` record that wedges every later
  // call with "backend requires a branch".
  const { service, storage } = setup({
    storageData: { docs: [{ id: 'a', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }] },
  });
  const configured = await service.configureBackend({
    kind: 'git',
    params: { repo: 'u/r', token: 'tok' },
  });
  assert.equal(configured.ok, true);
  const record = await storage.read('sync_backends', 'active');
  assert.equal(record.branch, null);

  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, true, 'the round ran on the default branch');
});

test('should_report_an_unreadable_remote_side_as_null_when_the_file_vanishes_before_the_enriching_read', async () => {
  // A vanished file is not an empty file: the report must distinguish
  // "empty" from "unreadable at report time" (null).
  const storage = memoryStorage({
    docs: [{ id: 'a', title: 'یادداشت', content: 'نسخه اولیه', folderId: null, updatedAt: 30 }],
  });
  const remote = fakeGitHub({});
  const innerFetch = remote.fetchFn;
  let vanishOnRead = false;
  const fetchFn = async (url, options = {}) => {
    if (vanishOnRead && (options.method ?? 'GET') === 'GET' && url.includes('/contents/')) {
      const path = decodeURIComponent((url.match(/\/contents\/?(.*?)(\?.*)?$/) ?? [])[1] ?? '');
      if (path === 'یادداشت.md') {
        vanishOnRead = false;
        remote.files.delete('یادداشت.md');
      }
    }
    return innerFetch(url, options);
  };
  const service = createService({ storage, events: events(), fetchFn });
  await configure(service);
  await service.syncNow({ scope: SCOPE });

  // Takeover: the remote file keeps its revision (so the rev shortcut
  // leaves it unread during capture) and vanishes right before the
  // compensating enrich read.
  await storage.delete('docs', 'a');
  await storage.write('docs', { id: 'b', title: 'یادداشت', content: 'بازنویسی', folderId: null, updatedAt: 40 });
  vanishOnRead = true;
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  assert.deepEqual(report.conflicts.map((item) => item.id), ['b']);
  assert.equal(report.conflicts[0].remote.content, null, 'unreadable is null, never an empty string');
});

test('should_fail_the_round_when_the_git_directory_listing_hits_the_truncation_limit', async () => {
  // GitHub's Contents API silently truncates a listing at 1,000 entries:
  // an incomplete listing must never drive a round — paths missing from it
  // would read as "remotely deleted" and destroy local edits.
  const files = {};
  for (let index = 0; index < 1000; index += 1) {
    files[`notes/n${index}.json`] = { content: Buffer.from(JSON.stringify({ key: `n${index}`, text: `متن ${index}`, mtime: 10 })).toString('base64'), rev: `r${index}` };
  }
  const { service } = setup({ files });

  await configure(service);
  const report = await service.syncNow({ scope: JSON_SCOPE }).catch((caught) => caught);

  assert.equal(report.code, 'SYNC_REMOTE_INVALID');
  assert.equal(report.detail?.adapterCode, 'GIT_DIRECTORY_TRUNCATED');
});

test('should_report_the_real_remote_content_when_a_takeover_conflict_uses_the_rev_shortcut', async () => {
  // The rev shortcut leaves a takeover conflict's remote file unread; the
  // conflict report must still carry the real remote content — an empty
  // string would present a non-empty file as "remotely empty" and steer
  // the user's choice.
  const { service, storage } = setup({
    storageData: { docs: [{ id: 'a', title: 'یادداشت', content: 'نسخه اولیه', folderId: null, updatedAt: 30 }] },
  });
  await configure(service);
  const first = await service.syncNow({ scope: SCOPE });
  assert.equal(first.completed, true);

  await storage.delete('docs', 'a');
  await storage.write('docs', { id: 'b', title: 'یادداشت', content: 'بازنویسی', folderId: null, updatedAt: 40 });

  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  assert.equal(report.conflicts[0].remote.content, 'نسخه اولیه', 'the host sees the content it is choosing about');
});

test('should_keep_the_conflict_open_when_the_local_deletion_is_recreated_before_the_local_resolution', async () => {
  // The CAS guard covers the DELETION branch of the local choice too: a
  // host re-creation mid-window means the deletion the user chose no
  // longer exists — the remote file must not be deleted on its strength.
  const { service, storage, remote } = setup({
    storageData: { docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }] },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت.md', { content: encode('نسخه طرف'), rev: 'd2' });
  await storage.delete('docs', 'd1');
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  assert.deepEqual(report.conflicts.map((item) => item.id), ['d1']);

  const innerRead = storage.read.bind(storage);
  storage.read = async (collection, key) => {
    const record = await innerRead(collection, key);
    if (collection === 'docs' && key === 'd1') {
      return { id: 'd1', title: 'یادداشت', content: 'بازآفرینی میزبان', folderId: null, updatedAt: 50 };
    }
    return record;
  };

  const resolved = await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'local' });

  assert.equal(resolved.remaining, 1, 'the CAS guard keeps the conflict open');
  assert.equal(decode(remote.files.get('یادداشت.md').content), 'نسخه طرف', 'the remote file was not deleted on a stale deletion');
});

test('should_keep_the_conflict_open_when_the_remote_file_vanishes_before_a_takeover_resolution', async () => {
  // Takeover conflict: the snapshot owner vanished locally, a new record
  // occupies the path, and the remote file kept its revision (so its
  // content never entered the round). If the file then vanishes before the
  // "remote" choice applies, the resolution must not half-apply — pinning
  // no baseline while the local record survives would push the local
  // content over the remote deletion next round.
  const storage = memoryStorage({
    docs: [{ id: 'a', title: 'یادداشت', content: 'نسخه اولیه', folderId: null, updatedAt: 30 }],
  });
  const remote = fakeGitHub({});
  const innerFetch = remote.fetchFn;
  let vanishOnRead = false;
  const fetchFn = async (url, options = {}) => {
    // The vanish must land between the resolution's own capture and its
    // fresh read — deleting the file earlier would dissolve the conflict
    // before it is even offered.
    if (vanishOnRead && (options.method ?? 'GET') === 'GET' && url.includes('/contents/')) {
      const path = decodeURIComponent((url.match(/\/contents\/?(.*?)(\?.*)?$/) ?? [])[1] ?? '');
      if (path === 'یادداشت.md') {
        vanishOnRead = false;
        remote.files.delete('یادداشت.md');
      }
    }
    return innerFetch(url, options);
  };
  const service = createService({ storage, events: events(), fetchFn });
  await configure(service);
  const first = await service.syncNow({ scope: SCOPE });
  assert.equal(first.completed, true);

  await storage.delete('docs', 'a');
  await storage.write('docs', { id: 'b', title: 'یادداشت', content: 'بازنویسی', folderId: null, updatedAt: 40 });
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  assert.deepEqual(report.conflicts.map((item) => item.id), ['b']);

  vanishOnRead = true;
  const resolved = await service.resolveConflict({ collection: 'docs', id: 'b', choice: 'remote' });

  assert.equal(resolved.remaining, 1, 'a vanished remote file keeps the conflict open');
  assert.equal((await storage.read('docs', 'b')).content, 'بازنویسی', 'the local record was not touched');
});

test('should_publish_changed_items_without_path_when_a_resolution_applies', async () => {
  // The sync:changed contract documents `{ collection, id }` items; the
  // internal path bookkeeping of resolution outcomes stays internal.
  const { service, storage, remote, events: bus } = setup({
    storageData: {
      docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }],
    },
  });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت.md', { content: encode('نسخه طرف'), rev: 'd2' });
  await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'نسخه تازه من', folderId: null, updatedAt: 40 });
  await service.syncNow({ scope: SCOPE });
  bus.seen.length = 0;

  await service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'local' });

  const changed = bus.seen.filter((event) => event.type === 'sync:changed').at(-1);
  assert.notEqual(changed, undefined);
  for (const item of [...changed.data.pushed, ...changed.data.pulled]) {
    assert.deepEqual(Object.keys(item).sort(), ['collection', 'id'], 'event items carry exactly the documented shape');
  }
});

test('should_close_a_vanished_remote_conflict_by_the_takeover_rule_when_the_file_stays_gone', async () => {
  // Documented behavior of the skipped "remote" resolution: the conflict is
  // reported open, and when the remote file never comes back the next round
  // treats the path as local-only and closes it by the regular takeover
  // push rule — the remote state itself superseding the stale choice.
  const storage = memoryStorage({
    docs: [{ id: 'a', title: 'یادداشت', content: 'نسخه اولیه', folderId: null, updatedAt: 30 }],
  });
  const remote = fakeGitHub({});
  const innerFetch = remote.fetchFn;
  let vanishOnRead = false;
  const fetchFn = async (url, options = {}) => {
    if (vanishOnRead && (options.method ?? 'GET') === 'GET' && url.includes('/contents/')) {
      const path = decodeURIComponent((url.match(/\/contents\/?(.*?)(\?.*)?$/) ?? [])[1] ?? '');
      if (path === 'یادداشت.md') {
        vanishOnRead = false;
        remote.files.delete('یادداشت.md');
      }
    }
    return innerFetch(url, options);
  };
  const service = createService({ storage, events: events(), fetchFn });
  await configure(service);
  await service.syncNow({ scope: SCOPE });

  await storage.delete('docs', 'a');
  await storage.write('docs', { id: 'b', title: 'یادداشت', content: 'بازنویسی', folderId: null, updatedAt: 40 });
  const report = await service.syncNow({ scope: SCOPE });
  assert.equal(report.completed, false);
  assert.deepEqual(report.conflicts.map((item) => item.id), ['b']);

  vanishOnRead = true;
  const resolved = await service.resolveConflict({ collection: 'docs', id: 'b', choice: 'remote' });
  assert.equal(resolved.remaining, 1, 'the vanished remote file keeps the conflict open');

  const done = await service.syncNow({ scope: SCOPE });
  assert.equal(done.completed, true, 'the next round closes the conflict by the takeover rule');
  assert.deepEqual(done.pushed.map((item) => item.id), ['b']);
});

test('should_report_concurrent_change_when_remote_moves_mid_round', async () => {
  const storage = memoryStorage({
    docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه اول', folderId: null, updatedAt: 30 }],
  });
  const remote = fakeGitHub({});
  const innerFetch = remote.fetchFn;
  let stolen = false;
  const fetchFn = async (url, options = {}) => {
    // Another client commits to the same file right before our PUT lands.
    const hit = remote.files.get('یادداشت.md');
    if (!stolen && hit && (options.method ?? 'GET') === 'PUT' && url.includes('/contents/')) {
      stolen = true;
      hit.rev = 'rev-stolen';
    }
    return innerFetch(url, options);
  };
  const service = createService({ storage, events: events(), fetchFn });
  await configure(service);
  // First clean round pins the baseline; the second round plans a push of
  // the edited record against the stolen revision.
  await service.syncNow({ scope: SCOPE });
  await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'نسخه دوم', folderId: null, updatedAt: 40 });

  await assert.rejects(
    () => service.syncNow({ scope: SCOPE }),
    (error) => error.code === 'SYNC_CONCURRENT_CHANGE',
  );
});

test('should_record_and_publish_a_mid_resolution_failure_when_the_remote_write_fails', async () => {
  const storage = memoryStorage({
    docs: [{ id: 'd1', title: 'یادداشت', content: 'نسخه من', folderId: null, updatedAt: 30 }],
  });
  const remote = fakeGitHub({});
  const innerFetch = remote.fetchFn;
  let failWrites = false;
  // The wrapper is installed before the service is created: the service
  // captured the fetch implementation at construction time.
  const fetchFn = async (url, options = {}) => {
    if (failWrites && (options.method ?? 'GET') === 'PUT') {
      return { status: 500, ok: false, headers: { get: () => null }, json: async () => ({}) };
    }
    return innerFetch(url, options);
  };
  const bus = events();
  const service = createService({ storage, events: bus, fetchFn });
  await configure(service);
  await service.syncNow({ scope: SCOPE });
  remote.files.set('یادداشت.md', { content: encode('نسخه طرف'), rev: 'd2' });
  await storage.write('docs', { id: 'd1', title: 'یادداشت', content: 'نسخه تازه من', folderId: null, updatedAt: 40 });
  await service.syncNow({ scope: SCOPE });
  bus.seen.length = 0;
  failWrites = true;

  await assert.rejects(
    () => service.resolveConflict({ collection: 'docs', id: 'd1', choice: 'local' }),
    (error) => error.code === 'SYNC_NETWORK_FAILED',
  );

  assert.notEqual((await service.getStatus()).lastError, null, 'the failure lands in lastError');
  const changed = bus.seen.filter((event) => event.type === 'sync:changed').at(-1);
  assert.notEqual(changed, undefined, 'the bus hears about the half-applied resolution');
  assert.deepEqual(changed.data.conflicts, [{ collection: 'docs', id: 'd1' }], 'the conflict stays open');
});
