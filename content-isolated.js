(() => {
  'use strict';
  let state;
  let registration;
  const stateReplies = new Map();
  const publish = () => { if (state) window.postMessage({ type: 'HLS_SAVER_STATE', state }, '*'); };
  async function register() {
    if (!registration) registration = chrome.runtime.sendMessage({ action: 'register' }).then(result => {
      if (!result?.ok) throw new Error(result?.error || '収録の初期化に失敗しました。');
      state = { sessionId: result.id, generation: result.generation, enabled: result.enabled };
      publish();
    }).catch(error => console.warn('[HLS Saver]', error.message)).finally(() => { registration = null; });
    return registration;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'captureState') {
      state = { sessionId: message.sessionId, generation: message.generation, enabled: message.enabled };
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { stateReplies.delete(requestId); respond({ ok: false }); }, 2000);
      stateReplies.set(requestId, () => { clearTimeout(timer); respond({ ok: true }); });
      window.postMessage({ type: 'HLS_SAVER_STATE', state, requestId }, '*');
      return true;
    }
  });
  const allowed = new Set(['begin', 'chunk', 'finish', 'fail', 'captureError']);
  window.addEventListener('message', async event => {
    if (event.source !== window) return;
    const message = event.data;
    if (message?.type === 'HLS_SAVER_STATE_APPLIED') {
      stateReplies.get(message.requestId)?.(); stateReplies.delete(message.requestId); return;
    }
    if (message?.type === 'HLS_SAVER_READY') { await register(); publish(); return; }
    if (message?.type !== 'HLS_SAVER_REQUEST' || !allowed.has(message.action) || typeof message.id !== 'string') return;
    let result;
    try {
      if (message.sessionId !== state?.sessionId) throw new Error('収録ページが更新されました。');
      result = await chrome.runtime.sendMessage(message);
    } catch (error) { result = { ok: false, error: error.message }; }
    window.postMessage({ type: 'HLS_SAVER_REPLY', id: message.id, result }, '*');
  });
  void register();
})();
