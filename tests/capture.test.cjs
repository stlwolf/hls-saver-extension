const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
function setup({ response = () => new Response(new Uint8Array([71, 1, 2])), pauseBegin = false, baseURI = 'https://video.test/', BlobClass = Blob, ackDelay = 0, stallChunk = false, timerScale = 1 } = {}) {
  const listeners = new Map();
  const messages = [];
  let release;
  let recordSequence = 0;
  const metrics = { inFlight: 0, peak: 0, maxChunk: 0, byRecord: new Map(), maxPerRecord: 0 };
  class XHR extends EventTarget {
    open() {} send() {}
    getResponseHeader() { return null; }
  }
  const w = { addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); } };
  function emit(data) { for (const listener of listeners.get('message') || []) listener({ source: w, data }); }
  w.postMessage = data => {
    messages.push(data);
    if (data.type !== 'HLS_SAVER_REQUEST') return;
    const bytes = data.action === 'chunk' ? Buffer.from(data.data, 'base64').length : 0;
    if (bytes) {
      metrics.inFlight += bytes; metrics.peak = Math.max(metrics.peak, metrics.inFlight); metrics.maxChunk = Math.max(metrics.maxChunk, bytes);
      const count = (metrics.byRecord.get(data.recordId) || 0) + 1; metrics.byRecord.set(data.recordId, count); metrics.maxPerRecord = Math.max(metrics.maxPerRecord, count);
    }
    const reply = () => {
      if (bytes) { metrics.inFlight -= bytes; metrics.byRecord.set(data.recordId, metrics.byRecord.get(data.recordId) - 1); }
      emit({ type: 'HLS_SAVER_REPLY', id: data.id, result: { ok: true, ...(data.action === 'begin' ? { recordId: `record-${++recordSequence}` } : {}) } });
    };
    if (data.action === 'chunk' && stallChunk) return;
    if (pauseBegin && data.action === 'begin') release = reply;
    else if (data.action === 'chunk' && ackDelay) setTimeout(reply, ackDelay);
    else queueMicrotask(reply);
  };
  w.fetch = async () => response();
  const document = { baseURI };
  const c = vm.createContext({ window: w, document, XMLHttpRequest: XHR, crypto: webcrypto, URL, location: { href: 'https://video.test/' },
    ArrayBuffer, Uint8Array, Blob: BlobClass, btoa, setTimeout: (fn, ms) => setTimeout(fn, ms >= 10000 ? ms * timerScale : ms), clearTimeout, console });
  vm.runInContext(fs.readFileSync(`${__dirname}/../content-main.js`, 'utf8'), c);
  const set = (enabled, generation) => emit({ type: 'HLS_SAVER_STATE', state: { sessionId: 'session', enabled, generation } });
  const waitFor = async action => {
    const end = Date.now() + 2000;
    while (Date.now() < end) { if (messages.some(m => m.action === action)) return; await new Promise(r => setTimeout(r, 5)); }
    throw new Error(`Missing action ${action}: ${JSON.stringify(messages.map(m => m.action))}`);
  };
  return { w, document, XHR, set, messages, metrics, waitFor, release: () => release?.() };
}
test('fetch response is returned and readable before storage begin ACK; capture uses small encoded chunks', async () => {
  const s = setup({ pauseBegin: true }); s.set(true, 1);
  const response = await s.w.fetch('https://video.test/a.ts');
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [71, 1, 2]);
  assert.ok(s.messages.some(m => m.action === 'begin'));
  assert.ok(!s.messages.some(m => m.action === 'finish'));
  s.release(); await s.waitFor('finish');
  const chunk = s.messages.find(m => m.action === 'chunk');
  assert.equal(chunk.data, 'RwEC'); assert.equal(chunk.index, 0);
});
test('OFF bypasses copying; an old fetch resolving after OFF/ON does not enter the new generation', async () => {
  let resolve;
  const s = setup({ response: () => new Promise(r => { resolve = r; }) });
  s.set(true, 1);
  const pending = s.w.fetch('https://video.test/a.ts');
  s.set(false, 2); s.set(true, 3);
  resolve(new Response(new Uint8Array([71]))); await pending;
  await new Promise(r => setTimeout(r, 10));
  assert.equal(s.messages.filter(m => m.action === 'begin').length, 0);
  s.set(false, 4);
  const off = s.w.fetch('https://video.test/b.ts'); resolve(new Response('x')); await off;
  assert.equal(s.messages.filter(m => m.action === 'begin').length, 0);
});
test('XHR text playlist and binary Blob are both captured without modifying playback response', async () => {
  const s = setup(); s.set(true, 1);
  const xhr = new s.XHR(); xhr.open('GET', '/index.m3u8'); xhr.responseType = ''; xhr.responseText = '#EXTM3U\na.ts'; xhr.status = 200;
  xhr.send(); xhr.dispatchEvent(new Event('load')); await s.waitFor('finish');
  assert.equal(xhr.responseText, '#EXTM3U\na.ts');
  assert.equal(s.messages.find(m => m.action === 'begin').url, 'https://video.test/index.m3u8');
});
test('a 9 MiB burst waits for storage and persists every byte without delaying playback', async () => {
  const bytes = new Uint8Array(9 * 1024 * 1024); bytes[0] = 71;
  const s = setup({ response: () => new Response(bytes), pauseBegin: true }); s.set(true, 1);
  const response = await s.w.fetch('https://video.test/a.ts');
  assert.equal((await response.arrayBuffer()).byteLength, bytes.length);
  assert.equal(s.messages.filter(m => m.action === 'chunk').length, 0);
  s.release(); await s.waitFor('finish');
  assert.equal(s.messages.filter(m => m.action === 'fail').length, 0);
  assert.equal(s.messages.filter(m => m.action === 'chunk').reduce((sum, m) => sum + Buffer.from(m.data, 'base64').length, 0), bytes.length);
  assert.equal(s.metrics.maxPerRecord, 1);
});
test('reusing an aborted XHR does not leave an old capture listener; Blob response is preserved', async () => {
  const s = setup(); s.set(true, 1);
  const xhr = new s.XHR(); xhr.open('GET', '/aborted.ts'); xhr.send();
  xhr.open('GET', '/actual.ts'); xhr.responseType = 'blob'; xhr.response = new Blob([new Uint8Array([71, 4, 5])]); xhr.status = 200;
  const original = xhr.response;
  xhr.send(); xhr.dispatchEvent(new Event('load')); await s.waitFor('finish');
  assert.equal(xhr.response, original);
  assert.equal(s.messages.filter(m => m.action === 'begin').length, 1);
  assert.equal(s.messages.find(m => m.action === 'begin').url, 'https://video.test/actual.ts');
});
test('redirected fetch retains requested URL and final response URL separately', async () => {
  const s = setup({ response: () => { const r = new Response(new Uint8Array([71, 1])); Object.defineProperty(r, 'url', { value: 'https://cdn.test/final.ts' }); return r; } });
  s.set(true, 1); await s.w.fetch('https://video.test/original.ts'); await s.waitFor('finish');
  const begin = s.messages.find(m => m.action === 'begin');
  assert.equal(begin.url, 'https://video.test/original.ts'); assert.equal(begin.responseUrl, 'https://cdn.test/final.ts');
});
test('HEAD XHR does not create an empty recording or disable capture', async () => {
  const s = setup(); s.set(true, 1);
  const xhr = new s.XHR(); xhr.open('HEAD', '/index.m3u8'); xhr.responseType = ''; xhr.responseText = ''; xhr.status = 200;
  xhr.send(); xhr.dispatchEvent(new Event('load'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(s.messages.filter(m => m.type === 'HLS_SAVER_REQUEST').length, 0);
});
test('redirected XHR preserves its original segment address', async () => {
  const s = setup(); s.set(true, 1);
  const xhr = new s.XHR(); xhr.open('GET', '/original.ts'); xhr.responseType = 'blob'; xhr.response = new Blob([new Uint8Array([71, 4])]); xhr.responseURL = 'https://cdn.test/final.ts'; xhr.status = 200;
  xhr.send(); xhr.dispatchEvent(new Event('load')); await s.waitFor('finish');
  const begin = s.messages.find(m => m.action === 'begin');
  assert.equal(begin.url, 'https://video.test/original.ts'); assert.equal(begin.responseUrl, 'https://cdn.test/final.ts');
});
test('one-shot fetch completed before initialization is saved after the first ON decision', async () => {
  const s = setup();
  const response = await s.w.fetch('/early.ts');
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [71, 1, 2]);
  assert.equal(s.messages.filter(m => m.action === 'begin').length, 0);
  s.set(true, 1); await s.waitFor('finish');
  assert.equal(s.messages.find(m => m.action === 'begin').url, 'https://video.test/early.ts');
});
test('XHR completed before initialization is retained until ON without delaying load', async () => {
  const s = setup();
  const xhr = new s.XHR(); xhr.open('GET', '/early.m3u8'); xhr.responseType = ''; xhr.responseText = '#EXTM3U\na.ts'; xhr.status = 200;
  xhr.send(); xhr.dispatchEvent(new Event('load'));
  assert.equal(xhr.responseText, '#EXTM3U\na.ts');
  s.set(true, 1); await s.waitFor('finish');
});
test('initial OFF discards startup candidates and a later ON cannot revive them', async () => {
  const s = setup();
  await (await s.w.fetch('/early.ts')).arrayBuffer();
  s.set(false, 1); await new Promise(resolve => setTimeout(resolve, 20));
  s.set(true, 2); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(s.messages.filter(m => m.type === 'HLS_SAVER_REQUEST').length, 0);
});
test('fetch and XHR resolve the document base when the request starts', async () => {
  let resolve;
  const s = setup({ baseURI: 'https://video.test/media/', response: () => new Promise(r => { resolve = r; }) });
  s.set(true, 1);
  const pending = s.w.fetch('a.ts');
  s.document.baseURI = 'https://video.test/changed/';
  resolve(new Response(new Uint8Array([71]))); await pending; await s.waitFor('finish');
  assert.equal(s.messages.find(m => m.action === 'begin').url, 'https://video.test/media/a.ts');
  const xhr = new s.XHR(); xhr.open('GET', 'b.ts'); xhr.responseType = 'blob'; xhr.response = new Blob([new Uint8Array([71])]); xhr.status = 200;
  s.document.baseURI = 'https://video.test/changed-again/';
  xhr.send(); xhr.dispatchEvent(new Event('load'));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(s.messages.filter(m => m.action === 'begin')[1].url, 'https://video.test/changed/b.ts');
});
test('a large startup response is preserved after the first ON decision', async () => {
  const s = setup({ response: () => new Response(new Uint8Array(9 * 1024 * 1024)) });
  const response = await s.w.fetch('/large-startup.ts');
  assert.equal((await response.arrayBuffer()).byteLength, 9 * 1024 * 1024);
  assert.equal(s.messages.filter(m => m.action === 'begin').length, 0);
  s.set(true, 1); await s.waitFor('finish');
  assert.equal(s.messages.filter(m => m.action === 'chunk').reduce((sum, m) => sum + Buffer.from(m.data, 'base64').length, 0), 9 * 1024 * 1024);
});
test('startup request resolving after initial OFF and a subsequent ON is not revived', async () => {
  let resolve;
  const s = setup({ response: () => new Promise(done => { resolve = done; }) });
  const pending = s.w.fetch('/early.ts'); s.set(false, 1); s.set(true, 2);
  resolve(new Response(new Uint8Array([71]))); await pending;
  await new Promise(done => setTimeout(done, 20));
  assert.equal(s.messages.filter(m => m.type === 'HLS_SAVER_REQUEST').length, 0);
});
for (const type of ['arraybuffer', 'blob']) {
  test(`oversized XHR ${type} is rejected before creating another Blob`, async () => {
    let constructions = 0;
    const ObservedBlob = new Proxy(Blob, { construct(target, args, newTarget) {
      constructions++; return Reflect.construct(target, args, newTarget);
    } });
    const s = setup({ BlobClass: ObservedBlob }); s.set(true, 1);
    const response = type === 'arraybuffer' ? new ArrayBuffer(32 * 1024 * 1024 + 1) : new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]);
    const xhr = new s.XHR(); xhr.open('GET', '/oversized.ts'); xhr.responseType = type; xhr.response = response; xhr.status = 200;
    xhr.send(); xhr.dispatchEvent(new Event('load')); await s.waitFor('captureError');
    assert.equal(constructions, 0, 'Size rejection must precede Blob construction');
    assert.equal(xhr.response, response);
    assert.equal(s.messages.filter(m => m.action === 'begin').length, 0);
    assert.match(s.messages.find(m => m.action === 'captureError').error, /32 MiB/);
  });
}
test('in-limit XHR Blob is streamed directly without constructing a wrapper Blob', async () => {
  let constructions = 0, streams = 0;
  const ObservedBlob = new Proxy(Blob, { construct(target, args, newTarget) {
    constructions++; return Reflect.construct(target, args, newTarget);
  } });
  const s = setup({ BlobClass: ObservedBlob }); s.set(true, 1);
  const response = new Blob([new Uint8Array([71, 4, 5])]);
  response.stream = function() { streams++; return Blob.prototype.stream.call(this); };
  const xhr = new s.XHR(); xhr.open('GET', '/small.ts'); xhr.responseType = 'blob'; xhr.response = response; xhr.status = 200;
  xhr.send(); xhr.dispatchEvent(new Event('load')); await s.waitFor('finish');
  assert.equal(constructions, 0); assert.equal(streams, 1);
  assert.equal(xhr.response, response);
  assert.equal(s.messages.find(m => m.action === 'chunk').data, 'RwQF');
});
test('six parallel bursts retain all bytes with one outstanding chunk per capture', async () => {
  const size = 2 * 1024 * 1024;
  const s = setup({ response: () => new Response(new Uint8Array(size)), ackDelay: 2 }); s.set(true, 1);
  await Promise.all(Array.from({ length: 6 }, async (_, i) => (await s.w.fetch(`/burst-${i}.ts`)).arrayBuffer()));
  const deadline = Date.now() + 3000;
  while (s.messages.filter(m => m.action === 'finish').length < 6 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(s.messages.filter(m => m.action === 'finish').length, 6);
  assert.equal(s.messages.filter(m => ['fail', 'captureError'].includes(m.action)).length, 0);
  assert.equal(s.messages.filter(m => m.action === 'chunk').reduce((sum, m) => sum + Buffer.from(m.data, 'base64').length, 0), 6 * size);
  assert.equal(s.metrics.maxPerRecord, 1);
  assert.ok(s.metrics.peak <= 6 * 192 * 1024);
});
test('slow but progressing storage is not subject to a total recording deadline', async () => {
  const s = setup({ response: () => new Response(new Uint8Array(9 * 1024 * 1024)), ackDelay: 2, timerScale: 0.001 }); s.set(true, 1);
  await (await s.w.fetch('/slow.ts')).arrayBuffer(); await s.waitFor('finish');
  assert.equal(s.metrics.maxPerRecord, 1);
  assert.equal(s.messages.filter(m => m.action === 'fail').length, 0);
});
test('genuinely stalled chunk acknowledgement fails visibly without affecting playback', async () => {
  const s = setup({ stallChunk: true, timerScale: 0.001 }); s.set(true, 1);
  assert.equal((await (await s.w.fetch('/stalled.ts')).arrayBuffer()).byteLength, 3);
  await s.waitFor('fail');
  assert.match(s.messages.find(m => m.action === 'fail').error, /応答がありません/);
  assert.equal(s.messages.filter(m => m.action === 'finish').length, 0);
});
test('OFF drains the accepted large response while rejecting new captures', async () => {
  const size = 1024 * 1024;
  const s = setup({ response: () => new Response(new Uint8Array(size)), ackDelay: 2 }); s.set(true, 1);
  await (await s.w.fetch('/accepted.ts')).arrayBuffer(); await s.waitFor('chunk');
  s.set(false, 2);
  await (await s.w.fetch('/off.ts')).arrayBuffer(); await s.waitFor('finish');
  assert.equal(s.messages.filter(m => m.action === 'begin').length, 1);
  assert.equal(s.messages.filter(m => m.action === 'chunk').reduce((sum, m) => sum + Buffer.from(m.data, 'base64').length, 0), size);
});
test('a genuinely stalled response fails by receive inactivity rather than total elapsed time', async () => {
  const s = setup({ response: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([71])); } })), timerScale: 0.001 });
  s.set(true, 1);
  const response = await s.w.fetch('/network-stall.ts');
  const playback = response.body.getReader(); assert.equal((await playback.read()).value[0], 71);
  await s.waitFor('fail');
  assert.match(s.messages.find(m => m.action === 'fail').error, /30秒間/);
  assert.equal(s.messages.filter(m => m.action === 'finish').length, 0);
  await playback.cancel();
});
