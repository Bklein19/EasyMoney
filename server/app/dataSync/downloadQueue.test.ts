import { expect, test } from 'bun:test';
import { SyncDownloadQueue } from './downloadQueue.ts';

test('downloads overlap across institutions, serialize shared logins, and free slots after failure', async () => {
  const queue = new SyncDownloadQueue(2);
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const run = (id: string, key: string, fail = false) => queue.enqueue(key, async () => {
    started.push(id);
    await new Promise<void>(resolve => gates.set(id, resolve));
    if (fail) throw new Error('download failed');
  });
  const first = run('first', 'vanguard');
  const second = run('second', 'vanguard');
  const third = run('third', 'tiaa', true).catch(error => error.message);
  const fourth = run('fourth', 'fidelity');
  expect(started).toEqual(['first', 'third']);
  gates.get('third')!();
  expect(await third).toBe('download failed');
  await Promise.resolve();
  expect(started).toEqual(['first', 'third', 'fourth']);
  gates.get('first')!();
  await first;
  await Promise.resolve();
  expect(started).toEqual(['first', 'third', 'fourth', 'second']);
  gates.get('second')!();
  gates.get('fourth')!();
  await Promise.all([second, fourth]);
});
