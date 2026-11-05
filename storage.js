(() => {
  'use strict';
  const MAX_PHOTO = 4*1024*1024, MAX_THUMB = 1024*1024;
  const fail = (message, status=400) => { throw Object.assign(Error(message), {status}); };
  const idValid = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(id);
  const now = () => new Date().toISOString();
  const timestamp = value => typeof value==='string' && value.length<50 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : now();
  // Restoring creates independent IDs without shuffling photos saved in the same millisecond.
  const photoOrder = (a,b) => a.createdAt.localeCompare(b.createdAt)||(a.orderKey||a.id).localeCompare(b.orderKey||b.id)||a.id.localeCompare(b.id);
  let opening;
  const urls = new Map(), thumbs = new Map(), backupReceipts = new WeakMap();
  const request = operation => new Promise((resolve,reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
  function open() {
    if (!opening) opening = new Promise((resolve,reject) => {
      if (!window.indexedDB) return reject(Error('This browser cannot save trips. Enable website storage or use another browser.'));
      const operation = indexedDB.open('redline-library-v1', 2);
      operation.onupgradeneeded = () => {
        const db = operation.result;
        if(!db.objectStoreNames.contains('trips'))db.createObjectStore('trips',{keyPath:'id'});
        if(!db.objectStoreNames.contains('photos'))db.createObjectStore('photos',{keyPath:'id'}).createIndex('tripId','tripId');
        // Text edits never reserialize the existing image Blob (which can fail in WebKit).
        if(!db.objectStoreNames.contains('photoNotes'))db.createObjectStore('photoNotes',{keyPath:'id'});
      };
      operation.onsuccess = () => {
        const db = operation.result;
        db.onversionchange = () => { db.close(); opening = null; };
        db.onclose = () => { opening = null; };
        resolve(db);
      };
      operation.onerror = () => { opening=null; reject(operation.error); };
      operation.onblocked = () => { opening=null; reject(Error('Close other Redline tabs and try again.')); };
    });
    return opening;
  }
  async function transaction(names, mode, action) {
    // The browser can close a connection at any time; the next save opens a fresh one.
    let db = await open(), tx;
    try { tx = db.transaction(names, mode); }
    catch (error) { if (error.name !== 'InvalidStateError') throw error; opening = null; db = await open(); tx = db.transaction(names, mode); }
    const done = new Promise((resolve,reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || Error('The save was interrupted. Please try again.'));
      tx.onerror = () => {};
    });
    // Observe immediately so an aborted transaction cannot produce an unhandled rejection.
    done.catch(() => {});
    try {
      const result = await action(Object.fromEntries(names.map(name=>[name,tx.objectStore(name)])));
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      if (error.name === 'QuotaExceededError') fail('This browser is out of storage. Export a backup before clearing anything.',507);
      throw error;
    }
  }
  function city(value) {
    if (!value || !idValid(value.id) || typeof value.name!=='string' || !value.name.trim() || value.name.length>120 || !Number.isFinite(value.latitude) || Math.abs(value.latitude)>90 || !Number.isFinite(value.longitude) || Math.abs(value.longitude)>180) fail('The trip contains an invalid destination.');
    return {id:value.id,name:value.name.trim(),country:typeof value.country==='string'?value.country.slice(0,100):'',admin1:typeof value.admin1==='string'?value.admin1.slice(0,100):'',latitude:value.latitude,longitude:value.longitude};
  }
  function tripData(value) {
    if (!value || typeof value.title!=='string' || !value.title.trim() || value.title.length>80) fail('Give the trip a name (up to 80 characters).');
    if (!Array.isArray(value.stops) || value.stops.length>100) fail('A trip can contain up to 100 stops.');
    const stops=value.stops.map(city);
    if (new Set(stops.map(stop=>stop.id)).size!==stops.length) fail('The trip contains duplicate destinations.');
    return {title:value.title.trim(),stops};
  }
  function postcard(value={}) {
    const result={};
    for (const [key,max] of Object.entries({message:1200,recipient:120,address:400,sender:120})) {
      const text=value?.[key]??'';
      if (typeof text!=='string' || text.length>max) fail('This postcard is too long.');
      result[key]=text;
    }
    return result;
  }
  function caption(value='') {
    if(typeof value!=='string'||value.length>180)fail('Keep captions to 180 characters.');
    return value.trim();
  }
  const dimension = value => { const n=Number(value); return Number.isInteger(n)&&n>0&&n<=20000?n:null; };
  function photoDto(record) {
    if (!urls.has(record.id)) urls.set(record.id,URL.createObjectURL(record.blob));
    if (record.thumb && !thumbs.has(record.id)) thumbs.set(record.id,URL.createObjectURL(record.thumb));
    const {blob,thumb,tripId,...photo}=record;
    return {...photo,caption:record.caption||'',captionRevision:record.captionRevision||1,url:urls.get(record.id),thumbUrl:thumbs.get(record.id)||null};
  }
  function coverUrl(record) {
    if (record.thumb) { if (!thumbs.has(record.id)) thumbs.set(record.id,URL.createObjectURL(record.thumb)); return thumbs.get(record.id); }
    if (!urls.has(record.id)) urls.set(record.id,URL.createObjectURL(record.blob));
    return urls.get(record.id);
  }
  function forget(id) {
    for (const cache of [urls,thumbs]) { if (cache.has(id)) { URL.revokeObjectURL(cache.get(id)); cache.delete(id); } }
  }
  const ownTrip = async (store,id) => {
    const trip=idValid(id)?await request(store.get(id)):null;
    if (!trip) fail('Trip not found.',404);
    return trip;
  };
  // Browsers may grant later what they first declined, so each session asks once, on a real save.
  let persistAsked = false;
  async function persist() {
    if (persistAsked) return; persistAsked = true;
    try { if (!await navigator.storage?.persisted?.()) await navigator.storage?.persist?.(); } catch {}
  }
  async function cleanPhoto(blob, max=MAX_PHOTO) {
    if (!blob || blob.type!=='image/jpeg' || !blob.size || blob.size>max) fail(max===MAX_PHOTO?'Use a processed JPEG smaller than 4 MB.':'The photo preview is too large.');
    return new Blob([window.RedlineJPEG.stripJpegMetadata(await blob.arrayBuffer())],{type:'image/jpeg'});
  }
  // Optional small preview and pixel size; galleries fall back to the full photo without them.
  async function extras(form) {
    const thumb=form?.get?.('thumb'),result={};
    if (thumb && typeof thumb!=='string') result.thumb=await cleanPhoto(thumb,MAX_THUMB);
    const width=dimension(form?.get?.('width')),height=dimension(form?.get?.('height'));
    if (width && height) Object.assign(result,{width,height});
    return result;
  }
  function photoIds(body) {
    const ids=body?.ids;
    if (!Array.isArray(ids) || !ids.length || !ids.every(idValid) || new Set(ids).size!==ids.length) fail('Choose photos from this trip.');
    return ids;
  }
  async function tripPhotos(stores,trip,ids) {
    const photos=await Promise.all(ids.map(id=>request(stores.photos.get(id))));
    if (photos.some(photo=>!photo || photo.tripId!==trip.id)) fail('Some photos are no longer in this trip. Reopen it and try again.',409);
    return photos;
  }

  // Edits live in photoNotes, because re-putting a stored image Blob can fail in WebKit. A backfilled
  // preview gets its own record, so later note saves never carry a Blob either.
  async function withNotes(stores,photos){
    return Promise.all(photos.map(async photo=>{
      const notes=await request(stores.photoNotes.get(photo.id)),side=notes?.sideThumb?await request(stores.photoNotes.get(`${photo.id}.thumb`)):null;
      return {...photo,...notes,...(side?{thumb:side.thumb}:{})};
    }));
  }
  const deleteNotes=async(store,id)=>{await request(store.delete(id));await request(store.delete(`${id}.thumb`));};
  // Photo and note edits leave the route's revision alone, but a backup made before them is out of date.
  const touch=async(store,id)=>{const trip=await request(store.get(id));if(trip)await request(store.put({...trip,changedAt:now()}));};

  async function api(path, options={}) {
    const parts=path.split('/').filter(Boolean),method=options.method||'GET';
    let body=options.body;
    if (typeof body==='string') { try { body=JSON.parse(body); } catch { fail('Invalid trip data.'); } }
    if (parts[0]==='trips' && parts.length===1) {
      if (method==='GET') return transaction(['trips','photos','photoNotes'],'readonly',async stores=>{
        const trips=await request(stores.trips.getAll()),index=stores.photos.index('tripId');
        // Count through the index and fetch one stable cover per trip. Listing
        // the logbook must not deserialize the library's full photo collection.
        return {trips:await Promise.all(trips.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(async ({stops,...trip})=>{
          const [photoCount,cover]=await Promise.all([request(index.count(trip.id)),request(index.get(trip.id))]);
          return {...trip,stopCount:stops.length,photoCount,points:stops.map(stop=>[Math.round(stop.longitude*100)/100,Math.round(stop.latitude*100)/100]),coverUrl:cover?coverUrl((await withNotes(stores,[cover]))[0]):null};
        }))};
      });
      if (method==='POST') {
        const data=tripData(body); persist();
        return transaction(['trips'],'readwrite',async ({trips})=>{
          if (await request(trips.count())>=200) fail('You have reached the 200-trip limit.',409);
          const trip={id:crypto.randomUUID(),...data,revision:1,createdAt:now(),updatedAt:now()};
          await request(trips.add(trip)); return {trip,photos:[]};
        });
      }
    }
    if (parts[0]==='trips' && parts.length===2) {
      if (method==='GET') {
        const result=await transaction(['trips','photos','photoNotes'],'readonly',async stores=>({trip:await ownTrip(stores.trips,parts[1]),photos:await withNotes(stores,await request(stores.photos.index('tripId').getAll(parts[1])))}));
        result.photos=result.photos.sort(photoOrder).map(photoDto);
        return result;
      }
      if (method==='PUT') {
        const data=tripData(body); persist();
        return transaction(['trips'],'readwrite',async ({trips})=>{
          const before=await ownTrip(trips,parts[1]);
          if (!Number.isInteger(body.revision) || body.revision!==before.revision) fail('This trip was updated in another tab. Choose it in the logbook to load the latest version, which discards edits here.',409);
          const trip={...before,...data,revision:before.revision+1,updatedAt:now()};
          await request(trips.put(trip)); return {trip};
        });
      }
      if (method==='DELETE') {
        const ids=await transaction(['trips','photos','photoNotes'],'readwrite',async stores=>{
          const trip=await ownTrip(stores.trips,parts[1]),keys=await request(stores.photos.index('tripId').getAllKeys(trip.id));
          for(const key of keys){await request(stores.photos.delete(key));await deleteNotes(stores.photoNotes,key);}
          await request(stores.trips.delete(trip.id)); return keys;
        });
        ids.forEach(forget); return {deleted:true,photoCount:ids.length};
      }
    }
    if (parts[0]==='trips' && parts.length===3 && parts[2]==='photos' && method==='POST') {
      const blob=await cleanPhoto(body?.get?.('photo')),stopId=body.get('stopId'),more=await extras(body); persist();
      const record=await transaction(['trips','photos'],'readwrite',async stores=>{
        const trip=await ownTrip(stores.trips,parts[1]),stop=trip.stops.find(s=>s.id===stopId);
        if (!stop) fail('Save this city in your trip before adding its photos.');
        const photo={id:crypto.randomUUID(),tripId:trip.id,stopId:stop.id,city:stop,blob,...more,createdAt:now(),postcard:{},postcardRevision:1};
        await request(stores.photos.add(photo)); await request(stores.trips.put({...trip,changedAt:now()})); return photo;
      });
      return {photo:photoDto(record)};
    }
    // Renaming touches only the title, with the same stale-tab check as a full save.
    if (parts[0]==='trips' && parts.length===3 && parts[2]==='title' && method==='PUT') {
      const title=typeof body?.title==='string'?body.title.trim():'';
      if (!title || title.length>80) fail('Give the trip a name (up to 80 characters).');
      return transaction(['trips'],'readwrite',async ({trips})=>{
        const before=await ownTrip(trips,parts[1]);
        if (!Number.isInteger(body.revision) || body.revision!==before.revision) fail('This trip was updated in another tab. Choose it in the logbook to load the latest version, then rename it.',409);
        const trip={...before,title,revision:before.revision+1,updatedAt:now()};
        await request(trips.put(trip)); const {stops,...summary}=trip; return {trip:summary};
      });
    }
    // Moving and deleting several photos are single atomic changes.
    if (parts[0]==='trips' && parts.length===3 && parts[2]==='photos' && method==='PUT') {
      const ids=photoIds(body);
      const records=await transaction(['trips','photos','photoNotes'],'readwrite',async stores=>{
        const trip=await ownTrip(stores.trips,parts[1]),stop=trip.stops.find(s=>s.id===body.stopId);
        if (!stop) fail('Save this city in your trip before moving photos there.');
        const photos=await tripPhotos(stores,trip,ids);
        for (const photo of photos) { const notes=await request(stores.photoNotes.get(photo.id))||{id:photo.id}; await request(stores.photoNotes.put({...notes,stopId:stop.id,city:stop})); }
        await request(stores.trips.put({...trip,changedAt:now()}));
        return withNotes(stores,photos);
      });
      return {photos:records.map(photoDto)};
    }
    if (parts[0]==='trips' && parts.length===3 && parts[2]==='photos' && method==='DELETE') {
      const ids=photoIds(body);
      await transaction(['trips','photos','photoNotes'],'readwrite',async stores=>{
        const trip=await ownTrip(stores.trips,parts[1]);await tripPhotos(stores,trip,ids);
        for(const id of ids){await request(stores.photos.delete(id));await deleteNotes(stores.photoNotes,id);}
        await request(stores.trips.put({...trip,changedAt:now()}));
      });
      ids.forEach(forget); return {deleted:ids.length};
    }
    if (parts[0]==='photos' && parts.length===3 && parts[2]==='thumb' && method==='PUT') {
      const more=await extras(body);if (!more.thumb) fail('Choose a photo preview.');
      const record=await transaction(['photos','photoNotes'],'readwrite',async ({photos,photoNotes})=>{
        const photo=idValid(parts[1])?await request(photos.get(parts[1])):null;
        if (!photo) fail('Photo not found.',404);
        const {thumb,...size}=more,notes=await request(photoNotes.get(photo.id))||{id:photo.id},saved={...notes,...size,sideThumb:true};
        await request(photoNotes.put({id:`${photo.id}.thumb`,thumb}));await request(photoNotes.put(saved));return {...photo,...saved,thumb};
      });
      // Only the preview changes; the full photo URL may still be on screen.
      if (thumbs.has(record.id)) { URL.revokeObjectURL(thumbs.get(record.id)); thumbs.delete(record.id); }
      return {photo:photoDto(record)};
    }
    if(parts[0]==='photos'&&parts.length===3&&['caption','postcard'].includes(parts[2])&&method==='PUT'){
      const field=parts[2],data=field==='caption'?caption(body?.caption):postcard(body?.postcard),revisionKey=`${field}Revision`;
      return transaction(['trips','photos','photoNotes'],'readwrite',async ({trips,photos,photoNotes})=>{
        const photo=idValid(parts[1])?await request(photos.get(parts[1])):null;
        if(!photo)fail('Photo not found.',404);
        const notes=await request(photoNotes.get(photo.id))||{id:photo.id},revision=notes[revisionKey]??photo[revisionKey]??1;
        if(!Number.isInteger(body.revision)||body.revision!==revision)fail(`This ${field} changed in another tab. Copy your draft, then reload before saving.`,409);
        notes[field]=data;notes[revisionKey]=revision+1;
        await request(photoNotes.put(notes));await touch(trips,photo.tripId);return {[field]:data,revision:notes[revisionKey]};
      });
    }
    fail('Not found.',404);
  }

  // One file per part, in order. A library that fits one file (nearly every library) has one part.
  async function exportParts(tripId=null) {
    const records=await transaction(['trips','photos','photoNotes'],'readonly',async stores=>{
      const trips=tripId?[await ownTrip(stores.trips,tripId)]:await request(stores.trips.getAll());
      if (!trips.length) fail('Save a trip before exporting a backup.');
      const photos=await withNotes(stores,await request(tripId?stores.photos.index('tripId').getAll(tripId):stores.photos.getAll()));
      return trips.map(trip=>({trip,photos:photos.filter(photo=>photo.tripId===trip.id).map(photo=>({photo,blob:photo.blob}))}));
    });
    const parts=window.RedlineArchive.split(records).map(part=>window.RedlineArchive.pack(part));
    // The last part carries the receipt: a backup only counts once every part has gone out.
    backupReceipts.set(parts.at(-1),{ids:records.map(record=>record.trip.id),at:now()});return parts;
  }
  // Called once the last part is handed to the browser. The browser gives no signal that the file arrived, so this records the attempt.
  async function recordBackup(blob){
    const receipt=backupReceipts.get(blob);if(!receipt)fail('Unknown backup.');
    await transaction(['trips'],'readwrite',async ({trips})=>{
      for(const id of receipt.ids){const trip=await request(trips.get(id));if(!trip)continue;
        // Merge only the receipt, preserving edits made in another tab after the export.
        await request(trips.put({...trip,backedUpAt:receipt.at,backupSource:'export'}));
      }
    });backupReceipts.delete(blob);
  }
  async function importArchive(file) {
    const records=await window.RedlineArchive.unpack(file),trips=[],photos=[];
    // Validate and sanitize every byte before starting the single atomic write.
    for (const record of records) {
      const data=tripData(record.trip),trip={...data,id:crypto.randomUUID(),revision:1,createdAt:timestamp(record.trip.createdAt),updatedAt:now(),backedUpAt:now(),backupSource:'import'};
      trips.push(trip);
      for (const [index,entry] of record.photos.entries()) {
        const p=entry.photo;
        // Older backups stored ties in manifest order, before they carried this key.
        const orderKey=p.orderKey??`import-${String(index).padStart(10,'0')}`;
        if (!idValid(orderKey)) fail('The backup contains an invalid photo order.');
        if (p.stopId!=null && !idValid(p.stopId)) fail('The backup contains an invalid photo location.');
        const snapshot=p.city==null?null:city(p.city);
        if (snapshot && snapshot.id!==p.stopId) fail('The backup contains an invalid photo location.');
        const blob=await cleanPhoto(entry.blob);
        const width=dimension(p.width),height=dimension(p.height);
        photos.push({id:crypto.randomUUID(),orderKey,tripId:trip.id,stopId:p.stopId||null,city:snapshot,blob,...(width&&height?{width,height}:{}),createdAt:timestamp(p.createdAt),postcard:postcard(p.postcard),postcardRevision:1,caption:caption(p.caption),captionRevision:1});
      }
    }
    if (!trips.length) fail('This backup has no trips.');
    await transaction(['trips','photos'],'readwrite',async stores=>{
      if (await request(stores.trips.count())+trips.length>200) fail('Importing this backup would exceed the 200-trip limit.',409);
      for (const trip of trips) await request(stores.trips.add(trip));
      for (const photo of photos) await request(stores.photos.add(photo));
    });
    persist(); return {tripCount:trips.length,photoCount:photos.length};
  }
  window.RedlineStorage={api,exportParts,recordBackup,importArchive};
})();
