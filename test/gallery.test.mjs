import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

const source=name=>readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
const jpeg=readFileSync(new URL('fixtures/gps.jpg',import.meta.url));
const paris={id:'city-paris-01',name:'Paris',country:'France',latitude:48.8566,longitude:2.3522};
const madrid={id:'city-madrid-01',name:'Madrid',country:'Spain',latitude:40.4168,longitude:-3.7038};
const wait=async condition=>{
  for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.ok(condition(),'The interaction should finish');
};
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));

async function setup(t,{seed=true}={}){
  const dom=new JSDOM(source('map.html'),{url:'https://redline.test/Redline/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,$=id=>w.document.getElementById(id),objects=new Set();let stops=[paris,madrid];
  Object.assign(w,{Blob,File,FormData,TextEncoder,TextDecoder,indexedDB:new IDBFactory()});
  w.URL.createObjectURL=blob=>{const url=URL.createObjectURL(blob);objects.add(url);return url;};
  w.URL.revokeObjectURL=url=>{objects.delete(url);URL.revokeObjectURL(url);};
  t.after(()=>{dom.window.close();for(const url of objects)URL.revokeObjectURL(url);});
  w.confirm=()=>true;
  w.fetch=async()=>{throw Error('The gallery must not send personal data to a server.');};
  const mapCalls={focused:null};
  w.RedlineApp={getStops:()=>stops,setStops:value=>stops=value,showControls(){},closeSearch(){},cityDistance:(a,b)=>a.latitude===b.latitude?0:500,
    focusStop:id=>mapCalls.focused=id,addCity:place=>stops.find(s=>s.latitude===place.latitude)};
  // Image decoding and native dialogs are browser services. Storage and UI handlers run unchanged.
  w.createImageBitmap=async file=>{if(file.name==='broken.jpg')throw Error('Cannot decode');return {width:1600,height:1000,close(){}};};
  w.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){},drawImage(){}});
  w.HTMLCanvasElement.prototype.toBlob=callback=>callback(new Blob([jpeg],{type:'image/jpeg'}));
  w.exifr={gps:async file=>file.name.startsWith('gps')?paris:null};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.HTMLImageElement.prototype.decode=async()=>{};
  Object.defineProperties(w.HTMLImageElement.prototype,{naturalWidth:{get:()=>1600},naturalHeight:{get:()=>1000}});
  w.RedlinePostcardExport={render:()=>({toBlob:callback=>callback(new Blob([jpeg],{type:'image/jpeg'}))})};
  for(const name of ['jpeg','archive','storage'])w.eval(source(`public/${name}.js`));
  const storage=w.RedlineStorage,api=storage.api;
  const {trip}=await api('/trips',{method:'POST',body:JSON.stringify({title:'A summer away',stops})});
  if(seed)for(const stop of [madrid,paris,paris]){
    const form=new FormData();form.append('photo',new Blob([jpeg],{type:'image/jpeg'}));form.append('stopId',stop.id);
    await api(`/trips/${trip.id}/photos`,{method:'POST',body:form});
  }
  w.localStorage.setItem('redline-saved-trip',JSON.stringify({id:trip.id,title:trip.title,revision:trip.revision,hash:JSON.stringify(stops)}));
  w.eval(source('public/postcards.js'));w.eval(source('public/trips.js'));
  await wait(()=>$('trip-title').textContent===trip.title&&(!seed||$('photo-count').textContent==='3'));
  $('photos-button').click();await wait(()=>$('photo-panel').open);await tick();
  const change=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event('change',{bubbles:true}));};
  const choose=names=>{
    const files=names.map(name=>new File([jpeg],name,{type:/\.txt$/.test(name)?'text/plain':'image/jpeg'}));
    Object.defineProperty($('photo-files'),'files',{configurable:true,value:files});
    $('photo-files').dispatchEvent(new w.Event('change',{bubbles:true}));
    return files;
  };
  const press=(key,target=w.document,extra={})=>target.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  const click=id=>$(id).dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1}));
  // "All photos" lists every photo; the album shows only the open spread.
  const tiles=()=>{if($('sheet-view').getAttribute('aria-pressed')!=='true')$('sheet-view').click();return [...$('photo-gallery').querySelectorAll('.photo-image')];};
  const prints=()=>[...$('album-pages').querySelectorAll('.photo-image')];
  const pages=()=>[...$('album-pages').children].map(page=>page.className.replace(/album-page |page-/g,''));
  const tab=id=>[...$('gallery-filter').children].find(el=>el.dataset.filter===id);
  return {w,$,api,storage,trip,change,choose,press,click,objects,tiles,prints,pages,tab,mapCalls};
}

test('the album opens on its title spread, turns like a book, and city tabs jump to their pages',async t=>{
  const {w,$,press,prints,pages,tab,mapCalls}=await setup(t);
  assert.deepEqual(pages(),['left inside','right title']);
  assert.equal($('photo-panel').querySelector('.album-name').textContent,'A summer away');
  assert.equal($('photo-panel').querySelector('.title-route').textContent,'Paris → Madrid');
  assert.equal($('album-position').textContent,'Title page');assert.equal($('album-previous').disabled,true);
  assert.deepEqual([...$('gallery-filter').children].map(el=>el.textContent),['01Paris2','02Madrid1']);
  $('album-next').click();
  assert.deepEqual(pages(),['left city','right city']);
  assert.deepEqual([...$('album-pages').querySelectorAll('.city-name')].map(el=>el.textContent),['Paris','Madrid']);
  assert.deepEqual([...$('album-pages').querySelectorAll('.page-stop')].map(el=>el.textContent),['Stop 01','Stop 02']);
  assert.equal(prints().length,3);assert.equal($('album-next').disabled,true);
  assert.match($('album-position').textContent,/pages 1–2 of 2/);
  press('ArrowLeft');assert.deepEqual(pages(),['left inside','right title'],'The keyboard turns pages');
  tab(madrid.id).click();assert.equal(tab(madrid.id).getAttribute('aria-current'),'true');assert.equal(prints().length,3);
  const opener=prints()[0];opener.focus();opener.click();
  assert.equal($('photo-viewer').open,true);assert.equal($('photo-position').textContent,'1 / 2','The viewer browses the city it was opened from');
  press('ArrowRight');await wait(()=>$('photo-position').textContent==='2 / 2');
  assert.equal($('photo-caption').textContent,'Paris');assert.equal($('next-photo').disabled,true);
  press('ArrowRight');await tick();assert.equal($('photo-position').textContent,'2 / 2');
  press('ArrowRight');assert.equal(prints().length,3,'Arrow keys in the viewer never turn the album');
  await w.RedlinePostcards.close();assert.equal(w.document.activeElement,opener);
  press('Escape');assert.equal($('photo-panel').open,false);assert.equal(w.document.activeElement,$('photos-button'));
  $('photos-button').click();await wait(()=>$('photo-panel').open);
  assert.deepEqual(pages(),['left city','right city'],'The album reopens where it was left');
  $('album-pages').querySelector('.gallery-map-button').click();
  assert.equal(mapCalls.focused,paris.id);assert.equal($('photo-panel').open,false,'Finding a city on the map closes the album');
});

test('navigation saves postcard edits before moving; failed saves keep the photo and draft open',async t=>{
  const {w,$,storage,api,trip,press,click,tiles}=await setup(t);
  tiles()[0].click();click('full-photo');
  assert.equal($('photo-viewer').classList.contains('flipped'),true);
  $('postcard-message').value='A memory worth keeping.';$('postcard-message').dispatchEvent(new w.Event('input',{bubbles:true}));
  press('ArrowRight',$('postcard-message'));await tick();assert.equal($('photo-position').textContent,'1 / 2','Editing keys do not navigate');
  let fail=true;
  storage.api=async(path,options)=>{if(fail&&path.endsWith('/postcard'))throw Error('Storage is full.');return api(path,options);};
  press('ArrowRight');await wait(()=>$('postcard-error').textContent==='Storage is full.');
  assert.equal($('photo-position').textContent,'1 / 2');assert.equal($('postcard-message').value,'A memory worth keeping.');
  fail=false;press('ArrowRight');await wait(()=>$('photo-position').textContent==='2 / 2');
  assert.equal($('photo-viewer').classList.contains('flipped'),false);
  press('ArrowLeft');await wait(()=>$('photo-position').textContent==='1 / 2');
  assert.equal($('postcard-message').value,'A memory worth keeping.');
  const records=await w.RedlineArchive.unpack(await storage.exportArchive(trip.id));
  assert.equal(records[0].photos.filter(p=>p.photo.postcard.message==='A memory worth keeping.').length,1);
  await w.RedlinePostcards.close();$('album-view').click();$('album-next').click();
  assert.equal($('album-pages').querySelector('figcaption').textContent,'A memory worth keeping.','The album captions a print with its postcard');
});

test('import review supports bulk assignment, previews, and saving only assigned photos',async t=>{
  const {w,$,choose,change,api,trip,click,pages}=await setup(t,{seed:false});
  assert.deepEqual(pages(),['left inside','right title']);$('album-next').click();
  assert.equal($('album-pages').querySelector('.photo-empty p').textContent,'No photos yet');assert.equal($('gallery-toolbar').hidden,true);
  choose(['gps-paris.jpg','one.jpg','two.jpg']);
  await wait(()=>$('photo-review').children.length===3&&!$('choose-photos').disabled);
  assert.equal($('album-pages').hidden,true);assert.equal($('photo-gallery').hidden,true);assert.equal($('gallery-toolbar').hidden,true);
  assert.equal($('photo-selection-count').textContent,'3 selected');assert.equal($('photo-ready-count').textContent,'2 need a city');
  const entries=[...$('photo-review').children];entries[0].querySelector('.photo-image').click();
  assert.equal($('photo-position').textContent,'1 / 3');click('full-photo');assert.equal($('photo-viewer').classList.contains('flipped'),false);
  assert.equal($('print-postcard').disabled,true);await w.RedlinePostcards.close();
  const checkbox=entries[2].querySelector('input');checkbox.checked=false;checkbox.dispatchEvent(new w.Event('change'));
  assert.equal($('select-all-photos').indeterminate,true);
  change('bulk-photo-city',madrid.id);
  assert.deepEqual([...$('photo-review').querySelectorAll('select')].map(el=>el.value),[madrid.id,madrid.id,'']);
  assert.equal($('photo-ready-count').textContent,'1 needs a city');assert.equal($('upload-photos').textContent,'Save 2 photos');
  $('upload-photos').click();await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  assert.equal((await api(`/trips/${trip.id}`)).photos.length,2);
  const select=$('photo-review').querySelector('select');select.value=paris.id;select.dispatchEvent(new w.Event('change'));
  $('upload-photos').click();await wait(()=>!$('album-pages').hidden);
  assert.equal($('photo-review').children.length,0);assert.equal($('gallery-count').textContent,'3 photos');
  assert.equal($('photo-message').textContent,'1 photo saved.');
  assert.ok($('album-pages').querySelector('.page-city'),'The album opens where the new photos were mounted');
});

test('a partial photo save preserves remaining imports and retry never duplicates completed saves',async t=>{
  const {w,$,choose,change,api,storage,trip}=await setup(t,{seed:false});
  choose(['one.jpg','two.jpg','three.jpg']);await wait(()=>$('photo-review').children.length===3&&!$('choose-photos').disabled);
  change('bulk-photo-city',paris.id);let writes=0;
  storage.api=async(path,options)=>{if(options?.method==='POST'&&path.endsWith('/photos')&&++writes===2)throw Error('Not enough space.');return api(path,options);};
  $('upload-photos').click();await wait(()=>$('photo-message').textContent==='Not enough space.'&&!$('choose-photos').disabled);
  assert.equal($('photo-review').children.length,2);assert.equal((await api(`/trips/${trip.id}`)).photos.length,1);
  storage.api=api;$('upload-photos').click();await wait(()=>!$('album-pages').hidden);
  assert.equal((await api(`/trips/${trip.id}`)).photos.length,3);assert.equal($('photo-count').textContent,'3');
  const restored=await w.RedlineArchive.unpack(await storage.exportArchive(trip.id));assert.equal(restored[0].photos.length,3);
});

test('file drops, batch limits, and cancelling imports leave saved photos untouched',async t=>{
  const {w,$,choose,api,trip}=await setup(t);
  choose(Array.from({length:31},(_,i)=>`${i}.jpg`));assert.equal($('photo-review').children.length,0);
  assert.match($('photo-message').textContent,/up to 30/);
  const event=new w.Event('drop',{bubbles:true,cancelable:true});
  Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],files:[new File([jpeg],'drop.jpg',{type:'image/jpeg'}),new File(['no'],'notes.txt',{type:'text/plain'})]}});
  $('photo-panel').dispatchEvent(event);
  await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  assert.equal(event.defaultPrevented,true);assert.match($('photo-message').textContent,/1 photo could not be read/);
  w.confirm=()=>false;$('cancel-photo-import').click();assert.equal($('photo-review').children.length,1);
  w.confirm=()=>true;$('cancel-photo-import').click();assert.equal($('photo-review').children.length,0);
  assert.equal($('album-pages').hidden,false);assert.equal((await api(`/trips/${trip.id}`)).photos.length,3);
});

test('swiping browses without flipping, while a tap still flips the entire postcard',async t=>{
  const {w,$,click,tiles}=await setup(t);tiles()[0].click();
  for(const [type,x] of [['pointerdown',200],['pointerup',100]]){
    const event=new w.Event(type,{bubbles:true});Object.assign(event,{pointerType:'touch',pointerId:1,clientX:x,clientY:100});$('full-photo').dispatchEvent(event);
  }
  click('full-photo');await wait(()=>$('photo-position').textContent==='2 / 2');
  assert.equal($('photo-viewer').classList.contains('flipped'),false);
  await new Promise(resolve=>setTimeout(resolve,510));click('full-photo');
  assert.equal($('photo-viewer').classList.contains('flipped'),true);assert.equal($('postcard-front').inert,true);
});

test('print and share use the browsed photo and preserve the postcard viewer',async t=>{
  const {w,$,press,click,tiles}=await setup(t);let shared=null,printed=0;
  Object.defineProperty(w.navigator,'canShare',{value:()=>true});
  Object.defineProperty(w.navigator,'share',{value:async value=>shared=value});
  tiles()[2].click();assert.equal($('photo-caption').textContent,'Madrid');click('full-photo');
  $('postcard-message').value='An afternoon in Madrid.';$('postcard-message').dispatchEvent(new w.Event('input',{bubbles:true}));
  await wait(()=>!$('share-postcard').disabled);$('share-postcard').click();await wait(()=>shared);
  assert.equal(shared.files[0].name,'Madrid-postcard.jpg');assert.equal(shared.url,undefined);
  w.print=()=>{
    printed++;assert.equal($('photo-viewer').open,false);
    assert.equal($('postcard-print-root').querySelector('.print-front img').src,$('full-photo').src);
    assert.equal($('postcard-print-root').querySelector('.print-message').textContent,'An afternoon in Madrid.');
  };
  $('print-postcard').click();await wait(()=>printed===1);w.dispatchEvent(new w.Event('afterprint'));
  assert.equal($('photo-viewer').open,true);assert.equal($('photo-caption').textContent,'Madrid');assert.equal($('photo-viewer').classList.contains('flipped'),true);
  press('p',w.document,{metaKey:true});await wait(()=>printed===2);w.dispatchEvent(new w.Event('afterprint'));
});

test('select mode moves and deletes several photos atomically',async t=>{
  const {w,$,api,trip,tiles,change}=await setup(t);
  $('select-photos').click();
  assert.equal($('sheet-view').getAttribute('aria-pressed'),'true','Selecting works on the full list of photos');
  assert.equal($('gallery-actions').hidden,false);assert.equal($('gallery-toolbar').hidden,true);
  assert.equal($('gallery-selection-count').textContent,'Tap photos to select');assert.equal($('delete-photos').disabled,true);
  tiles()[0].click();tiles()[1].click();
  assert.equal($('photo-viewer').open,false,'Selecting never opens the viewer');
  assert.equal($('gallery-selection-count').textContent,'2 selected');assert.equal(tiles()[0].getAttribute('aria-pressed'),'true');
  change('move-photos',madrid.id);
  await wait(()=>$('photo-message').textContent==='Moved 2 photos to Madrid.');
  assert.deepEqual([...$('photo-gallery').querySelectorAll('.gallery-city-count')].map(el=>el.textContent),['3 photos']);
  assert.equal((await api(`/trips/${trip.id}`)).photos.filter(p=>p.stopId===madrid.id).length,3);
  $('select-photos').click();$('select-visible').click();assert.equal($('gallery-selection-count').textContent,'3 selected');
  w.confirm=()=>false;$('delete-photos').click();await tick();assert.equal(tiles().length,3);
  w.confirm=()=>true;tiles()[2].click();$('delete-photos').click();
  await wait(()=>$('photo-message').textContent==='2 photos deleted.');
  assert.equal(tiles().length,1);assert.equal($('photo-count').textContent,'1');
  assert.equal((await api(`/trips/${trip.id}`)).photos.length,1);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal($('gallery-actions').hidden,true,'Escape leaves select mode first');assert.equal($('photo-panel').open,true);
});

test('the viewer moves a photo to another city and deletes it, then shows the next photo',async t=>{
  const {w,$,api,trip,tiles}=await setup(t);
  tiles()[0].click();
  assert.equal($('photo-city').hidden,false);assert.equal($('photo-city').value,paris.id);
  $('photo-city').value=madrid.id;$('photo-city').dispatchEvent(new w.Event('change',{bubbles:true}));
  await wait(()=>$('photo-caption').textContent==='Madrid');
  assert.equal((await api(`/trips/${trip.id}`)).photos.filter(p=>p.stopId===madrid.id).length,2);
  w.confirm=()=>true;$('delete-photo').click();
  await wait(()=>$('photo-navigation').hidden&&$('photo-caption').textContent==='Paris');
  assert.equal($('photo-viewer').open,true);assert.equal((await api(`/trips/${trip.id}`)).photos.length,2);
  $('delete-photo').click();await wait(()=>!$('photo-viewer').open);
  assert.equal((await api(`/trips/${trip.id}`)).photos.length,1);
  assert.equal(tiles().length,1);
});

test('the trips sheet lists, renames, and deletes trips, and closes when you click outside it',async t=>{
  const {w,$,api,trip}=await setup(t);
  await api('/trips',{method:'POST',body:JSON.stringify({title:'Another time',stops:[madrid]})});
  $('trips-button').click();
  assert.equal($('trip-panel').open,true);assert.equal($('photo-panel').open,false,'Only one sheet at a time');
  assert.equal($('trips-button').getAttribute('aria-expanded'),'true');
  await wait(()=>$('trip-list').querySelectorAll('.trip-card').length===2);
  assert.equal($('trips-summary').textContent,'2 trips saved in this browser');assert.equal($('trip-state').textContent,'All changes saved');
  const card=()=>[...$('trip-list').querySelectorAll('.trip-card')].find(el=>el.classList.contains('active'));
  assert.match(card().querySelector('.trip-meta').textContent,/^2 stops · 3 photos · /);
  assert.ok(card().querySelector('.trip-cover').src,'A saved trip shows its first photo');
  card().querySelector('.trip-more').click();assert.equal(card().querySelector('.trip-menu').hidden,false);
  card().querySelector('.trip-rename').click();assert.equal(card().querySelector('.trip-menu').hidden,true);
  const input=$('trip-list').querySelector('.trip-rename-form input');input.value='Summer in Spain';
  $('trip-list').querySelector('.trip-rename-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>$('trip-title').textContent==='Summer in Spain');
  assert.equal((await api(`/trips/${trip.id}`)).trip.title,'Summer in Spain');
  const other=()=>[...$('trip-list').querySelectorAll('.trip-card')].find(el=>!el.classList.contains('active'));
  await wait(()=>other()?.querySelector('.trip-more'));other().querySelector('.trip-more').click();other().querySelector('.trip-rename').click();
  $('trip-list').querySelector('.trip-rename-form input').value='Another place';
  $('trip-list').querySelector('.trip-rename-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>other()?.querySelector('.trip-name')?.textContent==='Another place');
  assert.equal($('trip-title').textContent,'Summer in Spain','Renaming another trip leaves the open one alone');
  const pointer=(type,target)=>target.dispatchEvent(new w.MouseEvent(type,{bubbles:true,clientX:5,clientY:5}));
  pointer('pointerdown',$('trip-name'));pointer('click',$('trip-panel'));
  assert.equal($('trip-panel').open,true,'A drag that ends outside the sheet keeps it open');
  pointer('pointerdown',$('trip-panel'));pointer('click',$('trip-panel'));
  assert.equal($('trip-panel').open,false,'Clicking outside the sheet closes it');
  $('trips-button').click();await wait(()=>$('trip-list').querySelectorAll('.trip-delete').length===2);
  w.confirm=()=>true;card().querySelector('.trip-more').click();card().querySelector('.trip-delete').click();
  await wait(()=>$('trip-list').querySelectorAll('.trip-card').length===1);
  assert.equal($('trip-title').textContent,'');assert.equal($('photo-count').textContent,'');
  assert.equal((await api('/trips')).trips.length,1);
  await assert.rejects(api(`/trips/${trip.id}`),e=>e.status===404);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal($('trip-panel').open,false);assert.equal(w.document.activeElement,$('trips-button'));
  $('photos-button').click();await wait(()=>$('trip-panel').open);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal($('trip-message').textContent,'Name and save this trip to add photos.','The prompt is not replaced by the list');
  assert.equal($('trip-list').querySelectorAll('.trip-card').length,1);
});

test('renaming the open trip keeps the stale-tab check, and focus stays in the sheet',async t=>{
  const {w,$,api,trip}=await setup(t);
  // Another tab saves a newer route while this tab still shows revision 1.
  await api(`/trips/${trip.id}`,{method:'PUT',body:JSON.stringify({title:trip.title,stops:[paris],revision:1})});
  $('trips-button').click();await wait(()=>$('trip-list').querySelector('.trip-rename'));
  $('trip-list').querySelector('.trip-rename').click();
  const input=$('trip-list').querySelector('.trip-rename-form input');input.value='Renamed';
  $('trip-list').querySelector('.trip-rename-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>/another tab/.test($('trip-message').textContent));
  assert.equal((await api(`/trips/${trip.id}`)).trip.title,'A summer away');
  assert.equal(JSON.parse(w.localStorage.getItem('redline-saved-trip')).revision,1,'The stale revision is kept, so the next save also refuses to overwrite');
  await wait(()=>w.document.activeElement?.classList.contains('trip-open'));
  $('trip-list').querySelector('.trip-rename').click();
  $('trip-list').querySelector('.trip-rename-form input').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await wait(()=>w.document.activeElement?.classList.contains('trip-more'));
  assert.equal($('trip-panel').open,true,'Escape in the rename field only cancels the rename');
});

test('a viewer delete blocks browsing until it finishes, and focus returns to the album',async t=>{
  const {w,$,storage,api,tiles,press}=await setup(t);
  let release;const gate=new Promise(resolve=>release=resolve);
  storage.api=async(path,options)=>{if(options?.method==='DELETE')await gate;return api(path,options);};
  tiles()[1].click();assert.equal($('photo-position').textContent,'2 / 2');
  w.confirm=()=>true;$('delete-photo').click();await tick();
  press('ArrowLeft');await tick();assert.equal($('previous-photo').disabled,true);
  release();await wait(()=>$('photo-position').textContent==='1 / 1');
  assert.equal($('photo-caption').textContent,'Paris');
  await w.RedlinePostcards.close();
  assert.ok(w.document.activeElement===$('photo-panel')||w.document.activeElement?.classList.contains('photo-image'),'Focus is not lost to the page');
});

test('select mode follows route edits, and dragging files never saves route edits',async t=>{
  const {w,$,api,trip}=await setup(t);
  $('select-photos').click();$('select-visible').click();w.confirm=()=>true;$('delete-photos').click();
  await wait(()=>$('photo-message').textContent==='3 photos deleted.');
  assert.equal($('gallery-actions').hidden,true,'Selection ends when no photos are left');
  $('album-view').click();$('album-next').click();
  assert.equal($('album-pages').querySelector('.photo-empty p').textContent,'No photos yet');
  $('select-photos').click();
  const rome={id:'city-rome-0001',name:'Rome',country:'Italy',latitude:41.9,longitude:12.5};
  w.RedlineApp.setStops([paris,madrid,rome]);w.dispatchEvent(new w.Event('redline:routechange'));
  assert.ok([...$('move-photos').options].some(option=>option.value===rome.id),'A city added during selection can be chosen');
  $('photo-panel').querySelector('[data-close]').click();assert.equal($('photo-panel').open,false);
  const drag=new w.Event('dragenter',{bubbles:true,cancelable:true});Object.defineProperty(drag,'dataTransfer',{value:{types:['Files'],files:[]}});
  w.document.body.dispatchEvent(drag);await wait(()=>$('photo-panel').open);await tick();
  assert.equal((await api(`/trips/${trip.id}`)).trip.stops.length,2,'Opening the album for a drag leaves the saved route alone');
  assert.equal($('save-trip').classList.contains('dirty'),true);
});

test('the trip search never hides trips once it is no longer needed',async t=>{
  const {w,$,api}=await setup(t);
  for(let i=1;i<=6;i++)await api('/trips',{method:'POST',body:JSON.stringify({title:`Extra ${i}`,stops:[madrid]})});
  $('trips-button').click();await wait(()=>$('trip-list').querySelectorAll('.trip-card').length===7);
  assert.equal($('trip-search-label').hidden,false);
  $('trip-search').value='Extra 1';$('trip-search').dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.equal($('trip-list').querySelectorAll('.trip-card').length,1);
  const card=$('trip-list').querySelector('.trip-card');card.querySelector('.trip-more').click();
  w.confirm=()=>true;card.querySelector('.trip-delete').click();
  await wait(()=>$('trip-search-label').hidden);
  assert.equal($('trip-search').value,'');assert.equal($('trip-list').querySelectorAll('.trip-card').length,6);
});
