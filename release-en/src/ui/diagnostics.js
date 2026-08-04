const metrics = document.querySelector("#metrics");
const probeRows = document.querySelector("#probeRows");
const sessionRows = document.querySelector("#sessionRows");
const routeRows = document.querySelector("#routeRows");
const playerRows = document.querySelector("#playerRows");
const probeMeta = document.querySelector("#probeMeta");
const captureDescription = document.querySelector("#captureDescription");
const enableDiagnostics = document.querySelector("#enableDiagnostics");
const exportButton = document.querySelector("#export");
const status = document.querySelector("#status");
let snapshot = null;
let exportPending = false;

function formatDuration(ms) {
  if (ms === null || ms === undefined) {
    return "—";
  }
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatThroughput(bps) {
  if (!bps) {
    return "—";
  }
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}

function metric(label, value) {
  const box = document.createElement("div");
  box.className = "metric";
  const name = document.createElement("span");
  name.className = "muted";
  name.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  box.append(name, strong);
  return box;
}

function renderMetrics(latest) {
  metrics.replaceChildren();
  if (!latest) {
    metrics.append(metric("Status", "No data yet"));
    return;
  }
  metrics.append(
    metric("Stall events", String(latest.waitingCount + latest.stalledCount)),
    metric("Total buffering", formatDuration(latest.bufferingMs)),
    metric("First-play time", formatDuration(latest.firstPlayingMs)),
    metric("Planned node", latest.plannedMediaHost || "—"),
    metric("Actual node", latest.mediaHost || "—"),
    metric("Rewrite count", String(latest.rewriteCount)),
    metric("Fallback count", String(latest.fallbackCount))
  );
  metrics.append(
    metric("Active degrade", String(latest.degradedCount ?? 0)),
    metric("Actual route switches", String(latest.routeSwitchCount ?? 0)),
    metric("Tab rules", String(latest.activeRuleCount ?? 0)),
    metric("Rule apply latency", formatDuration(latest.lastRuleLatencyMs ?? 0))
  );
  const resources = latest.resourceStats ?? {};
  metrics.append(
    metric(
      "Presentations",
      `${resources.presentations ?? 0} / ${resources.maxPresentations ?? 4}`
    ),
    metric("Routes", String(resources.routes ?? 0)),
    metric(
      "DNR rules",
      `${resources.tabRules ?? 0} / ${resources.maxTabRules ?? 16}`
    ),
    metric(
      "Probe in-flight",
      `${resources.probeActiveTab ?? 0} tab / ${resources.probeActiveGlobal ?? 0} global`
    ),
    metric(
      "Probe bytes/min",
      `${resources.probeBytesTabMinute ?? 0} tab / ${resources.probeBytesGlobalMinute ?? 0} global`
    )
  );
}

function renderProbes(config) {
  probeRows.replaceChildren();
  probeMeta.textContent = config.lastProbeAt
    ? `Last probe: ${new Date(config.lastProbeAt).toLocaleString()}; probe-ranked pick: ${config.selectedHost || "none"}`
    : "Not probed yet; measurement runs automatically after a supported video plays.";
  for (const result of config.probeResults) {
    const row = document.createElement("tr");
    const cells = [
      result.host,
      `${result.presentationId || "unassigned"} · ${result.kind || "media"} · ${result.routeKey || "—"}`,
      result.healthy
        ? "Healthy"
        : result.compatible && !result.routeQualified
          ? "Compatible/low bandwidth"
          : "Failed",
      `${formatDuration(result.ttfbMs)} / ${formatDuration(result.durationMs)}`,
      `${formatThroughput(result.throughputBps)} / ${formatThroughput(result.requestThroughputBps)}${result.bodyTimingReliable ? "" : " (conservative timing)"}`,
      String(result.status || "—")
    ];
    for (const value of cells) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    probeRows.append(row);
  }
}

function appendCells(row, values) {
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(cell);
  }
}

function renderRouteDetails(latest) {
  routeRows.replaceChildren();
  const routes = Object.values(latest?.routeDetails ?? {}).sort(
    (left, right) => right.updatedAt - left.updatedAt
  );
  if (!routes.length) {
    const row = document.createElement("tr");
    appendCells(row, ["No route details", "—", "—", "—", "—", "—", "—", "—"]);
    routeRows.append(row);
    return;
  }
  for (const route of routes) {
    const row = document.createElement("tr");
    appendCells(row, [
      route.presentationId || "unassigned",
      route.kind || "media",
      route.routeKey || "—",
      `${route.plannedHost || "—"} → ${route.mediaHost || "—"}`,
      String(route.routeSwitchCount ?? 0),
      formatThroughput(route.lastThroughputBps),
      `${Number(route.lastBufferAhead ?? 0).toFixed(2)} s`,
      route.recoveryStatus || "idle"
    ]);
    routeRows.append(row);
  }
}

function renderPlayerDetails(latest) {
  playerRows.replaceChildren();
  const players = Object.values(latest?.playerDetails ?? {}).sort(
    (left, right) => right.updatedAt - left.updatedAt
  );
  if (!players.length) {
    const row = document.createElement("tr");
    appendCells(row, ["No player details yet", "—", "—", "—", "—", "—", "—"]);
    playerRows.append(row);
    return;
  }
  for (const player of players) {
    const row = document.createElement("tr");
    appendCells(row, [
      player.playerId || "—",
      player.presentationId || "unassigned",
      player.routeKey || "—",
      player.mediaHost || "—",
      `${player.waitingCount ?? 0} / ${player.stalledCount ?? 0}`,
      `${Number(player.bufferAhead ?? 0).toFixed(2)} s`,
      Number(player.playbackSeconds ?? 0).toFixed(2)
    ]);
    playerRows.append(row);
  }
}

function renderSessions(sessions) {
  sessionRows.replaceChildren();
  for (const entry of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const row = document.createElement("tr");
    const values = [
      new Date(entry.startedAt).toLocaleString(),
      entry.pageUrl,
      `${entry.plannedMediaHost || "—"} → ${entry.mediaHost || "—"}`,
      String(entry.waitingCount + entry.stalledCount),
      formatDuration(entry.bufferingMs),
      formatDuration(entry.firstPlayingMs),
      `${entry.rewriteCount} / ${entry.fallbackCount} / ${entry.degradedCount ?? 0}`
    ];
    appendCells(row, values);
    sessionRows.append(row);
  }
}

function renderCaptureState(settings, capture, sessions) {
  const globalEnabled = Boolean(settings?.globalEnabled);
  const collectionEnabled = Boolean(
    globalEnabled && settings?.diagnostics?.enabled
  );
  enableDiagnostics.hidden = collectionEnabled || !globalEnabled;
  enableDiagnostics.disabled = !globalEnabled || collectionEnabled;
  exportButton.disabled = exportPending || sessions.length === 0;

  if (!globalEnabled) {
    captureDescription.textContent =
      "The extension is disabled. Enable it in Settings before diagnostics can record.";
    return;
  }
  if (!collectionEnabled) {
    captureDescription.textContent = sessions.length
      ? `Diagnostics are off; you may export the existing ${sessions.length} sessions, but new playback issues will not be recorded.`
      : "Diagnostics are not enabled. Enable them, then return to the playback page and reproduce the issue; earlier playback cannot be captured retroactively.";
    return;
  }
  if (!sessions.length) {
    captureDescription.textContent =
      "Diagnostics are enabled, but no playback session has been captured. Reproduce the issue on a supported playback page before exporting.";
    return;
  }
  const failures = Number(capture?.failedActiveSessions) || 0;
  captureDescription.textContent = failures
    ? `Saved ${sessions.length} sessions; before export, ${failures} active playback pages could not be captured live; existing data is retained.`
    : `Diagnostics are collecting; currently saved ${sessions.length} playback sessions, with the latest active sessions synchronized before export.`;
}

async function load() {
  exportButton.disabled = true;
  const response = await chrome.runtime.sendMessage({
    type: "PREPARE_DIAGNOSTIC_EXPORT"
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Unable to read diagnostics");
  }
  const sessions = Array.isArray(response.sessions)
    ? response.sessions
    : [];
  snapshot = {
    exportedAt: new Date().toISOString(),
    extensionVersion: response.version,
    captureState: response.capture,
    settings: response.settings,
    runtimeState: response.runtimeState,
    sessions
  };
  const latest =
    [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  renderMetrics(latest);
  renderRouteDetails(latest);
  renderPlayerDetails(latest);
  renderProbes(response.config);
  renderSessions(sessions);
  renderCaptureState(response.settings, response.capture, sessions);
  return snapshot;
}

document.querySelector("#refresh").addEventListener("click", () => {
  load().catch((error) => {
    status.textContent = error.message;
  });
});

enableDiagnostics.addEventListener("click", async () => {
  enableDiagnostics.disabled = true;
  status.textContent = "Enabling diagnostics…";
  try {
    const stored = await chrome.storage.local.get("settings");
    const settings = structuredClone(
      stored.settings ?? snapshot?.settings ?? {}
    );
    if (!settings.globalEnabled) {
      throw new Error("The extension is disabled. Enable it in Settings first.");
    }
    settings.diagnostics ??= {};
    settings.diagnostics.enabled = true;
    await chrome.storage.local.set({ settings });
    snapshot.settings = settings;
    renderCaptureState(settings, snapshot.captureState, snapshot.sessions);
    status.textContent =
      "Diagnostics enabled. Return to the playback page, reproduce the issue, then come back here to export.";
  } catch (error) {
    enableDiagnostics.disabled = false;
    status.textContent = `Enable failed: ${error.message}`;
  }
});

exportButton.addEventListener("click", async () => {
  if (exportPending) {
    return;
  }
  exportPending = true;
  exportButton.disabled = true;
  status.textContent = "Synchronizing latest diagnostics…";
  try {
    await load();
    if (!snapshot?.sessions?.length) {
      status.textContent = snapshot?.settings?.diagnostics?.enabled
        ? "Diagnostics are enabled but contain no playback session; reproduce the issue before exporting."
        : "Diagnostics are not enabled; an empty export cannot diagnose playback issues.";
      return;
    }
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `bilibili-speedup-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    status.textContent = "Generated a local JSON export containing the latest active sessions.";
  } catch (error) {
    status.textContent = `Export failed: ${error.message}`;
  } finally {
    exportPending = false;
    exportButton.disabled = !(snapshot?.sessions?.length > 0);
  }
});

document.querySelector("#clear").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({
    type: "CLEAR_DIAGNOSTICS"
  });
  if (!response?.ok) {
    status.textContent = response?.error ?? "Clear failed";
    return;
  }
  status.textContent = "Cleared earlier local measurements. If diagnostics remain enabled and a playback page is still open, a new active session is recorded immediately.";
  await load();
});

load().catch((error) => {
  exportButton.disabled = true;
  status.textContent = error.message;
});
