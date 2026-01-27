// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const capturedEl = document.getElementById('captured');
  const totalSizeEl = document.getElementById('totalSize');
  const toggleBtn = document.getElementById('toggleBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const clearBtn = document.getElementById('clearBtn');
  const fileListEl = document.getElementById('fileList');
  
  // 統計を取得して表示
  async function updateStats() {
    try {
      const stats = await chrome.runtime.sendMessage({ action: 'getStats' });
      
      // ステータス表示
      statusEl.classList.toggle('on', stats.enabled);
      statusEl.classList.toggle('off', !stats.enabled);
      toggleBtn.textContent = `Capturing: ${stats.enabled ? 'ON' : 'OFF'}`;
      toggleBtn.classList.toggle('off', !stats.enabled);
      
      // 統計表示
      capturedEl.textContent = `${stats.captured} files`;
      totalSizeEl.textContent = formatSize(stats.totalSize);
      
      // ダウンロードボタン
      downloadBtn.disabled = stats.captured === 0;
      
      // ファイルリスト
      renderFileList(stats.files || []);
    } catch (err) {
      console.error('Failed to get stats:', err);
    }
  }
  
  // ファイルリスト描画
  function renderFileList(files) {
    if (files.length === 0) {
      fileListEl.innerHTML = '<div style="color:#999;text-align:center;">No files captured yet</div>';
      return;
    }
    
    // ファイル名でソート
    files.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
    
    fileListEl.innerHTML = files.map(f => `
      <div class="file-item">
        <span class="file-name">${escapeHtml(f.filename)}</span>
        <span class="file-size">${formatSize(f.size)}</span>
      </div>
    `).join('');
  }
  
  // ON/OFF切り替え
  toggleBtn.addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ action: 'toggle' });
    updateStats();
  });
  
  // ダウンロード
  downloadBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Downloading...';
    
    try {
      await chrome.runtime.sendMessage({ action: 'downloadAll' });
      downloadBtn.textContent = 'Done!';
      setTimeout(() => {
        downloadBtn.textContent = 'Download All';
        updateStats();
      }, 2000);
    } catch (err) {
      console.error('Download failed:', err);
      downloadBtn.textContent = 'Error';
    }
  });
  
  // クリア
  clearBtn.addEventListener('click', async () => {
    if (confirm('Clear all captured segments?')) {
      await chrome.runtime.sendMessage({ action: 'clear' });
      updateStats();
    }
  });
  
  // サイズフォーマット
  function formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }
  
  // HTMLエスケープ
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  
  // 初期表示
  updateStats();
  
  // 定期更新（キャプチャ中の進捗確認用）
  setInterval(updateStats, 2000);
});
