export const STREAM_POLICY = Object.freeze({
  hardCooldownMs: 60_000,
  softCooldownMs: 30_000,
  softFailureWindows: 2,
  healthySegmentsToClose: 2,
  recoveryDeadlineMs: 5_000,
  lowBufferSeconds: 8,
  requiredThroughputFactor: 1.25,
  ewmaAlpha: 0.35
});

export function createHostCircuit(now = 0) {
  return {
    circuit: "closed",
    cooldownUntil: 0,
    softFailures: 0,
    healthySegments: 0,
    ewmaThroughputBps: 0,
    recoveryStartedAt: 0,
    recoveryBaselineBuffer: 0,
    recoveryBaselineTime: 0,
    lastTransitionAt: Math.max(0, Number(now) || 0),
    lastReason: ""
  };
}

function normalizedCircuit(input, now) {
  return {
    ...createHostCircuit(now),
    ...(input && typeof input === "object" ? input : {})
  };
}

function openCircuit(state, now, cooldownMs, reason) {
  return {
    ...state,
    circuit: "open",
    cooldownUntil: now + cooldownMs,
    softFailures: 0,
    healthySegments: 0,
    lastTransitionAt: now,
    lastReason: String(reason ?? "").slice(0, 60)
  };
}

export function advanceHostCircuit(input, now = Date.now()) {
  const current = normalizedCircuit(input, now);
  if (current.circuit !== "open" || now < current.cooldownUntil) {
    return { state: current, changed: false };
  }
  return {
    state: {
      ...current,
      circuit: "half-open",
      healthySegments: 0,
      lastTransitionAt: now,
      lastReason: "cooldown-expired"
    },
    changed: true
  };
}

export function noteHostFailure(
  input,
  {
    severity = "hard",
    reason = "media-failure",
    now = Date.now(),
    hardCooldownMs = STREAM_POLICY.hardCooldownMs,
    softCooldownMs = STREAM_POLICY.softCooldownMs
  } = {}
) {
  const advanced = advanceHostCircuit(input, now).state;
  if (advanced.circuit === "open" && now < advanced.cooldownUntil) {
    return { state: advanced, changed: false, opened: true };
  }
  if (severity === "soft" && advanced.circuit === "closed") {
    const softFailures = advanced.softFailures + 1;
    if (softFailures < STREAM_POLICY.softFailureWindows) {
      return {
        state: {
          ...advanced,
          softFailures,
          lastReason: String(reason).slice(0, 60)
        },
        changed: false,
        opened: false
      };
    }
    return {
      state: openCircuit(advanced, now, softCooldownMs, reason),
      changed: true,
      opened: true
    };
  }
  return {
    state: openCircuit(advanced, now, hardCooldownMs, reason),
    changed: true,
    opened: true
  };
}

export function beginHostRecovery(
  input,
  {
    now = Date.now(),
    bufferAhead = 0,
    currentTime = 0
  } = {}
) {
  const advanced = advanceHostCircuit(input, now).state;
  return {
    ...advanced,
    recoveryStartedAt: now,
    recoveryBaselineBuffer: Math.max(0, Number(bufferAhead) || 0),
    recoveryBaselineTime: Math.max(0, Number(currentTime) || 0),
    healthySegments: 0
  };
}

export function noteHealthySegment(
  input,
  {
    now = Date.now(),
    throughputBps = 0,
    bufferAhead = 0,
    currentTime = 0
  } = {}
) {
  const current = advanceHostCircuit(input, now).state;
  const throughput = Math.max(0, Number(throughputBps) || 0);
  const ewmaThroughputBps = current.ewmaThroughputBps
    ? Math.round(
        current.ewmaThroughputBps * (1 - STREAM_POLICY.ewmaAlpha) +
          throughput * STREAM_POLICY.ewmaAlpha
      )
    : Math.round(throughput);
  const healthySegments = current.healthySegments + 1;
  const playbackAdvanced =
    Number(bufferAhead) > current.recoveryBaselineBuffer ||
    Number(currentTime) > current.recoveryBaselineTime;
  const recoveryExpired =
    current.recoveryStartedAt > 0 &&
    now - current.recoveryStartedAt > STREAM_POLICY.recoveryDeadlineMs;

  if (
    current.circuit === "half-open" &&
    healthySegments >= STREAM_POLICY.healthySegmentsToClose &&
    playbackAdvanced
  ) {
    return {
      state: {
        ...current,
        circuit: "closed",
        cooldownUntil: 0,
        softFailures: 0,
        healthySegments,
        ewmaThroughputBps,
        lastTransitionAt: now,
        lastReason: "recovered"
      },
      changed: true,
      recovered: true
    };
  }
  if (current.circuit === "half-open" && recoveryExpired && !playbackAdvanced) {
    return {
      state: openCircuit(
        current,
        now,
        STREAM_POLICY.softCooldownMs,
        "recovery-timeout"
      ),
      changed: true,
      recovered: false
    };
  }
  return {
    state: {
      ...current,
      healthySegments,
      ewmaThroughputBps,
      lastReason: "healthy-segment"
    },
    changed: false,
    recovered: false
  };
}

export function confirmHostRecovery(input, now = Date.now()) {
  const current = advanceHostCircuit(input, now).state;
  if (current.circuit !== "half-open") {
    return { state: current, changed: false, recovered: false };
  }
  return {
    state: {
      ...current,
      circuit: "closed",
      cooldownUntil: 0,
      softFailures: 0,
      lastTransitionAt: now,
      lastReason: "recovered"
    },
    changed: true,
    recovered: true
  };
}

export function hostCanAttempt(input, now = Date.now()) {
  const { state } = advanceHostCircuit(input, now);
  return state.circuit !== "open";
}

export function isSoftThroughputFailure({
  throughputBps,
  bandwidth,
  bufferAhead
}) {
  const measured = Math.max(0, Number(throughputBps) || 0);
  const required =
    Math.max(0, Number(bandwidth) || 0) *
    STREAM_POLICY.requiredThroughputFactor;
  return (
    required > 0 &&
    Number(bufferAhead) < STREAM_POLICY.lowBufferSeconds &&
    measured < required
  );
}
