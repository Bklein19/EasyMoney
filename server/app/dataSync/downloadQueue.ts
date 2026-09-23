/** Bound browser work; serialize institutions that may share login state. */
export class SyncDownloadQueue {
  private active = new Set<string>();
  private pending: Array<{ key: string; run: () => Promise<void> }> = [];

  constructor(private readonly limit = 3) {}

  enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({ key, run: async () => {
        try { await operation(); resolve(); } catch (error) { reject(error); }
      } });
      this.drain();
    });
  }

  private drain() {
    while (this.active.size < this.limit) {
      const index = this.pending.findIndex(item => !this.active.has(item.key));
      if (index < 0) return;
      const [item] = this.pending.splice(index, 1);
      this.active.add(item!.key);
      void item!.run().finally(() => {
        this.active.delete(item!.key);
        this.drain();
      });
    }
  }
}
