/* Playback is never re-requested or made to wait for persistence. */
(() => {
  'use strict';
  const TARGET = /\.(ts|m3u8|m4s|mp4)(?:[?#]|$)/i;
  const CHUNK = 192 * 1024;
  const MAX_PENDING = 8 * 1024 * 1024;
  const MAX_RECORD = 32 * 1024 * 1024;
  let state = { initialized: false, enabled: false, generation: 0, sessionId: null };
  function createInitialization() {
    let resolve;
    const initial = { settled: false, attempted: false, value: null, promise: new Promise(done => { resolve = done; }) };
    const timer = setTimeout(() => initial.complete(null), 10000);
    initial.complete = value => {
      if (initial.settled) return;
      initial.settled = true; initial.value = value;
      clearTimeout(timer); resolve(value);
    };
    return initial;
  }
  let initialization = createInitialization();
  function requestStart(url, method) {
    if (state.initialized) return { ...state };
    if (method !== 'HEAD' && TARGET.test(url)) initialization.attempted = true;
    return { initialization };
  }
  async function decisionFor(start) {
    if (!start.initialization) return start;
    const value = await start.initialization.promise;
    return start.initialization === initialization ? value : null;
  }
  function mayCapture(start) {
    if (!start.initialization) return isCurrent(start);
    return start.initialization === initialization && (!initialization.settled || isCurrent(initialization.value));
  }
  let active = 0, pendingBytes = 0;
  const replies = new Map();
  function rpc(message) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { replies.delete(id); reject(new Error('保存先からの応答がありません。')); }, 10000);
      replies.set(id, { resolve, reject, timer });
      window.postMessage({ type: 'HLS_SAVER_REQUEST', id, ...message }, '*');
    });
  }
  function report(error, capturedState) {
    void decisionFor(capturedState).then(decision => {
      if (!isCurrent(decision)) return;
      state.enabled = false;
      return rpc({ action: 'captureError', sessionId: decision.sessionId, error: error.message });
    }).catch(() => {});
  }
  window.addEventListener('message', event => {
    if (event.source !== window) return;
    if (event.data?.type === 'HLS_SAVER_STATE') {
      const next = event.data.state;
      if (next && typeof next.enabled === 'boolean' && typeof next.sessionId === 'string' && next.generation >= state.generation) {
        const expired = initialization.settled && !initialization.value && initialization.attempted;
        state = { ...next, initialized: true };
        initialization.complete({ ...state });
        if (expired && state.enabled) report(new Error('収録の初期化が遅れ、開始時のデータを保持できませんでした。リロードしてください。'), { ...state });
      }
      if (event.data.requestId) window.postMessage({ type: 'HLS_SAVER_STATE_APPLIED', requestId: event.data.requestId }, '*');
    }
    if (event.data?.type === 'HLS_SAVER_REPLY') {
      const waiting = replies.get(event.data.id);
      if (!waiting) return;
      replies.delete(event.data.id); clearTimeout(waiting.timer);
      if (event.data.result?.ok) waiting.resolve(event.data.result);
      else waiting.reject(new Error(event.data.result?.error || '保存に失敗しました。'));
    }
  });
  const isCurrent = start => start?.enabled && state.enabled && start.sessionId === state.sessionId && start.generation === state.generation;
  function encode(bytes) {
    let text = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(text);
  }
  async function capture(stream, meta, start) {
    if (start.initialization) start.initialization.attempted = true;
    const reader = stream.getReader();
    if (active >= 32 || meta.length > MAX_RECORD) {
      void reader.cancel().catch(() => {});
      report(new Error('収録の同時数または断片サイズの上限を超えました。'), start);
      return;
    }
    active++;
    let recordId, captureState, chunks = 0, total = 0, failed = null, skipped = false;
    const deadline = setTimeout(() => {
      failed = new Error('断片の収録がタイムアウトしました。');
      void reader.cancel().catch(() => {});
    }, 30000);
    // Drain the clone promptly. Waiting on each DB ACK here would let the tee buffer grow.
    // Jobs are capped globally; on overload we cancel our branch instead of slowing playback.
    let writes = decisionFor(start).then(async decision => {
      if (!isCurrent(decision)) { skipped = true; void reader.cancel().catch(() => {}); return; }
      captureState = decision;
      const result = await rpc({ action: 'begin', sessionId: decision.sessionId, generation: decision.generation,
        url: meta.url, responseUrl: meta.responseUrl, range: meta.range, mime: meta.mime });
      recordId = result.recordId;
      if (result.skipped) { skipped = true; void reader.cancel().catch(() => {}); }
    }).catch(error => { failed = error; void reader.cancel().catch(() => {}); });
    try {
      while (!failed && !skipped) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RECORD) throw new Error('1断片の上限（32 MiB）を超えました。');
        for (let offset = 0; offset < value.length; offset += CHUNK) {
          const bytes = value.slice(offset, offset + CHUNK);
          if (pendingBytes + bytes.length > MAX_PENDING) throw new Error('保存が追いつきません。蓄積に欠落があります。');
          pendingBytes += bytes.length;
          const index = chunks++;
          writes = writes.then(async () => {
            if (!failed && recordId) await rpc({ action: 'chunk', sessionId: captureState.sessionId, recordId, index, data: encode(bytes) });
          }).catch(error => { failed = error; void reader.cancel().catch(() => {}); })
            .finally(() => { pendingBytes -= bytes.length; });
        }
      }
    } catch (error) {
      failed = error;
      void reader.cancel().catch(() => {});
    }
    await writes;
    clearTimeout(deadline);
    try {
      if (recordId) {
        if (failed) await rpc({ action: 'fail', sessionId: captureState.sessionId, recordId, error: failed.message });
        else await rpc({ action: 'finish', sessionId: captureState.sessionId, recordId, chunks });
      } else if (failed) report(failed, start);
    } catch (error) { report(error, start); }
    finally { active--; }
  }
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const input = args[0];
    const url = new URL(input?.url || String(input), document.baseURI).href;
    const method = String(args[1]?.method || input?.method || 'GET').toUpperCase();
    const start = requestStart(url, method);
    const response = await originalFetch.apply(this, args);
    const responseUrl = response.url || url;
    if (method !== 'HEAD' && mayCapture(start) && (TARGET.test(url) || TARGET.test(responseUrl)) && response.ok && response.body) {
      try {
        void capture(response.clone().body, { url, responseUrl, range: response.headers.get('content-range') || '',
          mime: response.headers.get('content-type') || '', length: Number(response.headers.get('content-length')) }, start);
      } catch (error) { report(error, start); }
    }
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const previous = xhrInfo.get(this);
    if (previous?.onLoad) this.removeEventListener('load', previous.onLoad);
    const result = originalOpen.apply(this, [method, url, ...rest]);
    xhrInfo.set(this, { url: new URL(String(url), document.baseURI).href, method: String(method).toUpperCase() });
    return result;
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const info = xhrInfo.get(this);
    const start = info && requestStart(info.url, info.method);
    if (info && info.method !== 'HEAD' && mayCapture(start)) {
      info.onLoad = () => {
        const url = info.url;
        const responseUrl = this.responseURL || url;
        if (!mayCapture(start) || !(TARGET.test(url) || TARGET.test(responseUrl)) || this.status < 200 || this.status >= 300) return;
        try {
          let blob;
          if (this.response instanceof ArrayBuffer || this.response instanceof Blob) blob = new Blob([this.response]);
          else if (!this.responseType || this.responseType === 'text') {
            if (!/\.m3u8(?:[?#]|$)/i.test(url) && !/\.m3u8(?:[?#]|$)/i.test(responseUrl)) throw new Error('テキスト形式の動画断片は保存できません。');
            blob = new Blob([this.responseText]);
          } else throw new Error('未対応のXHRレスポンス形式です。');
          void capture(blob.stream(), { url, responseUrl, range: this.getResponseHeader('content-range') || '',
            mime: this.getResponseHeader('content-type') || '', length: blob.size }, start);
        } catch (error) { report(error, start); }
      };
      this.addEventListener('load', info.onLoad, { once: true });
    }
    return originalSend.apply(this, args);
  };
  // A BFCache restore is a new capture session: old stored data has already been released.
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      state = { initialized: false, enabled: false, generation: 0, sessionId: null };
      initialization = createInitialization();
      window.postMessage({ type: 'HLS_SAVER_READY' }, '*');
    }
  });
  window.addEventListener('pagehide', () => { state.enabled = false; initialization.attempted = false; initialization.complete(null); });
  window.postMessage({ type: 'HLS_SAVER_READY' }, '*');
})();
