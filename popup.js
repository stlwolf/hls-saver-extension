'use strict';
const $ = id => document.getElementById(id);
let tabId, session, busy = false, refreshing = false;
let actionError = '';
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '拡張機能から応答がありません。');
  return result;
}
async function refresh() {
  if (refreshing || busy || !tabId) return;
  refreshing = true;
  try {
    const stats = await send({ action: 'getStats', tabId });
    session = stats.session;
    $('toggleBtn').disabled = !session || !!session.error;
    $('downloadBtn').disabled = !session || !stats.captured || !!session.error;
    $('clearBtn').disabled = !session;
    if (!session) {
      $('error').textContent = actionError;
      $('status').textContent = '対象ページをリロードしてから再生してください。';
      $('captured').textContent = '0 件'; $('totalSize').textContent = '0 MiB'; $('pending').textContent = '0 件';
      $('playlists').textContent = '0 件'; $('failed').textContent = '0 件';
      return;
    }
    $('status').textContent = session.error ? 'エラーで収録停止 — 自動再開しません' : session.enabled ? '収録中' : stats.pending ? '停止処理中 — 受付済みデータを保存しています' : '収録 OFF';
    $('toggleBtn').textContent = session.enabled ? '収録を OFF にする' : '収録を ON にする';
    $('captured').textContent = `${stats.mediaCaptured} 件`;
    $('playlists').textContent = `${stats.playlistsCaptured} 件`;
    $('failed').textContent = `${stats.failed} 件`;
    $('totalSize').textContent = `${(stats.totalSize / 1024 / 1024).toFixed(1)} MiB`;
    $('pending').textContent = `${stats.pending} 件`;
    $('error').textContent = session.error ? `${session.error}\nこの収録には欠落があります。保存待ちの件数が減っても収録の再開ではありません。\nクリアしてONにした後、ページをリロードして再生し直してください。` : actionError;
  } catch (error) { $('error').textContent = error.message; }
  finally { refreshing = false; }
}
async function act(action, extra = {}) {
  if (!session || busy) return;
  busy = true;
  actionError = '';
  for (const id of ['toggleBtn', 'downloadBtn', 'clearBtn']) $(id).disabled = true;
  try { await send({ action, sessionId: session.id, ...extra }); }
  catch (error) { actionError = error.message; }
  finally { busy = false; await refresh(); }
}
$('toggleBtn').addEventListener('click', () => act('setEnabled', { enabled: !session.enabled }));
$('downloadBtn').addEventListener('click', () => act('snapshot'));
$('clearBtn').addEventListener('click', () => {
  if (confirm('このページの蓄積データを削除します。書き出し中の処理も中止されます。')) void act('clear');
});
void chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => { tabId = tabs[0]?.id; return refresh(); }).catch(error => { $('error').textContent = error.message; });
setInterval(() => { void refresh(); }, 1000);
