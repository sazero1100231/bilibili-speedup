// Independent of extension diagnostics: observe what the native player renders.
export const playbackObserverSource = `(${function () {
  const states = new WeakMap();
  const attach = video => {
    if (states.has(video)) return;
    const state = { firstFrameMs: null, frames: 0, lastMediaTime: 0, waits: [],
      started: false, reason: "startup", waitingAt: null, audioBytes: 0 };
    states.set(video, state);
    const close = () => {
      if (state.waitingAt !== null) state.waits.push({ reason: state.reason,
        ms: Math.round(performance.now() - state.waitingAt), mediaTime: video.currentTime });
      state.waits = state.waits.slice(-100);
      state.waitingAt = null;
    };
    video.addEventListener("seeking", () => { close(); state.reason = "seek"; });
    video.addEventListener("waiting", () => {
      if (!video.paused && state.waitingAt === null) state.waitingAt = performance.now();
    });
    video.addEventListener("playing", () => { close(); state.started = true; state.reason = "playback"; });
    video.addEventListener("pause", close);
    const frame = (_, metadata) => {
      state.firstFrameMs ??= Math.round(performance.now());
      state.frames += 1; state.lastMediaTime = metadata.mediaTime;
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback?.(frame);
  };
  new MutationObserver(() => document.querySelectorAll("video").forEach(attach))
    .observe(document, { childList: true, subtree: true });
  globalThis.__biliAcceptanceSnapshot = video => {
    if (!video) return null;
    attach(video);
    const state = states.get(video);
    return { ...state, audioBytes: Number(video.webkitAudioDecodedByteCount) || 0,
      decoded: video.getVideoPlaybackQuality?.() || null,
      openWaitMs: state.waitingAt === null ? 0 : Math.round(performance.now() - state.waitingAt),
      width: video.videoWidth, height: video.videoHeight };
  };
}.toString()})();`;
