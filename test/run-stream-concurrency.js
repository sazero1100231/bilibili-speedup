const scenarios = [
  "bridge.test.js",
  "dnr.test.js",
  "live-stream-matrix.test.js",
  "main-world.test.js",
  "probe-scheduler.test.js",
  "prober.test.js",
  "service-worker-routing.test.js",
  "stream-policy.test.js",
  "url-utils.test.js"
];

for (const scenario of scenarios) {
  await import(new URL(`./unit/${scenario}`, import.meta.url));
}
