(() => {
  "use strict";
  function install({ plan, start }) {
    const prototype = window.XMLHttpRequest?.prototype;
    if (!prototype) return () => {};
    const requests = new WeakMap();
    const originals = {};
    const installed = {};
    for (const name of ["open", "send", "abort", "setRequestHeader", "getResponseHeader", "getAllResponseHeaders"]) originals[name] = prototype[name];
    for (const name of ["readyState", "status", "statusText", "responseURL", "response", "responseText"]) originals[name] = Object.getOwnPropertyDescriptor(prototype, name);
    const fire = (xhr, type, loaded = 0, total = 0) => xhr.dispatchEvent(
      ["progress", "load", "loadend", "loadstart", "abort", "error", "timeout"].includes(type)
        ? new ProgressEvent(type, { loaded, total, lengthComputable: total > 0 }) : new Event(type));
    const current = (xhr, request) => requests.get(xhr) === request && request.managed && !request.ended;
    function finish(xhr, request, type) {
      if (!current(xhr, request)) return;
      request.ended = true;
      clearTimeout(request.timer);
      if (type !== "load") {
        request.job.abort();
        request.status = 0;
        request.response = null;
        request.responseURL = "";
        request.headers = new Headers();
      }
      request.readyState = 4;
      fire(xhr, "readystatechange");
      // A player's event handler may open a new request on the same object.
      if (requests.get(xhr) !== request) return;
      fire(xhr, type, request.loaded, request.total);
      if (requests.get(xhr) !== request) return;
      fire(xhr, "loadend", request.loaded, request.total);
      if (type === "abort" && requests.get(xhr) === request) request.readyState = 0;
    }
    installed.open = function(method, url, async = true) {
      const previous = requests.get(this);
      if (previous?.managed && !previous.ended) {
        previous.ended = true;
        clearTimeout(previous.timer);
        previous.job.abort();
      }
      requests.delete(this);
      const result = originals.open.apply(this, arguments);
      requests.set(this, { method: String(method).toUpperCase(), url: String(url), async,
        requestHeaders: new Headers(), managed: false, ended: false, sent: false });
      return result;
    };
    installed.setRequestHeader = function(name, value) {
      const request = requests.get(this);
      if (request?.managed && request.sent) throw new DOMException("Request already sent", "InvalidStateError");
      const result = originals.setRequestHeader.apply(this, arguments);
      request?.requestHeaders.append(name, value);
      return result;
    };
    installed.send = function(body) {
      const request = requests.get(this);
      if (request?.managed && request.sent) throw new DOMException("Request already sent", "InvalidStateError");
      const routing = request && request.async !== false && request.method === "GET" && body == null
        && this.responseType === "arraybuffer" && !this.withCredentials ? plan(request) : null;
      const job = routing ? start({ ...routing, headers: request.requestHeaders }) : null;
      if (!job) return originals.send.apply(this, arguments);
      Object.assign(request, { managed: true, sent: true, job, readyState: 1, status: 0,
        response: null, responseURL: "", headers: new Headers(), loaded: 0, total: 0 });
      if (this.timeout > 0) request.timer = setTimeout(() => finish(this, request, "timeout"), this.timeout);
      fire(this, "loadstart");
      void (async () => {
        try {
          const response = await job.response;
          if (!current(this, request)) return;
          request.status = response.status;
          request.statusText = "Partial Content";
          request.responseURL = response.url;
          request.headers = response.headers;
          request.total = Number(response.headers.get("content-length")) || 0;
          request.readyState = 2;
          fire(this, "readystatechange");
          const reader = response.body.getReader();
          const chunks = [];
          while (current(this, request)) {
            const { value, done } = await reader.read();
            if (!current(this, request)) { await reader.cancel(); return; }
            if (done) break;
            chunks.push(value); request.loaded += value.length;
            request.readyState = 3;
            fire(this, "readystatechange");
            if (!current(this, request)) { await reader.cancel(); return; }
            fire(this, "progress", request.loaded, request.total);
          }
          if (!current(this, request)) return;
          const bytes = new Uint8Array(request.loaded);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          request.response = bytes.buffer;
          finish(this, request, "load");
        } catch (error) {
          finish(this, request, error?.name === "AbortError" ? "abort" : error?.name === "TimeoutError" ? "timeout" : "error");
        }
      })();
    };
    installed.abort = function() {
      const request = requests.get(this);
      if (!request?.managed) return originals.abort.apply(this, arguments);
      if (!request.ended) finish(this, request, "abort");
      else { request.readyState = 0; request.response = null; request.status = 0; }
    };
    installed.getResponseHeader = function(name) {
      const request = requests.get(this);
      return request?.managed ? request.readyState >= 2 ? request.headers.get(name) : null
        : originals.getResponseHeader.apply(this, arguments);
    };
    installed.getAllResponseHeaders = function() {
      const request = requests.get(this);
      return request?.managed ? request.readyState >= 2
        ? [...request.headers].map(([name, value]) => `${name}: ${value}\r\n`).join("") : ""
        : originals.getAllResponseHeaders.apply(this, arguments);
    };
    for (const name of ["open", "send", "abort", "setRequestHeader", "getResponseHeader", "getAllResponseHeaders"]) prototype[name] = installed[name];
    for (const name of ["readyState", "status", "statusText", "responseURL", "response", "responseText"]) {
      const descriptor = originals[name];
      if (!descriptor?.get || !descriptor.configurable) continue;
      const get = function() {
        const request = requests.get(this);
        if (!request?.managed) return descriptor.get.call(this);
        if (name === "responseText") throw new DOMException("Binary response has no responseText", "InvalidStateError");
        return request[name] ?? (name === "response" ? null : name === "status" || name === "readyState" ? 0 : "");
      };
      installed[name] = get;
      Object.defineProperty(prototype, name, { ...descriptor, get });
    }
    return () => {
      for (const [name, value] of Object.entries(originals)) {
        if (typeof value === "function") {
          if (prototype[name] === installed[name]) prototype[name] = value;
        } else if (value && Object.getOwnPropertyDescriptor(prototype, name)?.get === installed[name]) {
          Object.defineProperty(prototype, name, value);
        }
      }
    };
  }
  Object.defineProperty(window, "__BILI_SPEEDUP_XHR_FACTORY__", { configurable: true, value: Object.freeze({ install }) });
})();
