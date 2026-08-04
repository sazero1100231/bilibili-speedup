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
    metrics.append(metric("狀態", "尚無資料"));
    return;
  }
  metrics.append(
    metric("卡頓事件", String(latest.waitingCount + latest.stalledCount)),
    metric("總緩衝", formatDuration(latest.bufferingMs)),
    metric("起播時間", formatDuration(latest.firstPlayingMs)),
    metric("規劃節點", latest.plannedMediaHost || "—"),
    metric("實際節點", latest.mediaHost || "—"),
    metric("改寫次數", String(latest.rewriteCount)),
    metric("回退次數", String(latest.fallbackCount))
  );
  metrics.append(
    metric("主動降權", String(latest.degradedCount ?? 0)),
    metric("實際路由切換", String(latest.routeSwitchCount ?? 0)),
    metric("分頁規則", String(latest.activeRuleCount ?? 0)),
    metric("規則生效延遲", formatDuration(latest.lastRuleLatencyMs ?? 0))
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
    ? `最後測速：${new Date(config.lastProbeAt).toLocaleString()}；測速排序首選：${config.selectedHost || "無"}`
    : "尚未測速；播放支援的視頻後會自動測量。";
  for (const result of config.probeResults) {
    const row = document.createElement("tr");
    const cells = [
      result.host,
      `${result.presentationId || "unassigned"} · ${result.kind || "media"} · ${result.routeKey || "—"}`,
      result.healthy
        ? "健康"
        : result.compatible && !result.routeQualified
          ? "相容／頻寬不足"
          : "失敗",
      `${formatDuration(result.ttfbMs)} / ${formatDuration(result.durationMs)}`,
      `${formatThroughput(result.throughputBps)} / ${formatThroughput(result.requestThroughputBps)}${result.bodyTimingReliable ? "" : "（保守計時）"}`,
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
    appendCells(row, ["尚無 route 明細", "—", "—", "—", "—", "—", "—", "—"]);
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
    appendCells(row, ["尚無播放器明細", "—", "—", "—", "—", "—", "—"]);
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
      "擴充功能目前已停用；請先在設定中啟用，診斷才會開始記錄。";
    return;
  }
  if (!collectionEnabled) {
    captureDescription.textContent = sessions.length
      ? `診斷目前關閉；可匯出既有 ${sessions.length} 場，但不會記錄新的播放問題。`
      : "診斷尚未啟用。請先啟用，再回到播放頁重現問題；之前的播放無法事後補記。";
    return;
  }
  if (!sessions.length) {
    captureDescription.textContent =
      "診斷已啟用，但尚無播放場次。請在支援的播放頁重現問題後再匯出。";
    return;
  }
  const failures = Number(capture?.failedActiveSessions) || 0;
  captureDescription.textContent = failures
    ? `已保存 ${sessions.length} 場；匯出前有 ${failures} 個作用中播放頁無法即時擷取，既有資料仍會保留。`
    : `診斷正在收集；目前已保存 ${sessions.length} 場播放，匯出前已同步最新作用中場次。`;
}

async function load() {
  exportButton.disabled = true;
  const response = await chrome.runtime.sendMessage({
    type: "PREPARE_DIAGNOSTIC_EXPORT"
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "無法讀取診斷資料");
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
  status.textContent = "正在啟用診斷…";
  try {
    const stored = await chrome.storage.local.get("settings");
    const settings = structuredClone(
      stored.settings ?? snapshot?.settings ?? {}
    );
    if (!settings.globalEnabled) {
      throw new Error("擴充功能目前已停用，請先在設定中啟用。");
    }
    settings.diagnostics ??= {};
    settings.diagnostics.enabled = true;
    await chrome.storage.local.set({ settings });
    snapshot.settings = settings;
    renderCaptureState(settings, snapshot.captureState, snapshot.sessions);
    status.textContent =
      "已啟用診斷。請回到播放頁重現問題，再返回此頁匯出。";
  } catch (error) {
    enableDiagnostics.disabled = false;
    status.textContent = `啟用失敗：${error.message}`;
  }
});

exportButton.addEventListener("click", async () => {
  if (exportPending) {
    return;
  }
  exportPending = true;
  exportButton.disabled = true;
  status.textContent = "正在同步最新診斷…";
  try {
    await load();
    if (!snapshot?.sessions?.length) {
      status.textContent = snapshot?.settings?.diagnostics?.enabled
        ? "診斷已啟用但尚無播放場次；請先重現問題再匯出。"
        : "診斷尚未啟用；空白匯出無法分析播放問題。";
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
    status.textContent = "已產生包含最新作用中場次的本地 JSON 匯出檔。";
  } catch (error) {
    status.textContent = `匯出失敗：${error.message}`;
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
    status.textContent = response?.error ?? "清除失敗";
    return;
  }
  status.textContent = "已清除先前的本地量測；若診斷仍啟用且播放頁仍開啟，新的作用中場次會立即重新記錄。";
  await load();
});

load().catch((error) => {
  exportButton.disabled = true;
  status.textContent = error.message;
});
