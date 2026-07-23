import assert from "node:assert/strict";
import test from "node:test";
import {
  STREAM_POLICY,
  advanceHostCircuit,
  beginHostRecovery,
  confirmHostRecovery,
  createHostCircuit,
  hostCanAttempt,
  isSoftThroughputFailure,
  noteHealthySegment,
  noteHostFailure
} from "../../src/lib/stream-policy.js";

test("hard failures open immediately and admit only after cooldown", () => {
  const opened = noteHostFailure(createHostCircuit(0), {
    severity: "hard",
    reason: "HTTP 0",
    now: 100
  });
  assert.equal(opened.opened, true);
  assert.equal(opened.state.circuit, "open");
  assert.equal(opened.state.cooldownUntil, 100 + 60_000);
  assert.equal(hostCanAttempt(opened.state, 60_099), false);
  assert.equal(hostCanAttempt(opened.state, 60_100), true);
  assert.equal(
    advanceHostCircuit(opened.state, 60_100).state.circuit,
    "half-open"
  );
});

test("one soft window does not open but two consecutive windows do", () => {
  const first = noteHostFailure(createHostCircuit(0), {
    severity: "soft",
    reason: "slow-body",
    now: 100
  });
  assert.equal(first.opened, false);
  assert.equal(first.state.softFailures, 1);
  const second = noteHostFailure(first.state, {
    severity: "soft",
    reason: "slow-body",
    now: 200
  });
  assert.equal(second.opened, true);
  assert.equal(second.state.circuit, "open");
  assert.equal(second.state.cooldownUntil, 200 + 30_000);
});

test("half-open requires two healthy segments and playback progress", () => {
  const opened = noteHostFailure(createHostCircuit(0), {
    now: 0,
    severity: "hard"
  }).state;
  const halfOpen = beginHostRecovery(opened, {
    now: STREAM_POLICY.hardCooldownMs,
    bufferAhead: 0,
    currentTime: 10
  });
  assert.equal(halfOpen.circuit, "half-open");
  const first = noteHealthySegment(halfOpen, {
    now: 60_100,
    throughputBps: 2_000_000,
    bufferAhead: 0,
    currentTime: 10
  });
  assert.equal(first.recovered, false);
  const second = noteHealthySegment(first.state, {
    now: 60_200,
    throughputBps: 2_000_000,
    bufferAhead: 2,
    currentTime: 11
  });
  assert.equal(second.recovered, true);
  assert.equal(second.state.circuit, "closed");
});

test("HTTP success without playback progress reopens after recovery deadline", () => {
  const opened = noteHostFailure(createHostCircuit(0), {
    now: 0,
    severity: "hard"
  }).state;
  const halfOpen = beginHostRecovery(opened, {
    now: 60_000,
    bufferAhead: 0,
    currentTime: 10
  });
  const result = noteHealthySegment(halfOpen, {
    now: 65_001,
    throughputBps: 3_000_000,
    bufferAhead: 0,
    currentTime: 10
  });
  assert.equal(result.recovered, false);
  assert.equal(result.state.circuit, "open");
  assert.equal(result.state.lastReason, "recovery-timeout");
});

test("throughput risk requires both low buffer and insufficient bandwidth", () => {
  assert.equal(
    isSoftThroughputFailure({
      throughputBps: 1_000_000,
      bandwidth: 1_000_000,
      bufferAhead: 2
    }),
    true
  );
  assert.equal(
    isSoftThroughputFailure({
      throughputBps: 1_000_000,
      bandwidth: 1_000_000,
      bufferAhead: 12
    }),
    false
  );
});

test("a recovery acknowledgement cannot close a host before cooldown", () => {
  const opened = noteHostFailure(createHostCircuit(0), {
    severity: "hard",
    now: 100
  }).state;
  const early = confirmHostRecovery(opened, 1_000);
  assert.equal(early.recovered, false);
  assert.equal(early.state.circuit, "open");

  const admitted = confirmHostRecovery(
    opened,
    100 + STREAM_POLICY.hardCooldownMs
  );
  assert.equal(admitted.recovered, true);
  assert.equal(admitted.state.circuit, "closed");
});
