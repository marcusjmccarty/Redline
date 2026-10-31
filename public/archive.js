(() => {
  'use strict';
  // A small, uncompressed container: magic, JSON manifest length, manifest,
  // then the JPEG blobs in manifest order. Photos never become base64 strings.
  const magic = new TextEncoder().encode('REDLINE1\n');
  const MAX_MANIFEST = 8 * 1024 * 1024, MAX_ARCHIVE = 2 * 1024 ** 3;
  const invalid = () => { throw Error('This is not a complete Redline backup.'); };

  function pack(records) {
    const blobs = [], trips = records.map(({trip, photos}) => ({
      trip: {id:trip.id, title:trip.title, stops:trip.stops, createdAt:trip.createdAt},
      photos: photos.map(({photo, blob}) => {
        blobs.push(blob);
        return {stopId:photo.stopId, city:photo.city, postcard:photo.postcard || {}, caption:photo.caption||'', createdAt:photo.createdAt, width:photo.width, height:photo.height, bytes:blob.size};
      })
    }));
    const manifest = new TextEncoder().encode(JSON.stringify({version:1, trips}));
    if (manifest.length > MAX_MANIFEST) throw Error('This library is too large for one backup. Export one trip at a time.');
    const header = new Uint8Array(magic.length + 4);
    header.set(magic); new DataView(header.buffer).setUint32(magic.length, manifest.length, true);
    const archive = new Blob([header, manifest, ...blobs], {type:'application/octet-stream'});
    if (archive.size > MAX_ARCHIVE) throw Error('Export one trip at a time to keep each backup under 2 GB.');
    return archive;
  }

  async function unpack(file) {
    if (!file || file.size < magic.length + 4 || file.size > MAX_ARCHIVE) invalid();
    const head = new Uint8Array(await file.slice(0, magic.length + 4).arrayBuffer());
    if (!magic.every((byte,i) => head[i] === byte)) invalid();
    const length = new DataView(head.buffer).getUint32(magic.length, true);
    let offset = head.length + length;
    if (!length || length > MAX_MANIFEST || offset > file.size) invalid();
    let manifest;
    try { manifest = JSON.parse(await file.slice(head.length, offset).text()); } catch { invalid(); }
    if (manifest.version !== 1 || !Array.isArray(manifest.trips) || manifest.trips.length > 200) invalid();
    const records = [];
    for (const record of manifest.trips) {
      if (!record?.trip || !Array.isArray(record.photos) || record.photos.length > 300) invalid();
      const photos = [];
      for (const photo of record.photos) {
        if (!Number.isInteger(photo?.bytes) || photo.bytes <= 0 || photo.bytes > 4*1024*1024 || offset + photo.bytes > file.size) invalid();
        photos.push({photo, blob:file.slice(offset, offset + photo.bytes, 'image/jpeg')});
        offset += photo.bytes;
      }
      records.push({trip:record.trip, photos});
    }
    if (offset !== file.size) invalid();
    return records;
  }
  window.RedlineArchive = {pack, unpack};
})();
