import assert from "node:assert/strict";
import test from "node:test";
import {
  PROBE_SCHEDULER_LIMITS,
  ProbeScheduler
} from "../../src/lib/probe-scheduler.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("probe scheduler enforces global four and per-tab one with fair starts", async () => {
  const scheduler = new ProbeScheduler();
  const running = [];
  const gates = [];
  const jobs = [];
  for (let index = 0; index < 30; index += 1) {
    const tabId = index % 10;
    const gate = deferred();
    gates.push(gate);
    jobs.push(
      scheduler.schedule({
        tabId,
        estimatedBytes: 256,
        run: async () => {
          running.push(tabId);
          await gate.promise;
          return { value: tabId, bytes: 256 };
        }
      })
    );
  }
  await Promise.resolve();
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.activeGlobal, 4);
  assert.ok(Object.values(snapshot.activeByTab).every((count) => count === 1));
  assert.equal(new Set(running.slice(0, 4)).size, 4);

  for (const gate of gates) {
    gate.resolve();
    await Promise.resolve();
  }
  await Promise.all(jobs);
  assert.equal(new Set(running).size, 10);
  assert.equal(scheduler.snapshot().bytesInWindow, 30 * 256);
});

test("cancelling a tab aborts running work and rejects its queued jobs", async () => {
  const scheduler = new ProbeScheduler();
  const running = scheduler.schedule({
    tabId: 7,
    estimatedBytes: 256,
    run: (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true }
        );
      })
  });
  const queued = scheduler.schedule({
    tabId: 7,
    estimatedBytes: 256,
    run: async () => ({ value: true, bytes: 256 })
  });
  await Promise.resolve();
  scheduler.cancelTab(7);
  await assert.rejects(running, /cancelled/i);
  await assert.rejects(queued, /cancelled/i);
  assert.equal(scheduler.snapshot().activeGlobal, 0);
});

test("probe scheduler rejects work beyond the per-tab byte budget", async () => {
  const scheduler = new ProbeScheduler();
  const estimate = PROBE_SCHEDULER_LIMITS.perTabBytesPerMinute;
  await scheduler.schedule({
    tabId: 3,
    estimatedBytes: estimate,
    run: async () => ({ value: true, bytes: estimate })
  });
  assert.equal(scheduler.snapshot().bytesByTab[3], estimate);
  await assert.rejects(
    scheduler.schedule({
      tabId: 3,
      estimatedBytes: 1,
      run: async () => true
    }),
    /byte budget exceeded/i
  );
});
