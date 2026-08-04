export function mergePopupSettings(latestSettings, values) {
  const settings = structuredClone(latestSettings);
  settings.globalEnabled = Boolean(values.globalEnabled);
  settings.acceleration.enabled = Boolean(values.accelerationEnabled);
  settings.privacy.urlCleaning = Boolean(values.urlCleaning);
  settings.privacy.telemetryBlocking = Boolean(values.telemetryBlocking);
  return settings;
}
