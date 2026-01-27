// content-isolated.js - Bridge between MAIN world and background
(function() {
  'use strict';
  
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'HLS_SAVER_CAPTURED') return;
    
    const { filename, url, data, size, timestamp } = event.data;
    
    try {
      // backgroundに送信（ダウンロード処理）
      const response = await chrome.runtime.sendMessage({
        action: 'saveSegment',
        filename: filename,
        url: url,
        data: data, // Uint8Array as normal array
        size: size,
        timestamp: timestamp,
        pageUrl: window.location.href
      });
      
      if (response?.success) {
        console.log(`[HLS Saver] Saved: ${filename} (${formatSize(size)})`);
      }
    } catch (err) {
      console.warn('[HLS Saver] Failed to send to background:', err);
    }
  });
  
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
})();
