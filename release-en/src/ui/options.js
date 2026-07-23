const controls = {
  globalEnabled: document.querySelector("#globalEnabled"),
  accelerationEnabled: document.querySelector("#accelerationEnabled"),
  playurlRewrite: document.querySelector("#playurlRewrite"),
  dnrFallback: document.querySelector("#dnrFallback"),
  strategy: document.querySelector("#strategy"),
  manualHost: document.querySelector("#manualHost"),
  probeCacheMinutes: document.querySelector("#probeCacheMinutes"),
  urlCleaning: document.querySelector("#urlCleaning"),
  telemetryBlocking: document.querySelector("#telemetryBlocking"),
  cosmeticFiltering: document.querySelector("#cosmeticFiltering"),
  diagnosticsEnabled: document.querySelector("#diagnosticsEnabled"),
  endpointList: document.querySelector("#endpointList"),
  status: document.querySelector("#status")
};

let runtimeConfig;

function endpointInputId(id) {
  return `endpoint-${id}`;
}

function renderEndpoints(catalog, settings) {
  controls.endpointList.replaceChildren();
  for (const endpoint of catalog) {
    const row = document.createElement("div");
    row.className = "row";
    const text = document.createElement("span");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = endpoint.label;
    const description = document.createElement("span");
    description.className = endpoint.conservative
      ? "description danger"
      : "description";
    description.textContent = `${endpoint.rationale} ${endpoint.side_effect}`;
    text.append(label, description);
    const switchLabel = document.createElement("label");
    switchLabel.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = endpointInputId(endpoint.id);
    input.dataset.endpointId = endpoint.id;
    input.checked = Boolean(settings.privacy.endpointToggles[endpoint.id]);
    const slider = document.createElement("span");
    switchLabel.append(input, slider);
    row.append(text, switchLabel);
    controls.endpointList.append(row);
  }
}

function fillForm(config) {
  const { settings } = config;
  controls.globalEnabled.checked = settings.globalEnabled;
  controls.accelerationEnabled.checked = settings.acceleration.enabled;
  controls.playurlRewrite.checked = settings.acceleration.playurlRewrite;
  controls.dnrFallback.checked = settings.acceleration.dnrFallback;
  controls.strategy.value = settings.acceleration.strategy;
  controls.probeCacheMinutes.value = settings.acceleration.probeCacheMinutes;
  controls.urlCleaning.checked = settings.privacy.urlCleaning;
  controls.telemetryBlocking.checked = settings.privacy.telemetryBlocking;
  controls.cosmeticFiltering.checked = settings.privacy.cosmeticFiltering;
  controls.diagnosticsEnabled.checked = settings.diagnostics.enabled;
  controls.manualHost.replaceChildren();
  for (const host of config.candidateHosts) {
    const option = document.createElement("option");
    option.value = host;
    option.textContent =
      host === config.selectedHost ? `${host} (probe pick)` : host;
    controls.manualHost.append(option);
  }
  controls.manualHost.value =
    settings.acceleration.manualHost || config.selectedHost;
  renderEndpoints(config.endpointCatalog, settings);
  updateDisabledState();
}

function updateDisabledState() {
  const enabled = controls.globalEnabled.checked;
  const acceleration = enabled && controls.accelerationEnabled.checked;
  controls.playurlRewrite.disabled = !acceleration;
  controls.dnrFallback.disabled = !acceleration;
  controls.strategy.disabled = !acceleration;
  controls.manualHost.disabled =
    !acceleration || controls.strategy.value !== "manual";
  controls.probeCacheMinutes.disabled = !acceleration;
  controls.urlCleaning.disabled = !enabled;
  controls.telemetryBlocking.disabled = !enabled;
  controls.cosmeticFiltering.disabled = !enabled;
  controls.diagnosticsEnabled.disabled = !enabled;
  controls.endpointList
    .querySelectorAll("input")
    .forEach((input) => {
      input.disabled = !enabled || !controls.telemetryBlocking.checked;
    });
}

function readSettings() {
  const settings = structuredClone(runtimeConfig.settings);
  settings.globalEnabled = controls.globalEnabled.checked;
  settings.acceleration.enabled = controls.accelerationEnabled.checked;
  settings.acceleration.playurlRewrite = controls.playurlRewrite.checked;
  settings.acceleration.dnrFallback = controls.dnrFallback.checked;
  settings.acceleration.strategy = controls.strategy.value;
  settings.acceleration.manualHost = controls.manualHost.value;
  settings.acceleration.probeCacheMinutes = Number(
    controls.probeCacheMinutes.value
  );
  settings.privacy.urlCleaning = controls.urlCleaning.checked;
  settings.privacy.telemetryBlocking = controls.telemetryBlocking.checked;
  settings.privacy.cosmeticFiltering = controls.cosmeticFiltering.checked;
  settings.diagnostics.enabled = controls.diagnosticsEnabled.checked;
  controls.endpointList
    .querySelectorAll("[data-endpoint-id]")
    .forEach((input) => {
      settings.privacy.endpointToggles[input.dataset.endpointId] = input.checked;
    });
  return settings;
}

async function load() {
  const response = await chrome.runtime.sendMessage({
    type: "GET_RUNTIME_CONFIG"
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Unable to read settings");
  }
  runtimeConfig = response.config;
  fillForm(runtimeConfig);
}

document.querySelector("#save").addEventListener("click", async () => {
  controls.status.textContent = "Saving…";
  try {
    const settings = readSettings();
    await chrome.storage.local.set({ settings });
    runtimeConfig.settings = settings;
    controls.status.textContent = "Saved. Reload any open Bilibili pages.";
  } catch (error) {
    controls.status.textContent = `Save failed: ${error.message}`;
  }
});

document.querySelector("#clearProbe").addEventListener("click", async () => {
  controls.status.textContent = "Clearing…";
  const response = await chrome.runtime.sendMessage({
    type: "CLEAR_PROBE_CACHE"
  });
  if (response?.ok) {
    runtimeConfig = response.config;
    fillForm(runtimeConfig);
    controls.status.textContent = "Probe cache cleared; the next video will re-probe.";
  } else {
    controls.status.textContent = `Clear failed: ${response?.error ?? "unknown error"}`;
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("input, select")) {
    updateDisabledState();
  }
});

load().catch((error) => {
  controls.status.textContent = `Load failed: ${error.message}`;
});
