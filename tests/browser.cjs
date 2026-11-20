/* Run with Node >=20. This uses a fresh browser profile, never the user's profile. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-saver-browser-'));
let context, server;
const requests = new Map();
const errors = [];
(async () => {
  for (const type of ['ts', 'fmp4']) {
    const dir = path.join(tmp, type); fs.mkdirSync(dir);
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '3', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-g', '10', '-sc_threshold', '0', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0'];
    if (type === 'fmp4') args.push('-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4');
    args.push('-hls_segment_filename', path.join(dir, type === 'ts' ? 'seg%d.ts' : 'seg%d.m4s'), path.join(dir, 'index.m3u8'));
    execFileSync('ffmpeg', args);
  }
  const originalSegment = fs.readFileSync(path.join(tmp, 'ts', 'seg0.ts'));
  const bulkSegment = Buffer.concat(Array.from({ length: Math.ceil(512 * 1024 / originalSegment.length) }, () => originalSegment));
  const bulkCount = 128;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.set(url.pathname, (requests.get(url.pathname) || 0) + 1);
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Playback fixture</title><video controls></video>'); return; }
    if (url.pathname === '/bulk/index.m3u8') {
      res.end('#EXTM3U\n' + Array.from({ length: bulkCount }, (_, i) => `#EXTINF:1,\n${i}.ts\n`).join('') + '#EXT-X-ENDLIST'); return;
    }
    if (/^\/bulk\/\d+\.ts$/.test(url.pathname)) { res.setHeader('content-length', bulkSegment.length); res.end(bulkSegment); return; }
    const file = path.join(tmp, url.pathname);
    if (!file.startsWith(tmp + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'application/octet-stream');
    res.setHeader('content-length', fs.statSync(file).size);
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium', headless: true,
    ...(process.env.PW_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--enable-precise-memory-info']
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extension = worker.url().split('/')[2];
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extension}/popup.html`);
  const playback = await context.newPage();
  await playback.goto(origin);
  const tabId = await control.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url === origin + '/').id, origin);
  const send = message => control.evaluate(async message => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'No response');
    return result;
  }, message);
  const wait = async predicate => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`Timed out; stats: ${JSON.stringify(await stats().catch(() => ({})))}`);
  };
  const stats = () => send({ action: 'getStats', tabId });
  let session = (await wait(async () => (await stats()).session)).id;
  const fetchFiles = async type => playback.evaluate(async type => {
    const base = `/${type}/`;
    const text = await (await fetch(base + 'index.m3u8')).text();
    const init = /URI="([^"]+)"/.exec(text)?.[1];
    if (init) await (await fetch(base + init)).arrayBuffer();
    for (const line of text.split(/\r?\n/)) if (line && !line.startsWith('#')) await (await fetch(base + line)).arrayBuffer();
  }, type);
  for (const type of ['ts', 'fmp4']) {
    if (type === 'fmp4') { await send({ action: 'clear', sessionId: session }); session = (await stats()).session.id; }
    await fetchFiles(type);
    const captured = await wait(async () => { const s = await stats(); return !s.pending && s.captured >= (type === 'ts' ? 4 : 5) && s; });
    assert.equal(captured.failed, 0); assert.equal(captured.session.error, '');
    const pageEvent = context.waitForEvent('page');
    await send({ action: 'snapshot', sessionId: session });
    const output = await pageEvent;
    await output.waitForURL(`chrome-extension://${extension}/export.html?id=*`);
    await output.locator('#save').waitFor({ state: 'visible' });
    await wait(() => output.locator('#save').isEnabled());
    await output.evaluate(() => {
      window.showSaveFilePicker = async () => {
        window.pickerHadActivation = navigator.userActivation.isActive;
        const directory = await navigator.storage.getDirectory();
        return directory.getFileHandle('test-output', { create: true });
      };
    });
    await output.locator('#save').click();
    await output.waitForFunction(() => document.getElementById('status').textContent.startsWith('書き出しが完了'), { timeout: 15000 });
    assert.equal(await output.evaluate(() => window.pickerHadActivation), true);
    const bytes = await output.evaluate(async () => {
      const directory = await navigator.storage.getDirectory();
      const file = await (await directory.getFileHandle('test-output')).getFile();
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    });
    const target = path.join(tmp, `merged.${type === 'ts' ? 'ts' : 'm4s'}`);
    fs.writeFileSync(target, Buffer.from(bytes));
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', target], { encoding: 'utf8' }).trim());
    assert.ok(duration >= 2.9 && duration <= 3.2, `Unexpected ${type} duration: ${duration}`);
    console.log(`PASS ${type}: real extension capture -> real IDB -> sequential native file writer -> ffprobe ${duration}s; picker user activation verified`);
    await output.screenshot({ path: path.join(tmp, `export-${type}.png`), fullPage: true });
    await output.evaluate(() => { window.showSaveFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); }; });
    await output.locator('#save').click();
    await output.waitForFunction(() => document.getElementById('status').textContent === '書き出しを中止しました。');
    assert.equal((await stats()).captured, captured.captured);
    await output.evaluate(() => { window.showSaveFilePicker = async () => ({ createWritable: async () => { throw new Error('Test disk failure'); } }); });
    await output.locator('#save').click();
    await output.waitForFunction(() => document.getElementById('status').textContent === '書き出しに失敗しました。');
    assert.match(await output.locator('#error').textContent(), /Test disk failure/);
    console.log(`PASS ${type}: picker cancellation and writer failure retain source data`);
    await output.close();
  }
  const before = (await stats()).captured;
  await send({ action: 'setEnabled', sessionId: session, enabled: false });
  await playback.evaluate(async () => { await (await fetch('/ts/seg0.ts?off=1')).arrayBuffer(); });
  assert.equal((await stats()).captured, before);
  console.log('PASS OFF: playback response still readable; no new capture');
  await playback.reload();
  await wait(async () => (await stats()).session?.id !== session);
  const remaining = await control.evaluate(async id => {
    await import(chrome.runtime.getURL('storage.js'));
    return { session: await CaptureDB.get('sessions', id), records: await CaptureDB.all('records', id), chunks: await CaptureDB.all('chunks') };
  }, session);
  assert.equal(remaining.session, undefined); assert.equal(remaining.records.length, 0); assert.equal(remaining.chunks.length, 0);
  console.log('PASS reload: previous session, records, chunks and export snapshots released');
  session = (await stats()).session.id;
  await send({ action: 'setEnabled', sessionId: session, enabled: true });
  const playbackCDP = await context.newCDPSession(playback);
  await playbackCDP.send('HeapProfiler.collectGarbage');
  const captureBefore = await playback.evaluate(() => performance.memory.usedJSHeapSize);
  await playback.evaluate(async () => { await (await fetch('/bulk/index.m3u8')).text(); });
  await wait(async () => !(await stats()).pending);
  for (let i = 0; i < bulkCount; i++) {
    await playback.evaluate(async i => { await (await fetch(`/bulk/${i}.ts`)).arrayBuffer(); }, i);
    await wait(async () => !(await stats()).pending);
  }
  await playbackCDP.send('HeapProfiler.collectGarbage');
  const captureAfter = await playback.evaluate(() => performance.memory.usedJSHeapSize);
  const bulkStats = await stats();
  assert.equal(bulkStats.failed, 0); assert.equal(bulkStats.session.error, '');
  assert.equal(bulkStats.captured, bulkCount + 1);
  assert.ok(captureAfter - captureBefore < 24 * 1024 * 1024, 'Capture retained too much JS heap');
  const bulkPageEvent = context.waitForEvent('page');
  await send({ action: 'snapshot', sessionId: session });
  const bulkOutput = await bulkPageEvent;
  await wait(() => bulkOutput.locator('#save').isEnabled());
  await bulkOutput.evaluate(() => {
    window.largestWrite = 0;
    window.showSaveFilePicker = async () => {
      const file = await (await navigator.storage.getDirectory()).getFileHandle('bulk-output', { create: true });
      return { createWritable: async () => {
        const native = await file.createWritable();
        return { write: async bytes => { window.largestWrite = Math.max(window.largestWrite, bytes.byteLength); await native.write(bytes); }, close: () => native.close(), abort: () => native.abort() };
      } };
    };
  });
  const exportCDP = await context.newCDPSession(bulkOutput);
  await exportCDP.send('HeapProfiler.collectGarbage');
  const exportBefore = await bulkOutput.evaluate(() => performance.memory.usedJSHeapSize);
  await bulkOutput.locator('#save').click();
  await bulkOutput.waitForFunction(() => document.getElementById('status').textContent.startsWith('書き出しが完了'), { timeout: 60000 });
  await exportCDP.send('HeapProfiler.collectGarbage');
  const exportAfter = await bulkOutput.evaluate(() => performance.memory.usedJSHeapSize);
  const bulkResult = await bulkOutput.evaluate(async () => ({ largestWrite: window.largestWrite,
    size: (await (await (await navigator.storage.getDirectory()).getFileHandle('bulk-output')).getFile()).size }));
  assert.equal(bulkResult.size, bulkCount * bulkSegment.length);
  assert.ok(bulkResult.largestWrite <= 192 * 1024);
  assert.ok(exportAfter - exportBefore < 24 * 1024 * 1024, 'Export retained too much JS heap');
  console.log(`PASS large recording: ${(bulkResult.size / 1024 / 1024).toFixed(1)} MiB, max write ${bulkResult.largestWrite} bytes, retained JS heap capture ${(Math.max(0, captureAfter - captureBefore) / 1024 / 1024).toFixed(1)} MiB / export ${(Math.max(0, exportAfter - exportBefore) / 1024 / 1024).toFixed(1)} MiB (not browser total memory)`);
  await playback.evaluate(() => history.pushState({}, '', '/next'));
  await bulkOutput.waitForFunction(() => document.getElementById('error').textContent.includes('削除されました'));
  assert.equal(await bulkOutput.locator('#save').isEnabled(), false);
  assert.equal((await control.evaluate(async () => (await CaptureDB.all('chunks')).length)), 0);
  console.log('PASS SPA navigation: invalidates snapshot and releases previous page data');
  await wait(async () => (await stats()).session?.id !== session);
  await playback.evaluate(async () => { await (await fetch('/ts/seg0.ts?afterHistory=1')).arrayBuffer(); });
  await wait(async () => (await stats()).captured > 0 && !(await stats()).pending);
  await playback.close();
  await wait(async () => !(await stats()).session);
  assert.equal((await control.evaluate(async () => (await CaptureDB.all('chunks')).length)), 0);
  console.log('PASS tab close: invalidates export and releases binary chunks');
  for (const [url, count] of requests) if (/\.(m3u8|ts|m4s|mp4)$/.test(url)) {
    assert.equal(count, url === '/ts/seg0.ts' ? 3 : 1, `Unexpected refetch: ${url} (${count})`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS network: no extension refetches; no uncaught page errors');
  console.log(`Artifacts: ${tmp}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
