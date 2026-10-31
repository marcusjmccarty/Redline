import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {IDBFactory, IDBObjectStore} from 'fake-indexeddb';

const jpeg=readFileSync(new URL('./fixtures/gps.jpg',import.meta.url));
const paris={id:'city-paris-01',name:'Paris',country:'France',latitude:48.8566,longitude:2.3522};
const card={message:'Bonjour!\nA good day.',recipient:'A friend',address:'A street',sender:'Marcus'};
function library(indexedDB=new IDBFactory()) {
  const window={indexedDB},context={window,indexedDB,Blob,URL,crypto,TextEncoder,TextDecoder,Uint8Array,DataView,FormData,navigator:{storage:{persist:async()=>true}}};
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
  const backup=await source.exportArchive(),target=library().store,existing=await create(target);
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
  assert.ok(!trips.includes('/api'));assert.ok(!trips.includes('signin-with-chatgpt'));assert.ok(trips.includes("fetch('photo-cities.json')"));
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
  const target=library().store;await target.importArchive(await store.exportArchive());
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
  const blob=await store.exportArchive(trip.id);
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
  const all=await store.exportArchive();await store.recordBackup(all);
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
  const target=library().store;await target.importArchive(await store.exportArchive(trip.id));
  const restored=(await target.api(`/trips/${(await target.api('/trips')).trips[0].id}`)).photos[0];
  assert.equal(restored.caption,saved.caption);assert.deepEqual(plain(restored.postcard),card);
  await store.api(`/photos/${photo.id}/caption`,{method:'PUT',body:JSON.stringify({caption:'',revision:2})});
  const cleared=(await store.api(`/trips/${trip.id}`)).photos[0];assert.equal(cleared.caption,'');assert.deepEqual(plain(cleared.postcard),card);
});
