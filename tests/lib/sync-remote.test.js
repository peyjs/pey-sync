// Tests for lib/sync-remote.js — remote listing attribution, hashing,
// pulled-record shaping and the legacy artifact sweep. All IO goes through
// a fake adapter; nothing touches the network.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPulledRecord,
  cleanupLegacyArtifacts,
  hashRemoteFile,
  readRemoteListing,
} from '../../lib/sync-remote.js';
import { normalizeScope } from '../../lib/sync-scope.js';

const SCOPE = {
  collections: [
    { collection: 'docs', serializer: 'markdown', titleField: 'title' },
    { collection: 'notes', serializer: 'json', idField: 'key', contentField: 'text' },
  ],
};

function fakeAdapter({ files = {}, manifest = undefined, failDelete = false } = {}) {
  const deleted = [];
  return {
    deleted,
    async listDir() {
      const paths = Object.keys(files);
      if (manifest !== undefined) {
        paths.push('sync-manifest.json');
      }
      return paths.map((path) => ({ path, rev: `rev-${path}` }));
    },
    async readFile(path) {
      if (path === 'sync-manifest.json') {
        if (manifest === undefined) {
          return null;
        }
        return { content: manifest, rev: 'rev-manifest' };
      }
      return Object.prototype.hasOwnProperty.call(files, path)
        ? { content: files[path], rev: `rev-${path}` }
        : null;
    },
    async deleteFile(path) {
      if (failDelete) {
        throw new Error('backend down');
      }
      deleted.push(path);
      return { ok: true };
    },
  };
}

test('should_attribute_owned_paths_when_listing_the_remote', async () => {
  const configs = normalizeScope(SCOPE);
  const adapter = fakeAdapter({ files: { 'docs/a.md': '# a', 'notes/b.json': '{"key":"b"}', 'other.txt': 'x' } });

  const listing = await readRemoteListing(adapter, configs, new Map(), ['md', 'json']);

  const owned = listing.entries.map((entry) => entry.path).sort();
  assert.deepEqual(owned, ['docs/a.md', 'notes/b.json']);
  assert.deepEqual(listing.foreign, [{ path: 'other.txt' }]);
});

test('should_read_legacy_manifest_records_when_one_is_present', async () => {
  const configs = normalizeScope(SCOPE);
  const manifest = JSON.stringify({ version: 1, records: [{ collection: 'docs', id: 'a', path: 'docs/a.md' }] });
  const adapter = fakeAdapter({ manifest });

  const listing = await readRemoteListing(adapter, configs, new Map(), ['md', 'json']);

  assert.deepEqual(listing.legacyManifestRecords, [{ collection: 'docs', id: 'a', path: 'docs/a.md' }]);
  assert.equal(listing.entries.some((entry) => entry.path === 'sync-manifest.json'), false);
});

test('should_ignore_corrupt_or_wrong_version_manifest_instead_of_failing', async () => {
  const configs = normalizeScope(SCOPE);

  const corrupt = await readRemoteListing(fakeAdapter({ manifest: '{not json' }), configs, new Map(), ['md']);
  const wrongVersion = await readRemoteListing(
    fakeAdapter({ manifest: JSON.stringify({ version: 2, records: [] }) }),
    configs,
    new Map(),
    ['md'],
  );
  const missing = await readRemoteListing(fakeAdapter({}), configs, new Map(), ['md']);

  assert.equal(corrupt.legacyManifestRecords, null);
  assert.equal(wrongVersion.legacyManifestRecords, null);
  assert.equal(missing.legacyManifestRecords, null);
});

test('should_hash_remote_file_on_the_local_comparable_basis', async () => {
  const configs = normalizeScope(SCOPE);
  const adapter = fakeAdapter({ files: { 'docs/a.md': '# سلام' } });

  const hashed = await hashRemoteFile(adapter, configs, 'docs', 'docs/a.md', 'rev-listing');

  assert.equal(typeof hashed.hash, 'string');
  assert.equal(hashed.hash.length, 8);
  assert.equal(hashed.rev, 'rev-docs/a.md');
  assert.equal(hashed.content, '# سلام');
});

test('should_return_null_when_remote_file_is_gone', async () => {
  const configs = normalizeScope(SCOPE);

  assert.equal(await hashRemoteFile(fakeAdapter({}), configs, 'docs', 'docs/a.md', null), null);
});

test('should_mint_markdown_record_when_pulling_a_never_local_file', async () => {
  const configs = normalizeScope(SCOPE);
  const storageCalls = [];

  const built = await buildPulledRecord(
    { write: async (...args) => storageCalls.push(args) },
    new Map(),
    configs,
    { collection: 'docs', id: null, path: 'docs/تازه.md' },
    'متن برگشته',
    1234,
  );

  assert.equal(built.collection, 'docs');
  assert.equal(typeof built.record.id, 'string', 'a fresh markdown id must be minted');
  assert.equal(built.record.title, 'تازه');
  assert.equal(built.record.content, 'متن برگشته');
  assert.equal(built.record.updatedAt, 1234);
});

test('should_reject_json_payload_when_it_claims_another_identity', async () => {
  const configs = normalizeScope(SCOPE);

  const built = await buildPulledRecord(
    {},
    new Map(),
    configs,
    { collection: 'notes', id: 'b', path: 'notes/b.json' },
    JSON.stringify({ key: 'another', text: 'x' }),
    1234,
  );

  assert.equal(built, null);
});

test('should_delete_legacy_manifest_when_records_were_seen_this_round', async () => {
  // The "only after a readable manifest was seen" rule lives in the caller:
  // it hands the records array over, and cleanup deletes exactly then.
  const adapter = fakeAdapter({});

  await cleanupLegacyArtifacts(adapter, []);

  assert.deepEqual(adapter.deleted, ['sync-manifest.json']);
});

test('should_skip_legacy_sweep_when_no_manifest_was_seen', async () => {
  const adapter = fakeAdapter({});

  await cleanupLegacyArtifacts(adapter, null);

  assert.deepEqual(adapter.deleted, []);
});

test('should_sweep_legacy_artifact_best_effort_when_delete_fails', async () => {
  await cleanupLegacyArtifacts(fakeAdapter({ failDelete: true }), []);
});
