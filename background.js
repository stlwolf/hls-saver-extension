/* All lifecycle mutations use one lane: late chunks cannot resurrect deleted sessions. */
importScripts('storage.js');
const MAX_RECORD = 32 * 1024 * 1024;
const MAX_CHUNK = 192 * 1024;
let lane = Promise.resolve();
const serialize = work => {
  const result = lane.then(work);
  lane = result.catch(error => console.warn('[HLS Saver]', error.message));
  return result;
};
let epoch;
const ready = (async () => {
  const state = await chrome.storage.session.get('captureEpoch');
  epoch = state.captureEpoch || crypto.randomUUID();
  if (!state.captureEpoch) await chrome.storage.session.set({ captureEpoch: epoch });
  for (const session of await CaptureDB.all('sessions')) {
    const frame = await chrome.webNavigation.getFrame({ tabId: session.tabId, frameId: 0 }).catch(() => null);
    if (session.epoch !== epoch || frame?.documentId !== session.documentId) await CaptureDB.removeSession(session.id);
  }
  await chrome.alarms.create('capture-maintenance', { periodInMinutes: 1 });
})();
async function sendState(session) {
  const result = await chrome.tabs.sendMessage(session.tabId, {
    type: 'captureState', sessionId: session.id, generation: session.generation, enabled: session.enabled
  }, { documentId: session.documentId });
  if (result?.ok === false) throw new Error('ページ側で収録状態を更新できませんでした。リロードしてください。');
}
async function requireSession(id) {
  const session = await CaptureDB.get('sessions', id);
  if (!session || session.epoch !== epoch) throw new Error('ページが閉じられたか、収録データが削除されました。');
  return session;
}
async function failSession(session, error) {
  session.enabled = false;
  session.generation++;
  session.error = String(error).slice(0, 400);
  await CaptureDB.put('sessions', session);
  await sendState(session);
}
async function maintain() {
  for (const session of await CaptureDB.all('sessions')) {
    for (const record of await CaptureDB.all('records', session.id)) {
      if (record.state === 'pending' && Date.now() - record.touched > 30000) {
        await CaptureDB.put('records', { ...record, state: 'failed', error: '保存処理がタイムアウトしました。' });
        await failSession(session, '保存処理が中断しました。蓄積に欠落があります。');
      }
    }
  }
}
async function handle(message, sender) {
  await ready;
  if (message.action === 'register') {
    if (!sender.tab || sender.frameId !== 0 || !sender.documentId) throw new Error('トップページでのみ収録できます。');
    const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
    if (frame?.documentId !== sender.documentId || frame.documentLifecycle === 'cached') throw new Error('古いページからの登録を拒否しました。');
    let session;
    for (const old of await CaptureDB.all('sessions')) {
      if (old.tabId !== sender.tab.id) continue;
      if (old.documentId === sender.documentId) session = old;
      else await CaptureDB.removeSession(old.id);
    }
    if (!session) {
      const pref = await chrome.storage.local.get('isEnabled');
      session = { id: crypto.randomUUID(), tabId: sender.tab.id, documentId: sender.documentId,
        epoch, generation: 1, enabled: pref.isEnabled !== false, sequence: 0, error: '', pageUrl: sender.url };
      await CaptureDB.put('sessions', session);
    }
    return session;
  }
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    const session = await requireSession(message.sessionId);
    if (session.tabId !== sender.tab.id || session.documentId !== sender.documentId) throw new Error('収録ページが一致しません。');
    if (message.action === 'begin') {
      if (!session.enabled || message.generation !== session.generation) return { skipped: true };
      const responseUrl = message.responseUrl || message.url;
      const target = /\.(m3u8|ts|m4s|mp4)(?:[?#]|$)/i;
      if (!/^https?:\/\//.test(message.url) || !/^https?:\/\//.test(responseUrl) || !(target.test(message.url) || target.test(responseUrl))) throw new Error('対象外のURLです。');
      if ((await CaptureDB.all('records', session.id)).filter(r => r.state === 'pending').length >= 32) throw new Error('同時保存数の上限を超えました。');
      session.sequence++;
      const record = { id: crypto.randomUUID(), sessionId: session.id, sequence: session.sequence,
        url: message.url, responseUrl, range: message.range || '', mime: message.mime || '', state: 'pending',
        chunks: 0, size: 0, touched: Date.now() };
      await CaptureDB.put('sessions', session);
      await CaptureDB.put('records', record);
      return { recordId: record.id };
    }
    if (message.action === 'captureError') {
      await failSession(session, message.error || 'キャプチャに失敗しました。');
      return {};
    }
    const record = await CaptureDB.get('records', message.recordId);
    if (!record || record.sessionId !== session.id || record.state !== 'pending') throw new Error('保存対象が無効です。');
    try {
      if (message.action === 'chunk') {
        if (typeof message.data !== 'string' || message.data.length > MAX_CHUNK * 4 / 3 + 4) throw new Error('転送チャンクが大きすぎます。');
        const bytes = Uint8Array.from(atob(message.data), c => c.charCodeAt(0));
        if (message.index !== record.chunks || !bytes.length || record.size + bytes.length > MAX_RECORD) throw new Error('断片のサイズまたは順序が不正です。');
        await CaptureDB.append(record, bytes);
      } else if (message.action === 'finish') {
        if (record.chunks !== message.chunks || !record.size) throw new Error('保存が不完全です。');
        record.state = 'complete';
        await CaptureDB.put('records', record);
        if (!/\.m3u8(?:[?#]|$)/i.test(record.url) && !/\.m3u8(?:[?#]|$)/i.test(record.responseUrl)) {
          const pinned = new Set((await CaptureDB.all('exports', session.id)).flatMap(job => job.recordIds));
          for (const old of await CaptureDB.all('records', session.id)) {
            if (old.id !== record.id && old.state === 'complete' && old.url === record.url && old.range === record.range && !pinned.has(old.id)) await CaptureDB.removeRecord(old.id);
          }
        }
      } else if (message.action === 'fail') {
        record.state = 'failed'; record.error = String(message.error || '保存が中断しました。').slice(0, 400);
        await CaptureDB.put('records', record);
        await failSession(session, record.error);
      } else throw new Error('不明な収録操作です。');
    } catch (error) {
      await CaptureDB.put('records', { ...record, state: 'failed', error: error.message }).catch(() => {});
      await failSession(session, error.message).catch(() => {});
      throw error;
    }
    return {};
  }
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('拡張画面から操作してください。');
  if (message.action === 'getStats') {
    await maintain();
    const session = (await CaptureDB.all('sessions')).find(s => s.tabId === message.tabId);
    if (!session) return { session: null };
    const records = await CaptureDB.all('records', session.id);
    return { session, captured: records.filter(r => r.state === 'complete').length,
      totalSize: records.reduce((sum, r) => sum + r.size, 0), pending: records.filter(r => r.state === 'pending').length,
      failed: records.filter(r => r.state === 'failed').length };
  }
  if (message.action === 'setEnabled') {
    const session = await requireSession(message.sessionId);
    session.enabled = !!message.enabled; session.generation++;
    await CaptureDB.put('sessions', session);
    await chrome.storage.local.set({ isEnabled: session.enabled });
    await sendState(session);
    return {};
  }
  if (message.action === 'clear') {
    const old = await requireSession(message.sessionId);
    await CaptureDB.removeSession(old.id);
    const next = { ...old, id: crypto.randomUUID(), sequence: 0, generation: old.generation + 1, error: '' };
    await CaptureDB.put('sessions', next);
    await sendState(next);
    return {};
  }
  if (message.action === 'snapshot') {
    const session = await requireSession(message.sessionId);
    if (session.error) throw new Error('収録に欠落があります。クリアして収録し直してください。');
    const recordIds = (await CaptureDB.all('records', session.id)).map(r => r.id);
    if (!recordIds.length) throw new Error('蓄積データがありません。');
    const job = { id: crypto.randomUUID(), sessionId: session.id, recordIds, created: Date.now() };
    await CaptureDB.put('exports', job);
    await chrome.tabs.create({ url: chrome.runtime.getURL(`export.html?id=${job.id}`) });
    return {};
  }
  throw new Error('不明な操作です。');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serialize(() => handle(message, sender)).then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => serialize(async () => {
  await ready;
  for (const s of await CaptureDB.all('sessions')) if (s.tabId === tabId) await CaptureDB.removeSession(s.id);
}));
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  serialize(async () => {
    await ready;
    for (const s of await CaptureDB.all('sessions')) if (s.tabId === details.tabId && s.documentId !== details.documentId) await CaptureDB.removeSession(s.id);
  });
});
function rotatePageSession(details) {
  if (details.frameId !== 0) return;
  serialize(async () => {
    await ready;
    for (const old of await CaptureDB.all('sessions')) {
      if (old.tabId !== details.tabId || old.documentId !== details.documentId || old.pageUrl === details.url) continue;
      await CaptureDB.removeSession(old.id);
      const next = { ...old, id: crypto.randomUUID(), generation: old.generation + 1,
        pageUrl: details.url, sequence: 0, error: '' };
      await CaptureDB.put('sessions', next);
      await sendState(next);
    }
  });
}
chrome.webNavigation.onHistoryStateUpdated.addListener(rotatePageSession);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(rotatePageSession);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'capture-maintenance') serialize(async () => { await ready; await maintain(); });
});
chrome.runtime.onStartup.addListener(() => serialize(async () => { await ready; }));
