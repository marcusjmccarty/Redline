(() => {
  'use strict';
  // A small, uncompressed container: magic, JSON manifest length, manifest,
  // then the JPEG blobs in manifest order. Photos never become base64 strings.
  const magic = new TextEncoder().encode('REDLINE1\n');
  const MAX_MANIFEST = 8 * 1024 * 1024, MAX_ARCHIVE = 2 * 1024 ** 3;
  const invalid = () => { throw Error('This is not a complete Redline backup.'); };

  const encoder = new TextEncoder(), textSize = value => encoder.encode(JSON.stringify(value)).length;
  const tripEntry = trip => ({id:trip.id, title:trip.title, stops:trip.stops, createdAt:trip.createdAt});
  const photoEntry = ({photo, blob}) => ({stopId:photo.stopId, city:photo.city, postcard:photo.postcard || {}, caption:photo.caption||'', createdAt:photo.createdAt, orderKey:photo.orderKey||photo.id, width:photo.width, height:photo.height, bytes:blob.size});

  function pack(records) {
    const blobs = [], trips = records.map(({trip, photos}) => ({
      trip: tripEntry(trip),
      photos: photos.map(item => { blobs.push(item.blob); return photoEntry(item); })
    }));
    const manifest = encoder.encode(JSON.stringify({version:1, trips}));
    if (manifest.length > MAX_MANIFEST) throw Error('This backup has too much text for one file.');
    const header = new Uint8Array(magic.length + 4);
    header.set(magic); new DataView(header.buffer).setUint32(magic.length, manifest.length, true);
    const archive = new Blob([header, manifest, ...blobs], {type:'application/octet-stream'});
    if (archive.size > MAX_ARCHIVE) throw Error('This backup is over 2 GB, too large for one file.');
    return archive;
  }

  // Divides records into files that each fit both caps and import on their own. Trips stay whole when
  // a fresh file can hold them; a larger one continues in a copy that repeats its route as "(part n)".
  function split(records, {bytes:maxBytes = MAX_ARCHIVE - MAX_MANIFEST, text:maxText = MAX_MANIFEST - 4096} = {}) {
    const parts = []; let part, bytes, text;
    const begin = () => { parts.push(part = []); bytes = 0; text = 32; };
    begin();
    for (const {trip, photos} of records) {
      const head = textSize(tripEntry(trip)) + 32, sizes = photos.map(item => textSize(photoEntry(item)) + 1);
      if (part.length && (bytes + photos.reduce((sum, item) => sum + item.blob.size, 0) > maxBytes || text + head + sizes.reduce((sum, size) => sum + size, 0) > maxText)) begin();
      let copy = {trip, photos:[]}, number = 1; part.push(copy); text += head;
      photos.forEach((item, index) => {
        if (copy.photos.length && (bytes + item.blob.size > maxBytes || text + sizes[index] > maxText)) {
          begin();
          copy = {trip:{...trip, title:`${trip.title.slice(0, 68)} (part ${++number})`}, photos:[]}; part.push(copy); text += head + 32;
        }
        copy.photos.push(item); bytes += item.blob.size; text += sizes[index];
      });
    }
    return parts;
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
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.trips) || manifest.trips.length > 200) invalid();
    const records = [];
    for (const record of manifest.trips) {
      if (!record?.trip || !Array.isArray(record.photos)) invalid();
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
  window.RedlineArchive = {pack, split, unpack};
})();
