// background.js - Service Worker
const DB_NAME = 'HLSSaverDB';
const STORE_NAME = 'segments';

let isEnabled = true;
let stats = {
  captured: 0,
  totalSize: 0,
  files: []
};

// Restore isEnabled state on Service Worker startup
const isEnabledInitPromise = (async () => {
  try {
    const result = await chrome.storage.local.get('isEnabled');
    if (result.isEnabled !== undefined) {
      isEnabled = result.isEnabled;
    }
  } finally {
    console.log('[HLS Saver] Initialized, capturing:', isEnabled);
  }
})();

// IndexedDB初期化
async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'filename' });
      }
    };
  });
}

// セグメント保存
async function saveSegment(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    const record = {
      filename: data.filename,
      url: data.url,
      data: new Uint8Array(data.data),
      size: data.size,
      timestamp: data.timestamp,
      pageUrl: data.pageUrl
    };
    
    const request = store.put(record);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

// 全セグメント取得
async function getAllSegments() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// DB クリア
async function clearDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    
    request.onsuccess = () => {
      stats = { captured: 0, totalSize: 0, files: [] };
      resolve(true);
    };
    request.onerror = () => reject(request.error);
  });
}

// メッセージハンドラ
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'saveSegment') {
    isEnabledInitPromise.then(() => {
      if (!isEnabled) {
        sendResponse({ success: false, skipped: true });
        return;
      }
      saveSegment(message)
        .then(() => {
          stats.captured++;
          stats.totalSize += message.size;
          stats.files.push({
            filename: message.filename,
            size: message.size
          });
          sendResponse({ success: true });
        })
        .catch(err => {
          console.error('Save failed:', err);
          sendResponse({ success: false, error: err.message });
        });
    });
    return true; // async response
  }

  if (message.action === 'getStats') {
    isEnabledInitPromise.then(() => {
      getAllSegments().then(segments => {
        sendResponse({
          enabled: isEnabled,
          captured: segments.length,
          totalSize: segments.reduce((sum, s) => sum + s.size, 0),
          files: segments.map(s => ({ filename: s.filename, size: s.size }))
        });
      });
    });
    return true;
  }
  
  if (message.action === 'toggle') {
    isEnabled = !isEnabled;
    chrome.storage.local.set({ isEnabled });
    sendResponse({ enabled: isEnabled });
    return false;
  }
  
  if (message.action === 'clear') {
    clearDB().then(() => sendResponse({ success: true }));
    return true;
  }
  
  if (message.action === 'downloadAll') {
    downloadAllSegments().then(() => sendResponse({ success: true }));
    return true;
  }
  
  if (message.action === 'downloadSingle') {
    downloadSingleSegment(message.filename).then(() => sendResponse({ success: true }));
    return true;
  }
});

// 全セグメントをダウンロード
async function downloadAllSegments() {
  const segments = await getAllSegments();
  
  for (const segment of segments) {
    await downloadSegment(segment);
    // レート制限回避のため少し待つ
    await new Promise(r => setTimeout(r, 100));
  }
}

// 単一セグメントをダウンロード
async function downloadSingleSegment(filename) {
  const segments = await getAllSegments();
  const segment = segments.find(s => s.filename === filename);
  if (segment) {
    await downloadSegment(segment);
  }
}

// ダウンロード実行
async function downloadSegment(segment) {
  const blob = new Blob([segment.data], { type: 'video/mp2t' });
  const dataUrl = await blobToDataUrl(blob);
  
  return chrome.downloads.download({
    url: dataUrl,
    filename: `hls_segments/${segment.filename}`,
    saveAs: false
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
