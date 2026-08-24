import { expect, test } from 'bun:test';

import { SerialSyncDatabaseQueue } from './databaseQueue.ts';

test('sync database work is serialized even when jobs finish together', async () => {
  const queue = new SerialSyncDatabaseQueue();
  const order: string[] = [];
  let active = 0;
  let maximumActive = 0;

  const operation = (name: string) => queue.run(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push(`${name}:start`);
    await Promise.resolve();
    order.push(`${name}:end`);
    active -= 1;
    return name;
  });

  await expect(Promise.all([operation('first'), operation('second')]))
    .resolves.toEqual(['first', 'second']);
  expect(maximumActive).toBe(1);
  expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
});

test('a failed database task does not poison later confirmations', async () => {
  const queue = new SerialSyncDatabaseQueue();
  await expect(queue.run(() => {
    throw new Error('synthetic failure');
  })).rejects.toThrow('synthetic failure');
  await expect(queue.run(() => 'continued')).resolves.toBe('continued');
});
