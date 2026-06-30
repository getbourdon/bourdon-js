/**
 * A minimal async mutex — the Node equivalent of Python's `threading.RLock`
 * guarding `L6Store.commit_l5`.
 *
 * Why this exists: Node is single-threaded but interleaves at every `await`
 * point. `commitL5` is a read-modify-write-RELOAD (read the cached manifest,
 * merge, write to disk, reload the in-memory index). Two overlapping commits to
 * the SAME agent would each read the same cached manifest, each build a merge
 * missing the other's rows, and the second write would silently drop the
 * first's contribution and could corrupt the shared entity index (3-Star audit
 * P1-3). Serializing the whole critical section closes that race.
 *
 * NOT re-entrant (unlike RLock), but the ported code never re-acquires from
 * within a held section, so FIFO mutual exclusion is sufficient and matches the
 * observable Python behavior.
 */
export class Mutex {
  private _tail: Promise<void> = Promise.resolve();

  /** Run `fn` with exclusive access. Calls are serialized in FIFO order. */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    // Chain onto the current tail so each caller waits for all prior ones.
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this._tail;
    this._tail = prior.then(() => next);
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
