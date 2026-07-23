export const PROBE_SCHEDULER_LIMITS = Object.freeze({
  globalConcurrency: 4,
  perTabConcurrency: 1,
  globalBytesPerMinute: 8 * 1024 * 1024,
  perTabBytesPerMinute: 2 * 1024 * 1024,
  windowMs: 60_000
});

function abortError(reason = "Probe cancelled") {
  return new DOMException(String(reason), "AbortError");
}

export class ProbeScheduler {
  constructor({
    limits = PROBE_SCHEDULER_LIMITS,
    now = () => Date.now()
  } = {}) {
    this.limits = { ...PROBE_SCHEDULER_LIMITS, ...limits };
    this.now = now;
    this.queues = new Map();
    this.tabOrder = [];
    this.cursor = 0;
    this.active = new Map();
    this.activeGlobal = 0;
    this.activeByTab = new Map();
    this.reservedGlobal = 0;
    this.reservedByTab = new Map();
    this.byteEvents = [];
    this.nextId = 1;
  }

  schedule({ tabId, estimatedBytes, run }) {
    if (!Number.isInteger(tabId) || tabId < 0 || typeof run !== "function") {
      return Promise.reject(new Error("Invalid probe scheduling input"));
    }
    const reservation = Math.max(0, Number(estimatedBytes) || 0);
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(tabId) ?? [];
      queue.push({
        id: this.nextId++,
        tabId,
        estimatedBytes: reservation,
        run,
        resolve,
        reject
      });
      this.queues.set(tabId, queue);
      if (!this.tabOrder.includes(tabId)) {
        this.tabOrder.push(tabId);
      }
      this.drain();
    });
  }

  trimBytes() {
    const cutoff = this.now() - this.limits.windowMs;
    while (this.byteEvents[0]?.at < cutoff) {
      this.byteEvents.shift();
    }
  }

  usedBytes(tabId) {
    this.trimBytes();
    let global = 0;
    let tab = 0;
    for (const event of this.byteEvents) {
      global += event.bytes;
      if (event.tabId === tabId) {
        tab += event.bytes;
      }
    }
    return { global, tab };
  }

  canReserve(tabId, bytes) {
    const used = this.usedBytes(tabId);
    return (
      used.global + this.reservedGlobal + bytes <=
        this.limits.globalBytesPerMinute &&
      used.tab + (this.reservedByTab.get(tabId) ?? 0) + bytes <=
        this.limits.perTabBytesPerMinute
    );
  }

  reserve(tabId, bytes) {
    this.reservedGlobal += bytes;
    this.reservedByTab.set(
      tabId,
      (this.reservedByTab.get(tabId) ?? 0) + bytes
    );
  }

  releaseReservation(tabId, reserved, actualBytes) {
    this.reservedGlobal = Math.max(0, this.reservedGlobal - reserved);
    const remaining = Math.max(
      0,
      (this.reservedByTab.get(tabId) ?? 0) - reserved
    );
    if (remaining) {
      this.reservedByTab.set(tabId, remaining);
    } else {
      this.reservedByTab.delete(tabId);
    }
    const bytes = Math.max(0, Number(actualBytes) || 0);
    if (bytes) {
      this.byteEvents.push({ tabId, bytes, at: this.now() });
    }
  }

  nextTask() {
    if (!this.tabOrder.length) {
      return null;
    }
    let checked = 0;
    while (checked < this.tabOrder.length) {
      this.cursor %= this.tabOrder.length;
      const tabId = this.tabOrder[this.cursor];
      this.cursor = (this.cursor + 1) % this.tabOrder.length;
      checked += 1;
      const queue = this.queues.get(tabId);
      if (!queue?.length) {
        this.queues.delete(tabId);
        this.tabOrder = this.tabOrder.filter((entry) => entry !== tabId);
        this.cursor = 0;
        continue;
      }
      if (
        (this.activeByTab.get(tabId) ?? 0) >=
        this.limits.perTabConcurrency
      ) {
        continue;
      }
      const task = queue[0];
      if (!this.canReserve(tabId, task.estimatedBytes)) {
        queue.shift();
        task.reject(new Error("Probe byte budget exceeded"));
        checked -= 1;
        continue;
      }
      queue.shift();
      return task;
    }
    return null;
  }

  drain() {
    while (this.activeGlobal < this.limits.globalConcurrency) {
      const task = this.nextTask();
      if (!task) {
        break;
      }
      this.start(task);
    }
  }

  start(task) {
    const controller = new AbortController();
    this.reserve(task.tabId, task.estimatedBytes);
    this.activeGlobal += 1;
    this.activeByTab.set(
      task.tabId,
      (this.activeByTab.get(task.tabId) ?? 0) + 1
    );
    this.active.set(task.id, { task, controller });
    Promise.resolve()
      .then(() => task.run(controller.signal))
      .then(
        (result) => {
          const wrapped =
            result && typeof result === "object" && "value" in result
              ? result
              : { value: result, bytes: 0 };
          this.finish(task, wrapped.bytes);
          task.resolve(wrapped.value);
        },
        (error) => {
          this.finish(task, 0);
          task.reject(error);
        }
      );
  }

  finish(task, actualBytes) {
    this.active.delete(task.id);
    this.activeGlobal = Math.max(0, this.activeGlobal - 1);
    const tabActive = Math.max(
      0,
      (this.activeByTab.get(task.tabId) ?? 0) - 1
    );
    if (tabActive) {
      this.activeByTab.set(task.tabId, tabActive);
    } else {
      this.activeByTab.delete(task.tabId);
    }
    this.releaseReservation(
      task.tabId,
      task.estimatedBytes,
      actualBytes
    );
    this.drain();
  }

  cancelTab(tabId, reason = "Probe tab cancelled") {
    const queued = this.queues.get(tabId) ?? [];
    this.queues.delete(tabId);
    this.tabOrder = this.tabOrder.filter((entry) => entry !== tabId);
    this.cursor = 0;
    for (const task of queued) {
      task.reject(abortError(reason));
    }
    for (const { task, controller } of this.active.values()) {
      if (task.tabId === tabId) {
        controller.abort(reason);
      }
    }
  }

  cancelAll(reason = "Probe scheduler cancelled") {
    for (const tabId of [...this.queues.keys(), ...this.activeByTab.keys()]) {
      this.cancelTab(tabId, reason);
    }
  }

  snapshot() {
    this.trimBytes();
    const bytesByTab = {};
    for (const event of this.byteEvents) {
      bytesByTab[event.tabId] =
        (bytesByTab[event.tabId] ?? 0) + event.bytes;
    }
    return {
      activeGlobal: this.activeGlobal,
      activeByTab: Object.fromEntries(this.activeByTab),
      queuedByTab: Object.fromEntries(
        [...this.queues].map(([tabId, queue]) => [tabId, queue.length])
      ),
      bytesByTab,
      bytesInWindow: this.byteEvents.reduce(
        (sum, event) => sum + event.bytes,
        0
      )
    };
  }
}
