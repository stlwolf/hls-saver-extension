'use strict';
const $ = id => document.getElementById(id);
const jobId = new URLSearchParams(location.search).get('id');
let job, records, versions, selectedPlan, invalid = false, running = false, cancelled = false, writer;
const showError = error => { $('error').textContent = error.message || String(error); };
async function checkSession() {
  const epoch = (await chrome.storage.session.get('captureEpoch')).captureEpoch;
  const session = job && await CaptureDB.get('sessions', job.sessionId);
  if (!session || !epoch || session.epoch !== epoch) throw new Error('元のページが閉じられたか、収録データが削除されました。');
  if (cancelled) throw new DOMException('書き出しを中止しました。', 'AbortError');
}
async function textOf(record) {
  if (record.size > 2 * 1024 * 1024) throw new Error('プレイリストが大きすぎます（上限2 MiB）。');
  const decoder = new TextDecoder();
  let text = '';
  for (let index = 0; index < record.chunks; index++) {
    const chunk = await CaptureDB.get('chunks', [record.id, index]);
    if (!chunk) throw new Error('プレイリストの保存が不完全です。');
    text += decoder.decode(chunk.data, { stream: true });
  }
  return text + decoder.decode();
}
function selectPlaylist() {
  selectedPlan = null;
  $('error').textContent = ''; $('details').textContent = ''; $('warning').textContent = '';
  try {
    const url = $('playlist').value;
    selectedPlan = HLSPlaylist.plan(versions.filter(v => v.url === url), records);
    $('details').textContent = `${selectedPlan.count} 断片・${(selectedPlan.bytes / 1024 / 1024).toFixed(1)} MiB`;
    $('warning').textContent = selectedPlan.partial ? 'プレイリストの一部だけが収録されています。収録範囲のみを書き出します。' : '蓄積された範囲を書き出します。ライブや別音声を含む動画では、動画全体を取得できたことを意味しません。';
  } catch (error) { showError(error); }
  $('save').disabled = !selectedPlan || invalid || running || !window.showSaveFilePicker;
}
async function load() {
  if (!window.showSaveFilePicker) throw new Error('このブラウザでは逐次書き出しを利用できません。デスクトップ版Chromeを使用してください。');
  job = await CaptureDB.get('exports', jobId);
  if (!job) throw new Error('書き出しデータが失効しました。元のページで書き出しを押してください。');
  const deadline = Date.now() + 45000;
  while (true) {
    await checkSession();
    const byId = new Map((await CaptureDB.all('records', job.sessionId)).map(record => [record.id, record]));
    records = job.recordIds.map(id => byId.get(id));
    if (records.some(r => !r)) throw new Error('書き出し対象が削除されました。');
    if (records.some(r => r.state === 'failed')) throw new Error('保存に失敗した断片があります。クリアして収録し直してください。');
    const pending = records.filter(r => r.state === 'pending').length;
    if (!pending) break;
    if (Date.now() > deadline) throw new Error('保存完了を確認できませんでした。元のページの状態を確認してください。');
    $('status').textContent = `${pending} 件の保存完了を待っています…`;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  records.sort((a, b) => a.sequence - b.sequence);
  versions = [];
  for (const record of records) {
    if (/\.m3u8(?:[?#]|$)/i.test(record.url) || /\.m3u8(?:[?#]|$)/i.test(record.responseUrl)) versions.push({ url: record.url, base: record.responseUrl || record.url, text: await textOf(record) });
  }
  const urls = [...new Set(versions.filter(v => !HLSPlaylist.parse(v.text, v.base).master).map(v => v.url))];
  if (!urls.length) throw new Error('断片の順序を決めるプレイリストがありません。ONにした状態でリロードして再生してください。');
  for (const url of urls) { const option = document.createElement('option'); option.value = url; option.textContent = url; $('playlist').append(option); }
  $('playlist').disabled = false;
  $('status').textContent = '書き出すプレイリストを選んでください。';
  selectPlaylist();
}
$('playlist').addEventListener('change', selectPlaylist);
$('cancel').addEventListener('click', () => { cancelled = true; $('cancel').disabled = true; });
window.addEventListener('pagehide', () => {
  cancelled = true;
  if (writer) void writer.abort().catch(() => {});
});
$('save').addEventListener('click', async () => {
  if (!selectedPlan || running || invalid) return;
  const plan = selectedPlan;
  running = true; cancelled = false;
  $('save').disabled = true; $('playlist').disabled = true; $('cancel').disabled = false; $('error').textContent = '';
  try {
    // Must be the first awaited operation in this user gesture.
    const handle = await window.showSaveFilePicker({ suggestedName: `hls-${job.id.slice(0, 8)}.${plan.container === 'ts' ? 'ts' : 'm4s'}` });
    await checkSession();
    writer = await handle.createWritable();
    let done = 0;
    $('progress').max = plan.bytes;
    for (let partIndex = 0; partIndex < plan.parts.length; partIndex++) {
      const record = plan.parts[partIndex];
      await CaptureMedia.validate(record, plan.container);
      let actual = 0;
      for (let index = 0; index < record.chunks; index++) {
        await checkSession();
        const chunk = await CaptureDB.get('chunks', [record.id, index]);
        if (!chunk) throw new Error('書き出し中にデータが削除されました。');
        await writer.write(chunk.data);
        actual += chunk.data.byteLength; done += chunk.data.byteLength;
        $('progress').value = done;
        $('status').textContent = `書き出し中… ${Math.round(done / plan.bytes * 100)}%`;
      }
      if (actual !== record.size) throw new Error('断片の保存サイズが一致しません。');
    }
    await checkSession();
    await writer.close(); writer = null;
    await checkSession();
    $('status').textContent = '書き出しが完了しました。蓄積データは元のページを離れるまで残ります。';
  } catch (error) {
    if (writer) await writer.abort().catch(() => {});
    writer = null;
    $('status').textContent = error.name === 'AbortError' ? '書き出しを中止しました。' : '書き出しに失敗しました。';
    if (error.name !== 'AbortError') showError(error);
  } finally {
    running = false; $('cancel').disabled = true;
    $('playlist').disabled = invalid; $('save').disabled = invalid || !selectedPlan;
  }
});
setInterval(async () => {
  if (!job || invalid) return;
  try { await checkSession(); }
  catch (error) {
    // User cancellation is local to the current write, not session invalidation.
    if (error.name === 'AbortError') return;
    invalid = true; cancelled = true;
    $('save').disabled = true; $('playlist').disabled = true;
    if (writer) { await writer.abort().catch(() => {}); writer = null; }
    showError(error);
  }
}, 1000);
void load().catch(showError);
