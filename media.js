/* Read only the bounded prefix needed for format checks, across arbitrary network chunks. */
(() => {
  'use strict';
  async function validate(record, container, readChunk = (id, index) => CaptureDB.get('chunks', [id, index])) {
    const needed = container === 'ts' ? Math.min(record.size, 189) : 8;
    const prefix = new Uint8Array(needed);
    let copied = 0;
    for (let index = 0; index < record.chunks && copied < needed; index++) {
      const chunk = await readChunk(record.id, index);
      if (!chunk) throw new Error('断片の保存が不完全です。');
      const part = chunk.data.subarray(0, needed - copied);
      prefix.set(part, copied); copied += part.length;
    }
    if (copied < needed) throw new Error('断片のヘッダーが不完全です。');
    if (container === 'ts') {
      if (!prefix.length || prefix[0] !== 0x47 || (prefix.length > 188 && prefix[188] !== 0x47)) throw new Error('TSとして認識できない断片があります。');
    } else if (!['ftyp', 'moov', 'styp', 'moof', 'sidx', 'emsg', 'prft'].includes(String.fromCharCode(...prefix.subarray(4, 8)))) {
      throw new Error('fMP4として認識できない断片があります。');
    }
  }
  globalThis.CaptureMedia = { validate };
})();
