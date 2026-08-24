export class SerialSyncDatabaseQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

const syncDatabaseQueue = new SerialSyncDatabaseQueue();

export function runSerializedSyncDatabaseWork<T>(operation: () => T | Promise<T>): Promise<T> {
  return syncDatabaseQueue.run(operation);
}
