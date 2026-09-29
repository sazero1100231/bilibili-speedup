import { mergePopupSettings } from "./popup-settings.js";

const inputs = {
  globalEnabled: document.querySelector("#globalEnabled"),
  accelerationEnabled: document.querySelector("#accelerationEnabled"),
  urlCleaning: document.querySelector("#urlCleaning"),
  telemetryBlocking: document.querySelector("#telemetryBlocking")
};
const status = document.querySelector("#status");
const node = document.querySelector("#node");
let config;
let playbackStatus = null;

function render() {
  inputs.globalEnabled.checked = config.settings.globalEnabled;
  inputs.accelerationEnabled.checked = config.settings.acceleration.enabled;
  inputs.urlCleaning.checked = config.settings.privacy.urlCleaning;
  inputs.telemetryBlocking.checked =
    config.settings.privacy.telemetryBlocking;
  const enabled = config.settings.globalEnabled;
  inputs.accelerationEnabled.disabled = !enabled;
  inputs.urlCleaning.disabled = !enabled;
  inputs.telemetryBlocking.disabled = !enabled;
  const current = playbackStatus?.playback;
  node.textContent = !config.settings.globalEnabled || !config.settings.acceleration.enabled
    ? "Playback acceleration is disabled"
    : current?.status === "seeking" ? "Loading the new playback position"
    : current?.status === "waiting" ? "Playback is waiting for data; evaluating available routes"
    : current?.status === "paused" ? "Playback is paused"
    : current?.status === "playing" ? "Video is playing; adjusting transfers to buffer demand"
    : "No playback status for this tab yet; a node speed test does not confirm playback recovery";
}

async function load() {
  const response = await chrome.runtime.sendMessage({
    type: "GET_RUNTIME_CONFIG"
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Load failed");
  }
  config = response.config;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (Number.isInteger(tab?.id)) playbackStatus = await chrome.runtime.sendMessage({ type: "GET_TAB_PLAYBACK_STATUS", tabId: tab.id });
  } catch { playbackStatus = null; }
  render();
}

async function save() {
  status.textContent = "Applying…";
  const stored = await chrome.storage.local.get("settings");
  config.settings = mergePopupSettings(
    stored.settings ?? config.settings,
    {
      globalEnabled: inputs.globalEnabled.checked,
      accelerationEnabled: inputs.accelerationEnabled.checked,
      urlCleaning: inputs.urlCleaning.checked,
      telemetryBlocking: inputs.telemetryBlocking.checked
    }
  );
  await chrome.storage.local.set({ settings: config.settings });
  render();
  status.textContent = config.settings.globalEnabled
    ? "Applied; reload the page to ensure all modules update."
    : "Disabled and network rules removed; no injection after reload.";
}

for (const input of Object.values(inputs)) {
  input.addEventListener("change", () => void save());
}

document.querySelector("#options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

load().catch((error) => {
  status.textContent = error.message;
});
