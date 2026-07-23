const metrics = document.querySelector("#metrics");
const probeRows = document.querySelector("#probeRows");
const sessionRows = document.querySelector("#sessionRows");
const routeRows = document.querySelector("#routeRows");
const playerRows = document.querySelector("#playerRows");
const probeMeta = document.querySelector("#probeMeta");
const status = document.querySelector("#status");
let snapshot;

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
      result.healthy
        ? "Healthy"
        : result.compatible && !result.routeQualified
          ? "Compatible/low bandwidth"
          : "Failed",
      formatDuration(result.ttfbMs),
      formatThroughput(result.throughputBps),
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

async function load() {
  const [response, stored] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_RUNTIME_CONFIG" }),
    chrome.storage.local.get(["settings", "runtimeState", "diagnostics"])
  ]);
  if (!response?.ok) {
    throw new Error(response?.error ?? "Unable to read diagnostics");
  }
  const sessions = stored.diagnostics?.sessions ?? [];
  snapshot = {
    exportedAt: new Date().toISOString(),
    extensionVersion: response.config.version,
    settings: stored.settings,
    runtimeState: stored.runtimeState,
    sessions
  };
  const latest =
    [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  renderMetrics(latest);
  renderRouteDetails(latest);
  renderPlayerDetails(latest);
  renderProbes(response.config);
  renderSessions(sessions);
}

document.querySelector("#refresh").addEventListener("click", () => {
  load().catch((error) => {
    status.textContent = error.message;
  });
});

document.querySelector("#export").addEventListener("click", () => {
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
  status.textContent = "Generated a local JSON export file.";
});

document.querySelector("#clear").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({
    type: "CLEAR_DIAGNOSTICS"
  });
  if (!response?.ok) {
    status.textContent = response?.error ?? "Clear failed";
    return;
  }
  status.textContent = "Local measurements cleared.";
  await load();
});

load().catch((error) => {
  status.textContent = error.message;
});
