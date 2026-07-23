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
  node.textContent = config.selectedHost
    ? `測速排序首選：${config.selectedHost}`
    : "暫無已驗證加速節點；無候選時保留 Bilibili 原生路由";
}

async function load() {
  const response = await chrome.runtime.sendMessage({
    type: "GET_RUNTIME_CONFIG"
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "讀取失敗");
  }
  config = response.config;
  render();
}

async function save() {
  status.textContent = "套用中…";
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
    ? "已套用；重載頁面可確保全部模組更新。"
    : "已停用並移除網路規則；重載頁面後不再注入。";
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
