/* Conservative HLS merge planner. No network requests; unsupported input fails closed. */
(() => {
  'use strict';
  const attributes = text => Object.fromEntries([...text.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map(m => [m[1], m[2] ?? m[3]]));
  function parse(text, base) {
    if (!text.replace(/^\uFEFF/, '').startsWith('#EXTM3U')) throw new Error('HLSプレイリストではありません。');
    if (text.includes('#EXT-X-STREAM-INF:')) return { master: true, segments: [] };
    const segments = [];
    let sequence = 0, discontinuitySequence = 0, init = null, key = 'NONE', range = null, discontinuity = false, gap = false;
    const resolve = url => new URL(url, base).href;
    const makeRange = (value, uri, previous) => {
      const match = /^(\d+)(?:@(\d+))?$/.exec(value || '');
      if (!match) throw new Error('BYTERANGEが不正です。');
      const length = Number(match[1]);
      const offset = match[2] === undefined ? (previous?.uri === uri && previous.range ? previous.range.end + 1 : NaN) : Number(match[2]);
      if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + length)) throw new Error('BYTERANGEの位置を確定できません。');
      return { start: offset, end: offset + length - 1 };
    };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        sequence = Number(line.slice(line.indexOf(':') + 1));
        if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('MEDIA-SEQUENCEが不正です。');
      } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
        discontinuitySequence = Number(line.slice(line.indexOf(':') + 1));
        if (!Number.isSafeInteger(discontinuitySequence) || discontinuitySequence < 0) throw new Error('DISCONTINUITY-SEQUENCEが不正です。');
      } else if (line.startsWith('#EXT-X-SKIP:')) {
        throw new Error('差分プレイリスト（EXT-X-SKIP）の結合は未対応です。');
      } else if (line.startsWith('#EXT-X-KEY:')) {
        key = attributes(line).METHOD || 'UNKNOWN';
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const attr = attributes(line);
        if (!attr.URI) throw new Error('初期化断片のURLがありません。');
        const uri = resolve(attr.URI);
        init = { uri, range: attr.BYTERANGE ? makeRange(attr.BYTERANGE, uri, init) : null, key };
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(line.indexOf(':') + 1);
      else if (line === '#EXT-X-DISCONTINUITY') { discontinuity = true; discontinuitySequence++; }
      else if (line === '#EXT-X-GAP') gap = true;
      else if (!line.startsWith('#')) {
        const uri = resolve(line);
        segments.push({ uri, sequence: sequence++, init, key, discontinuity, discontinuitySequence, gap,
          range: range ? makeRange(range, uri, segments[segments.length - 1]) : null });
        range = null; discontinuity = false; gap = false;
      }
    }
    return { segments, master: false, live: !text.includes('#EXT-X-ENDLIST') };
  }
  function responseRange(record) {
    if (!record.range) return null;
    const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(record.range);
    if (!match) return undefined;
    return { start: +match[1], end: +match[2] };
  }
  function matches(record, part) {
    if (record.url !== part.uri) return false;
    const range = responseRange(record);
    return part.range ? range?.start === part.range.start && range.end === part.range.end && record.size === range.end - range.start + 1 : range === null;
  }
  const identity = part => JSON.stringify([part.uri, part.range, part.init, part.key, part.discontinuitySequence]);
  function plan(versions, records) {
    const merged = new Map();
    for (const version of versions) {
      const parsed = parse(version.text, version.base || version.url);
      if (parsed.master) continue;
      for (const part of parsed.segments) {
        const old = merged.get(part.sequence);
        if (old && identity(old) !== identity(part)) throw new Error('同じ再生位置の構成が変わっています。リロードして収録を分けてください。');
        merged.set(part.sequence, old ? { ...part, discontinuity: old.discontinuity || part.discontinuity } : part);
      }
    }
    const segments = [...merged.values()].sort((a, b) => a.sequence - b.sequence);
    const addressOf = (url, range) => JSON.stringify([url, range?.start ?? null, range?.end ?? null]);
    const captured = new Map();
    for (const record of records) {
      if (record.state !== 'complete') continue;
      const range = responseRange(record);
      if (range === undefined || (range && record.size !== range.end - range.start + 1)) continue;
      const address = addressOf(record.url, range);
      if (!captured.has(address) || captured.get(address).sequence < record.sequence) captured.set(address, record);
    }
    const choose = part => {
      const record = captured.get(addressOf(part.uri, part.range));
      return record && matches(record, part) ? record : undefined;
    };
    const available = segments.map((part, index) => choose(part) ? index : -1).filter(index => index >= 0);
    if (!available.length) throw new Error('このプレイリストに対応する動画断片がまだありません。');
    const first = available[0], last = available[available.length - 1];
    const selected = segments.slice(first, last + 1);
    const parts = [];
    const mapIdentity = JSON.stringify(selected[0].init);
    const seen = new Set();
    if (selected[0].init) {
      if (selected[0].init.key !== 'NONE') throw new Error('暗号化された初期化断片の結合は未対応です。');
      const init = choose(selected[0].init);
      if (!init) throw new Error('fMP4の初期化断片が取得されていません。');
      parts.push(init);
    }
    for (let index = 0; index < selected.length; index++) {
      const part = selected[index];
      const address = JSON.stringify([part.uri, part.range]);
      if (seen.has(address)) throw new Error('同じ断片URLが複数の再生位置にあり、対応を確定できません。');
      seen.add(address);
      if (part.key !== 'NONE') throw new Error('暗号化された動画の結合は未対応です。');
      if (part.gap || (index > 0 && part.discontinuity) || part.discontinuitySequence !== selected[0].discontinuitySequence || JSON.stringify(part.init) !== mapIdentity) throw new Error('断片の欠落・不連続・初期化情報の変更があるため結合できません。');
      if (index > 0 && part.sequence !== selected[index - 1].sequence + 1) throw new Error('プレイリストの途中が未取得です。');
      const record = choose(part);
      if (!record) throw new Error(`収録範囲の途中に未取得の断片があります（位置 ${part.sequence}）。`);
      parts.push(record);
    }
    return { parts, container: selected[0].init ? 'fmp4' : 'ts', count: selected.length,
      first: selected[0].sequence, last: selected[selected.length - 1].sequence,
      partial: first > 0 || last < segments.length - 1, bytes: parts.reduce((sum, r) => sum + r.size, 0) };
  }
  globalThis.HLSPlaylist = { parse, plan };
})();
