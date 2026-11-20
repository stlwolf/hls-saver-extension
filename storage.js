/* Shared by service worker and export page. Statistics never read binary bodies. */
(() => {
  'use strict';
  let connection;
  async function open() {
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('HLSSaverCaptureDB', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('records', { keyPath: 'id' }).createIndex('session', 'sessionId');
        db.createObjectStore('chunks', { keyPath: ['recordId', 'index'] }).createIndex('record', 'recordId');
        db.createObjectStore('exports', { keyPath: 'id' }).createIndex('session', 'sessionId');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = null; };
        resolve(request.result);
      };
      request.onerror = () => { connection = null; reject(request.error); };
    });
    return connection;
  }
  async function transaction(names, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      let value;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
      tx.onerror = () => {};
      try { work(tx, result => { value = result; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  const get = (store, key) => transaction([store], 'readonly', (tx, result) => {
    const r = tx.objectStore(store).get(key); r.onsuccess = () => result(r.result);
  });
  const put = (store, value) => transaction([store], 'readwrite', tx => tx.objectStore(store).put(value));
  const all = (store, sessionId) => transaction([store], 'readonly', (tx, result) => {
    const s = tx.objectStore(store);
    const r = sessionId === undefined ? s.getAll() : s.index('session').getAll(sessionId);
    r.onsuccess = () => result(r.result);
  });
  async function append(record, bytes) {
    const next = { ...record, chunks: record.chunks + 1, size: record.size + bytes.byteLength, touched: Date.now() };
    await transaction(['records', 'chunks'], 'readwrite', tx => {
      tx.objectStore('chunks').add({ recordId: record.id, index: record.chunks, data: bytes });
      tx.objectStore('records').put(next);
    });
    return next;
  }
  function removeRecordIn(tx, id) {
    tx.objectStore('records').delete(id);
    const cursor = tx.objectStore('chunks').index('record').openKeyCursor(IDBKeyRange.only(id));
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (item) { tx.objectStore('chunks').delete(item.primaryKey); item.continue(); }
    };
  }
  const removeRecord = id => transaction(['records', 'chunks'], 'readwrite', tx => removeRecordIn(tx, id));
  const removeSession = id => transaction(['sessions', 'records', 'chunks', 'exports'], 'readwrite', tx => {
    tx.objectStore('sessions').delete(id);
    const records = tx.objectStore('records').index('session').openCursor(IDBKeyRange.only(id));
    records.onsuccess = () => {
      const item = records.result;
      if (item) { removeRecordIn(tx, item.value.id); item.continue(); }
    };
    const jobs = tx.objectStore('exports').index('session').openCursor(IDBKeyRange.only(id));
    jobs.onsuccess = () => {
      const item = jobs.result;
      if (item) { item.delete(); item.continue(); }
    };
  });
  globalThis.CaptureDB = { open, get, put, all, append, removeRecord, removeSession };
})();
