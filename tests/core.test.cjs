const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
function load(context, name) { vm.runInContext(fs.readFileSync(`${__dirname}/../${name}`, 'utf8'), context, { filename: name }); }
function context() {
  const c = vm.createContext({ indexedDB: new IDBFactory(), IDBKeyRange, console, crypto: webcrypto, Uint8Array, URL, atob, btoa, setTimeout, clearTimeout });
  load(c, 'storage.js'); load(c, 'playlist.js'); return c;
}
const list = (segments, extras = '') => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n${extras}${segments.map(s => `#EXTINF:1,\n${s}\n`).join('')}#EXT-X-ENDLIST`;
const rec = (url, sequence = 1, extra = {}) => ({ id: String(sequence), url: `https://video.test/${url}`, sequence, state: 'complete', size: 188, ...extra });
test('playlist orders by sequence, not arrival or filename; same filename in another directory is distinct', () => {
  const { HLSPlaylist: h } = context();
  const plan = h.plan([{ url: 'https://video.test/index.m3u8', text: list(['b.ts', 'a.ts']) }], [rec('a.ts', 1), rec('b.ts', 2), rec('other/b.ts', 3)]);
  assert.deepEqual(Array.from(plan.parts, r => r.url), ['https://video.test/b.ts', 'https://video.test/a.ts']);
});
test('missing middle is rejected; missing prefix or suffix is an explicit partial export', () => {
  const h = context().HLSPlaylist;
  const versions = [{ url: 'https://video.test/index.m3u8', text: list(['a.ts', 'b.ts', 'c.ts']) }];
  assert.throws(() => h.plan(versions, [rec('a.ts'), rec('c.ts', 3)]), /途中/);
  assert.equal(h.plan(versions, [rec('b.ts')]).partial, true);
});
test('rolling playlist updates accumulate; conflicting sequence mappings are rejected', () => {
  const h = context().HLSPlaylist;
  const a = { url: 'https://video.test/index.m3u8', text: list(['a.ts', 'b.ts']) };
  const b = { url: a.url, text: list(['b.ts', 'c.ts']).replace('SEQUENCE:10', 'SEQUENCE:11') };
  assert.equal(h.plan([a, b], [rec('a.ts'), rec('b.ts', 2), rec('c.ts', 3)]).count, 3);
  assert.throws(() => h.plan([a, { ...a, text: list(['c.ts']) }], [rec('a.ts')]), /構成が変わ/);
});
test('range identity is preserved and an ignored Range response is rejected', () => {
  const h = context().HLSPlaylist;
  const text = '#EXTM3U\n#EXT-X-BYTERANGE:188@0\na.ts\n#EXT-X-BYTERANGE:188\na.ts\n';
  const versions = [{ url: 'https://video.test/i.m3u8', text }];
  const p = h.plan(versions, [rec('a.ts', 1, { range: 'bytes 0-187/376' }), rec('a.ts', 2, { range: 'bytes 188-375/376' })]);
  assert.equal(p.count, 2);
  assert.throws(() => h.plan(versions, [rec('a.ts')]), /まだありません/);
  assert.throws(() => h.parse('#EXTM3U\n#EXT-X-BYTERANGE:188\na.ts', 'https://video.test/i.m3u8'), /位置/);
});
test('fMP4 requires captured init; encryption, gaps, discontinuities and map changes are rejected', () => {
  const h = context().HLSPlaylist;
  const base = { url: 'https://video.test/i.m3u8', text: list(['a.m4s'], '#EXT-X-MAP:URI="init.mp4"\n') };
  assert.throws(() => h.plan([base], [rec('a.m4s')]), /初期化断片/);
  const p = h.plan([base], [rec('a.m4s'), rec('init.mp4', 2)]);
  assert.equal(p.container, 'fmp4'); assert.equal(p.parts[0].url, 'https://video.test/init.mp4');
  assert.throws(() => h.plan([{ ...base, text: list(['a.ts'], '#EXT-X-KEY:METHOD=AES-128,URI="key"\n') }], [rec('a.ts')]), /暗号化/);
  assert.throws(() => h.plan([{ ...base, text: '#EXTM3U\na.ts\n#EXT-X-DISCONTINUITY\nb.ts' }], [rec('a.ts'), rec('b.ts', 2)]), /不連続/);
  assert.throws(() => h.plan([{ ...base, text: '#EXTM3U\n#EXT-X-MAP:URI="i.mp4"\na.m4s\n#EXT-X-MAP:URI="j.mp4"\nb.m4s' }], [rec('a.m4s'), rec('b.m4s', 2), rec('i.mp4', 3)]), /初期化情報/);
});
test('real IDB transactions store chunks, and session deletion removes records/chunks/exports atomically', async () => {
  const db = context().CaptureDB;
  await db.put('sessions', { id: 's' }); await db.put('sessions', { id: 'other' });
  let record = { id: 'r', sessionId: 's', chunks: 0, size: 0 };
  await db.put('records', record);
  record = await db.append(record, new Uint8Array([1, 2, 3]));
  await db.put('exports', { id: 'export', sessionId: 's', recordIds: ['r'] });
  assert.equal((await db.get('chunks', ['r', 0])).data[2], 3);
  assert.equal(record.size, 3);
  await db.removeSession('s');
  assert.equal(await db.get('sessions', 's'), undefined);
  assert.equal((await db.all('records')).length, 0);
  assert.equal((await db.all('chunks')).length, 0);
  assert.equal((await db.all('exports')).length, 0);
  assert.ok(await db.get('sessions', 'other'));
});
function background(c = context(), sessionStorage = {}, frames = new Map([[1, 'doc1'], [2, 'doc2']])) {
  const events = {};
  const event = key => ({ addListener: listener => { events[key] = listener; } });
  c.chrome = {
    storage: { session: { get: async () => sessionStorage, set: async v => Object.assign(sessionStorage, v) }, local: { get: async () => ({}), set: async () => {} } },
    runtime: { getURL: path => `chrome-extension://test/${path}`, onMessage: event('message'), onStartup: event('startup') },
    webNavigation: { getFrame: async ({ tabId }) => ({ documentId: frames.get(tabId) }), onCommitted: event('navigate'), onHistoryStateUpdated: event('history') },
    tabs: { sendMessage: async () => {}, create: async () => {}, onRemoved: event('removed') },
    alarms: { create: async () => {}, onAlarm: event('alarm') }
  };
  c.importScripts = () => {};
  // Separate worker globals share the same persistent DB and storage.session.
  load(c, 'background.js');
  const send = (message, sender) => new Promise(resolve => events.message(message, sender, resolve));
  const page = (tab = 1, doc = `doc${tab}`) => ({ tab: { id: tab }, frameId: 0, documentId: doc, url: 'https://video.test/' });
  const control = { url: 'chrome-extension://test/popup.html' };
  return { c, send, page, control, events, frames, sessionStorage };
}
test('OFF drains accepted record; stale generation and deleted session cannot accept new data', async () => {
  const b = background();
  const session = await b.send({ action: 'register' }, b.page());
  const begin = await b.send({ action: 'begin', sessionId: session.id, generation: 1, url: 'https://video.test/a.ts' }, b.page());
  await b.send({ action: 'setEnabled', sessionId: session.id, enabled: false }, b.control);
  const skipped = await b.send({ action: 'begin', sessionId: session.id, generation: 1, url: 'https://video.test/b.ts' }, b.page());
  assert.equal(skipped.skipped, true);
  assert.equal((await b.send({ action: 'chunk', sessionId: session.id, recordId: begin.recordId, index: 0, data: 'Rw==' }, b.page())).ok, true);
  assert.equal((await b.send({ action: 'finish', sessionId: session.id, recordId: begin.recordId, chunks: 1 }, b.page())).ok, true);
  await b.send({ action: 'clear', sessionId: session.id }, b.control);
  assert.equal((await b.send({ action: 'chunk', sessionId: session.id, recordId: begin.recordId, index: 1, data: 'Rw==' }, b.page())).ok, false);
});
test('snapshot is immutable; tab cleanup and document verification isolate sessions', async () => {
  const b = background();
  const s = await b.send({ action: 'register' }, b.page());
  const s2 = await b.send({ action: 'register' }, b.page(2));
  const first = await b.send({ action: 'begin', sessionId: s.id, generation: 1, url: 'https://video.test/a.ts' }, b.page());
  await b.send({ action: 'snapshot', sessionId: s.id }, b.control);
  await b.send({ action: 'begin', sessionId: s.id, generation: 1, url: 'https://video.test/b.ts' }, b.page());
  const jobs = await b.c.CaptureDB.all('exports');
  assert.deepEqual(Array.from(jobs[0].recordIds), [first.recordId]);
  b.frames.set(1, 'new-doc'); b.events.navigate({ frameId: 0, tabId: 1, documentId: 'new-doc' });
  await b.send({ action: 'getStats', tabId: 1 }, b.control);
  assert.equal(await b.c.CaptureDB.get('sessions', s.id), undefined);
  assert.ok(await b.c.CaptureDB.get('sessions', s2.id));
  assert.equal((await b.send({ action: 'register' }, b.page())).ok, false);
});
test('new browser epoch releases data; same epoch on worker restart preserves completed captures', async () => {
  const b = background();
  const s = await b.send({ action: 'register' }, b.page());
  const restart = () => { const c = context(); c.CaptureDB = b.c.CaptureDB; return background(c, b.sessionStorage, b.frames); };
  const same = restart(); await same.send({ action: 'getStats', tabId: 1 }, same.control);
  assert.ok(await b.c.CaptureDB.get('sessions', s.id));
  delete b.sessionStorage.captureEpoch;
  const fresh = restart(); await fresh.send({ action: 'getStats', tabId: 1 }, fresh.control);
  assert.equal(await b.c.CaptureDB.get('sessions', s.id), undefined);
});
test('out-of-order chunk fails visibly, disables capture and prohibits export', async () => {
  const b = background();
  const s = await b.send({ action: 'register' }, b.page());
  const r = await b.send({ action: 'begin', sessionId: s.id, generation: 1, url: 'https://video.test/a.ts' }, b.page());
  assert.equal((await b.send({ action: 'chunk', sessionId: s.id, recordId: r.recordId, index: 4, data: 'Rw==' }, b.page())).ok, false);
  const stats = await b.send({ action: 'getStats', tabId: 1 }, b.control);
  assert.equal(stats.session.enabled, false); assert.ok(stats.session.error);
  assert.equal((await b.send({ action: 'snapshot', sessionId: s.id }, b.control)).ok, false);
});
test('SPA page changes invalidate the old recording and preserve the chosen capture state', async () => {
  const b = background(); const s = await b.send({ action: 'register' }, b.page());
  b.events.history({ frameId: 0, tabId: 1, documentId: 'doc1', url: 'https://video.test/next' });
  const stats = await b.send({ action: 'getStats', tabId: 1 }, b.control);
  assert.notEqual(stats.session.id, s.id); assert.equal(stats.session.enabled, true);
  assert.equal(await b.c.CaptureDB.get('sessions', s.id), undefined);
  assert.equal((await b.send({ action: 'begin', sessionId: s.id, generation: 1, url: 'https://video.test/a.ts' }, b.page())).ok, false);
});
test('ambiguous repeated URLs are rejected rather than mapped to the newest body twice', () => {
  const h = context().HLSPlaylist;
  assert.throws(() => h.plan([{ url: 'https://video.test/i.m3u8', text: list(['a.ts', 'a.ts']) }], [rec('a.ts')]), /複数の再生位置/);
});
