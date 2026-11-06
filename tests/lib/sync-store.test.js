// Tests for lib/sync-store.js — the storage outage guard.

import assert from 'node:assert/strict';
import test from 'node:test';
import { requireStorage, store } from '../../lib/sync-store.js';

test('should_pass_value_through_when_storage_succeeds', async () => {
  const value = { id: 'a', snapshot: [] };

  assert.deepEqual(await store(Promise.resolve(value)), value);
});

test('should_map_storage_outage_to_structured_error_when_access_fails', async () => {
  await assert.rejects(
    () => store(Promise.reject(new Error('boom'))),
    (error) => error.code === 'SYNC_STORAGE_UNAVAILABLE' && error.detail.cause === 'UNKNOWN',
  );
});

test('should_keep_storage_error_code_as_cause_when_it_carries_one', async () => {
  const outage = Object.assign(new Error('quota'), { code: 'QUOTA_EXCEEDED' });

  await assert.rejects(
    () => store(Promise.reject(outage)),
    (error) => error.code === 'SYNC_STORAGE_UNAVAILABLE' && error.detail.cause === 'QUOTA_EXCEEDED',
  );
});

test('should_return_storage_when_require_storage_sees_one', () => {
  const storage = { read: () => {} };

  assert.equal(requireStorage({ storage }), storage);
});

test('should_throw_structured_error_when_storage_is_missing', () => {
  assert.throws(
    () => requireStorage({ storage: null }),
    (error) => error.code === 'SYNC_STORAGE_UNAVAILABLE',
  );
});
