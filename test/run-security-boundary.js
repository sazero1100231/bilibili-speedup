const scenarios = [
  "dnr.test.js",
  "prober.test.js",
  "service-worker-routing.test.js",
  "url-utils.test.js"
];

for (const scenario of scenarios) {
  await import(new URL(`./unit/${scenario}`, import.meta.url));
}
