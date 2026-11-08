// Tests for adapters/shared.js — the helpers shared by git-family backends.

import assert from 'node:assert/strict';
import test from 'node:test';
import { commitMessageOf, decodeContent, encodeContent, REQUEST_TIMEOUT_MS } from '../../adapters/shared.js';

test('should_prefer_run_message_when_one_is_given', () => {
  assert.equal(commitMessageOf({ message: '  نوت جدید  ' }, 'fallback'), 'نوت جدید');
});

test('should_fall_back_when_message_is_blank_or_missing', () => {
  assert.equal(commitMessageOf({ message: '   ' }, 'fallback'), 'fallback');
  assert.equal(commitMessageOf(null, 'fallback'), 'fallback');
  assert.equal(commitMessageOf({}, 'fallback'), 'fallback');
});

test('should_round_trip_text_through_base64_when_encoding_and_decoding', () => {
  const samples = ['plain', 'سلام دنیا — متن چندبایتی', 'line1\nline2 <b>html</b>'];
  for (const text of samples) {
    assert.equal(decodeContent(encodeContent(text)), text);
  }
});

test('should_decode_wrapped_base64_when_provider_folds_lines', () => {
  const wrapped = encodeContent('سلام دنیا').replace(/(.{4})/g, '$1\n');

  assert.equal(decodeContent(wrapped), 'سلام دنیا');
});

test('should_keep_the_request_deadline_at_thirty_seconds_when_no_override_is_configured', () => {
  // The timeout is a contract with the UI: long enough for slow networks,
  // short enough that a stalled request cannot hang a sync round forever.
  assert.equal(REQUEST_TIMEOUT_MS, 30000);
});
