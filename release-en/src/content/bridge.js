(() => {
  "use strict";

  const CHANNEL = "bilibili-speedup";
  const INIT_EVENT = `${CHANNEL}:init`;
  const READY_EVENT = `${CHANNEL}:ready`;
  const MAX_PRESENTATIONS = 4;
  const MAX_ROUTES_PER_PRESENTATION = 32;
  const MAX_PLAYERS = 4;
  const MAX_CRITICAL_EVENTS = 64;
  const MAX_ORDINARY_EVENTS = 32;
  const MAX_BEACON_AGGREGATES = 16;
  const HIDDEN_IDLE_SUSPEND_MS = 15_000;
  const PLAYBACK_RISK_CONFIRM_MS = 2_500;
  const PAGE_PROBE_BYTES = 262_144;
  const PAGE_PROBE_TIMEOUT_MS = 3_000;
  const MAX_RECOVERY_SWEEP_PROBES = 4;
  const RECOVERY_PROBE_BACKOFF_MS = 30_000;
  const RECOVERY_PROBE_BUDGET_RETRY_MS = 30_000;
  const RECOVERY_BUDGET_BYPASS_MS = 60_000;
  const CRITICAL_EVENT_TYPES = new Set([
    "fallback",
    "handoff-triggered",
    "media-degraded",
    "playback-risk",
    "probe-recovery-exhausted",
    "route-policy",
    "route-policy-error",
    "route-recovery-failed",
    "route-recovered",
    "route-switch",
    "stalled",
    "waiting"
  ]);
  let documentStartedAt = Date.now();
  const dispatchDocumentEvent = document.dispatchEvent.bind(document);
  let config = null;
  let refreshTimer = null;
  let privateInboundEvent = "";
  let privateOutboundEvent = "";
  let privateOutboundListener = null;
  let mainChannelReady = false;
  let mainConnectAttempts = 0;
  let sessionSerial = 0;
  let session = createSession();
  let currentNavigationKey = playbackNavigationKey(location.href);
  let routingTabId = null;
  let sessionStartedPerformance = performance.now();
  let sessionPlayerSerial = 0;
  let localCosmeticStyle = null;
  const observedVideos = new WeakSet();
  const videoStates = new WeakMap();
  const activePlayers = new Map();
  const probedKeys = new Set();
  const probeCountsByPresentation = new Map();
  const probeReferenceKeys = new Set();
  const probeReferenceCountsByPresentation = new Map();
  const probeRecoveryKeys = new Set();
  const degradationProbeKeys = new Set();
  const recoveryProbeBackoffs = new Map();
  const recoveryTriggerBackoffs = new Map();
  const recoveryProbeRetryTimers = new Map();
  const recoveryTimers = new Map();
  const activePageProbes = new Map();
  const pendingDiagnosticSessions = new Map();
  let diagnosticTimer = null;
  let latestRoutes = [];
  let routeRegistrationPromise = Promise.resolve(null);
  let routingSuspended = false;
  let lifecycleTimer = null;

  function handleMainMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }
    const payload = message.payload ?? {};
    switch (message.type) {
      case "PROBE_URL":
        requestProbe(payload.mediaUrl, payload);
        break;
      case "PROBE_REFERENCE":
        requestProbe(payload.mediaUrl, {
          ...payload,
          observedReference: true
        });
        break;
      case "ROUTE_MANIFEST": {
        if (!isPlaybackPage(session.pageUrl)) {
          sendToMain("ROUTE_POLICY_READY", {
            requestId: String(payload.requestId ?? "").slice(0, 80)
          });
          break;
        }
        const plannedHost = firstRouteHost(payload.routes);
        if (!session.plannedMediaHost && plannedHost) {
          session.plannedMediaHost = plannedHost;
          addEvent("media-plan", plannedHost);
          recordSession();
        }
        for (const route of Array.isArray(payload.routes)
          ? payload.routes.slice(0, 64)
          : []) {
          const detail = ensureRouteDetail(route);
          const rawUrl = Array.isArray(route?.urls) ? route.urls[0] : "";
          if (detail && rawUrl) {
            try {
              detail.plannedHost = new URL(rawUrl, location.href).hostname.slice(
                0,
                255
              );
            } catch {
              // The service worker performs the authoritative URL validation.
            }
          }
        }
        routeRegistrationPromise = registerMediaRoutes(payload.routes);
        void routeRegistrationPromise.finally(() => {
          sendToMain("ROUTE_POLICY_READY", {
            requestId: String(payload.requestId ?? "").slice(0, 80)
          });
        });
        break;
      }
      case "MEDIA_REWRITE":
        session.rewritten = true;
        session.rewriteCount += 1;
        if (!session.plannedMediaHost && payload.host) {
          session.plannedMediaHost = String(payload.host).slice(0, 255);
        }
        addEvent("rewrite", "", `${Number(payload.streams) || 0} streams`);
        recordSession();
        break;
      case "PRESENTATION_CAPACITY":
        addEvent(
          "presentation-capacity",
          "",
          `${Math.max(0, Number(payload.droppedRoutes) || 0)} routes dropped; max ${Math.max(0, Number(payload.maxPresentations) || 0)} presentations`
        );
        recordSession();
        break;
      case "MEDIA_HOST":
        updateRouteHost(payload, Boolean(payload.rewritten), false);
        session.rewritten ||= Boolean(payload.rewritten);
        addEvent(
          "media-host",
          String(payload.host ?? "").slice(0, 255),
          routeEventDetail(payload)
        );
        recordSession();
        break;
      case "MEDIA_DEGRADED":
        {
          const detail = ensureRouteDetail(payload);
          if (requestObservationIsOlder(detail, payload)) {
            addEvent(
              "media-degraded-stale",
              String(payload.host ?? "").slice(0, 255),
              routeEventDetail(payload)
            );
            recordSession();
            break;
          }
        }
        session.degradedCount += 1;
        session.lastThroughputBps = Math.max(
          0,
          Number(payload.throughputBps) || 0
        );
        session.lastBufferAhead = Math.max(
          0,
          Number(payload.bufferAhead) || 0
        );
        {
          const detail = ensureRouteDetail(payload);
          if (detail) {
            detail.degradedCount += 1;
            detail.lastThroughputBps = session.lastThroughputBps;
            detail.lastRequiredBps = Math.max(
              0,
              Number(payload.requiredBps) || 0
            );
            detail.lastBufferAhead = session.lastBufferAhead;
            applyTransferTelemetry(detail, payload);
            detail.updatedAt = Date.now();
            applyRouteSummary(detail);
          }
        }
        addEvent(
          "media-degraded",
          String(payload.host ?? "").slice(0, 255),
          `${routeEventDetail(payload)}; ${String(payload.reason ?? "")}; ${session.lastThroughputBps}bps; buffer ${session.lastBufferAhead.toFixed(2)}s${transferEventDetail(payload)}`
        );
        {
          const degradationSessionId = session.id;
          void Promise.resolve(degradeHost(payload)).then((response) => {
            if (
              session.id === degradationSessionId &&
              response?.ok &&
              response.escalated === true &&
              response.exhausted === true
            ) {
              requestRecoveryProbe(payload);
              requestNativeRouteBypass(payload, "route-exhausted");
            }
          });
        }
        recordSession();
        break;
      case "HANDOFF_TRIGGERED": {
        session.fallbackCount += 1;
        const detail = ensureRouteDetail(payload);
        if (detail) {
          detail.fallbackCount += 1;
          detail.recoveryStatus = "handoff";
          detail.recoveryStartedAt = Date.now();
          detail.recoveryBaselineBuffer = Math.max(
            0,
            Number(payload.bufferAhead) || 0
          );
          detail.updatedAt = Date.now();
          applyRouteSummary(detail);
        }
        addEvent(
          "handoff-triggered",
          String(payload.fromHost ?? "").slice(0, 255),
          `${routeEventDetail(payload)}; ${String(payload.fromHost ?? "").slice(0, 255)} -> ${String(payload.toHost ?? "").slice(0, 255)}`
        );
        recordSession();
        break;
      }
      case "MEDIA_REQUEST_RESULT": {
        const status = Math.max(0, Number(payload.status) || 0);
        const bytes = Math.max(0, Number(payload.bytes) || 0);
        // A completed attempt is not evidence that the attempted host became
        // the active route. In particular, XHR loadend also fires for status 0,
        // timeouts and errors. Only an observed successful body may advance
        // mediaHost or start route-recovery verification.
        const successfulBody =
          status >= 200 && status < 300 && bytes > 0;
        const existingDetail = ensureRouteDetail(payload);
        const staleSuccessfulBody =
          successfulBody &&
          requestObservationIsOlder(existingDetail, payload);
        if (staleSuccessfulBody) {
          if (existingDetail) {
            existingDetail.lastAttemptedHost = String(
              payload.host ?? ""
            ).slice(0, 255);
          }
          addEvent(
            "media-result-stale",
            String(payload.host ?? "").slice(0, 255),
            routeEventDetail(payload)
          );
          recordSession();
          break;
        }
        const detail = successfulBody
          ? updateRouteHost(payload, false, true)
          : existingDetail;
        session.lastThroughputBps = Math.max(
          0,
          Number(payload.throughputBps) || 0
        );
        session.lastBufferAhead = Math.max(
          0,
          Number(payload.bufferAhead) || 0
        );
        if (detail) {
          detail.lastThroughputBps = session.lastThroughputBps;
          detail.lastBufferAhead = session.lastBufferAhead;
          detail.lastAttemptedHost = String(
            payload.host ?? ""
          ).slice(0, 255);
          if (successfulBody) {
            noteRequestObservation(detail, payload);
          }
          detail.lastStatus = status;
          detail.lastBytes = bytes;
          applyTransferTelemetry(detail, payload);
          detail.updatedAt = Date.now();
          if (successfulBody) {
            evaluateRouteRecovery(detail, payload);
          }
          applyRouteSummary(detail);
        }
        recordSession();
        break;
      }
      case "MEDIA_REQUEST_CANCELLED": {
        const detail = ensureRouteDetail(payload);
        if (detail) {
          detail.lastBytes = Math.max(0, Number(payload.bytes) || 0);
          applyTransferTelemetry(detail, payload);
          detail.updatedAt = Date.now();
          applyRouteSummary(detail);
        }
        addEvent(
          "media-cancelled",
          String(payload.host ?? "").slice(0, 255),
          `${routeEventDetail(payload)}; ${String(payload.reason ?? "cancelled")}${transferEventDetail(payload)}`
        );
        recordSession();
        break;
      }
      case "FALLBACK":
        session.fallbackCount += 1;
        {
          const detail = ensureRouteDetail(payload);
          if (detail) {
            detail.fallbackCount += 1;
            detail.updatedAt = Date.now();
          }
        }
        addEvent(
          "fallback",
          String(payload.host ?? "").slice(0, 255),
          `${routeEventDetail(payload)}; ${String(payload.detail ?? "")}`
        );
        recordSession();
        break;
      case "BEACON_BLOCKED":
        session.blockedBeaconCount += 1;
        aggregateBlockedBeacon(payload.url);
        recordSession();
        break;
      case "NAVIGATION":
        startNewSession(payload.url);
        break;
      case "CONFIG_READY":
        addEvent(
          "config-ready",
          "",
          `${Math.max(0, Number(payload.elapsedMs) || 0)}ms`
        );
        recordSession();
        break;
      case "STARTUP_PASSTHROUGH":
        addEvent(
          "startup-pass-through",
          "",
          `${Math.max(0, Number(payload.elapsedMs) || 0)}ms; ` +
            `readyWithinBudget=${Boolean(payload.readyWithinBudget)}; ` +
            `configReady=${Boolean(payload.configReady)}`
        );
        recordSession();
        break;
      default:
        break;
    }
  }

  function normalizedPresentationId(value) {
    const raw = String(value ?? "").slice(0, 160);
    return /^[a-zA-Z0-9._:-]{1,160}$/.test(raw) ? raw : "unassigned";
  }

  function normalizedRouteKey(value) {
    return String(value ?? "").slice(0, 1000);
  }

  function normalizedKind(value) {
    const kind = String(value ?? "").toLowerCase();
    return ["audio", "video", "mp4", "media"].includes(kind)
      ? kind
      : "media";
  }

  // Keep in sync with main-world.js and service-worker.js.
  function isPlaybackPage(raw = location.href) {
    try {
      const url = new URL(raw, location.href);
      if (
        !["www.bilibili.com", "m.bilibili.com"].includes(
          url.hostname.toLowerCase()
        )
      ) {
        return false;
      }
      return (
        /^\/video\/(?:BV[0-9a-z_-]+|av\d+)(?:\/|$)/i.test(url.pathname) ||
        /^\/bangumi\/play\/(?:ep|ss|md)\d+(?:\/|$)/i.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  function playbackNavigationKey(raw = location.href) {
    try {
      const url = new URL(raw, location.href);
      if (!isPlaybackPage(url.href)) {
        return "non-playback";
      }
      const video = url.pathname.match(
        /^\/video\/(BV[0-9a-z_-]+|av\d+)(?:\/|$)/i
      )?.[1];
      if (video) {
        const rawPart = Number.parseInt(url.searchParams.get("p") ?? "1", 10);
        const part = Number.isFinite(rawPart) && rawPart > 1 ? rawPart : 1;
        return `video:${video.toLowerCase()}:p=${part}`;
      }
      const bangumi = url.pathname.match(
        /^\/bangumi\/play\/((?:ep|ss|md)\d+)(?:\/|$)/i
      )?.[1];
      return bangumi
        ? `bangumi:${bangumi.toLowerCase()}`
        : `playback:${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
    } catch {
      return "non-playback";
    }
  }

  function routeDetailId(payload) {
    const routeKey = normalizedRouteKey(payload?.routeKey);
    if (!routeKey) {
      return "";
    }
    return `${normalizedPresentationId(payload?.presentationId)}::${routeKey}`;
  }

  function ensureRouteDetail(payload) {
    const id = routeDetailId(payload);
    if (!id) {
      return null;
    }
    let detail = session.routeDetails[id];
    if (!detail) {
      const routes = Object.values(session.routeDetails);
      const presentationId = normalizedPresentationId(
        payload?.presentationId
      );
      const presentations = new Set(
        routes.map((route) => route.presentationId)
      );
      if (
        (!presentations.has(presentationId) &&
          presentations.size >= MAX_PRESENTATIONS) ||
        routes.filter(
          (route) => route.presentationId === presentationId
        ).length >= MAX_ROUTES_PER_PRESENTATION
      ) {
        return null;
      }
      detail = {
        id,
        presentationId,
        routeKey: normalizedRouteKey(payload?.routeKey),
        kind: normalizedKind(payload?.kind),
        bandwidth: Math.min(
          200_000_000,
          Math.max(0, Number(payload?.bandwidth) || 0)
        ),
        plannedHost: "",
        mediaHost: "",
        routeSwitchCount: 0,
        degradedCount: 0,
        fallbackCount: 0,
        lastThroughputBps: 0,
        lastRequiredBps: 0,
        lastBufferAhead: 0,
        lastStatus: 0,
        lastBytes: 0,
        lastExpectedBytes: 0,
        lastDurationMs: 0,
        lastProgressAgeMs: 0,
        lastResponseRange: "",
        lastAttemptedHost: "",
        latestSuccessfulRequestStartedAt: 0,
        latestSuccessfulRoutingGeneration: 0,
        lastObservedAt: 0,
        recoveryStatus: "idle",
        recoveryStartedAt: 0,
        recoveryBaselineBuffer: 0,
        recoveryHealthySegments: 0,
        rewritten: false,
        updatedAt: Date.now()
      };
      session.routeDetails[id] = detail;
    } else {
      if (payload?.kind) {
        detail.kind = normalizedKind(payload.kind);
      }
      if (Number(payload?.bandwidth) > 0) {
        detail.bandwidth = Math.min(
          200_000_000,
          Math.max(0, Number(payload.bandwidth) || 0)
        );
      }
    }
    return detail;
  }

  function applyRouteSummary(detail) {
    if (!detail) {
      return;
    }
    session.mediaHost = detail.mediaHost;
    session.activeRouteKey = detail.routeKey;
    session.lastThroughputBps = detail.lastThroughputBps;
    session.lastBufferAhead = detail.lastBufferAhead;
    session.routeSwitchCount = Object.values(session.routeDetails).reduce(
      (sum, route) => sum + Math.max(0, Number(route.routeSwitchCount) || 0),
      0
    );
  }

  function updateRouteHost(payload, rewritten, observableResult = false) {
    const detail = ensureRouteDetail(payload);
    if (!detail) {
      return null;
    }
    const host = String(payload?.host ?? "").slice(0, 255);
    detail.requestResultsObserved ||= Boolean(observableResult);
    if (host && detail.mediaHost && detail.mediaHost !== host) {
      detail.routeSwitchCount += 1;
      if (detail.requestResultsObserved) {
        beginRouteRecovery(detail);
      } else {
        detail.recoveryStatus = "diagnostic-only";
      }
      addEvent("route-switch", host, routeEventDetail(payload));
    }
    if (host) {
      detail.mediaHost = host;
      detail.lastObservedAt = Date.now();
    }
    detail.rewritten ||= Boolean(rewritten);
    detail.updatedAt = Date.now();
    applyRouteSummary(detail);
    return detail;
  }

  function requestObservationIsOlder(detail, payload) {
    if (!detail) {
      return false;
    }
    const generation = Math.max(
      0,
      Number(payload?.routingGeneration) || 0
    );
    const startedAt = Math.max(
      0,
      Number(payload?.requestStartedAt) || 0
    );
    const latestGeneration = Math.max(
      0,
      Number(detail.latestSuccessfulRoutingGeneration) || 0
    );
    const latestStartedAt = Math.max(
      0,
      Number(detail.latestSuccessfulRequestStartedAt) || 0
    );
    if (
      generation > 0 &&
      latestGeneration > 0 &&
      generation !== latestGeneration
    ) {
      return generation < latestGeneration;
    }
    return (
      startedAt > 0 &&
      latestStartedAt > 0 &&
      startedAt < latestStartedAt
    );
  }

  function noteRequestObservation(detail, payload) {
    const generation = Math.max(
      0,
      Number(payload?.routingGeneration) || 0
    );
    const startedAt = Math.max(
      0,
      Number(payload?.requestStartedAt) || 0
    );
    if (generation > 0) {
      detail.latestSuccessfulRoutingGeneration = Math.max(
        detail.latestSuccessfulRoutingGeneration,
        generation
      );
    }
    if (startedAt > 0) {
      detail.latestSuccessfulRequestStartedAt = Math.max(
        detail.latestSuccessfulRequestStartedAt,
        startedAt
      );
    }
  }

  function beginRouteRecovery(detail) {
    const id = detail.id;
    clearTimeout(recoveryTimers.get(id));
    detail.recoveryStatus = "pending";
    detail.recoveryStartedAt = Date.now();
    detail.recoveryBaselineBuffer = detail.lastBufferAhead;
    detail.recoveryHealthySegments = 0;
    detail.recoveryStrongTransfers = 0;
    const requestSessionId = session.id;
    scheduleRouteRecoveryDeadline(detail, requestSessionId);
  }

  function routeRecoveryIsPaused(detail) {
    if (document.hidden) {
      return true;
    }
    const matchingPlayers = Object.values(session.playerDetails).filter(
      (player) =>
        player.presentationId === detail.presentationId &&
        player.routeKey === detail.routeKey
    );
    return (
      matchingPlayers.length > 0 &&
      matchingPlayers.every((player) => player.paused)
    );
  }

  function scheduleRouteRecoveryDeadline(detail, requestSessionId) {
    const id = detail.id;
    const timer = setTimeout(() => {
      recoveryTimers.delete(id);
      if (
        session.id !== requestSessionId ||
        (
          detail.recoveryStatus !== "pending" &&
          detail.recoveryStatus !== "awaiting-evidence"
        )
      ) {
        return;
      }
      if (routeRecoveryIsPaused(detail)) {
        detail.recoveryStartedAt = Date.now();
        scheduleRouteRecoveryDeadline(detail, requestSessionId);
        return;
      }
      // Silence is not negative network evidence. The player may already have
      // ample buffered media and legitimately issue no request in this window.
      // Keep accepting later successful transfers, but never trip the circuit
      // solely because a fixed timer expired.
      detail.recoveryStatus = "awaiting-evidence";
      addEvent(
        "route-recovery-awaiting",
        detail.mediaHost,
        `${detail.presentationId} ${detail.kind} ${detail.routeKey}`
      );
      recordSession();
    }, 5000);
    recoveryTimers.set(id, timer);
  }

  function evaluateRouteRecovery(detail, payload) {
    if (
      detail.recoveryStatus !== "pending" &&
      detail.recoveryStatus !== "awaiting-evidence"
    ) {
      return;
    }
    const status = Math.max(0, Number(payload.status) || 0);
    const bytes = Math.max(0, Number(payload.bytes) || 0);
    if (status < 200 || status >= 300 || bytes <= 0) {
      return;
    }
    detail.recoveryHealthySegments += 1;
    const expectedBytes = Math.max(
      0,
      Number(payload.expectedBytes) || 0
    );
    const throughputBps = Math.max(
      0,
      Number(payload.throughputBps) || 0
    );
    const requiredBps = Math.max(
      0,
      Number(payload.requiredBps) ||
        (Number(detail.bandwidth) || 0) * 1.25
    );
    const fullTransfer =
      expectedBytes > 0 && bytes >= expectedBytes;
    if (
      fullTransfer &&
      (!requiredBps || throughputBps >= requiredBps)
    ) {
      detail.recoveryStrongTransfers += 1;
    }
    const playbackAdvanced =
      Number(payload.bufferAhead) > detail.recoveryBaselineBuffer;
    const transferProvedCapacity =
      detail.recoveryStrongTransfers >= 2;
    if (
      detail.recoveryHealthySegments < 2 ||
      (!playbackAdvanced && !transferProvedCapacity)
    ) {
      return;
    }
    detail.recoveryStatus = "confirming";
    clearTimeout(recoveryTimers.get(detail.id));
    recoveryTimers.delete(detail.id);
    recoverHost(detail);
  }

  function recoverHost(detail) {
    const requestSessionId = session.id;
    const resumePendingRecovery = () => {
      if (session.id !== requestSessionId) {
        return;
      }
      detail.recoveryStatus = "pending";
      detail.recoveryStartedAt = Date.now();
      detail.recoveryBaselineBuffer = detail.lastBufferAhead;
      detail.recoveryHealthySegments = 0;
      detail.recoveryStrongTransfers = 0;
      scheduleRouteRecoveryDeadline(detail, requestSessionId);
      recordSession();
    };
    chrome.runtime
      .sendMessage({
        type: "HOST_RECOVERED",
        sessionId: requestSessionId,
        ...(Number.isInteger(routingTabId) ? { routingTabId } : {}),
        host: detail.mediaHost,
        presentationId: detail.presentationId,
        kind: detail.kind,
        routeKey: detail.routeKey,
        healthySegments: detail.recoveryHealthySegments,
        bufferAhead: detail.lastBufferAhead
      })
      .then((response) => {
        if (
          response?.ok &&
          response.sessionId === session.id &&
          response.config
        ) {
          dispatchConfig(response.config);
        }
        if (
          response?.ok &&
          response.sessionId === session.id &&
          response.config
        ) {
          dispatchConfig(response.config);
        }
        if (
          response?.ok &&
          response.sessionId === session.id &&
          response.recovered
        ) {
          detail.recoveryStatus = "recovered";
          addEvent(
            "route-recovered",
            detail.mediaHost,
            `${detail.presentationId} ${detail.kind} ${detail.routeKey}; ${detail.recoveryHealthySegments} segments`
          );
          session.activeRuleCount = Math.max(
            0,
            Number(response.ruleCount) || 0
          );
          applyResourceStats(response.resourceStats);
          if (response.config) {
            dispatchConfig(response.config);
          }
          recordSession();
          return;
        }
        if (session.id !== requestSessionId) {
          return;
        }
        if (
          response?.ok &&
          response.sessionId === session.id &&
          response.circuit === "static-open"
        ) {
          detail.recoveryStatus = "static-open";
          addEvent(
            "route-recovery-failed",
            detail.mediaHost,
            `${detail.presentationId} ${detail.kind} ${detail.routeKey}; static blocked host cannot recover`
          );
          if (response.config) {
            dispatchConfig(response.config);
          }
          recordSession();
          return;
        }
        resumePendingRecovery();
      })
      .catch(resumePendingRecovery);
  }

  function routeEventDetail(payload) {
    return (
      `${normalizedPresentationId(payload?.presentationId)}` +
      ` ${normalizedKind(payload?.kind)}` +
      ` ${normalizedRouteKey(payload?.routeKey)}`
    ).trim();
  }

  function applyTransferTelemetry(detail, payload) {
    if (!detail) {
      return;
    }
    detail.lastExpectedBytes = Math.max(
      0,
      Number(payload?.expectedBytes) || 0
    );
    detail.lastDurationMs = Math.max(
      0,
      Math.round(Number(payload?.durationMs) || 0)
    );
    detail.lastProgressAgeMs = Math.max(
      0,
      Math.round(Number(payload?.progressAgeMs) || 0)
    );
    detail.lastResponseRange = String(payload?.responseRange ?? "").slice(
      0,
      160
    );
  }

  function transferEventDetail(payload) {
    const bytes = Math.max(0, Number(payload?.bytes) || 0);
    const expected = Math.max(0, Number(payload?.expectedBytes) || 0);
    const durationMs = Math.max(
      0,
      Math.round(Number(payload?.durationMs) || 0)
    );
    const progressAgeMs = Math.max(
      0,
      Math.round(Number(payload?.progressAgeMs) || 0)
    );
    const responseRange = String(payload?.responseRange ?? "").slice(0, 160);
    if (!bytes && !expected && !durationMs && !progressAgeMs && !responseRange) {
      return "";
    }
    return (
      `; bytes ${bytes}${expected ? `/${expected}` : ""}` +
      `${durationMs ? `; ${durationMs}ms` : ""}` +
      `${progressAgeMs ? `; idle ${progressAgeMs}ms` : ""}` +
      `${responseRange ? `; range ${responseRange}` : ""}`
    );
  }

  function sendToMain(type, payload) {
    if (mainChannelReady && privateInboundEvent) {
      dispatchDocumentEvent(
        new CustomEvent(privateInboundEvent, {
          detail: JSON.stringify({ type, payload })
        })
      );
    }
  }

  function connectMain(force = false) {
    if (mainChannelReady || mainConnectAttempts >= 5) {
      return;
    }
    if (privateInboundEvent && !force) {
      return;
    }
    if (privateOutboundEvent && privateOutboundListener) {
      document.removeEventListener(
        privateOutboundEvent,
        privateOutboundListener
      );
    }
    mainConnectAttempts += 1;
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    privateInboundEvent = `${CHANNEL}:private:${nonce}:in`;
    privateOutboundEvent = `${CHANNEL}:private:${nonce}:out`;
    privateOutboundListener = (event) => {
      try {
        const message = JSON.parse(String(event.detail ?? ""));
        if (message.type === "ACK") {
          if (
            privateOutboundEvent !==
            `${CHANNEL}:private:${nonce}:out`
          ) {
            return;
          }
          mainChannelReady = true;
          if (config) {
            sendToMain("CONFIG", config);
          }
          return;
        }
        handleMainMessage(message);
      } catch {
        // Reject malformed private-channel messages.
      }
    };
    document.addEventListener(
      privateOutboundEvent,
      privateOutboundListener
    );
    dispatchDocumentEvent(new CustomEvent(INIT_EVENT, { detail: nonce }));
    setTimeout(() => {
      if (
        !mainChannelReady &&
        privateOutboundEvent === `${CHANNEL}:private:${nonce}:out`
      ) {
        connectMain(true);
      }
    }, 20 * mainConnectAttempts);
  }

  function announceSession({ restoredFromBfcache = false } = {}) {
    if (!isPlaybackPage(session.pageUrl)) {
      return Promise.resolve(null);
    }
    return chrome.runtime
      .sendMessage({
        type: "START_PLAYBACK_SESSION",
        sessionId: session.id,
        sessionEpoch: session.epoch,
        documentStartedAt,
        restoredFromBfcache,
        ...(Number.isInteger(routingTabId) ? { routingTabId } : {}),
        pageUrl: session.pageUrl
      })
      .then((response) => {
        if (Number.isInteger(response?.routingTabId)) {
          routingTabId = response.routingTabId;
        }
        if (
          response?.ok &&
          response.sessionId === session.id &&
          response.config
        ) {
          dispatchConfig(response.config);
        }
      })
      .catch(() => null);
  }

  function stopPlaybackSession(previousSession) {
    if (!previousSession || !isPlaybackPage(previousSession.pageUrl)) {
      return Promise.resolve(null);
    }
    return chrome.runtime
      .sendMessage({
        type: "STOP_PLAYBACK_SESSION",
        sessionId: previousSession.id,
        ...(Number.isInteger(routingTabId) ? { routingTabId } : {})
      })
      .catch(() => null);
  }

  function registerMediaRoutes(routes, mayRecover = true) {
    if (!Array.isArray(routes) || !routes.length) {
      return Promise.resolve(null);
    }
    const merged = new Map(
      latestRoutes.map((route) => [routeDetailId(route), route])
    );
    for (const route of routes.slice(0, 64)) {
      const id = routeDetailId(route);
      if (id) {
        merged.set(id, route);
      }
    }
    latestRoutes = [...merged.values()].slice(0, 64);
    if (
      !isPlaybackPage(session.pageUrl) ||
      routingSuspended
    ) {
      return Promise.resolve(null);
    }
    const requestSessionId = session.id;
    return chrome.runtime
      .sendMessage({
        type: "REGISTER_MEDIA_ROUTES",
        sessionId: requestSessionId,
        ...(Number.isInteger(routingTabId) ? { routingTabId } : {}),
        routes: latestRoutes
      })
      .then((response) => {
        if (response?.ok && response.sessionId === session.id) {
          session.activeRuleCount = Math.max(
            0,
            Number(response.ruleCount) || 0
          );
          applyResourceStats(response.resourceStats);
          if (response.config) {
            dispatchConfig(response.config);
          }
          recordSession();
          return response;
        }
        if (
          mayRecover &&
          requestSessionId === session.id &&
          /stale or unknown playback session/i.test(
            String(response?.error ?? "")
          )
        ) {
          return announceSession().then(() => {
            if (requestSessionId !== session.id) {
              return null;
            }
            return registerMediaRoutes(latestRoutes, false);
          });
        }
        if (!response?.ok && requestSessionId === session.id) {
          addEvent(
            "route-register-error",
            "",
            String(response?.error ?? "unknown registration error")
          );
          recordSession();
        }
        return response;
      })
      .catch((error) => {
        if (requestSessionId === session.id) {
          addEvent("route-register-error", "", error?.message ?? String(error));
          recordSession();
        }
        return null;
      });
  }

  function firstRouteHost(routes) {
    if (!Array.isArray(routes)) {
      return "";
    }
    for (const route of routes.slice(0, 64)) {
      const rawUrl = Array.isArray(route?.urls) ? route.urls[0] : "";
      try {
        const url = new URL(String(rawUrl ?? ""), location.href);
        const host = url.hostname;
        if (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.hash &&
          (
            host.endsWith(".bilivideo.com") ||
            host.endsWith(".bilivideo.cn") ||
            host === "upos-hz-mirrorakam.akamaized.net"
          )
        ) {
          return host.slice(0, 255);
        }
      } catch {
        // Ignore malformed page-route diagnostics.
      }
    }
    return "";
  }

  function degradeHost(payload, mayRecover = true) {
    const requestSessionId = session.id;
    return chrome.runtime
      .sendMessage({
        type: "HOST_DEGRADED",
        sessionId: requestSessionId,
        ...(Number.isInteger(routingTabId) ? { routingTabId } : {}),
        host: String(payload.host ?? ""),
        presentationId: normalizedPresentationId(payload.presentationId),
        kind: normalizedKind(payload.kind),
        routeKey: String(payload.routeKey ?? "").slice(0, 1000),
        reason: String(payload.reason ?? "").slice(0, 60)
      })
      .then((response) => {
        if (
          mayRecover &&
          !response?.ok &&
          requestSessionId === session.id
        ) {
          return announceSession()
            .then(() => registerMediaRoutes(latestRoutes))
            .then(() => degradeHost(payload, false));
        }
        if (!response?.ok && requestSessionId === session.id) {
          addEvent(
            "route-policy-error",
            String(payload.host ?? "").slice(0, 255),
            String(response?.error ?? "unknown route-policy error")
          );
          recordSession();
          return null;
        }
        if (response?.ok && response.sessionId === session.id) {
          session.activeRuleCount = Math.max(
            0,
            Number(response.ruleCount) || 0
          );
          applyResourceStats(response.resourceStats);
          if (response.config) {
            dispatchConfig(response.config);
          }
          session.lastRuleLatencyMs = Math.max(
            0,
            Number(response.latencyMs) || 0
          );
          addEvent(
            "route-policy",
            String(response.host ?? "").slice(0, 255),
            `${session.activeRuleCount} rules in ${session.lastRuleLatencyMs}ms`
          );
          recordSession();
        }
        return response;
      })
      .catch((error) => {
        if (requestSessionId === session.id) {
          addEvent(
            "route-policy-error",
            String(payload.host ?? "").slice(0, 255),
            error?.message ?? String(error)
          );
          recordSession();
        }
      });
  }

  function requestNativeRouteBypass(
    payload,
    reason = "route-exhausted",
    {
      force = false,
      backoffUntil = 0,
      bypassUntil = 0
    } = {}
  ) {
    const presentationId = normalizedPresentationId(
      payload.presentationId
    );
    const kind = normalizedKind(payload.kind);
    const routeKey = normalizedRouteKey(payload.routeKey);
    const routeId = routeDetailId({ presentationId, routeKey });
    if (!routeId) {
      return;
    }
    const now = Date.now();
    const existingUntil = recoveryProbeBackoffs.get(routeId) ?? 0;
    if (!force && existingUntil > now) {
      return;
    }
    const until = Math.max(
      now + RECOVERY_PROBE_BACKOFF_MS,
      Number(bypassUntil) || 0
    );
    recoveryProbeBackoffs.set(
      routeId,
      Math.max(
        now + RECOVERY_PROBE_BACKOFF_MS,
        Number(backoffUntil) || 0
      )
    );
    sendToMain("ROUTE_NATIVE_BYPASS", {
      presentationId,
      kind,
      routeKey,
      until
    });
    const requestSessionId = session.id;
    void chrome.runtime
      .sendMessage({
        type: "BYPASS_PLAYBACK_ROUTE",
        sessionId: requestSessionId,
        ...(Number.isInteger(routingTabId) ? { routingTabId } : {}),
        presentationId,
        routeKey,
        until
      })
      .then((response) => {
        if (
          !response?.ok ||
          requestSessionId !== session.id
        ) {
          return;
        }
        session.activeRuleCount = Math.max(
          0,
          Number(response.ruleCount) || 0
        );
        applyResourceStats(response.resourceStats);
        if (response.config) {
          dispatchConfig(response.config);
        }
        addEvent(
          "route-native-bypass",
          String(payload.host ?? "").slice(0, 255),
          `${presentationId} ${kind} ${routeKey}; ${reason}; temporary`
        );
        recordSession();
      })
      .catch(() => {});
  }

  function requestRecoveryProbe(payload) {
    const presentationId = normalizedPresentationId(
      payload.presentationId
    );
    const routeKey = normalizedRouteKey(payload.routeKey);
    const id = routeDetailId({ presentationId, routeKey });
    const requestedHost = String(payload.host ?? "").toLowerCase();
    const triggerId = `${id}\u0000${requestedHost}`;
    const triggerBackoffUntil = recoveryTriggerBackoffs.get(triggerId) ?? 0;
    if (triggerBackoffUntil > Date.now()) {
      return;
    }
    recoveryTriggerBackoffs.delete(triggerId);
    const backoffUntil = recoveryProbeBackoffs.get(id) ?? 0;
    if (backoffUntil > Date.now()) {
      return;
    }
    recoveryProbeBackoffs.delete(id);
    const route = latestRoutes.find(
      (candidate) => routeDetailId(candidate) === id
    );
    if (!route) {
      return;
    }
    const urls = [
      ...(Array.isArray(route.urls) ? route.urls : []),
      ...(Array.isArray(route.originalUrls) ? route.originalUrls : [])
    ];
    const mediaUrl =
      urls.find((url) => {
        try {
          return new URL(url, location.href).hostname === requestedHost;
        } catch {
          return false;
        }
      }) ?? urls[0];
    if (!mediaUrl) {
      return;
    }
    recoveryTriggerBackoffs.set(
      triggerId,
      Date.now() + RECOVERY_PROBE_BACKOFF_MS
    );
    requestProbe(mediaUrl, {
      presentationId,
      kind: normalizedKind(payload.kind || route.kind),
      routeKey,
      recovery: true
    });
  }

  function scheduleRecoveryProbeRetry(
    mediaUrl,
    routeMeta,
    reason = "probe-budget"
  ) {
    const presentationId = normalizedPresentationId(
      routeMeta.presentationId
    );
    const kind = normalizedKind(routeMeta.kind);
    const routeKey = normalizedRouteKey(routeMeta.routeKey);
    const routeId = routeDetailId({ presentationId, routeKey });
    if (!routeId) {
      return;
    }
    const requestSessionId = session.id;
    const retryAt = Date.now() + RECOVERY_PROBE_BUDGET_RETRY_MS;
    clearTimeout(recoveryProbeRetryTimers.get(routeId));
    requestNativeRouteBypass(
      {
        presentationId,
        kind,
        routeKey,
        host: String(routeMeta.host ?? "")
      },
      reason,
      {
        force: true,
        backoffUntil: retryAt,
        // Keep the exact route native across a second budget check. Only one
        // timer per route is allowed, so this cannot become a probe storm.
        bypassUntil: Date.now() + RECOVERY_BUDGET_BYPASS_MS
      }
    );
    const timer = setTimeout(() => {
      recoveryProbeRetryTimers.delete(routeId);
      if (
        session.id !== requestSessionId ||
        recoveryProbeBackoffs.get(routeId) === Number.POSITIVE_INFINITY
      ) {
        return;
      }
      recoveryProbeBackoffs.delete(routeId);
      requestProbe(mediaUrl, routeMeta);
    }, RECOVERY_PROBE_BUDGET_RETRY_MS);
    recoveryProbeRetryTimers.set(routeId, timer);
    addEvent(
      "probe-recovery-retry-wait",
      String(routeMeta.host ?? "").slice(0, 255),
      `${presentationId} ${kind} ${routeKey}; ${reason}; retry scheduled`
    );
    recordSession();
  }

  function hasCompatibleProbeRoute(responseConfig, presentationId, routeKey) {
    const routes = responseConfig?.compatibleRoutes;
    if (!routes || typeof routes !== "object") {
      return false;
    }
    const exact = routes[routeDetailId({ presentationId, routeKey })];
    const legacy = routes[routeKey];
    return [exact, legacy].some(
      (urls) => Array.isArray(urls) && urls.length > 0
    );
  }

  function requestProbe(mediaUrl, routeMeta = {}) {
    if (
      !isPlaybackPage(session.pageUrl) ||
      routingSuspended ||
      (
        document.hidden &&
        routeMeta.recovery !== true
      )
    ) {
      return;
    }
    mediaUrl = String(mediaUrl ?? "");
    let key = "";
    let routeId = "";
    let mediaRouteKey = "";
    let mediaHost = "";
    try {
      const url = new URL(mediaUrl, location.href);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !/\.(?:m4s|flv|mp4)$/i.test(url.pathname) ||
        !(
          url.hostname.endsWith(".bilivideo.com") ||
          url.hostname.endsWith(".bilivideo.cn") ||
          url.hostname === "upos-hz-mirrorakam.akamaized.net"
        )
      ) {
        return;
      }
      mediaUrl = url.href;
      routeMeta = inferProbeRouteMeta(url.pathname, routeMeta);
      mediaRouteKey = normalizedRouteKey(routeMeta.routeKey || url.pathname);
      mediaHost = url.hostname;
      routeId = routeDetailId({
        presentationId: routeMeta.presentationId,
        routeKey: mediaRouteKey
      });
      key = `${routeId}\u0000${mediaHost}`;
    } catch {
      return;
    }
    const presentationId = normalizedPresentationId(
      routeMeta.presentationId
    );
    if (
      /\/(?:video\/BV[0-9a-zA-Z]{10}|bangumi\/play\/(?:ep|ss)\d+)/i.test(
        new URL(session.pageUrl, location.href).pathname
      ) &&
      !presentationMatchesPage(presentationId, session.pageUrl)
    ) {
      return;
    }
    const kind = normalizedKind(routeMeta.kind);
    const recovery = routeMeta.recovery === true;
    const recoveryAttempt = Math.min(
      MAX_RECOVERY_SWEEP_PROBES - 1,
      Math.max(0, Number(routeMeta.recoveryAttempt) || 0)
    );
    const recoveryCandidatesAttempted = Math.max(
      0,
      Number(routeMeta.recoveryCandidatesAttempted) || 0
    );
    const recoveryUnderpoweredSeen =
      routeMeta.recoveryUnderpoweredSeen === true;
    const observedReference = routeMeta.observedReference === true;
    const referenceHash = String(
      routeMeta.referenceHash ?? ""
    ).toLowerCase();
    const referenceStatus = Number(routeMeta.referenceStatus) || 0;
    const referenceBytes = Number(routeMeta.referenceBytes) || 0;
    if (
      observedReference &&
      (
        kind !== "video" ||
        !/^[0-9a-f]{64}$/.test(referenceHash) ||
        (referenceStatus !== 200 && referenceStatus !== 206) ||
        referenceBytes < 262_144
      )
    ) {
      return;
    }
    const presentationProbeCount =
      probeCountsByPresentation.get(presentationId) ?? 0;
    const presentationReferenceCount =
      probeReferenceCountsByPresentation.get(presentationId) ?? 0;
    const hasVideoRoute = latestRoutes.some(
      (route) =>
        normalizedPresentationId(route?.presentationId) === presentationId &&
        normalizedKind(route?.kind) === "video"
    );
    if (
      mediaUrl.length > 4096 ||
      (observedReference
        ? probeReferenceKeys.has(key) ||
          presentationReferenceCount >= 2
        : recovery
        ? degradationProbeKeys.has(routeId)
        : probedKeys.has(key) ||
          presentationProbeCount >= 2 ||
          (kind === "audio" && hasVideoRoute))
    ) {
      return;
    }
    if (observedReference) {
      probeReferenceKeys.add(key);
      probeReferenceCountsByPresentation.set(
        presentationId,
        presentationReferenceCount + 1
      );
      addEvent(
        "probe-reference",
        mediaHost,
        `${presentationId} ${kind} ${mediaRouteKey}`
      );
      recordSession();
    } else if (recovery) {
      degradationProbeKeys.add(routeId);
      addEvent("probe-recovery", mediaHost, `${presentationId} ${kind} ${mediaRouteKey}`);
      recordSession();
    } else {
      probedKeys.add(key);
      probeCountsByPresentation.set(
        presentationId,
        presentationProbeCount + 1
      );
    }
    const releaseQualification = () => {
      if (observedReference) {
        probeReferenceKeys.delete(key);
        const count =
          probeReferenceCountsByPresentation.get(presentationId) ?? 1;
        if (count <= 1) {
          probeReferenceCountsByPresentation.delete(presentationId);
        } else {
          probeReferenceCountsByPresentation.set(
            presentationId,
            count - 1
          );
        }
        return;
      }
      if (recovery) {
        degradationProbeKeys.delete(routeId);
        return;
      }
      probedKeys.delete(key);
      probeCountsByPresentation.set(
        presentationId,
        Math.max(
          0,
          (probeCountsByPresentation.get(presentationId) ?? 1) - 1
        )
      );
    };
    const requestSessionId = session.id;
    let continueRecovery = false;
    let exhaustRecovery = false;
    let retryRecoveryLater = false;
    let recoveryRetryReason = "probe-budget";
    let nextRecoveryCandidatesAttempted = recoveryCandidatesAttempted;
    let nextRecoveryUnderpoweredSeen = recoveryUnderpoweredSeen;
    chrome.runtime
      .sendMessage({
        type: "PROBE_MEDIA",
        sessionId: requestSessionId,
        ...(Number.isInteger(routingTabId) ? { routingTabId } : {}),
        presentationId,
        kind,
        routeKey: mediaRouteKey,
        mediaUrl,
        ...(recovery ? { recovery: true } : {}),
        ...(observedReference
          ? {
              observedReference: true,
              referenceHash,
              referenceStatus,
              referenceBytes
            }
          : {})
      })
      .then((response) => {
        if (
          response?.ok &&
          response.sessionId === session.id &&
          requestSessionId === session.id &&
          response.config
        ) {
          dispatchConfig(response.config);
          if (recovery && response.probeOutcome) {
            const attemptedPoolCandidates = Math.max(
              0,
              Number(response.probeOutcome.attemptedPoolCandidates) || 0
            );
            const candidatePoolSize = Math.max(
              0,
              Number(response.probeOutcome.candidatePoolSize) || 0
            );
            nextRecoveryUnderpoweredSeen =
              recoveryUnderpoweredSeen ||
              response.probeOutcome.underpoweredPoolSeen === true ||
              Number(
                response.probeOutcome.underpoweredPoolCandidates
              ) > 0;
            const coveredPoolCandidates = Math.max(
              0,
              Number(response.probeOutcome.coveredPoolCandidates) || 0
            );
            nextRecoveryCandidatesAttempted =
              coveredPoolCandidates > 0
                ? Math.min(
                    candidatePoolSize || Number.MAX_SAFE_INTEGER,
                    coveredPoolCandidates
                  )
                : Math.min(
                    candidatePoolSize || Number.MAX_SAFE_INTEGER,
                    recoveryCandidatesAttempted +
                      attemptedPoolCandidates
                  );
            const compatible = hasCompatibleProbeRoute(
              response.config,
              presentationId,
              mediaRouteKey
            );
            const poolExhausted =
              response.probeOutcome.poolExhausted === true ||
              (
                candidatePoolSize > 0 &&
                nextRecoveryCandidatesAttempted >= candidatePoolSize
              );
            if (!compatible) {
              exhaustRecovery = poolExhausted;
              continueRecovery =
                !poolExhausted &&
                attemptedPoolCandidates > 0 &&
                recoveryAttempt + 1 < MAX_RECOVERY_SWEEP_PROBES;
              if (
                !poolExhausted &&
                attemptedPoolCandidates > 0 &&
                !continueRecovery
              ) {
                retryRecoveryLater = true;
                recoveryRetryReason = "partial-sweep";
              }
            }
          }
        } else if (
          requestSessionId === session.id &&
          /probe.*budget|budget.*probe/i.test(
            String(response?.error ?? "")
          )
        ) {
          retryRecoveryLater = recovery;
          recoveryRetryReason = "probe-budget";
          releaseQualification();
        } else if (
          requestSessionId === session.id &&
          /probe url is not registered/i.test(
            String(response?.error ?? "")
          )
        ) {
          releaseQualification();
          return routeRegistrationPromise
            .catch(() => null)
            .then(() => registerMediaRoutes(latestRoutes))
            .then(() => {
            if (requestSessionId === session.id) {
              requestProbe(mediaUrl, routeMeta);
            }
            });
        } else if (
          requestSessionId === session.id &&
          !probeRecoveryKeys.has(
            `${
              observedReference
                ? "reference"
                : recovery
                  ? "recovery"
                  : "normal"
            }:${key}`
          ) &&
          /stale or unknown playback session/i.test(
            String(response?.error ?? "")
          )
        ) {
          probeRecoveryKeys.add(
            `${
              observedReference
                ? "reference"
                : recovery
                  ? "recovery"
                  : "normal"
            }:${key}`
          );
          return announceSession()
            .then(() => registerMediaRoutes(latestRoutes))
            .then(() => {
              if (requestSessionId === session.id) {
                releaseQualification();
                requestProbe(mediaUrl, routeMeta);
              }
            });
        } else if (requestSessionId === session.id) {
          releaseQualification();
        }
      })
      .catch(() => {
        if (requestSessionId === session.id) {
          releaseQualification();
        }
      })
      .finally(() => {
        if (recovery && requestSessionId === session.id) {
          // Recovery qualification is an in-flight lock, not a permanent
          // route ban. Keeping it forever stopped candidate rotation after
          // the first recovery pair, so later failures could never reach the
          // remaining bounded CDN pool entries.
          degradationProbeKeys.delete(routeId);
          if (retryRecoveryLater) {
            scheduleRecoveryProbeRetry(mediaUrl, {
              ...routeMeta,
              presentationId,
              kind,
              routeKey: mediaRouteKey,
              host: mediaHost,
              recovery: true,
              recoveryAttempt,
              recoveryCandidatesAttempted:
                nextRecoveryCandidatesAttempted,
              recoveryUnderpoweredSeen:
                nextRecoveryUnderpoweredSeen
            }, recoveryRetryReason);
          } else if (exhaustRecovery) {
            const persistent = nextRecoveryUnderpoweredSeen;
            const now = Date.now();
            const existingBackoff =
              recoveryProbeBackoffs.get(routeId) ?? 0;
            const bypassUntil = Math.max(
              now + RECOVERY_PROBE_BACKOFF_MS,
              Number.isFinite(existingBackoff) ? existingBackoff : 0
            );
            // A temporary exact-route bypass was installed when recovery
            // started. Never promote page state to Infinity until the service
            // worker has atomically committed the matching DNR state.
            recoveryProbeBackoffs.set(routeId, bypassUntil);
            if (!persistent) {
              sendToMain("ROUTE_NATIVE_BYPASS", {
                presentationId,
                kind,
                routeKey: mediaRouteKey,
                persistent: false,
                until: bypassUntil
              });
            }
            void chrome.runtime
              .sendMessage({
                type: "BYPASS_PLAYBACK_ROUTE",
                sessionId: requestSessionId,
                ...(Number.isInteger(routingTabId)
                  ? { routingTabId }
                  : {}),
                presentationId,
                routeKey: mediaRouteKey,
                persistent,
                ...(!persistent ? { until: bypassUntil } : {})
              })
              .then((response) => {
                const acknowledged =
                  response?.ok &&
                  requestSessionId === session.id &&
                  response.sessionId === requestSessionId &&
                  response.presentationId === presentationId &&
                  response.routeKey === mediaRouteKey &&
                  response.persistent === persistent;
                if (!acknowledged) {
                  return;
                }
                session.activeRuleCount = Math.max(
                  0,
                  Number(response.ruleCount) || 0
                );
                applyResourceStats(response.resourceStats);
                if (response.config) {
                  dispatchConfig(response.config);
                }
                if (persistent) {
                  recoveryProbeBackoffs.set(
                    routeId,
                    Number.POSITIVE_INFINITY
                  );
                  clearTimeout(
                    recoveryProbeRetryTimers.get(routeId)
                  );
                  recoveryProbeRetryTimers.delete(routeId);
                  sendToMain("ROUTE_NATIVE_BYPASS", {
                    presentationId,
                    kind,
                    routeKey: mediaRouteKey,
                    persistent: true
                  });
                }
                recordSession();
              })
              .catch(() => {});
            addEvent(
              "probe-recovery-exhausted",
              mediaHost,
              `${presentationId} ${kind} ${mediaRouteKey}; ${nextRecoveryCandidatesAttempted} candidates; ${
                persistent ? "capacity exhausted for session" : "30s backoff"
              }`
            );
            recordSession();
          } else if (continueRecovery) {
            addEvent(
              "probe-recovery-continue",
              mediaHost,
              `${presentationId} ${kind} ${mediaRouteKey}; round ${recoveryAttempt + 2}/${MAX_RECOVERY_SWEEP_PROBES}`
            );
            requestProbe(mediaUrl, {
              ...routeMeta,
              recoveryAttempt: recoveryAttempt + 1,
              recoveryCandidatesAttempted: nextRecoveryCandidatesAttempted,
              recoveryUnderpoweredSeen: nextRecoveryUnderpoweredSeen
            });
          }
        }
      });
  }

  function inferProbeRouteMeta(routeKey, routeMeta = {}) {
    const suppliedPresentation = normalizedPresentationId(
      routeMeta.presentationId
    );
    if (suppliedPresentation !== "unassigned") {
      return routeMeta;
    }
    const matches = Object.values(session.routeDetails).filter(
      (route) => route.routeKey === normalizedRouteKey(routeKey)
    );
    if (!matches.length) {
      return routeMeta;
    }
    const pageMatches = matches.filter((route) =>
      presentationMatchesPage(route.presentationId, session.pageUrl)
    );
    const eligible = pageMatches.length ? pageMatches : matches;
    if (eligible.length !== 1) {
      return routeMeta;
    }
    return {
      ...routeMeta,
      presentationId: eligible[0].presentationId,
      kind: eligible[0].kind,
      routeKey: eligible[0].routeKey
    };
  }

  function createSession() {
    sessionSerial += 1;
    const randomId =
      crypto.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return {
      id: `${randomId}-${sessionSerial.toString(36)}`,
      epoch: sessionSerial,
      pageUrl: canonicalPageUrl(location.href),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      firstPlayingMs: null,
      waitingCount: 0,
      stalledCount: 0,
      bufferingMs: 0,
      playbackSeconds: 0,
      mediaHost: "",
      plannedMediaHost: "",
      rewritten: false,
      rewriteCount: 0,
      fallbackCount: 0,
      degradedCount: 0,
      routeSwitchCount: 0,
      activeRuleCount: 0,
      lastRuleLatencyMs: 0,
      lastThroughputBps: 0,
      lastBufferAhead: 0,
      activeRouteKey: "",
      blockedBeaconCount: 0,
      routeDetails: {},
      playerDetails: {},
      beaconAggregates: {},
      resourceStats: {},
      criticalEvents: [],
      ordinaryEvents: [],
      recentEvents: []
    };
  }

  function canonicalPageUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl, location.href);
      const pathname =
        parsed.pathname === "/"
          ? "/"
          : parsed.pathname.replace(/\/+$/, "");
      return `${parsed.origin}${pathname}`;
    } catch {
      return `${location.origin}${location.pathname}`;
    }
  }

  function presentationMatchesPage(presentationId, rawUrl) {
    const normalized = normalizedPresentationId(presentationId);
    let parsed;
    try {
      parsed = new URL(rawUrl, location.href);
    } catch {
      return false;
    }
    const parts = normalized ? new Set(normalized.split(":")) : new Set();
    const bvid = parsed.pathname.match(
      /\/video\/(BV[0-9a-zA-Z]{10})/i
    )?.[1];
    if (bvid) {
      return parts.has(`bvid-${bvid}`);
    }
    const episode = parsed.pathname.match(/\/bangumi\/play\/ep(\d+)/i)?.[1];
    if (episode) {
      return (
        normalized === `episode-ep${episode}` ||
        parts.has(`ep_id-${episode}`)
      );
    }
    const season = parsed.pathname.match(/\/bangumi\/play\/ss(\d+)/i)?.[1];
    if (season) {
      return (
        normalized === `season-ss${season}` ||
        parts.has(`season_id-${season}`)
      );
    }
    return false;
  }

  function addEvent(type, host = "", detail = "") {
    const entry = {
      type,
      at: Date.now(),
      host,
      detail: String(detail).slice(0, 300)
    };
    const target = CRITICAL_EVENT_TYPES.has(type)
      ? session.criticalEvents
      : session.ordinaryEvents;
    target.push(entry);
    if (target === session.criticalEvents) {
      session.criticalEvents = target.slice(-MAX_CRITICAL_EVENTS);
    } else {
      session.ordinaryEvents = target.slice(-MAX_ORDINARY_EVENTS);
    }
    session.recentEvents = [
      ...session.criticalEvents,
      ...session.ordinaryEvents
    ]
      .sort((left, right) => left.at - right.at)
      .slice(-30);
  }

  function aggregateBlockedBeacon(rawUrl) {
    let key = "unknown";
    try {
      const parsed = new URL(String(rawUrl ?? ""), location.href);
      key = `${parsed.hostname}${parsed.pathname}`.slice(0, 300);
    } catch {
      // Keep a bounded aggregate without retaining a malformed URL.
    }
    let aggregate = session.beaconAggregates[key];
    if (!aggregate) {
      const keys = Object.keys(session.beaconAggregates);
      if (keys.length >= MAX_BEACON_AGGREGATES) {
        key = "other";
      }
      aggregate = session.beaconAggregates[key] ?? {
        endpoint: key,
        count: 0,
        firstAt: Date.now(),
        lastAt: 0
      };
      session.beaconAggregates[key] = aggregate;
    }
    aggregate.count += 1;
    aggregate.lastAt = Date.now();
  }

  function recordSession() {
    if (
      !isPlaybackPage(session.pageUrl) ||
      routingSuspended ||
      !config?.settings?.globalEnabled ||
      !config.settings.diagnostics.enabled
    ) {
      return;
    }
    session.updatedAt = Date.now();
    pendingDiagnosticSessions.set(session.id, session);
    if (!diagnosticTimer) {
      diagnosticTimer = setTimeout(flushDiagnosticSessions, 1000);
    }
  }

  function flushDiagnosticSessions() {
    diagnosticTimer = null;
    if (
      !config?.settings?.globalEnabled ||
      !config.settings.diagnostics.enabled
    ) {
      pendingDiagnosticSessions.clear();
      return;
    }
    const snapshots = [...pendingDiagnosticSessions.values()].map(
      (pendingSession) =>
        JSON.parse(JSON.stringify(pendingSession))
    );
    pendingDiagnosticSessions.clear();
    for (const snapshot of snapshots) {
      chrome.runtime
        .sendMessage({ type: "RECORD_DIAGNOSTIC", session: snapshot })
        .catch(() => {});
    }
  }

  function startNewSession(url = location.href) {
    const nextNavigationKey = playbackNavigationKey(url);
    if (nextNavigationKey === currentNavigationKey) {
      return;
    }
    currentNavigationKey = nextNavigationKey;
    const previousSession = session;
    const nextIsPlaybackPage = isPlaybackPage(url);
    const retainedRoutes = latestRoutes.filter((route) =>
      nextIsPlaybackPage &&
      presentationMatchesPage(route?.presentationId, url)
    );
    recordSession();
    if (!nextIsPlaybackPage) {
      void stopPlaybackSession(previousSession);
    }
    for (const timer of recoveryTimers.values()) {
      clearTimeout(timer);
    }
    recoveryTimers.clear();
    for (const timer of recoveryProbeRetryTimers.values()) {
      clearTimeout(timer);
    }
    recoveryProbeRetryTimers.clear();
    // Probe limits are scoped to one SPA navigation session, not the tab lifetime.
    probedKeys.clear();
    probeCountsByPresentation.clear();
    probeReferenceKeys.clear();
    probeReferenceCountsByPresentation.clear();
    probeRecoveryKeys.clear();
    degradationProbeKeys.clear();
    recoveryProbeBackoffs.clear();
    recoveryTriggerBackoffs.clear();
    abortActivePageProbes("playback session changed");
    latestRoutes = retainedRoutes;
    routeRegistrationPromise = Promise.resolve(null);
    routingSuspended = false;
    clearTimeout(lifecycleTimer);
    lifecycleTimer = null;
    session = createSession();
    session.pageUrl = canonicalPageUrl(url);
    sessionPlayerSerial = 0;
    activePlayers.clear();
    sessionStartedPerformance = performance.now();
    if (nextIsPlaybackPage) {
      addEvent("session-start");
    }
    const nextSessionId = session.id;
    void announceSession().then(() => {
      if (session.id === nextSessionId && retainedRoutes.length) {
        return registerMediaRoutes(retainedRoutes);
      }
      return null;
    });
    recordSession();
    if (nextIsPlaybackPage && document.documentElement) {
      Promise.resolve().then(() => scanNode(document.documentElement));
    }
  }

  function blockedParams() {
    return config?.trackingParams ?? [];
  }

  function cleanUrl(raw) {
    if (!raw) {
      return raw;
    }
    let url;
    try {
      url = new URL(raw, location.href);
    } catch {
      return raw;
    }
    let changed = false;
    for (const param of blockedParams()) {
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param);
        changed = true;
      }
    }
    if (!changed) {
      return raw;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(raw)) {
      return url.href;
    }
    if (raw.startsWith("//")) {
      return `//${url.host}${url.pathname}${url.search}${url.hash}`;
    }
    if (raw.startsWith("?")) {
      return `${url.search}${url.hash}`;
    }
    if (raw.startsWith("/")) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return url.href;
  }

  function cleanAnchor(anchor) {
    if (
      !config?.settings?.globalEnabled ||
      !config.settings.privacy.urlCleaning
    ) {
      return;
    }
    const raw = anchor.getAttribute("href");
    if (!raw || raw.startsWith("javascript:") || raw.startsWith("#")) {
      return;
    }
    const cleaned = cleanUrl(raw);
    if (cleaned !== raw) {
      anchor.setAttribute("href", cleaned);
    }
  }

  function scanNode(node) {
    if (!(node instanceof Element)) {
      return;
    }
    if (node.matches("a[href]")) {
      cleanAnchor(node);
    }
    node.querySelectorAll?.("a[href]").forEach(cleanAnchor);
    if (isPlaybackPage(session.pageUrl) && node.matches("video")) {
      observeVideo(node);
    }
    if (isPlaybackPage(session.pageUrl)) {
      node.querySelectorAll?.("video").forEach(observeVideo);
    }
  }

  function videoBufferAhead(video) {
    const currentTime = Number(video.currentTime) || 0;
    const ranges = video.buffered;
    if (!ranges) {
      return 0;
    }
    for (let index = 0; index < ranges.length; index += 1) {
      if (
        ranges.start(index) <= currentTime + 0.25 &&
        ranges.end(index) >= currentTime
      ) {
        return Math.max(0, ranges.end(index) - currentTime);
      }
    }
    return 0;
  }

  function reportPlaybackRisk(type, video) {
    const videoState = videoStateFor(video);
    const route = resolveVideoRoute(video, videoState);
    if (!route?.mediaHost || !route.routeKey) {
      addEvent(
        "playback-risk-unassigned",
        "",
        `${videoState.playerId} ${type}`
      );
      return;
    }
    const requestSessionId = session.id;
    chrome.runtime
      .sendMessage({
        type: "PLAYBACK_RISK",
        sessionId: requestSessionId,
        ...(Number.isInteger(routingTabId) ? { routingTabId } : {}),
        presentationId: route.presentationId,
        kind: route.kind,
        host: route.mediaHost,
        routeKey: route.routeKey,
        reason: type,
        bufferAhead: videoBufferAhead(video)
      })
      .then((response) => {
        if (
          response?.ok &&
          response.sessionId === session.id &&
          response.config
        ) {
          dispatchConfig(response.config);
        }
        if (
          response?.ok &&
          response.sessionId === session.id &&
          response.escalated
        ) {
          session.activeRuleCount = Math.max(
            0,
            Number(response.ruleCount) || 0
          );
          applyResourceStats(response.resourceStats);
          session.lastRuleLatencyMs = Math.max(
            0,
            Number(response.latencyMs) || 0
          );
          addEvent(
            "risk-escalated",
            route.mediaHost,
            `${route.presentationId} ${route.kind} ${route.routeKey}; ${session.activeRuleCount} rules`
          );
          if (response.exhausted === true) {
            requestNativeRouteBypass(route, "playback-risk-exhausted");
          }
          recordSession();
        }
      })
      .catch(() => {});
  }

  function clearPlaybackRisk(videoState) {
    if (!videoState) {
      return;
    }
    clearTimeout(videoState.playbackRiskTimer);
    videoState.playbackRiskTimer = null;
    videoState.playbackRiskToken = null;
    videoState.playbackRiskType = "";
    videoState.playbackRiskStartedAt = 0;
    videoState.playbackRiskBaselineTime = 0;
    videoState.playbackRiskBaselineBuffer = 0;
  }

  function schedulePlaybackRisk(type, video) {
    const videoState = videoStates.get(video);
    if (
      videoState?.sessionId !== session.id ||
      videoState.playbackRiskTimer
    ) {
      return;
    }
    const requestSessionId = session.id;
    videoState.playbackRiskType = type;
    videoState.playbackRiskStartedAt = performance.now();
    videoState.playbackRiskBaselineTime =
      Number(video.currentTime) || 0;
    videoState.playbackRiskBaselineBuffer = videoBufferAhead(video);
    const riskToken = {};
    videoState.playbackRiskToken = riskToken;
    videoState.playbackRiskTimer = setTimeout(() => {
      if (videoState.playbackRiskToken !== riskToken) {
        return;
      }
      videoState.playbackRiskTimer = null;
      if (
        requestSessionId !== session.id ||
        videoStates.get(video) !== videoState ||
        document.hidden ||
        video.paused ||
        video.ended
      ) {
        clearPlaybackRisk(videoState);
        return;
      }
      const readyState = Number(video.readyState);
      const playbackAdvanced =
        (Number(video.currentTime) || 0) >
        videoState.playbackRiskBaselineTime + 0.1;
      const bufferAdvanced =
        videoBufferAhead(video) >
        videoState.playbackRiskBaselineBuffer + 0.5;
      if (
        (Number.isFinite(readyState) && readyState >= 3) ||
        playbackAdvanced ||
        bufferAdvanced
      ) {
        clearPlaybackRisk(videoState);
        return;
      }
      const riskType = videoState.playbackRiskType || type;
      clearPlaybackRisk(videoState);
      reportPlaybackRisk(`sustained-${riskType}`, video);
    }, PLAYBACK_RISK_CONFIRM_MS);
  }

  function cleanupInactivePlayers() {
    for (const [video, videoState] of activePlayers) {
      if (video.isConnected === false || video.ended) {
        releasePlayer(video, videoState);
      }
    }
  }

  function activatePlayer(video, videoState) {
    if (videoState.sessionId !== session.id) {
      return false;
    }
    if (videoState.active) {
      return true;
    }
    cleanupInactivePlayers();
    if (activePlayers.size >= MAX_PLAYERS) {
      videoState.tracked = false;
      return false;
    }
    videoState.active = true;
    videoState.tracked = true;
    activePlayers.set(video, videoState);
    return true;
  }

  function releasePlayer(video, videoState = videoStates.get(video)) {
    if (!videoState) {
      return;
    }
    clearPlaybackRisk(videoState);
    activePlayers.delete(video);
    delete session.playerDetails[videoState.playerId];
    videoState.active = false;
    videoState.tracked = false;
  }

  function hasActivePlayback() {
    cleanupInactivePlayers();
    for (const [video] of activePlayers) {
      if (
        video.isConnected !== false &&
        !video.paused &&
        !video.ended
      ) {
        return true;
      }
    }
    return false;
  }

  function clearTransientRoutingWork() {
    abortActivePageProbes("routing suspended");
    for (const timer of recoveryTimers.values()) {
      clearTimeout(timer);
    }
    recoveryTimers.clear();
    for (const timer of recoveryProbeRetryTimers.values()) {
      clearTimeout(timer);
    }
    recoveryProbeRetryTimers.clear();
    probedKeys.clear();
    probeCountsByPresentation.clear();
    probeReferenceKeys.clear();
    probeReferenceCountsByPresentation.clear();
    probeRecoveryKeys.clear();
    degradationProbeKeys.clear();
    recoveryProbeBackoffs.clear();
    recoveryTriggerBackoffs.clear();
    for (const [video, videoState] of activePlayers) {
      releasePlayer(video, videoState);
    }
    activePlayers.clear();
  }

  function suspendRouting(reason = "hidden-idle") {
    clearTimeout(lifecycleTimer);
    lifecycleTimer = null;
    if (
      routingSuspended ||
      !isPlaybackPage(session.pageUrl)
    ) {
      return;
    }
    addEvent("lifecycle-suspend", "", reason);
    recordSession();
    flushDiagnosticSessions();
    routingSuspended = true;
    sendToMain("LIFECYCLE", { active: false, reason });
    clearTransientRoutingWork();
    void stopPlaybackSession(session);
  }

  function resumeRouting({ restoredFromBfcache = false } = {}) {
    clearTimeout(lifecycleTimer);
    lifecycleTimer = null;
    if (
      !routingSuspended ||
      !isPlaybackPage(session.pageUrl)
    ) {
      return Promise.resolve(null);
    }
    routingSuspended = false;
    sendToMain("LIFECYCLE", { active: true });
    addEvent("lifecycle-resume");
    if (restoredFromBfcache) {
      documentStartedAt = Math.max(Date.now(), documentStartedAt + 1);
    }
    return announceSession({ restoredFromBfcache })
      .then(() => registerMediaRoutes(latestRoutes))
      .then(() => refreshConfig())
      .then(() => {
        if (document.documentElement) {
          scanNode(document.documentElement);
        }
        recordSession();
      })
      .catch(() => null);
  }

  function scheduleHiddenIdleSuspend() {
    clearTimeout(lifecycleTimer);
    lifecycleTimer = null;
    if (
      !document.hidden ||
      routingSuspended ||
      hasActivePlayback()
    ) {
      return;
    }
    lifecycleTimer = setTimeout(() => {
      lifecycleTimer = null;
      if (document.hidden && !hasActivePlayback()) {
        suspendRouting("hidden-idle");
      }
    }, HIDDEN_IDLE_SUSPEND_MS);
  }

  function videoStateFor(video, activate = false) {
    let videoState = videoStates.get(video);
    if (
      !videoState ||
      videoState.sessionId !== session.id
    ) {
      sessionPlayerSerial += 1;
      videoState = {
        sessionId: session.id,
        playerId: `player-${sessionPlayerSerial}`,
        presentationId: "",
        routeKey: "",
        kind: "video",
        mediaHost: "",
        bufferingSince: null,
        waitingCount: 0,
        stalledCount: 0,
        playbackSeconds: 0,
        lastTimeUpdateSentAt: 0,
        playbackRiskTimer: null,
        playbackRiskToken: null,
        playbackRiskType: "",
        playbackRiskStartedAt: 0,
        playbackRiskBaselineTime: 0,
        playbackRiskBaselineBuffer: 0,
        tracked: false,
        active: false
      };
      videoStates.set(video, videoState);
    }
    if (activate) {
      activatePlayer(video, videoState);
    }
    return videoState;
  }

  function syncPlayerDetail(videoState, video) {
    if (!activatePlayer(video, videoState)) {
      return;
    }
    session.playerDetails[videoState.playerId] = {
      playerId: videoState.playerId,
      presentationId: videoState.presentationId,
      routeKey: videoState.routeKey,
      kind: videoState.kind,
      mediaHost: videoState.mediaHost,
      waitingCount: videoState.waitingCount,
      stalledCount: videoState.stalledCount,
      playbackSeconds: videoState.playbackSeconds,
      bufferAhead: videoBufferAhead(video),
      buffering: videoState.bufferingSince !== null,
      paused: Boolean(video.paused),
      updatedAt: Date.now()
    };
    const players = Object.values(session.playerDetails).sort(
      (left, right) => Number(right.updatedAt) - Number(left.updatedAt)
    );
    for (const stale of players.slice(MAX_PLAYERS)) {
      delete session.playerDetails[stale.playerId];
    }
  }

  function resolveVideoRoute(video, videoState = videoStateFor(video)) {
    if (!videoState.tracked) {
      return null;
    }
    let currentRouteKey = "";
    try {
      const source = video.currentSrc || video.src;
      const parsed = new URL(String(source ?? ""), location.href);
      if (/\.(?:m4s|flv|mp4)$/i.test(parsed.pathname)) {
        currentRouteKey = parsed.pathname;
      }
    } catch {
      currentRouteKey = "";
    }
    const routes = Object.values(session.routeDetails);
    let route = currentRouteKey
      ? routes.find((entry) => entry.routeKey === currentRouteKey)
      : null;
    if (!route && routes.length === 1) {
      route = routes[0];
    }
    if (!route && activePlayers.size === 1) {
      const pageVideoRoutes = routes
        .filter(
          (entry) =>
            entry.mediaHost &&
            ["video", "mp4"].includes(entry.kind) &&
            presentationMatchesPage(entry.presentationId, session.pageUrl)
        )
        .sort(
          (left, right) =>
            Number(right.lastObservedAt || right.updatedAt || 0) -
            Number(left.lastObservedAt || left.updatedAt || 0)
        );
      const presentations = new Set(
        pageVideoRoutes.map((entry) => entry.presentationId)
      );
      if (presentations.size === 1) {
        route = pageVideoRoutes[0] ?? null;
      }
    }
    if (route) {
      const changed =
        videoState.presentationId !== route.presentationId ||
        videoState.routeKey !== route.routeKey;
      videoState.presentationId = route.presentationId;
      videoState.routeKey = route.routeKey;
      videoState.kind = route.kind;
      videoState.mediaHost = route.mediaHost;
      if (changed && !currentRouteKey) {
        addEvent(
          "player-route-inferred",
          route.mediaHost,
          `${videoState.playerId} ${route.presentationId} ${route.kind} ${route.routeKey}`
        );
      }
    }
    return route;
  }

  function observeVideo(video) {
    if (
      !isPlaybackPage(session.pageUrl) ||
      observedVideos.has(video)
    ) {
      return;
    }
    observedVideos.add(video);
    videoStateFor(video);
    video.addEventListener("loadstart", () => {
      if (!isPlaybackPage(session.pageUrl)) {
        return;
      }
      const videoState = videoStateFor(video, true);
      resolveVideoRoute(video, videoState);
      syncPlayerDetail(videoState, video);
      requestProbe(video.currentSrc || video.src);
    });
    video.addEventListener("loadedmetadata", () => {
      const videoState = videoStates.get(video);
      if (videoState?.sessionId !== session.id) {
        return;
      }
      resolveVideoRoute(video, videoState);
      syncPlayerDetail(videoState, video);
      requestProbe(video.currentSrc || video.src);
    });
    video.addEventListener("waiting", () => {
      const videoState = videoStates.get(video);
      if (videoState?.sessionId !== session.id) {
        return;
      }
      resolveVideoRoute(video, videoState);
      videoState.waitingCount += 1;
      session.waitingCount += 1;
      if (videoState.bufferingSince === null) {
        videoState.bufferingSince = performance.now();
      }
      syncPlayerDetail(videoState, video);
      addEvent("waiting", "", videoState.playerId);
      schedulePlaybackRisk("waiting", video);
      recordSession();
    });
    video.addEventListener("stalled", () => {
      const videoState = videoStates.get(video);
      if (videoState?.sessionId !== session.id) {
        return;
      }
      resolveVideoRoute(video, videoState);
      videoState.stalledCount += 1;
      session.stalledCount += 1;
      if (videoState.bufferingSince === null) {
        videoState.bufferingSince = performance.now();
      }
      syncPlayerDetail(videoState, video);
      addEvent("stalled", "", videoState.playerId);
      schedulePlaybackRisk("stalled", video);
      recordSession();
    });
    video.addEventListener("playing", () => {
      const videoState = videoStates.get(video);
      if (videoState?.sessionId !== session.id) {
        return;
      }
      if (routingSuspended) {
        void resumeRouting();
      }
      clearTimeout(lifecycleTimer);
      lifecycleTimer = null;
      clearPlaybackRisk(videoState);
      resolveVideoRoute(video, videoState);
      if (session.firstPlayingMs === null) {
        session.firstPlayingMs = Math.round(
          performance.now() - sessionStartedPerformance
        );
        addEvent("first-playing", "", `${session.firstPlayingMs}ms`);
      }
      if (videoState.bufferingSince !== null) {
        session.bufferingMs += performance.now() - videoState.bufferingSince;
        videoState.bufferingSince = null;
      }
      syncPlayerDetail(videoState, video);
      recordSession();
    });
    video.addEventListener("timeupdate", () => {
      const videoState = videoStates.get(video);
      if (videoState?.sessionId !== session.id) {
        return;
      }
      resolveVideoRoute(video, videoState);
      if (
        videoState.playbackRiskTimer &&
        (Number(video.currentTime) || 0) >
          videoState.playbackRiskBaselineTime + 0.1
      ) {
        clearPlaybackRisk(videoState);
      }
      videoState.playbackSeconds = Math.max(
        videoState.playbackSeconds,
        Number(video.currentTime) || 0
      );
      session.playbackSeconds = Math.max(
        session.playbackSeconds,
        videoState.playbackSeconds
      );
      syncPlayerDetail(videoState, video);
      if (performance.now() - videoState.lastTimeUpdateSentAt > 5000) {
        videoState.lastTimeUpdateSentAt = performance.now();
        recordSession();
      }
    });
    video.addEventListener("pause", () => {
      const videoState = videoStates.get(video);
      if (videoState?.sessionId === session.id) {
        clearPlaybackRisk(videoState);
        syncPlayerDetail(videoState, video);
        scheduleHiddenIdleSuspend();
      }
    });
    video.addEventListener("canplay", () => {
      const videoState = videoStates.get(video);
      if (videoState?.sessionId === session.id) {
        clearPlaybackRisk(videoState);
      }
    });
    for (const type of ["emptied", "ended"]) {
      video.addEventListener(type, () => {
        const videoState = videoStates.get(video);
        if (videoState?.sessionId === session.id) {
          releasePlayer(video, videoState);
          scheduleHiddenIdleSuspend();
          recordSession();
        }
      });
    }
  }

  function releaseNodePlayers(node) {
    if (!(node instanceof Element)) {
      return;
    }
    if (node.matches("video")) {
      releasePlayer(node);
    }
    node.querySelectorAll?.("video").forEach((video) =>
      releasePlayer(video)
    );
  }

  const pendingNodeScans = new Set();
  let nodeScanScheduled = false;

  function flushPendingNodeScans() {
    nodeScanScheduled = false;
    const nodes = [...pendingNodeScans];
    pendingNodeScans.clear();
    for (const node of nodes) {
      if (node?.isConnected === false) {
        continue;
      }
      let parent = node?.parentNode;
      let covered = false;
      while (parent) {
        if (nodes.includes(parent)) {
          covered = true;
          break;
        }
        parent = parent.parentNode;
      }
      if (!covered) {
        scanNode(node);
      }
    }
  }

  function scheduleNodeScan(node) {
    if (!(node instanceof Element)) {
      return;
    }
    pendingNodeScans.add(node);
    if (nodeScanScheduled) {
      return;
    }
    nodeScanScheduled = true;
    if (typeof globalThis.requestIdleCallback === "function") {
      globalThis.requestIdleCallback(flushPendingNodeScans, {
        timeout: 250
      });
    } else {
      setTimeout(flushPendingNodeScans, 0);
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        cleanAnchor(mutation.target);
      }
      for (const node of mutation.addedNodes) {
        scheduleNodeScan(node);
      }
      for (const node of mutation.removedNodes) {
        releaseNodePlayers(node);
      }
    }
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["href"]
  });
  if (document.documentElement) {
    scanNode(document.documentElement);
  }

  document.addEventListener("copy", (event) => {
    if (
      !config?.settings?.globalEnabled ||
      !config.settings.privacy.urlCleaning ||
      !event.clipboardData
    ) {
      return;
    }
    const selected = String(getSelection?.() ?? "");
    const cleaned = selected.replace(
      /https?:\/\/[^\s"'<>，。；）)\]]+/g,
      (candidate) => cleanUrl(candidate)
    );
    if (cleaned !== selected) {
      event.clipboardData.setData("text/plain", cleaned);
      event.preventDefault();
    }
  });

  // Keep in sync with src/lib/cosmetic.js (this world cannot import modules).
  // Hiding-only guarantee: reject anything that could escape the selector
  // position and inject CSS declarations or external references.
  function isSafeCosmeticSelector(selector) {
    return (
      typeof selector === "string" &&
      selector.trim().length > 0 &&
      selector.length <= 200 &&
      !/[{}@\\<>;]|\/\*|url\s*\(|[\r\n]/i.test(selector)
    );
  }

  function applyResourceStats(input) {
    if (!input || typeof input !== "object") {
      return;
    }
    if (Number.isFinite(Number(input.tabRules))) {
      session.activeRuleCount = Math.max(
        0,
        Number(input.tabRules) || 0
      );
    }
    session.resourceStats = {
      ...session.resourceStats,
      ...input,
      tabRules: session.activeRuleCount
    };
  }

  function dispatchConfig(nextConfig) {
    if (
      nextConfig.playbackSessionId &&
      nextConfig.playbackSessionId !== session.id
    ) {
      return;
    }
    if (Number.isInteger(nextConfig.routingTabId)) {
      routingTabId = nextConfig.routingTabId;
    }
    config = nextConfig;
    applyResourceStats(nextConfig.resourceStats);
    const pageConfig = { ...nextConfig };
    delete pageConfig.healthyHosts;
    delete pageConfig.selectedHost;
    sendToMain("CONFIG", pageConfig);
    const cosmeticEnabled = Boolean(
      nextConfig.settings.globalEnabled &&
        nextConfig.settings.privacy.cosmeticFiltering
    );
    const safeSelectors = (
      Array.isArray(nextConfig.cosmeticSelectors)
        ? nextConfig.cosmeticSelectors
        : []
    ).filter(isSafeCosmeticSelector);
    if (localCosmeticStyle) {
      localCosmeticStyle.remove();
      localCosmeticStyle = null;
    }
    if (cosmeticEnabled && safeSelectors.length) {
      const style = document.createElement("style");
      style.dataset.biliOverseaAccel = "cosmetic";
      style.textContent = safeSelectors
        .map((selector) => `${selector}{display:none!important;}`)
        .join("\n");
      localCosmeticStyle = style;
      const attach = () => {
        const parent = document.head ?? document.documentElement;
        if (parent && localCosmeticStyle === style && !style.isConnected) {
          parent.append(style);
        }
      };
      attach();
      if (!style.isConnected) {
        document.addEventListener("DOMContentLoaded", attach, { once: true });
      }
    }
    chrome.runtime
      .sendMessage({ type: "APPLY_COSMETIC", enabled: cosmeticEnabled })
      .catch(() => {});
    if (nextConfig.settings.privacy.urlCleaning && document.documentElement) {
      scanNode(document.documentElement);
    }
    for (const entry of performance.getEntriesByType?.("resource") ?? []) {
      requestProbe(entry.name);
    }
  }

  async function refreshConfig() {
    try {
      const playbackPage = isPlaybackPage(session.pageUrl);
      const response = await chrome.runtime.sendMessage({
        type: "GET_RUNTIME_CONFIG",
        ...(playbackPage
          ? {
              sessionId: session.id,
              sessionEpoch: session.epoch,
              documentStartedAt,
              ...(Number.isInteger(routingTabId)
                ? { routingTabId }
                : {}),
              pageUrl: session.pageUrl
            }
          : { pageUrl: session.pageUrl })
      });
      if (response?.ok && response.config) {
        dispatchConfig(response.config);
        recordSession();
      }
    } catch {
      // Extension context may have been reloaded.
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshConfig(), 50);
  }

  document.addEventListener(READY_EVENT, () => {
    connectMain(true);
    if (config) {
      dispatchConfig(config);
    } else {
      void refreshConfig();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === "local" &&
      (changes.settings || changes.runtimeState)
    ) {
      scheduleRefresh();
    }
  });

  function abortActivePageProbes(reason = "page probe cancelled") {
    for (const active of activePageProbes.values()) {
      active.controller.abort(reason);
    }
    activePageProbes.clear();
  }

  function allowedPageProbeTarget(message) {
    if (
      message?.version !== 1 ||
      message.sessionId !== session.id ||
      Number(message.sessionEpoch) !== session.epoch ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(String(message.probeId ?? "")) ||
      routingSuspended ||
      !isPlaybackPage(session.pageUrl)
    ) {
      return null;
    }
    let target;
    try {
      target = new URL(String(message.targetUrl ?? ""));
    } catch {
      return null;
    }
    if (
      target.href.length > 4096 ||
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.hash ||
      !/\.(?:m4s|flv|mp4)$/i.test(target.pathname) ||
      !(
        target.hostname.endsWith(".bilivideo.com") ||
        target.hostname.endsWith(".bilivideo.cn") ||
        target.hostname === "upos-hz-mirrorakam.akamaized.net"
      )
    ) {
      return null;
    }
    const presentationId = normalizedPresentationId(
      message.presentationId
    );
    const routeKey = normalizedRouteKey(message.routeKey);
    const route = latestRoutes.find(
      (candidate) =>
        normalizedPresentationId(candidate?.presentationId) ===
          presentationId &&
        normalizedRouteKey(candidate?.routeKey) === routeKey
    );
    if (!route) {
      return null;
    }
    const registeredUrls = [
      ...(Array.isArray(route.urls) ? route.urls : []),
      ...(Array.isArray(route.originalUrls) ? route.originalUrls : [])
    ];
    const registeredHosts = new Set();
    let sameSignedResource = false;
    for (const rawUrl of registeredUrls) {
      try {
        const registered = new URL(rawUrl, location.href);
        registeredHosts.add(registered.hostname);
        sameSignedResource ||= (
          registered.protocol === target.protocol &&
          registered.pathname === target.pathname &&
          registered.search === target.search
        );
      } catch {
        // Ignore malformed routes; registration is authoritative in SW.
      }
    }
    const configuredCandidates = new Set(
      (Array.isArray(config?.candidateHosts)
        ? config.candidateHosts
        : []
      ).map((host) => String(host).toLowerCase())
    );
    if (
      !sameSignedResource ||
      (
        !registeredHosts.has(target.hostname) &&
        !configuredCandidates.has(target.hostname)
      )
    ) {
      return null;
    }
    return target;
  }

  async function readPageProbeBody(response) {
    if (!response?.body?.getReader) {
      throw new Error("Page probe response is not streamable");
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (received < PAGE_PROBE_BYTES) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!(value instanceof Uint8Array)) {
          throw new Error("Invalid page probe stream chunk");
        }
        const length = Math.min(
          value.byteLength,
          PAGE_PROBE_BYTES - received
        );
        if (length > 0) {
          chunks.push(value.subarray(0, length));
          received += length;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  function pageProbeBodyBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
      binary += String.fromCharCode(
        ...bytes.subarray(offset, offset + 0x8000)
      );
    }
    return btoa(binary);
  }

  function runPageProbeFetch(message, sendResponse) {
    const target = allowedPageProbeTarget(message);
    const probeId = String(message?.probeId ?? "");
    if (!target || activePageProbes.has(probeId)) {
      sendResponse({
        ok: false,
        type: "PAGE_PROBE_FETCH_RESULT",
        version: 1,
        probeId,
        sessionId: session.id,
        error: "Rejected page probe request"
      });
      return false;
    }
    const controller = new AbortController();
    const capturedSessionId = session.id;
    const active = { controller, sessionId: capturedSessionId };
    activePageProbes.set(probeId, active);
    const startedAt = performance.now();
    const timeout = setTimeout(
      () => controller.abort("page probe timeout"),
      PAGE_PROBE_TIMEOUT_MS
    );
    void fetch(target.href, {
      method: "GET",
      headers: { Range: `bytes=0-${PAGE_PROBE_BYTES - 1}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal
    })
      .then(async (response) => {
        const headersAt = performance.now();
        const bytes = await readPageProbeBody(response);
        const completedAt = performance.now();
        if (
          controller.signal.aborted ||
          session.id !== capturedSessionId ||
          activePageProbes.get(probeId) !== active
        ) {
          throw new Error("Page probe session changed");
        }
        sendResponse({
          ok: true,
          type: "PAGE_PROBE_FETCH_RESULT",
          version: 1,
          probeId,
          sessionId: capturedSessionId,
          status: Number(response.status) || 0,
          finalUrl: String(response.url || target.href).slice(0, 4096),
          bytes: bytes.byteLength,
          ttfbMs: Math.max(0, Math.round(headersAt - startedAt)),
          transferDurationMs: Math.max(
            0,
            Math.round(completedAt - headersAt)
          ),
          durationMs: Math.max(1, Math.round(completedAt - startedAt)),
          bodyBase64: pageProbeBodyBase64(bytes)
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          type: "PAGE_PROBE_FETCH_RESULT",
          version: 1,
          probeId,
          sessionId: capturedSessionId,
          error: String(error?.message ?? error).slice(0, 160)
        });
      })
      .finally(() => {
        clearTimeout(timeout);
        if (activePageProbes.get(probeId) === active) {
          activePageProbes.delete(probeId);
        }
      });
    return true;
  }

  chrome.runtime.onMessage?.addListener(
    (message, sender, sendResponse) => {
      if (
        sender?.id &&
        chrome.runtime.id &&
        sender.id !== chrome.runtime.id
      ) {
        return false;
      }
      if (message?.type === "RUN_PAGE_PROBE_FETCH") {
        return runPageProbeFetch(message, sendResponse);
      }
      if (message?.type === "CANCEL_PAGE_PROBE_FETCH") {
        const probeId = String(message.probeId ?? "");
        const active = activePageProbes.get(probeId);
        const found = Boolean(
          active &&
          message.version === 1 &&
          message.sessionId === active.sessionId
        );
        if (found) {
          active.controller.abort("page probe cancelled");
        }
        sendResponse({
          ok: true,
          type: "PAGE_PROBE_FETCH_CANCELLED",
          version: 1,
          probeId,
          sessionId: session.id,
          found
        });
        return false;
      }
      if (
        message?.type !== "ROUTING_CONFIG_UPDATED" ||
        message.sessionId !== session.id ||
        message.config?.playbackSessionId !== session.id
      ) {
        return false;
      }
      dispatchConfig(message.config);
      addEvent(
        "route-config-push",
        "",
        String(message.reason ?? "").slice(0, 60)
      );
      recordSession();
      return false;
    }
  );

  globalThis.addEventListener?.("pageshow", (event) => {
    if (!event.persisted || !isPlaybackPage(session.pageUrl)) {
      return;
    }
    addEvent("bfcache-restore");
    if (routingSuspended) {
      void resumeRouting({ restoredFromBfcache: true });
      return;
    }
    documentStartedAt = Math.max(Date.now(), documentStartedAt + 1);
    announceSession({ restoredFromBfcache: true })
      .then(() => registerMediaRoutes(latestRoutes))
      .then(() => refreshConfig())
      .catch(() => {});
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      scheduleHiddenIdleSuspend();
    } else {
      void resumeRouting();
    }
  });
  document.addEventListener("freeze", () => {
    suspendRouting("freeze");
  });
  document.addEventListener("resume", () => {
    if (!document.hidden) {
      void resumeRouting();
    }
  });
  globalThis.addEventListener?.("pagehide", () => {
    suspendRouting("pagehide");
  });

  if (isPlaybackPage(session.pageUrl)) {
    addEvent("session-start");
    announceSession();
  }
  connectMain();
  if (typeof PerformanceObserver === "function") {
    const resourceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        requestProbe(entry.name);
      }
    });
    try {
      resourceObserver.observe({ type: "resource", buffered: true });
    } catch {
      resourceObserver.observe({ entryTypes: ["resource"] });
    }
  }
  void refreshConfig();
})();
