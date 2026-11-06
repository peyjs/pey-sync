// Verifies the pey.sync entry point (prepare/activate wiring).
import assert from 'node:assert/strict';
import test from 'node:test';
import { activate, prepare } from '../index.js';

function createPrepareContext() {
  return {
    config: {},
    events: {
      subscriptions: new Map(),
      subscribe(type, handler) {
        this.subscriptions.set(type, handler);
        return () => {
          if (this.subscriptions.get(type) === handler) {
            this.subscriptions.delete(type);
          }
        };
      },
      publish: () => ({ success: true }),
    },
    onShutdown: null,
    onDeactivated: null,
    reportCriticalError: () => {},
  };
}

function createStorageService() {
  return {
    async read() {
      return null;
    },
    async write(collection, record) {
      return record;
    },
    async delete() {},
    async query() {
      return [];
    },
  };
}

test('should_register_service_when_prepared', async () => {
  const context = createPrepareContext();
  const provided = await prepare(context);
  assert.deepEqual(provided.map(({ name }) => name), ['pey.sync.service']);
  assert.equal(typeof context.onShutdown, 'function');
  assert.equal(typeof context.onDeactivated, 'function');
});

test('should_fail_clearly_when_storage_is_missing', async () => {
  await prepare(createPrepareContext());
  const error = await activate({}).catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_STORAGE_UNAVAILABLE');
  assert.equal(error?.type, 'startup');
  assert.match(error?.message ?? '', /pey\.storage\.service/);
});

test('should_fail_service_calls_when_called_before_activation', async () => {
  const provided = await prepare(createPrepareContext());
  const service = provided[0].object;
  const error = await service.getStatus().catch((caught) => caught);
  assert.equal(error?.code, 'SYNC_STORAGE_UNAVAILABLE');
});

test('should_report_critical_error_when_storage_is_lost', async () => {
  const context = createPrepareContext();
  let reported = null;
  context.reportCriticalError = (error) => {
    reported = error;
  };
  await prepare(context);
  await activate({ 'pey.storage.service': createStorageService() });
  context.events.subscriptions.get('core:service-unavailable')({
    data: { serviceName: 'pey.storage.service' },
  });
  assert.equal(reported?.code, 'REQUIRED_DEPENDENCY_LOST');
  assert.equal(reported?.type, 'critical');
});

test('should_ignore_unrelated_service_loss_when_notified', async () => {
  const context = createPrepareContext();
  let reported = null;
  context.reportCriticalError = (error) => {
    reported = error;
  };
  await prepare(context);
  context.events.subscriptions.get('core:service-unavailable')({
    data: { serviceName: 'some.other.service' },
  });
  assert.equal(reported, null);
});

test('should_unsubscribe_from_service_unavailable_when_deactivated', async () => {
  const context = createPrepareContext();
  await prepare(context);
  assert.equal(context.events.subscriptions.has('core:service-unavailable'), true);

  context.onDeactivated();

  assert.equal(context.events.subscriptions.has('core:service-unavailable'), false, 'deactivation must leave the bus');
});

test('should_unsubscribe_from_service_unavailable_when_shutdown', async () => {
  const context = createPrepareContext();
  await prepare(context);

  await context.onShutdown();

  assert.equal(context.events.subscriptions.has('core:service-unavailable'), false, 'shutdown must leave the bus');
});

test('should_not_report_critical_error_when_dependency_is_lost_after_shutdown', async () => {
  const context = createPrepareContext();
  let reported = null;
  context.reportCriticalError = (error) => {
    reported = error;
  };
  await prepare(context);

  await context.onShutdown();

  assert.equal(context.events.subscriptions.has('core:service-unavailable'), false);
  assert.equal(reported, null);
});
