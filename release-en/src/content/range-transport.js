(() => {
  "use strict";
  // This factory runs in MAIN world before main-world.js. It never receives
  // extension privileges, arbitrary hosts, or credentials. Its caller supplies
  // exact representation URLs, playback state and a session-owned budget.
  const KiB = 1024;
  const MAX_RANGE = 8 * 1024 * KiB;
  const MAX_BUFFERED = 32 * 1024 * KiB;
  const abortError = () => new DOMException("Media request cancelled", "AbortError");
  const concatenate = chunks => {
    const out = new Uint8Array(chunks.reduce((sum, bytes) => sum + bytes.length, 0));
    let offset = 0;
    for (const bytes of chunks) { out.set(bytes, offset); offset += bytes.length; }
    return out;
  };
  function parseRange(value) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(value || "").trim());
    if (!match) return null;
    const start = Number(match[1]), end = Number(match[2]);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start
      && end - start + 1 <= MAX_RANGE ? { start, end, length: end - start + 1 } : null;
  }

  function create(options) {
    const jobs = new Set();
    const measurements = new Map();
    let retained = 0, serial = 0, turn = 0, active = 0, peak = 0;
    let concurrency = 2, goodRanges = 0;
    const localQueue = [];
    const now = () => performance.now();
    const meterKey = url => { const parsed = new URL(url); return parsed.host + parsed.pathname; };
    const info = url => {
      const key = meterKey(url);
      let entry = measurements.get(key);
      if (!entry) {
        if (measurements.size >= 256) measurements.delete(measurements.keys().next().value);
        entry = { bps: 0, latency: 0, measured: 0, blockedUntil: 0, pending: 0, failures: 0 };
        measurements.set(key, entry);
      }
      return entry;
    };
    const speed = entry => now() - entry.measured < 90000 ? entry.bps : 0;
    function pump() {
      localQueue.sort((a, b) => b.priority - a.priority || a.at - b.at);
      while (active < concurrency && localQueue.length) {
        const next = localQueue.shift();
        if (next.signal.aborted) { next.reject(abortError()); continue; }
        next.signal.removeEventListener("abort", next.cancel);
        active += 1; peak = Math.max(peak, active);
        let released = false;
        next.resolve(() => { if (!released) { released = true; active -= 1; pump(); } });
      }
    }
    function slot(signal, priority) {
      return new Promise((resolve, reject) => {
        const entry = { signal, priority, resolve, reject, at: now() };
        entry.cancel = () => {
          const index = localQueue.indexOf(entry);
          if (index >= 0) localQueue.splice(index, 1);
          reject(abortError());
        };
        if (signal.aborted) return reject(abortError());
        signal.addEventListener("abort", entry.cancel, { once: true });
        localQueue.push(entry); pump();
      });
    }
    function choose(urls, length, exclude = "", explore = false) {
      const eligible = urls.filter(url => url !== exclude && info(url).blockedUntil <= now());
      const pool = eligible.length ? eligible : urls.filter(url => url !== exclude);
      if (!pool.length) return null;
      const unknown = pool.filter(url => !speed(info(url)) && !info(url).pending);
      if (explore && unknown.length) return unknown[(turn++) % unknown.length];
      return pool.sort((a, b) => {
        const score = url => {
          const entry = info(url);
          // Pending work can use more than one request. Treating it as a
          // serial queue repeatedly assigned urgent pieces to a known slow CDN.
          return entry.latency + (entry.pending / Math.max(1, concurrency - 1) + length)
            / (speed(entry) || 256 * KiB) * 1000;
        };
        return score(a) - score(b);
      })[0];
    }
    function playback(route) {
      return options.playback?.(route) || { buffer: 0, rate: 1, paused: false };
    }

    async function attempt(job, piece, url, prefix, signal, context, priority) {
      const leaseId = `range:${++serial}`;
      const entry = info(url);
      const offset = prefix?.length || 0;
      const start = piece.start + offset;
      const length = piece.end - start + 1;
      let timer, reader, idleTimer, releaseLocal;
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError());
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      context.prefix = prefix;
      context.chunks = [];
      context.bytes = 0;
      context.started = 0;
      context.lastProgress = 0;
      context.lastSample = 0;
      context.url = url;
      context.length = length;
      context.controller = controller;
      entry.pending += length;
      try {
        releaseLocal = await slot(signal, priority);
        await options.acquire(leaseId, job.route.kind, controller.signal);
        if (controller.signal.aborted) throw abortError();
        context.started = now();
        context.lastProgress = context.started;
        timer = setTimeout(() => controller.abort(new DOMException("Media range timeout", "TimeoutError")), 12000);
        const headers = new Headers(job.headers);
        headers.set("Range", `bytes=${start}-${piece.end}`);
        job.requests += 1;
        const response = await options.fetch(url, {
          method: "GET", headers, credentials: "omit", mode: "cors",
          cache: "no-store", redirect: "error", signal: controller.signal
        });
        const latency = now() - context.started;
        const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get("content-range") || "");
        if (response.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== piece.end
          || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= piece.end) {
          throw Object.assign(new Error("Invalid media Content-Range"), { status: response.status, invalidRange: true });
        }
        const total = Number(match[3]);
        if (job.total !== null && job.total !== total) throw new Error("Media representation length changed");
        job.total = total;
        job.type ||= response.headers.get("content-type") || `${job.route.kind === "audio" ? "audio" : "video"}/mp4`;
        reader = response.body.getReader();
        const armIdle = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => controller.abort(new DOMException("Media body stalled", "TimeoutError")), 4000);
        };
        armIdle();
        while (true) {
          const { value, done } = await reader.read();
          if (controller.signal.aborted) throw controller.signal.reason || abortError();
          if (done) break;
          if (!value?.length) continue;
          job.downloaded += value.length;
          context.bytes += value.length;
          if (context.bytes > length) throw new Error("Media range overflow");
          context.chunks.push(value);
          context.lastProgress = now();
          job.lastProgress = context.lastProgress;
          if (context.bytes >= 64 * KiB && now() - context.started >= 500 && now() - context.lastSample >= 500) {
            const measured = context.bytes * 1000 / Math.max(1, now() - context.started);
            entry.bps = speed(entry) ? entry.bps * 0.5 + measured * 0.5 : measured;
            entry.measured = now(); context.lastSample = now();
          }
          context.onProgress?.();
          armIdle();
        }
        if (context.bytes !== length) throw new Error("Truncated media range");
        const elapsed = Math.max(1, now() - context.started);
        if (length >= 48 * KiB) {
          const measured = length * 1000 / elapsed;
          entry.bps = speed(entry) ? entry.bps * 0.65 + measured * 0.35 : measured;
          entry.measured = now();
        }
        entry.latency = entry.latency ? entry.latency * 0.65 + latency * 0.35 : latency;
        entry.failures = 0; entry.blockedUntil = 0;
        job.hosts.add(new URL(response.url || url).hostname);
        return concatenate(prefix ? [prefix, ...context.chunks] : context.chunks);
      } catch (error) {
        if (!signal.aborted && !job.controller.signal.aborted) {
          entry.failures += 1;
          entry.blockedUntil = now() + Math.min(30000, 2000 * 2 ** entry.failures);
          if (error.status === 412 || error.status === 429) { concurrency = 2; goodRanges = 0; }
        }
        // An intentionally cancelled race is a speed observation, not a failure.
        if (signal.aborted && context.bytes >= 48 * KiB && context.started) {
          const measured = context.bytes * 1000 / Math.max(1, now() - context.started);
          entry.bps = speed(entry) ? entry.bps * 0.65 + measured * 0.35 : measured;
          entry.measured = now();
        }
        throw error;
      } finally {
        clearTimeout(timer); clearTimeout(idleTimer);
        controller.abort();
        await reader?.cancel().catch(() => {});
        signal.removeEventListener("abort", cancel);
        entry.pending = Math.max(0, entry.pending - length);
        // Release also cancels an acquire whose acknowledgement arrived late.
        options.release(leaseId);
        releaseLocal?.();
      }
    }

    async function downloadPiece(job, piece, index) {
      let prefix = null, lastError, lastUrl = "";
      for (let round = 0; round < 3; round += 1) {
        if (job.controller.signal.aborted) throw abortError();
        const url = choose(job.urls, piece.length - (prefix?.length || 0), round ? lastUrl : "", index === job.count - 1);
        const primaryUrl = url || choose(job.urls, piece.length);
        if (!primaryUrl) throw new Error("No compatible media route");
        lastUrl = primaryUrl;
        const controllers = [new AbortController(), new AbortController()];
        const cancelAll = () => controllers.forEach(controller => controller.abort(abortError()));
        job.controller.signal.addEventListener("abort", cancelAll, { once: true });
        const contexts = [{}, {}];
        const priority = job.route.kind === "audio" ? 100 : 50 - index;
        let hedgeTimer, rejectHedge, hedgeStarted = false;
        const first = attempt(job, piece, primaryUrl, prefix, controllers[0].signal, contexts[0], priority);
        const otherUrl = choose(job.urls, piece.length, primaryUrl);
        const extraBudget = Math.max(32 * KiB, job.range.length * 0.15);
        const canHedge = otherUrl && !job.hedged && job.downloaded - job.delivered < job.range.length + extraBudget;
        const second = new Promise((resolve, reject) => {
          rejectHedge = reject;
          if (!canHedge) return;
          const check = () => {
            if (job.controller.signal.aborted || controllers[1].signal.aborted) return reject(abortError());
            if (job.hedged) return reject(new Error("Range rescue budget already used"));
            const firstState = contexts[0];
            const state = playback(job.route);
            if (!firstState.started || state.paused) { hedgeTimer = setTimeout(check, 200); return; }
            const elapsed = now() - firstState.started;
            const idle = now() - firstState.lastProgress;
            const rate = firstState.bytes * 1000 / Math.max(1, elapsed);
            const remaining = firstState.length - firstState.bytes;
            const deadlineMs = Math.max(500, (state.buffer || 0) / Math.max(0.25, state.rate || 1) * 1000);
            if (elapsed >= 900 && (idle >= 900 || (rate && remaining / rate * 1000 > deadlineMs))) {
              job.hedged = true; job.hedges += 1; hedgeStarted = true;
              const saved = concatenate(firstState.prefix ? [firstState.prefix, ...firstState.chunks] : firstState.chunks);
              const base = saved.length >= 32 * KiB && saved.length < piece.length ? saved : prefix;
              let duplicateLimitReached = false;
              const boundDuplicate = () => {
                const duplicate = Math.min(Math.max(0, (firstState.prefix?.length || 0) + firstState.bytes - (base?.length || 0)), contexts[1].bytes || 0);
                if (duplicateLimitReached || duplicate < extraBudget) return;
                duplicateLimitReached = true;
                const remainingMs = context => (context.length - context.bytes)
                  * Math.max(1, now() - context.started) / Math.max(1, context.bytes);
                // Stop the slower copy once the duplicate payload allowance is
                // spent. One network read can cross the allowance boundary.
                controllers[remainingMs(firstState) <= remainingMs(contexts[1]) ? 1 : 0].abort(abortError());
              };
              firstState.onProgress = contexts[1].onProgress = boundDuplicate;
              attempt(job, piece, otherUrl, base, controllers[1].signal, contexts[1], priority + 10).then(resolve, reject);
            } else hedgeTimer = setTimeout(check, 200);
          };
          hedgeTimer = setTimeout(check, 400);
        });
        first.catch(error => { if (!hedgeStarted) { clearTimeout(hedgeTimer); rejectHedge(error); } });
        try {
          const result = await Promise.any([first, second]);
          cancelAll();
          if (!hedgeStarted) rejectHedge(abortError());
          await Promise.allSettled([first, second]);
          return result;
        } catch (error) {
          lastError = error;
          for (const context of contexts) {
            if (!context.chunks) continue;
            const saved = concatenate(context.prefix ? [context.prefix, ...context.chunks] : context.chunks);
            if (saved.length >= 32 * KiB && saved.length < piece.length && saved.length > (prefix?.length || 0)) prefix = saved;
          }
        } finally {
          clearTimeout(hedgeTimer); cancelAll();
          job.controller.signal.removeEventListener("abort", cancelAll);
        }
      }
      throw lastError || new Error("Media candidates exhausted");
    }

    function start({ url, headers, route, urls, signal }) {
      const range = parseRange(new Headers(headers).get("range"));
      if (!range || jobs.size >= 8 || retained + range.length > MAX_BUFFERED) return null;
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError());
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const hosts = new Set();
      const candidates = [...new Set([url, ...urls])].filter(value => {
        try {
          const parsed = new URL(value);
          if (!options.allowed(value) || parsed.pathname !== route.routeKey || hosts.has(parsed.host)) return false;
          hosts.add(parsed.host); return true;
        }
        catch { return false; }
      }).slice(0, 8);
      if (!candidates.length) { signal?.removeEventListener("abort", cancel); return null; }
      const job = { controller, route, headers, urls: candidates, range, total: null, type: "", requests: 0,
        downloaded: 0, delivered: 0, hedges: 0, hedged: false, hosts: new Set(), started: now(), lastProgress: 0, count: 0 };
      jobs.add(job); retained += range.length;
      let resolveResponse, rejectResponse, streamController, responseSent = false;
      const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
      const stream = new ReadableStream({
        start(value) { streamController = value; },
        cancel() { controller.abort(abortError()); }
      });
      const stop = () => {
        const reason = controller.signal.reason || abortError();
        if (!responseSent) rejectResponse(reason);
        try { streamController.error(reason); } catch { /* Already closed. */ }
      };
      controller.signal.addEventListener("abort", stop, { once: true });
      const measured = candidates.map(value => speed(info(value))).filter(Boolean);
      const chunkSize = Math.max(256 * KiB, Math.min(1024 * KiB,
        measured.length ? Math.max(...measured) * 0.6 : 512 * KiB));
      const count = route.kind === "audio" || range.length <= 512 * KiB || playback(route).buffer >= 15 ? 1
        : Math.min(16, Math.max(2, Math.ceil(range.length / chunkSize)));
      job.count = count;
      const pieces = Array.from({ length: count }, (_, index) => {
        const start = range.start + Math.floor(range.length * index / count);
        const end = range.start + Math.floor(range.length * (index + 1) / count) - 1;
        return { start, end, length: end - start + 1 };
      });
      const ordered = new Map();
      let cursor = 0, next = 0;
      const flush = () => {
        while (ordered.has(next)) {
          const bytes = ordered.get(next); ordered.delete(next++);
          if (!responseSent) {
            const result = new Response(stream, { status: 206, headers: {
              "Content-Type": job.type, "Content-Length": String(range.length),
              "Content-Range": `bytes ${range.start}-${range.end}/${job.total}`, "Accept-Ranges": "bytes"
            } });
            Object.defineProperty(result, "url", { value: url });
            responseSent = true; resolveResponse(result);
          }
          streamController.enqueue(bytes);
          job.delivered += bytes.length;
        }
      };
      const worker = async () => {
        while (cursor < pieces.length) {
          const index = cursor++;
          const bytes = await downloadPiece(job, pieces[index], index);
          if (controller.signal.aborted) throw abortError();
          ordered.set(index, bytes); flush();
        }
      };
      const done = (async () => {
        let outcome = "error";
        let workers = [];
        let scaleTimer;
        const deadline = () => {
          // A large range may span more than 25 seconds of media. Extend only
          // while bytes are arriving and already-delivered media covers playback.
          if (responseSent && now() - job.lastProgress < 4000 && playback(route).buffer > 2
            && now() - job.started < 55000) timeout = setTimeout(deadline, 5000);
          else controller.abort(new DOMException("Media delivery deadline", "TimeoutError"));
        };
        let timeout = setTimeout(deadline, 25000);
        try {
          if (controller.signal.aborted) throw abortError();
          const state = playback(route);
          if (route.kind !== "audio" && !state.paused && state.buffer / state.rate < 8) concurrency = Math.min(4, Math.max(2, concurrency + 1));
          workers = Array.from({ length: Math.min(count, Math.max(1, concurrency - 1)) }, worker);
          if (count > 2 && workers.length < 3) scaleTimer = setTimeout(() => {
            const current = playback(route);
            if (controller.signal.aborted || cursor >= count || current.paused || current.buffer / current.rate >= 4) return;
            concurrency = 4; pump();
            const extra = worker();
            extra.catch(error => controller.abort(error));
            workers.push(extra);
          }, 1500);
          await Promise.all(workers);
          // Includes any worker added by the bounded low-buffer trial below.
          await Promise.all(workers);
          streamController.close();
          outcome = "complete";
          goodRanges += 1;
          if (playback(route).buffer > 15 && goodRanges >= 2) concurrency = 2;
        } catch (error) {
          outcome = controller.signal.aborted && controller.signal.reason?.name === "AbortError" ? "cancelled" : "error";
          if (!responseSent) rejectResponse(error);
          try { streamController.error(error); } catch { /* Already settled. */ }
          controller.abort(error);
        } finally {
          // A rejected worker must not report completion or release its memory
          // reservation while sibling requests still own network leases.
          await Promise.allSettled(workers);
          clearTimeout(timeout);
          clearTimeout(scaleTimer);
          controller.signal.removeEventListener("abort", stop);
          signal?.removeEventListener("abort", cancel);
          jobs.delete(job); retained -= range.length;
          options.onResult?.({ presentationId: route.presentationId, routeKey: route.routeKey, kind: route.kind,
            outcome, bytes: job.delivered, downloadedBytes: job.downloaded,
            extraBytes: Math.max(0, job.downloaded - job.delivered), requests: job.requests,
            hedges: job.hedges, hosts: [...job.hosts], durationMs: Math.round(now() - job.started),
            parallelLimit: concurrency, parallelPeak: peak });
        }
      })();
      return { response, done, abort: cancel };
    }

    return {
      start,
      cancelAll() { for (const job of jobs) job.controller.abort(abortError()); },
      stats() { return { active, queued: localQueue.length, peak, concurrency, retained }; }
    };
  }
  Object.defineProperty(window, "__BILI_SPEEDUP_RANGE_FACTORY__", {
    configurable: true, value: Object.freeze({ create, parseRange })
  });
})();
