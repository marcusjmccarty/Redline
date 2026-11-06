import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {IDBFactory, IDBObjectStore, IDBIndex} from 'fake-indexeddb';

const jpeg=readFileSync(new URL('./fixtures/gps.jpg',import.meta.url));
const paris={id:'city-paris-01',name:'Paris',country:'France',latitude:48.8566,longitude:2.3522};
const card={message:'Bonjour!\nA good day.',recipient:'A friend',address:'A street',sender:'Marcus'};
function library(indexedDB=new IDBFactory(),overrides={}) {
  const window={indexedDB},context={window,indexedDB,Blob,URL,crypto,TextEncoder,TextDecoder,Uint8Array,DataView,FormData,navigator:{storage:{persist:async()=>true}},...overrides};
  vm.createContext(context);
  for(const name of ['jpeg','archive','storage'])vm.runInContext(readFileSync(new URL(`../public/${name}.js`,import.meta.url),'utf8'),context);
  return {store:window.RedlineStorage,archive:window.RedlineArchive,indexedDB};
}
const create=async store=>(await store.api('/trips',{method:'POST',body:JSON.stringify({title:'Europe',stops:[paris]})})).trip;
async function upload(store,trip,bytes=jpeg) {
  const form=new FormData();form.append('photo',new Blob([bytes],{type:'image/jpeg'}),'private-camera-name.jpg');form.append('stopId',paris.id);
  return (await store.api(`/trips/${trip.id}/photos`,{method:'POST',body:form})).photo;
}
const plain=value=>JSON.parse(JSON.stringify(value));
const single=async(store,id)=>{const parts=await store.exportParts(id);assert.equal(parts.length,1);return parts[0];};

test('map startup reads a route and exact photo count without reading image records or notes',async t=>{
  const {store,indexedDB}=library(),trip=await create(store);
  for(let i=0;i<25;i++)await upload(store,trip);
  const all=IDBIndex.prototype.getAll,get=IDBObjectStore.prototype.get;
  IDBIndex.prototype.getAll=function(...args){assert.notEqual(this.objectStore.name,'photos','The map must not deserialize photo Blobs');return all.apply(this,args);};
  IDBObjectStore.prototype.get=function(...args){assert.notEqual(this.name,'photoNotes','No per-photo note queries at startup');return get.apply(this,args);};
  t.after(()=>{IDBIndex.prototype.getAll=all;IDBObjectStore.prototype.get=get;});
  const {store:reopened}=library(indexedDB),data=await reopened.api(`/trips/${trip.id}`,{photos:false});
  assert.deepEqual(plain(data.trip.stops),[{...paris,admin1:''}]);assert.equal(data.photoCount,25);assert.equal('photos' in data,false);
  await assert.rejects(reopened.api('/trips/missing-trip-0000',{photos:false}),error=>error.status===404);
});

test('trips survive reopening and simultaneous tabs cannot overwrite newer edits',async()=>{
  const {store,indexedDB}=library(),trip=await create(store),second=library(indexedDB).store;
  assert.equal((await second.api('/trips')).trips[0].title,'Europe');
  const writes=await Promise.allSettled([store,second].map((s,i)=>s.api(`/trips/${trip.id}`,{method:'PUT',body:JSON.stringify({...trip,title:`Trip ${i}`})})));
  assert.equal(writes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(writes.find(r=>r.status==='rejected').reason.status,409);
  assert.equal((await second.api(`/trips/${trip.id}`)).trip.revision,2);
});

test('photos and postcard notes persist, with metadata removed and revisions checked',async()=>{
  const {store,indexedDB}=library(),trip=await create(store),photo=await upload(store,trip);
  const clean=Buffer.from(await (await fetch(photo.url)).arrayBuffer());
  assert.ok(clean.length<jpeg.length);assert.equal(clean.includes(Buffer.from('Exif')),false);assert.equal(clean.includes(Buffer.from('TEST CAMERA')),false);
  const saved=await store.api(`/photos/${photo.id}/postcard`,{method:'PUT',body:JSON.stringify({postcard:card,revision:1})});
  assert.equal(saved.revision,2);
  await assert.rejects(store.api(`/photos/${photo.id}/postcard`,{method:'PUT',body:JSON.stringify({postcard:card,revision:1})}),e=>e.status===409);
  const reopened=await library(indexedDB).store.api(`/trips/${trip.id}`);
  assert.deepEqual(plain(reopened.photos[0].postcard),card);
  assert.equal(reopened.photos[0].postcardRevision,2);
  assert.equal((await store.api('/trips')).trips[0].photoCount,1);
});

test('binary backup restores routes, image bytes and postcards on a different device without overwriting trips',async()=>{
  const source=library().store,trip=await create(source),photo=await upload(source,trip);
  await source.api(`/photos/${photo.id}/postcard`,{method:'PUT',body:JSON.stringify({postcard:card,revision:1})});
  const backup=await single(source),target=library().store,existing=await create(target);
  const result=await target.importArchive(backup);
  assert.deepEqual(plain(result),{tripCount:1,photoCount:1});
  const list=(await target.api('/trips')).trips;assert.equal(list.length,2);
  const restored=await target.api(`/trips/${list.find(t=>t.id!==existing.id).id}`);
  assert.notEqual(restored.trip.id,trip.id);assert.deepEqual(plain(restored.trip.stops),plain(trip.stops));
  assert.equal(restored.trip.createdAt,trip.createdAt);assert.equal(restored.photos[0].createdAt,photo.createdAt);
  assert.deepEqual(plain(restored.photos[0].postcard),card);
  assert.deepEqual(new Uint8Array(await (await fetch(restored.photos[0].url)).arrayBuffer()),new Uint8Array(await (await fetch(photo.url)).arrayBuffer()));
  assert.equal((await target.api(`/trips/${existing.id}`)).photos.length,0);
  await target.importArchive(backup);assert.equal((await target.api('/trips')).trips.length,3);
});

test('backup round-trips preserve photo order when creation timestamps tie',async()=>{
  const FixedDate=class extends Date{constructor(...args){super(...(args.length?args:['2026-11-05T00:00:00.000Z']));}};
  let sourceId=0,targetId=100;
  const source=library(undefined,{Date:FixedDate,crypto:{randomUUID:()=>`photo-${String(++sourceId).padStart(8,'0')}`}}).store;
  const trip=await create(source);
  for(const caption of ['First','Second','Third']){
    const photo=await upload(source,trip);
    await source.api(`/photos/${photo.id}/caption`,{method:'PUT',body:{caption,revision:1}});
  }
  const before=(await source.api(`/trips/${trip.id}`)).photos;
  assert.equal(new Set(before.map(photo=>photo.createdAt)).size,1);
  let backup=await single(source,trip.id);
  for(let round=0;round<2;round++){
    const target=library(undefined,{crypto:{randomUUID:()=>`photo-${String(--targetId).padStart(8,'0')}`}}).store;
    await target.importArchive(backup);
    const [copy]=(await target.api('/trips')).trips;
    const photos=(await target.api(`/trips/${copy.id}`)).photos;
    assert.deepEqual(plain(photos.map(photo=>photo.caption)),['First','Second','Third']);
    assert.ok(photos.every(photo=>!before.some(original=>original.id===photo.id)),'Restored photos still receive independent IDs');
    backup=await single(target,copy.id);
  }
});

test('legacy backups preserve manifest order for simultaneous photos',async()=>{
  let next=100;
  const {store,archive}=library(undefined,{crypto:{randomUUID:()=>`photo-${String(--next).padStart(8,'0')}`}});
  const backup=archive.pack([{trip:{title:'Legacy',stops:[paris]},photos:['First','Second'].map(caption=>({photo:{caption,createdAt:'2026-11-05T00:00:00.000Z',stopId:paris.id,city:paris},blob:new Blob([jpeg])}))}]);
  await store.importArchive(backup);
  const [trip]=(await store.api('/trips')).trips;
  assert.deepEqual(plain((await store.api(`/trips/${trip.id}`)).photos.map(photo=>photo.caption)),['First','Second']);
});

test('malformed backup manifests give a useful error and leave saved trips untouched',async()=>{
  const {store}=library();await create(store);
  for(const manifest of ['null','[]','42']){
    const json=new TextEncoder().encode(manifest),header=new Uint8Array(13);
    header.set(new TextEncoder().encode('REDLINE1\n'));new DataView(header.buffer).setUint32(9,json.length,true);
    await assert.rejects(store.importArchive(new Blob([header,json])),/This is not a complete Redline backup/);
  }
  assert.equal((await store.api('/trips')).trips.length,1);
});

test('a 512-photo trip survives backup, restore, and bulk edits',async()=>{
  const store=library().store,trip=await create(store);
  for(let i=0;i<512;i++)await upload(store,trip);
  const restored=library().store;
  const result=await restored.importArchive(await single(store,trip.id));
  assert.equal(result.photoCount,512);
  const [copy]=(await restored.api('/trips')).trips;
  const photosPath=`/trips/${copy.id}/photos`;
  const ids=(await restored.api(`/trips/${copy.id}`)).photos.map(photo=>photo.id);
  const moved=await restored.api(photosPath,{method:'PUT',body:{ids,stopId:paris.id}});
  assert.equal(moved.photos.length,512);
  assert.equal((await restored.api(photosPath,{method:'DELETE',body:{ids}})).deleted,512);
  assert.equal((await restored.api('/trips')).trips[0].photoCount,0);
});

test('invalid or truncated imports make no partial changes',async()=>{
  const {store,archive}=library(),trip=await create(store);
  const valid={trip,photos:[{photo:{stopId:paris.id,city:paris,postcard:card},blob:new Blob([jpeg])}]};
  const invalid={trip:{...trip,title:'Bad'},photos:[{photo:{stopId:paris.id,city:paris},blob:new Blob(['not a jpeg'])}]};
  const before=(await store.api('/trips')).trips.length;
  await assert.rejects(store.importArchive(archive.pack([valid,invalid])));
  assert.equal((await store.api('/trips')).trips.length,before);
  const backup=archive.pack([valid]);
  await assert.rejects(store.importArchive(backup.slice(0,-1)));
  await assert.rejects(store.importArchive(new Blob([backup,'extra'])));
  await assert.rejects(store.importArchive(new Blob(['wrong format'])));
  await assert.rejects(store.importArchive(archive.pack([{...valid,trip:{...trip,stops:[{...paris,latitude:999}]}}])));
  assert.equal((await store.api('/trips')).trips.length,before);
});

test('a storage failure rolls back the whole import and reports that nothing was saved',async()=>{
  const {store,archive}=library();await create(store);
  const backup=archive.pack([{trip:{title:'Import',stops:[paris]},photos:[{photo:{stopId:paris.id,city:paris},blob:new Blob([jpeg])}]}]);
  const original=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args){if(this.name==='photos')throw new DOMException('Quota full','QuotaExceededError');return original.apply(this,args);};
  try { await assert.rejects(store.importArchive(backup),e=>e.status===507); }
  finally { IDBObjectStore.prototype.add=original; }
  assert.equal((await store.api('/trips')).trips.length,1);
});

test('trip validation and photo assignment prevent corrupt saves',async()=>{
  const {store}=library(),trip=await create(store);
  await assert.rejects(store.api('/trips',{method:'POST',body:JSON.stringify({title:'Bad',stops:[paris,paris]})}));
  await assert.rejects(upload(store,trip,new Uint8Array([1,2,3])));
  await assert.rejects(store.api('/trips/not-a-trip'));
  assert.equal((await store.api(`/trips/${trip.id}`)).photos.length,0);
  assert.equal((await store.api('/trips')).trips.length,1);
});

test('static assets and storage have no ChatGPT or root-path API dependency',()=>{
  const html=readFileSync(new URL('../map.html',import.meta.url),'utf8');
  for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g))if(!match[1].startsWith('https:'))assert.ok(!match[1].startsWith('/'));
  const trips=readFileSync(new URL('../public/trips.js',import.meta.url),'utf8');
  assert.ok(!trips.includes('/api'));assert.ok(!trips.includes('signin-with-chatgpt'));assert.match(trips,/fetch\('photo-cities\.json'[,)]/);
});

test('photos move and delete atomically within one trip, and deleting a trip removes its photos',async()=>{
  const {store}=library(),rome={id:'city-rome-0001',name:'Rome',country:'Italy',latitude:41.9,longitude:12.5};
  const trip=(await store.api('/trips',{method:'POST',body:JSON.stringify({title:'Europe',stops:[paris,rome]})})).trip;
  const other=await create(store),[a,b]=[await upload(store,trip),await upload(store,trip)],foreign=await upload(store,other);
  const moved=await store.api(`/trips/${trip.id}/photos`,{method:'PUT',body:JSON.stringify({ids:[a.id,b.id],stopId:rome.id})});
  assert.deepEqual(plain(moved.photos.map(p=>p.city.name)),['Rome','Rome']);
  // A photo from another trip makes the whole change fail, with nothing half-applied.
  await assert.rejects(store.api(`/trips/${trip.id}/photos`,{method:'PUT',body:JSON.stringify({ids:[a.id,foreign.id],stopId:paris.id})}),e=>e.status===409);
  await assert.rejects(store.api(`/trips/${trip.id}/photos`,{method:'PUT',body:JSON.stringify({ids:[a.id],stopId:'city-nowhere-01'})}));
  assert.deepEqual(plain((await store.api(`/trips/${trip.id}`)).photos.map(p=>p.stopId)),[rome.id,rome.id]);
  await assert.rejects(store.api(`/trips/${trip.id}/photos`,{method:'DELETE',body:JSON.stringify({ids:[a.id,foreign.id]})}),e=>e.status===409);
  assert.equal((await store.api(`/trips/${trip.id}`)).photos.length,2);
  assert.deepEqual(plain(await store.api(`/trips/${trip.id}/photos`,{method:'DELETE',body:JSON.stringify({ids:[a.id]})})),{deleted:1});
  assert.equal((await store.api(`/trips/${trip.id}`)).photos.length,1);
  const listed=(await store.api('/trips')).trips.find(t=>t.id===trip.id);assert.equal(listed.stopCount,2);assert.equal(listed.photoCount,1);
  assert.deepEqual(plain(await store.api(`/trips/${trip.id}`,{method:'DELETE'})),{deleted:true,photoCount:1});
  await assert.rejects(store.api(`/trips/${trip.id}`),e=>e.status===404);
  assert.equal((await store.api(`/trips/${other.id}`)).photos.length,1,'Other trips keep their photos');
});

test('small previews and photo sizes are stored, cleaned, and carried through backups',async()=>{
  const {store}=library(),trip=await create(store),form=new FormData();
  form.append('photo',new Blob([jpeg],{type:'image/jpeg'}));form.append('stopId',paris.id);
  form.append('thumb',new Blob([jpeg],{type:'image/jpeg'}));form.append('width','1600');form.append('height','1000');
  const {photo}=await store.api(`/trips/${trip.id}/photos`,{method:'POST',body:form});
  assert.ok(photo.thumbUrl);assert.notEqual(photo.thumbUrl,photo.url);assert.equal(photo.width,1600);assert.equal(photo.height,1000);
  const thumb=Buffer.from(await (await fetch(photo.thumbUrl)).arrayBuffer());assert.equal(thumb.includes(Buffer.from('Exif')),false);
  const plainPhoto=await upload(store,trip);assert.equal(plainPhoto.thumbUrl,null);
  const later=new FormData();later.append('thumb',new Blob([jpeg],{type:'image/jpeg'}));later.append('width','800');later.append('height','1200');
  const updated=(await store.api(`/photos/${plainPhoto.id}/thumb`,{method:'PUT',body:later})).photo;
  assert.ok(updated.thumbUrl);assert.equal(updated.url,plainPhoto.url,'The full photo URL stays valid');assert.equal(updated.height,1200);
  const bad=new FormData();bad.append('thumb',new Blob(['not a jpeg'],{type:'image/jpeg'}));
  await assert.rejects(store.api(`/photos/${plainPhoto.id}/thumb`,{method:'PUT',body:bad}));
  const target=library().store;await target.importArchive(await single(store));
  const restored=await target.api(`/trips/${(await target.api('/trips')).trips[0].id}`);
  assert.deepEqual(plain(restored.photos.map(p=>[p.width,p.height]).sort((a,b)=>b[0]-a[0])),[[1600,1000],[800,1200]]);
});

test('renaming changes only the title and refuses a stale revision',async()=>{
  const {store}=library(),trip=await create(store);
  await assert.rejects(store.api(`/trips/${trip.id}/title`,{method:'PUT',body:JSON.stringify({title:'New',revision:0})}),e=>e.status===409);
  await assert.rejects(store.api(`/trips/${trip.id}/title`,{method:'PUT',body:JSON.stringify({title:' ',revision:1})}));
  const renamed=(await store.api(`/trips/${trip.id}/title`,{method:'PUT',body:JSON.stringify({title:'  Paris in spring ',revision:1})})).trip;
  assert.equal(renamed.title,'Paris in spring');assert.equal(renamed.revision,2);assert.equal(renamed.stops,undefined);
  const saved=(await store.api(`/trips/${trip.id}`)).trip;assert.deepEqual(plain(saved.stops),plain(trip.stops));assert.equal(saved.revision,2);
});

test('backup history records downloads and imported copies without overwriting concurrent trip edits',async()=>{
  const {store,indexedDB}=library(),trip=await create(store),other=await create(store);
  const blob=await single(store,trip.id);
  assert.equal((await store.api(`/trips/${trip.id}`)).trip.backedUpAt,undefined,'Packing alone is not a completed export');
  const second=library(indexedDB).store;
  await second.api(`/trips/${trip.id}`,{method:'PUT',body:JSON.stringify({...trip,title:'Updated elsewhere'})});
  await store.recordBackup(blob);
  const result=(await second.api(`/trips/${trip.id}`)).trip;
  assert.ok(Number.isFinite(Date.parse(result.backedUpAt)));assert.equal(result.backupSource,'export');
  assert.equal(result.title,'Updated elsewhere');assert.equal(result.revision,2);
  assert.equal((await store.api(`/trips/${other.id}`)).trip.backedUpAt,undefined,'A single-trip export never marks other trips');
  await assert.rejects(store.recordBackup(new Blob(['unknown'])),/Unknown backup/);
  const target=library().store;await target.importArchive(blob);
  const imported=(await target.api('/trips')).trips[0];assert.equal(imported.backupSource,'import');assert.ok(imported.backedUpAt);
  const all=await single(store);await store.recordBackup(all);
  assert.ok((await library(indexedDB).store.api('/trips')).trips.every(trip=>trip.backedUpAt),'Export history survives reopening');
});


test('captions save independently of postcards, reject stale edits, and survive backups',async()=>{
  const {store,indexedDB}=library(),trip=await create(store),photo=await upload(store,trip),other=library(indexedDB).store;
  assert.equal(photo.caption,'');assert.equal(photo.captionRevision,1);
  await Promise.all([
    store.api(`/photos/${photo.id}/caption`,{method:'PUT',body:JSON.stringify({caption:'  A morning in Paris.  ',revision:1})}),
    other.api(`/photos/${photo.id}/postcard`,{method:'PUT',body:JSON.stringify({postcard:card,revision:1})})
  ]);
  const saved=(await other.api(`/trips/${trip.id}`)).photos[0];
  assert.equal(saved.caption,'A morning in Paris.');assert.deepEqual(plain(saved.postcard),card);
  assert.equal(saved.captionRevision,2);assert.equal(saved.postcardRevision,2);
  await assert.rejects(other.api(`/photos/${photo.id}/caption`,{method:'PUT',body:JSON.stringify({caption:'Stale',revision:1})}),e=>e.status===409);
  for(const caption of ['x'.repeat(181),123])await assert.rejects(store.api(`/photos/${photo.id}/caption`,{method:'PUT',body:JSON.stringify({caption,revision:2})}));
  const target=library().store;await target.importArchive(await single(store,trip.id));
  const restored=(await target.api(`/trips/${(await target.api('/trips')).trips[0].id}`)).photos[0];
  assert.equal(restored.caption,saved.caption);assert.deepEqual(plain(restored.postcard),card);
  await store.api(`/photos/${photo.id}/caption`,{method:'PUT',body:JSON.stringify({caption:'',revision:2})});
  const cleared=(await store.api(`/trips/${trip.id}`)).photos[0];assert.equal(cleared.caption,'');assert.deepEqual(plain(cleared.postcard),card);
});

test('caption and postcard edits never reserialize image Blobs, and deleting photos cleans up their notes',async()=>{
  const {store,indexedDB}=library(),trip=await create(store),photo=await upload(store,trip),second=await upload(store,trip);
  const bytes=await (await fetch(photo.url)).arrayBuffer(),original=IDBObjectStore.prototype.put,written=[];
  IDBObjectStore.prototype.put=function(value,...args){
    if(Object.values(value).some(value=>value instanceof Blob))throw new DOMException('Error preparing Blob/File data to be stored in object store','DataCloneError');
    written.push(this.name);return original.call(this,value,...args);
  };
  try{
    await store.api(`/photos/${photo.id}/caption`,{method:'PUT',body:JSON.stringify({caption:'By the river',revision:1})});
    await store.api(`/photos/${photo.id}/postcard`,{method:'PUT',body:JSON.stringify({postcard:card,revision:1})});
    await store.api(`/photos/${second.id}/caption`,{method:'PUT',body:JSON.stringify({caption:'Later that day',revision:1})});
  }finally{IDBObjectStore.prototype.put=original;}
  assert.deepEqual(written.filter(name=>name!=='trips'),['photoNotes','photoNotes','photoNotes']);
  const reopened=(await library(indexedDB).store.api(`/trips/${trip.id}`)).photos.find(p=>p.id===photo.id);
  assert.equal(reopened.caption,'By the river');assert.deepEqual(plain(reopened.postcard),card);
  assert.deepEqual(await (await fetch(reopened.url)).arrayBuffer(),bytes);
  const db=await new Promise((resolve,reject)=>{const operation=indexedDB.open('redline-library-v1',2);operation.onsuccess=()=>resolve(operation.result);operation.onerror=()=>reject(operation.error);});
  const notes=()=>new Promise((resolve,reject)=>{const operation=db.transaction('photoNotes').objectStore('photoNotes').getAll();operation.onsuccess=()=>resolve(operation.result);operation.onerror=()=>reject(operation.error);});
  assert.equal((await notes()).length,2);
  await store.api(`/trips/${trip.id}/photos`,{method:'DELETE',body:JSON.stringify({ids:[photo.id]})});
  assert.deepEqual((await notes()).map(note=>note.id),[second.id]);
  await store.api(`/trips/${trip.id}`,{method:'DELETE'});assert.equal((await notes()).length,0);db.close();
});

test('upgrading an existing library keeps original photos and text, then exports updated notes',async()=>{
  const indexedDB=new IDBFactory(),createdAt='2026-09-15T10:00:00.000Z';
  const trip={id:'legacy-trip-01',title:'An older trip',stops:[paris],revision:3,createdAt,updatedAt:createdAt};
  const photo={id:'legacy-photo-01',tripId:trip.id,stopId:paris.id,city:paris,createdAt,blob:new Blob([jpeg],{type:'image/jpeg'}),caption:'An older caption',captionRevision:4,postcard:card,postcardRevision:7};
  await new Promise((resolve,reject)=>{
    const operation=indexedDB.open('redline-library-v1',1);
    operation.onupgradeneeded=()=>{const db=operation.result;db.createObjectStore('trips',{keyPath:'id'}).add(trip);const photos=db.createObjectStore('photos',{keyPath:'id'});photos.createIndex('tripId','tripId');photos.add(photo);};
    operation.onsuccess=()=>{operation.result.close();resolve();};operation.onerror=()=>reject(operation.error);
  });
  const {store}=library(indexedDB),before=await store.api(`/trips/${trip.id}`);
  assert.equal(before.trip.revision,3);assert.equal(before.photos[0].caption,'An older caption');assert.deepEqual(plain(before.photos[0].postcard),card);
  assert.equal(before.photos[0].captionRevision,4);assert.equal(before.photos[0].postcardRevision,7);
  assert.deepEqual(Buffer.from(await (await fetch(before.photos[0].url)).arrayBuffer()),jpeg);
  await store.api(`/photos/${photo.id}/caption`,{method:'PUT',body:JSON.stringify({caption:'A new caption',revision:4})});
  const after=(await store.api(`/trips/${trip.id}`)).photos[0];assert.equal(after.captionRevision,5);assert.deepEqual(plain(after.postcard),card);
  const updated={...card,message:'Updated without rewriting the photo'};
  await store.api(`/photos/${photo.id}/postcard`,{method:'PUT',body:JSON.stringify({postcard:updated,revision:7})});
  const target=library().store;await target.importArchive(await single(store,trip.id));
  const restored=(await target.api(`/trips/${(await target.api('/trips')).trips[0].id}`)).photos[0];
  assert.equal(restored.caption,'A new caption');assert.deepEqual(plain(restored.postcard),updated);
});


test('trip listing and a single-trip backup never read unrelated photo collections',async t=>{
  const {store}=library(),first=await create(store),second=await create(store);
  for(let i=0;i<6;i++)await upload(store,first);
  for(let i=0;i<3;i++)await upload(store,second);
  const getAll=IDBObjectStore.prototype.getAll,get=IDBIndex.prototype.get;
  let covers=0;
  IDBObjectStore.prototype.getAll=function(...args){assert.notEqual(this.name,'photos','No library-wide Blob read');return getAll.apply(this,args);};
  IDBIndex.prototype.get=function(...args){if(this.name==='tripId')covers++;return get.apply(this,args);};
  t.after(()=>{IDBObjectStore.prototype.getAll=getAll;IDBIndex.prototype.get=get;});
  const {trips}=await store.api('/trips');assert.equal(covers,2,'Only one cover photo is read per trip');
  assert.equal(trips.find(trip=>trip.id===first.id).photoCount,6);assert.equal(trips.find(trip=>trip.id===second.id).photoCount,3);
  const target=library();await target.store.importArchive(await single(store,first.id));
  const restored=(await target.store.api('/trips')).trips;assert.equal(restored.length,1);assert.equal(restored[0].photoCount,6);
});

const webkitBlobFailure=()=>{
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,...args){
    if(this.name==='photos'||(this.name==='photoNotes'&&value.id&&!value.id.endsWith('.thumb')&&Object.values(value).some(field=>field instanceof Blob)))throw new DOMException('Error preparing Blob/File data to be stored in object store','DataCloneError');
    return original.call(this,value,...args);
  };
  return ()=>{IDBObjectStore.prototype.put=original;};
};

test('moving photos and backfilling previews never reserialize a stored image Blob',async t=>{
  const rome={id:'city-rome-0001',name:'Rome',country:'Italy',latitude:41.9,longitude:12.5};
  const {store,indexedDB}=library(),trip=(await store.api('/trips',{method:'POST',body:JSON.stringify({title:'Europe',stops:[paris,rome]})})).trip;
  const photo=await upload(store,trip),other=await upload(store,trip),bytes=await (await fetch(photo.url)).arrayBuffer();
  const restore=webkitBlobFailure();t.after(restore);
  const moved=(await store.api(`/trips/${trip.id}/photos`,{method:'PUT',body:JSON.stringify({ids:[photo.id],stopId:rome.id})})).photos[0];
  assert.equal(moved.stopId,rome.id);assert.equal(moved.city.name,'Rome');
  const form=new FormData();form.append('thumb',new Blob([jpeg],{type:'image/jpeg'}));form.append('width','800');form.append('height','1200');
  const filled=(await store.api(`/photos/${photo.id}/thumb`,{method:'PUT',body:form})).photo;
  assert.ok(filled.thumbUrl);assert.equal(filled.id,photo.id);assert.equal(filled.height,1200);assert.equal(filled.url,photo.url);
  const form2=new FormData();form2.append('thumb',new Blob([jpeg],{type:'image/jpeg'}));await store.api(`/photos/${other.id}/thumb`,{method:'PUT',body:form2});
  await store.api(`/photos/${photo.id}/caption`,{method:'PUT',body:JSON.stringify({caption:'Still editable',revision:1})});
  await store.api(`/photos/${photo.id}/postcard`,{method:'PUT',body:JSON.stringify({postcard:card,revision:1})});
  const fresh=library(indexedDB).store,reread=(await fresh.api(`/trips/${trip.id}`)).photos.find(p=>p.id===photo.id);
  assert.equal(reread.stopId,rome.id);assert.equal(reread.city.name,'Rome');assert.ok(reread.thumbUrl,'The preview survives reopening');assert.equal(reread.width,800);assert.equal(reread.caption,'Still editable');
  assert.deepEqual(await (await fetch(reread.url)).arrayBuffer(),bytes,'The full photo is untouched');
  const thumbBytes=Buffer.from(await (await fetch(reread.thumbUrl)).arrayBuffer());assert.ok(thumbBytes.length&&!thumbBytes.includes(Buffer.from('Exif')));
  const listed=(await fresh.api('/trips')).trips[0],previews=(await fresh.api(`/trips/${trip.id}`)).photos.map(p=>p.thumbUrl);
  assert.ok(previews.includes(listed.coverUrl),'The logbook cover uses the small preview, not the full photo');
  const records=await library().archive.unpack(await single(fresh,trip.id));
  const exported=records[0].photos.find(entry=>entry.photo.stopId===rome.id);assert.equal(exported.photo.caption,'Still editable');assert.equal(exported.photo.width,800);assert.equal(records[0].photos.length,2);
  restore();
  const db=await new Promise((resolve,reject)=>{const operation=indexedDB.open('redline-library-v1',2);operation.onsuccess=()=>resolve(operation.result);operation.onerror=()=>reject(operation.error);});
  t.after(()=>db.close());
  const notes=()=>new Promise((resolve,reject)=>{const operation=db.transaction('photoNotes').objectStore('photoNotes').getAll();operation.onsuccess=()=>resolve(operation.result);operation.onerror=()=>reject(operation.error);});
  assert.equal((await notes()).length,4,'Each photo’s notes and preview sit beside it');
  await store.api(`/trips/${trip.id}/photos`,{method:'DELETE',body:JSON.stringify({ids:[photo.id]})});
  assert.equal((await notes()).length,2,'Deleting a photo removes its notes and its preview');
  await store.api(`/trips/${trip.id}`,{method:'DELETE'});assert.equal((await notes()).length,0,'Deleting a trip removes them too');
});

test('a closed database connection is replaced, so the next save works without a reload',async()=>{
  const real=new IDBFactory(),connections=[];
  const counted={open:(...args)=>{const operation=real.open(...args);operation.addEventListener('success',()=>connections.push(operation.result));return operation;}};
  const {store}=library(counted),trip=await create(store);assert.equal(connections.length,1);
  connections[0].close();
  assert.equal((await store.api(`/trips/${trip.id}`)).trip.title,'Europe');assert.equal(connections.length,2);
  connections[1].onclose();
  assert.equal((await store.api('/trips')).trips.length,1);assert.equal(connections.length,3,'A close signalled by the browser drops the cached connection at once');
});

test('persistent storage is requested once a session, on real saves, and never when already granted',async()=>{
  for(const route of ['photo save','route save']){
    let asked=0,granted=false;const indexedDB=new IDBFactory();
    const navigator={storage:{persisted:async()=>granted,persist:async()=>{asked++;return false;}}};
    await create(library(indexedDB,{navigator:{}}).store);
    const open=library(indexedDB,{navigator}).store;assert.equal(asked,0,'Opening the library asks nothing');
    const [trip]=(await open.api('/trips')).trips;
    if(route==='photo save')await upload(open,trip);else await open.api(`/trips/${trip.id}`,{method:'PUT',body:JSON.stringify({title:trip.title,stops:[paris],revision:1})});
    await new Promise(resolve=>setTimeout(resolve,0));assert.equal(asked,1,`A ${route} asks after an earlier session did not`);
    await upload(open,trip);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(asked,1,'Only once a session');
    granted=true;const later=library(indexedDB,{navigator}).store;await upload(later,trip);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(asked,1,'A granted library is not asked again');
  }
});

test('a library over one file splits into parts that import completely, and counts as backed up only after the last',async()=>{
  const {store,archive}=library(),trip=await create(store),other=await create(store);
  for(let i=0;i<3;i++)await upload(store,trip);await upload(store,other);
  const split=archive.split,{size}=await (await fetch((await store.api(`/trips/${other.id}`)).photos[0].url)).blob();
  archive.split=records=>split(records,{bytes:size*2.5});
  const parts=await store.exportParts();
  assert.ok(parts.length>1);
  await assert.rejects(store.recordBackup(parts[0]),/Unknown backup/,'Earlier parts are not the whole backup');
  assert.equal((await store.api(`/trips/${trip.id}`)).trip.backedUpAt,undefined);
  await store.recordBackup(parts.at(-1));
  assert.ok((await store.api('/trips')).trips.every(saved=>saved.backedUpAt),'The last part records every trip');
  const target=library().store;let photos=0;for(const part of parts)photos+=(await target.importArchive(part)).photoCount;
  assert.equal(photos,4,'Every photo is restored');
  const titles=(await target.api('/trips')).trips.map(saved=>saved.title);
  assert.ok(titles.includes('Europe')&&titles.includes('Europe (part 2)'),'A continued trip names its part');
  for(const saved of (await target.api('/trips')).trips)assert.deepEqual((await target.api(`/trips/${saved.id}`)).trip.stops.map(stop=>stop.id),[paris.id],'Each part repeats the route');
});

test('splitting respects both caps at their real sizes, keeps order, and keeps trips whole where it can',()=>{
  const {archive}=library(),MB=1024*1024,GB=1024*MB;
  const photos=(count,size,postcard={})=>Array.from({length:count},(_,i)=>({photo:{id:`photo-${String(i).padStart(8,'0')}`,postcard,createdAt:'2026-11-05T00:00:00.000Z',stopId:paris.id,city:paris},blob:{size}}));
  const trip=(title,list)=>({trip:{id:`trip-${title}-0000`,title,stops:[paris],createdAt:'2026-11-05T00:00:00.000Z'},photos:list});
  const manifestBytes=part=>new TextEncoder().encode(JSON.stringify({version:1,trips:part.map(record=>({trip:{id:record.trip.id,title:record.trip.title,stops:record.trip.stops,createdAt:record.trip.createdAt},photos:record.photos.map(({photo,blob})=>({stopId:photo.stopId,city:photo.city,postcard:photo.postcard||{},caption:'',createdAt:photo.createdAt,orderKey:photo.id,bytes:blob.size}))}))})).length;
  const blobs=part=>part.flatMap(record=>record.photos).reduce((sum,item)=>sum+item.blob.size,0);
  const huge=photos(513,4*MB),large=archive.split([trip('Long',huge)]);
  assert.equal(large.length,2);assert.equal(large[1][0].trip.title,'Long (part 2)');
  assert.deepEqual(plain(large.flatMap(part=>part.flatMap(record=>record.photos)).map(item=>item.photo.id)),huge.map(item=>item.photo.id),'Every photo, once, in order');
  for(const part of large)assert.ok(blobs(part)+manifestBytes(part)+13<=2*GB);
  const wordy=photos(1600,10*1024,{message:'東'.repeat(1200),recipient:'東'.repeat(120),address:'東'.repeat(400),sender:'東'.repeat(120)}),notes=archive.split([trip('Letters',wordy)]);
  assert.ok(notes.length>1,'Text alone can force another part');
  for(const part of notes)assert.ok(manifestBytes(part)<=8*MB);
  assert.equal(notes.flatMap(part=>part.flatMap(record=>record.photos)).length,1600);
  const whole=archive.split([trip('One',photos(300,4*MB)),trip('Two',photos(300,4*MB)),trip('Three',photos(100,4*MB))]);
  assert.deepEqual(plain(whole.map(part=>part.map(record=>[record.trip.title,record.photos.length]))),[[['One',300]],[['Two',300],['Three',100]]],'A trip that fits a fresh file is not cut');
  assert.deepEqual(plain(archive.split([trip('Tiny',[])]).map(part=>part.length)),[1]);
  assert.equal(archive.split([trip('A'.repeat(80),huge)])[1][0].trip.title.length,77,'A continued title stays within the 80-character limit');
});

test('a photo or note edit marks a trip as changed since its backup; a backfilled preview does not',async()=>{
  const {store}=library(),trip=await create(store),photo=await upload(store,trip);
  const changedAt=async()=>{await new Promise(resolve=>setTimeout(resolve,2));return (await store.api(`/trips/${trip.id}`)).trip.changedAt;};
  const first=await changedAt();assert.ok(first,'Saving a photo marks the trip');
  await store.api(`/photos/${photo.id}/caption`,{method:'PUT',body:JSON.stringify({caption:'Later',revision:1})});const second=await changedAt();assert.ok(second>first);
  await store.api(`/photos/${photo.id}/postcard`,{method:'PUT',body:JSON.stringify({postcard:card,revision:1})});const third=await changedAt();assert.ok(third>second);
  const form=new FormData();form.append('thumb',new Blob([jpeg],{type:'image/jpeg'}));await store.api(`/photos/${photo.id}/thumb`,{method:'PUT',body:form});
  assert.equal(await changedAt(),third,'A preview is rebuilt, not part of what a backup must hold');
  await store.api(`/trips/${trip.id}/photos`,{method:'PUT',body:JSON.stringify({ids:[photo.id],stopId:paris.id})});const fourth=await changedAt();assert.ok(fourth>third);
  await store.api(`/trips/${trip.id}/photos`,{method:'DELETE',body:JSON.stringify({ids:[photo.id]})});assert.ok(await changedAt()>fourth);
  assert.equal((await store.api(`/trips/${trip.id}`)).trip.revision,1,'None of this is a route revision');
});

test('the JPEG sanitizer keeps an allowlist of decoder segments, so hidden segments do not survive',async()=>{
  const {store}=library(),trip=await create(store);
  const segment=(marker,text)=>{const body=Buffer.from(text);return Buffer.concat([Buffer.from([255,marker,(body.length+2)>>8,(body.length+2)&255]),body]);};
  const hide=marker=>Buffer.concat([jpeg.subarray(0,2),segment(marker,'HIDDEN SECRET'),jpeg.subarray(2)]);
  const clean=async bytes=>Buffer.from(await (await fetch((await upload(store,trip,bytes)).url)).arrayBuffer());
  const baseline=await clean(jpeg);
  for(const marker of [0xF5,0xDE,0xC8,0xE1,0xFE,0x02]){
    const out=await clean(hide(marker));
    assert.equal(out.includes(Buffer.from('HIDDEN SECRET')),false,`Segment ${marker.toString(16)} is dropped`);assert.deepEqual(out,baseline);
  }
  assert.ok(baseline.includes(Buffer.from([255,0xDB])),'Quantization tables stay');assert.ok(baseline.includes(Buffer.from([255,0xDA])),'The scan stays');
  assert.ok([0xC0,0xC1,0xC2].some(marker=>baseline.includes(Buffer.from([255,marker]))),'The frame header stays');
});
