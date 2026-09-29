// A small real-HTTP boundary check. Playback acceptance is a separate journey.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { TransferBudget } from "../../src/lib/transfer-budget.js";

const bytes = Uint8Array.from({ length: 1536 * 1024 }, (_, index) => (index * 17 + Math.floor(index / 251)) & 255);
const servers = [];
let mode = "normal";
const network = { active: 0, peak: 0, bytes: 0 };
for (let index = 0; index < 2; index += 1) {
  const server = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || "");
    if (!match) { response.writeHead(416).end(); return; }
    const start = Number(match[1]), end = Number(match[2]);
    network.active += 1; network.peak = Math.max(network.peak, network.active);
    response.once("close", () => { network.active -= 1; });
    response.writeHead(206, { "content-range": `bytes ${start + (mode === "bad-range" && index === 0 ? 1 : 0)}-${end}/${bytes.length}`,
      "content-type": "video/mp4", "content-length": end - start + 1 });
    let offset = start, timer;
    response.once("close", () => clearTimeout(timer));
    const push = () => {
      if (response.destroyed) return;
      if (offset > end) { response.end(); return; }
      const count = Math.min(32 * 1024, end - offset + 1);
      response.write(bytes.subarray(offset, offset + count));
      network.bytes += count; offset += count;
      const delay = mode === "cancel" ? 100 : mode === "tail-stall" && index === 0 && offset - start >= 64 * 1024 ? 1400 : 15;
      timer = setTimeout(push, delay);
    };
    push();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
}
const urls = servers.map(server => `http://127.0.0.1:${server.address().port}/fixture.m4s`);
const window = {};
runInNewContext(await readFile(new URL("../../src/content/range-transport.js", import.meta.url), "utf8"), {
  window, URL, Headers, Response, ReadableStream, AbortController, DOMException,
  performance, setTimeout, clearTimeout, Uint8Array
});
const outcomes = [];
try {
  for (const scenario of ["normal", "tail-stall", "bad-range", "cancel"]) {
    mode = scenario;
    const budget = new TransferBudget();
    const engine = window.__BILI_SPEEDUP_RANGE_FACTORY__.create({
      fetch,
      allowed: url => urls.includes(url),
      playback: () => ({ buffer: 0.5, rate: 1, paused: false }),
      acquire: (id, kind) => budget.acquire(1, "boundary", id, kind),
      release: id => budget.release("boundary", id),
      onResult: result => outcomes.push({ scenario, ...result })
    });
    const controller = new AbortController();
    const job = engine.start({ url: urls[0], urls, headers: { Range: `bytes=0-${bytes.length - 1}` },
      route: { presentationId: "fixture", routeKey: "/fixture.m4s", kind: "video" }, signal: controller.signal });
    const read = job.response.then(response => response.arrayBuffer());
    if (scenario === "cancel") {
      setTimeout(() => controller.abort(), 150);
      await assert.rejects(read);
    } else {
      const delivered = new Uint8Array(await read);
      assert.deepEqual(delivered, bytes, "Consumer received changed or missing bytes");
    }
    await job.done;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(budget.active.size, 0, "Completed/cancelled job retained a request lease");
    assert.equal(budget.queue.length, 0);
    assert.equal(engine.stats().active, 0);
    assert.ok(budget.peak <= budget.tabLimit);
  }
  console.log(JSON.stringify({ outcomes, peakNetworkRequests: network.peak }, null, 2));
} finally {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
