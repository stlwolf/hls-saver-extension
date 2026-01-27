// content-main.js - Runs in MAIN world to intercept fetch
(function() {
  'use strict';
  
  // 対象パターン（必要に応じて調整）
  const TARGET_PATTERN = /\.(ts|m3u8|m4s)(\?.*)?$/i;
  
  const originalFetch = window.fetch;
  
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    
    if (url && TARGET_PATTERN.test(url)) {
      try {
        // レスポンスをクローンしてボディを読み取る
        const clone = response.clone();
        const buffer = await clone.arrayBuffer();
        const filename = url.split('/').pop().split('?')[0];
        
        // ISOLATEDワールドに送信
        window.postMessage({
          type: 'HLS_SAVER_CAPTURED',
          filename: filename,
          url: url,
          data: Array.from(new Uint8Array(buffer)), // ArrayBufferはpostMessageで送れないので変換
          size: buffer.byteLength,
          timestamp: Date.now()
        }, '*');
        
      } catch (err) {
        console.warn('[HLS Saver] Failed to capture:', url, err);
      }
    }
    
    return response;
  };
  
  // XMLHttpRequestもフック（一部サイトで使用）
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._hlsSaverUrl = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };
  
  XMLHttpRequest.prototype.send = function(...args) {
    const url = this._hlsSaverUrl;
    
    if (url && TARGET_PATTERN.test(url)) {
      this.addEventListener('load', function() {
        try {
          if (this.response instanceof ArrayBuffer) {
            const filename = url.split('/').pop().split('?')[0];
            
            window.postMessage({
              type: 'HLS_SAVER_CAPTURED',
              filename: filename,
              url: url,
              data: Array.from(new Uint8Array(this.response)),
              size: this.response.byteLength,
              timestamp: Date.now()
            }, '*');
          }
        } catch (err) {
          console.warn('[HLS Saver] XHR capture failed:', url, err);
        }
      });
    }
    
    return originalXHRSend.apply(this, args);
  };
  
  console.log('[HLS Saver] Interceptor installed');
})();
