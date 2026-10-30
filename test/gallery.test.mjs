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
  w.RedlineApp={getStops:()=>stops,setStops:value=>stops=value,showControls(){},cityDistance:(a,b)=>a.latitude===b.latitude?0:500};
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
  $('photos-button').click();await wait(()=>!$('photo-panel').hidden);await tick();
  const change=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event('change',{bubbles:true}));};
  const choose=names=>{
    const files=names.map(name=>new File([jpeg],name,{type:/\.txt$/.test(name)?'text/plain':'image/jpeg'}));
    Object.defineProperty($('photo-files'),'files',{configurable:true,value:files});
    $('photo-files').dispatchEvent(new w.Event('change',{bubbles:true}));
    return files;
  };
  const press=(key,target=w.document,extra={})=>target.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));
  const click=id=>$(id).dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1}));
  return {w,$,api,storage,trip,change,choose,press,click,objects};
}

test('gallery follows route order, filters cities, and browses only the visible photos',async t=>{
  const {w,$,change,press}=await setup(t);
  assert.deepEqual([...$('photo-gallery').querySelectorAll('h3')].map(el=>el.textContent),['Paris','Madrid']);
  assert.equal($('gallery-count').textContent,'3 photos');
  change('gallery-city',paris.id);
  assert.equal($('gallery-count').textContent,'2 photos');
  assert.equal($('photo-gallery').querySelectorAll('.gallery-city').length,1);
  const opener=$('photo-gallery').querySelector('button');opener.focus();opener.click();
  assert.equal($('photo-position').textContent,'1 / 2');
  assert.equal($('previous-photo').disabled,true);
  press('ArrowRight');await wait(()=>$('photo-position').textContent==='2 / 2');
  assert.equal($('photo-caption').textContent,'Paris');assert.equal($('next-photo').disabled,true);
  press('ArrowRight');await tick();assert.equal($('photo-position').textContent,'2 / 2');
  press('ArrowLeft');await wait(()=>$('photo-position').textContent==='1 / 2');
  await w.RedlinePostcards.close();assert.equal(w.document.activeElement,opener);
  press('Escape');assert.equal($('photo-panel').hidden,true);assert.equal(w.document.activeElement,$('photos-button'));
});

test('navigation saves postcard edits before moving; failed saves keep the photo and draft open',async t=>{
  const {w,$,storage,api,trip,press,click}=await setup(t);
  $('photo-gallery').querySelector('button').click();click('full-photo');
  assert.equal($('photo-viewer').classList.contains('flipped'),true);
  $('postcard-message').value='A memory worth keeping.';$('postcard-message').dispatchEvent(new w.Event('input',{bubbles:true}));
  press('ArrowRight',$('postcard-message'));await tick();assert.equal($('photo-position').textContent,'1 / 3','Editing keys do not navigate');
  let fail=true;
  storage.api=async(path,options)=>{if(fail&&path.endsWith('/postcard'))throw Error('Storage is full.');return api(path,options);};
  press('ArrowRight');await wait(()=>$('postcard-error').textContent==='Storage is full.');
  assert.equal($('photo-position').textContent,'1 / 3');assert.equal($('postcard-message').value,'A memory worth keeping.');
  fail=false;press('ArrowRight');await wait(()=>$('photo-position').textContent==='2 / 3');
  assert.equal($('photo-viewer').classList.contains('flipped'),false);
  press('ArrowLeft');await wait(()=>$('photo-position').textContent==='1 / 3');
  assert.equal($('postcard-message').value,'A memory worth keeping.');
  const records=await w.RedlineArchive.unpack(await storage.exportArchive(trip.id));
  assert.equal(records[0].photos.filter(p=>p.photo.postcard.message==='A memory worth keeping.').length,1);
});

test('import gallery supports bulk assignment, previews, and saving only assigned photos',async t=>{
  const {w,$,choose,change,api,trip,click}=await setup(t,{seed:false});
  assert.equal($('photo-gallery').querySelector('.photo-empty p').textContent,'No photos yet');
  choose(['gps-paris.jpg','one.jpg','two.jpg']);
  await wait(()=>$('photo-review').children.length===3&&!$('choose-photos').disabled);
  assert.equal($('photo-gallery').hidden,true);assert.equal($('gallery-toolbar').hidden,true);
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
  $('upload-photos').click();await wait(()=>!$('photo-gallery').hidden);
  assert.equal($('photo-review').children.length,0);assert.equal($('gallery-count').textContent,'3 photos');
  assert.equal($('photo-message').textContent,'1 photo saved.');
});

test('a partial photo save preserves remaining imports and retry never duplicates completed saves',async t=>{
  const {w,$,choose,change,api,storage,trip}=await setup(t,{seed:false});
  choose(['one.jpg','two.jpg','three.jpg']);await wait(()=>$('photo-review').children.length===3&&!$('choose-photos').disabled);
  change('bulk-photo-city',paris.id);let writes=0;
  storage.api=async(path,options)=>{if(options?.method==='POST'&&path.endsWith('/photos')&&++writes===2)throw Error('Not enough space.');return api(path,options);};
  $('upload-photos').click();await wait(()=>$('photo-message').textContent==='Not enough space.'&&!$('choose-photos').disabled);
  assert.equal($('photo-review').children.length,2);assert.equal((await api(`/trips/${trip.id}`)).photos.length,1);
  storage.api=api;$('upload-photos').click();await wait(()=>!$('photo-gallery').hidden);
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
  assert.equal($('photo-gallery').hidden,false);assert.equal((await api(`/trips/${trip.id}`)).photos.length,3);
});

test('swiping browses without flipping, while a tap still flips the entire postcard',async t=>{
  const {w,$,click}=await setup(t);$('photo-gallery').querySelector('button').click();
  for(const [type,x] of [['pointerdown',200],['pointerup',100]]){
    const event=new w.Event(type,{bubbles:true});Object.assign(event,{pointerType:'touch',pointerId:1,clientX:x,clientY:100});$('full-photo').dispatchEvent(event);
  }
  click('full-photo');await wait(()=>$('photo-position').textContent==='2 / 3');
  assert.equal($('photo-viewer').classList.contains('flipped'),false);
  await new Promise(resolve=>setTimeout(resolve,510));click('full-photo');
  assert.equal($('photo-viewer').classList.contains('flipped'),true);assert.equal($('postcard-front').inert,true);
});

test('print and share use the browsed photo and preserve the postcard viewer',async t=>{
  const {w,$,press,click}=await setup(t);let shared=null,printed=0;
  Object.defineProperty(w.navigator,'canShare',{value:()=>true});
  Object.defineProperty(w.navigator,'share',{value:async value=>shared=value});
  $('photo-gallery').querySelector('button').click();press('ArrowRight');await wait(()=>$('photo-position').textContent==='2 / 3');
  press('ArrowRight');await wait(()=>$('photo-caption').textContent==='Madrid');click('full-photo');
  $('postcard-message').value='An afternoon in Madrid.';$('postcard-message').dispatchEvent(new w.Event('input',{bubbles:true}));
  await wait(()=>!$('share-postcard').disabled);$('share-postcard').click();await wait(()=>shared);
  assert.equal(shared.files[0].name,'Madrid-postcard.jpg');assert.equal(shared.url,undefined);
  w.print=()=>{
    printed++;assert.equal($('photo-viewer').open,false);
    assert.equal($('postcard-print-root').querySelector('.print-front img').src,$('full-photo').src);
    assert.equal($('postcard-print-root').querySelector('.print-message').textContent,'An afternoon in Madrid.');
  };
  $('print-postcard').click();await wait(()=>printed===1);w.dispatchEvent(new w.Event('afterprint'));
  assert.equal($('photo-viewer').open,true);assert.equal($('photo-position').textContent,'3 / 3');assert.equal($('photo-viewer').classList.contains('flipped'),true);
  press('p',w.document,{metaKey:true});await wait(()=>printed===2);w.dispatchEvent(new w.Event('afterprint'));
});
