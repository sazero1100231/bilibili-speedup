// Media and qualification probes share a bounded, session-owned request pool.
// A lease is released on cancellation/session eviction as well as completion.
export class TransferBudget {
  constructor({ globalLimit = 8, tabLimit = 4, leaseMs = 20000 } = {}) {
    this.globalLimit = globalLimit;
    this.tabLimit = tabLimit;
    this.leaseMs = leaseMs;
    this.active = new Map();
    this.queue = [];
    this.peak = 0;
  }

  key(sessionId, id) { return `${sessionId}\u0000${id}`; }

  acquire(tabId, sessionId, id, kind = "video") {
    const key = this.key(sessionId, id);
    if (!/^[\w:-]{1,100}$/.test(id) || this.active.has(key) || this.queue.some(e => e.key === key)) {
      return Promise.reject(new Error("Invalid or duplicate transfer lease"));
    }
    if (this.queue.length >= 64 || this.queue.filter(e => e.tabId === tabId).length >= 16) {
      return Promise.reject(new Error("Transfer queue is full"));
    }
    return new Promise((resolve, reject) => {
      const entry = { tabId, sessionId, id, key, kind, resolve, reject, queuedAt: Date.now() };
      entry.timer = setTimeout(() => {
        this.queue = this.queue.filter(e => e !== entry);
        reject(new Error("Transfer queue expired"));
      }, 10000);
      entry.timer.unref?.();
      this.queue.push(entry);
      this.drain();
    });
  }

  drain() {
    while (this.active.size < this.globalLimit) {
      const available = this.queue.filter(entry =>
        [...this.active.values()].filter(e => e.tabId === entry.tabId).length < this.tabLimit);
      available.sort((a, b) => {
        const rank = e => (e.kind === "audio" ? 0 : e.kind === "probe" ? 2 : 1)
          - Math.floor((Date.now() - e.queuedAt) / 2000);
        return rank(a) - rank(b) || a.queuedAt - b.queuedAt;
      });
      const entry = available[0];
      if (!entry) break;
      this.queue.splice(this.queue.indexOf(entry), 1);
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.release(entry.sessionId, entry.id), this.leaseMs);
      entry.timer.unref?.();
      this.active.set(entry.key, entry);
      this.peak = Math.max(this.peak, this.active.size);
      entry.resolve({ id: entry.id, ...this.stats(entry.tabId) });
    }
  }

  release(sessionId, id) {
    const key = this.key(sessionId, id);
    const active = this.active.get(key);
    if (active) {
      clearTimeout(active.timer);
      this.active.delete(key);
    }
    const queued = this.queue.find(e => e.key === key);
    if (queued) {
      clearTimeout(queued.timer);
      this.queue.splice(this.queue.indexOf(queued), 1);
      queued.reject(new Error("Transfer cancelled"));
    }
    this.drain();
  }

  drop(sessionId) {
    for (const entry of [...this.queue, ...this.active.values()]) {
      if (entry.sessionId === sessionId) this.release(sessionId, entry.id);
    }
  }

  stats(tabId) {
    return {
      transferActive: this.active.size,
      transferQueued: this.queue.length,
      transferTabActive: [...this.active.values()].filter(e => e.tabId === tabId).length,
      transferPeak: this.peak,
      transferLimit: this.globalLimit,
      transferTabLimit: this.tabLimit
    };
  }
}
