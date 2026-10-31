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

async function setup(t,{seed=true,route=[paris,madrid],seedStops=[madrid,paris,paris],seedSizes=[],realMap=false,textLength=null}={}){
  const dom=new JSDOM(source('map.html'),{url:'https://redline.test/Redline/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,$=id=>w.document.getElementById(id),objects=new Set();let stops=route;
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
  w.HTMLImageElement.prototype.decode=async()=>{};w.Element.prototype.scrollIntoView=function(){};
  Object.defineProperties(w.HTMLImageElement.prototype,{naturalWidth:{get:()=>1600},naturalHeight:{get:()=>1000}});
  w.RedlinePostcardExport={render:()=>({toBlob:callback=>callback(new Blob([jpeg],{type:'image/jpeg'}))})};
  if(realMap){
    if(textLength!==null)w.SVGElement.prototype.getComputedTextLength=()=>textLength;
    w.localStorage.setItem('redline-route-v1',JSON.stringify(route));
    w.localStorage.setItem('redline-cities-collapsed','true');
    w.matchMedia=()=>({matches:false});w.ResizeObserver=class{observe(){}};
    let frame=0;w.requestAnimationFrame=()=>++frame;w.cancelAnimationFrame=()=>{};
    w.Element.prototype.getBoundingClientRect=function(){
      const [left,top,width,height]=this.id==='route-dock'?[370,760,700,116]:this.matches('.zoom-controls')?[1380,790,36,76]:this.closest?.('#trip-panel')?[24,24,380,600]:[0,0,1440,900];
      return {left,top,width,height,right:left+width,bottom:top+height};
    };
    w.SVGElement.prototype.getScreenCTM=function(){const [x,y,width,height]=$('map').getAttribute('viewBox').split(' ').map(Number);return {a:1440/width,b:0,c:0,d:900/height,e:-x*1440/width,f:-y*900/height};};
    w.Element.prototype.setPointerCapture=function(){};w.Element.prototype.hasPointerCapture=()=>false;
    for(const name of ['vendor/geo','map-layout','atlas-geography','trace','labels','map-paint','app'])w.eval(source(`public/${name}.js`));
    stops=w.RedlineApp.getStops();
  }
  for(const name of ['jpeg','archive','storage'])w.eval(source(`public/${name}.js`));
  const storage=w.RedlineStorage,api=storage.api;
  const {trip}=await api('/trips',{method:'POST',body:JSON.stringify({title:'A summer away',stops})});
  if(seed)for(const [i,stop] of seedStops.entries()){
    const form=new FormData();form.append('photo',new Blob([jpeg],{type:'image/jpeg'}));form.append('stopId',stop.id);
    if(seedSizes[i]){form.append('width',String(seedSizes[i][0]));form.append('height',String(seedSizes[i][1]));}
    await api(`/trips/${trip.id}/photos`,{method:'POST',body:form});
  }
  w.localStorage.setItem('redline-saved-trip',JSON.stringify({id:trip.id,title:trip.title,revision:trip.revision,hash:JSON.stringify(stops)}));
  w.eval(source('public/postcards.js'));w.eval(source('public/album-motion.js'));w.eval(source('public/trips.js'));
  await wait(()=>$('trip-title').textContent===trip.title&&(!seed||$('photo-count').textContent===String(seedStops.length)));
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
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
  const pages=()=>[...$('album-pages').children].map(page=>`${page.classList.contains('left')?'left':page.classList.contains('right')?'right':'single'}:${page.dataset.type}`).join(' ');
  const tab=id=>[...$('gallery-filter').children].find(el=>el.dataset.filter===id);
  return {w,$,api,storage,trip,change,choose,press,click,objects,tiles,prints,pages,tab,mapCalls};
}

test('the album opens from its cover, turns like a book, and its contents and tabs jump to cities',async t=>{
  const {w,$,press,prints,pages,tab,mapCalls}=await setup(t);
  await wait(()=>pages()==='left:inside right:title');
  assert.equal($('photo-panel').querySelector('.album-name').textContent,'A summer away');
  assert.equal($('photo-panel').querySelector('.title-route').textContent,'Paris → Madrid');
  assert.equal($('album-position').textContent,'Title page');
  assert.deepEqual([...$('gallery-filter').children].map(el=>el.textContent),['03Paris2','04Madrid1']);
  $('album-next').click();
  assert.equal(pages(),'left:contents right:city');
  assert.deepEqual([...$('album-pages').querySelectorAll('.contents-list button')].map(el=>el.textContent),['01Paris3','02Madrid4']);
  assert.deepEqual([...$('album-pages').querySelectorAll('.city-name')].map(el=>el.textContent),['Paris']);
  assert.equal($('album-pages').querySelector('.page-stop').textContent,'Stop 01');
  assert.equal(prints().length,2);assert.match($('album-position').textContent,/^Paris · pages 2–3$/);
  $('album-pages').querySelectorAll('.contents-list button')[1].click();
  assert.equal(pages(),'left:city right:inside');assert.equal(prints().length,1);assert.equal(tab(madrid.id).getAttribute('aria-current'),'true');
  $('album-next').click();assert.equal(pages(),'left:back right:void','The album closes on its back cover');
  assert.equal($('album-position').textContent,'Back cover');assert.equal($('album-next').disabled,true);
  assert.ok($('album-book').classList.contains('closed-back'));
  press('Home');assert.equal(pages(),'left:void right:cover');assert.ok($('album-book').classList.contains('closed-front'));
  assert.equal($('album-pages').querySelector('.cover-title').textContent,'A summer away');
  press('End');assert.equal(pages(),'left:back right:void');
  press('ArrowLeft');press('ArrowLeft');assert.equal(pages(),'left:contents right:city','The keyboard turns pages');
  const opener=prints()[0];opener.focus();opener.click();
  assert.equal($('photo-viewer').open,true);assert.equal($('photo-position').textContent,'1 / 2','The viewer browses the city it was opened from');
  press('ArrowRight');await wait(()=>$('photo-position').textContent==='2 / 2');
  assert.equal($('photo-caption').textContent,'Paris');assert.equal($('viewer-next').hidden,true);
  press('ArrowRight');await tick();assert.equal($('photo-position').textContent,'2 / 2');
  assert.equal(prints().length,2,'Arrow keys in the viewer never turn the album');
  await w.RedlinePostcards.close();assert.equal(w.document.activeElement,opener);
  press('Escape');assert.equal($('photo-panel').open,false);assert.equal(w.document.activeElement,$('map'),'Opened with nothing focused, the album hands the keys back to the map');
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
  assert.equal(pages(),'left:contents right:city','The album reopens where it was left');
  $('album-pages').querySelector('.gallery-map-button').click();
  assert.equal(mapCalls.focused,paris.id);assert.equal($('photo-panel').open,false,'Finding a city on the map closes the album');
});

test('a spread names both its cities, and turns keep tab focus and finish when pressed twice',async t=>{
  const rome={id:'city-rome-0001',name:'Rome',country:'Italy',latitude:41.9,longitude:12.5};
  const {w,$,press,pages,tab}=await setup(t,{route:[paris,madrid,rome],seedStops:[paris,madrid,rome]});
  await wait(()=>pages()==='left:inside right:title');
  const scrolled=[];w.Element.prototype.scrollIntoView=function(options){scrolled.push([this,options]);};
  press('ArrowRight');assert.equal($('album-position').textContent,'Paris · pages 2–3');
  press('ArrowRight');assert.equal(pages(),'left:city right:city');
  assert.equal($('album-position').textContent,'Madrid & Rome · pages 4–5','Both cities are named, left page first');
  assert.equal(tab(madrid.id).getAttribute('aria-current'),'true','The tab follows the first city on the pages');
  assert.equal($('album-scrub').getAttribute('aria-valuetext'),'Madrid & Rome · pages 4–5','The slider speaks the page label, not an index');
  assert.equal(scrolled.length,0,'Tab navigation never scrolls the book or its ancestors');
  tab(rome.id).click();assert.equal(tab(rome.id).getAttribute('aria-current'),'true','A chosen city on the same pages keeps its tab');
  assert.equal($('album-position').textContent,'Madrid & Rome · pages 4–5');
  // Turns animate from here on, and finish only when the test says so.
  const running=new Set();
  class Turn{constructor(){this.ended=new Promise((resolve,reject)=>{this.finish=()=>{running.delete(this);resolve(this);};this.cancel=()=>{if(running.delete(this))reject(Error('Cancelled'));};});this.ended.catch(()=>{});running.add(this);}get finished(){return this.ended;}}
  w.Animation=Turn;w.Element.prototype.animate=()=>new Turn();
  const finish=async()=>{const layer=$('album-book').querySelector('.album-view-layer');[...running].forEach(turn=>turn.finish());await tick();if(layer)await wait(()=>!layer.isConnected);};
  tab(paris.id).focus();tab(paris.id).click();const turning=[...running];assert.equal(turning.length,4);
  tab(paris.id).click();assert.deepEqual([...running],turning,'A second press toward the same page lets the turn finish');
  await finish();assert.equal(pages(),'left:contents right:city');
  assert.equal(w.document.activeElement,tab(paris.id),'Keyboard focus stays on the tab after an animated turn');
  press('End');const closing=[...running];press('End');assert.deepEqual([...running],closing);
  await finish();assert.equal(pages(),'left:back right:void');
  $('sheet-view').click();assert.equal($('album-foot').inert,true,'Hidden page controls leave the tab order');
  await wait(()=>running.size===4);await finish();
  $('album-view').click();await wait(()=>running.size===4);await finish();assert.equal($('album-foot').inert,false);
});

test('the divider tabs are coloured book cloth with readable labels',()=>{
  const css=source('public/gallery.css'),rule=css.match(/\.album-tab \{[^}]*\}/)[0];
  assert.match(rule,/var\(--tab\b/,'Each tab takes its colour from its --tab index');
  const colours=rule.match(/linear-gradient\(([^;]*)\)/)[1].match(/#[0-9a-f]{6}/gi);assert.equal(colours.length,6);
  const luminance=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=.03928?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
  const foreground=rule.match(/color:\s*(#[0-9a-f]{6})/)[1];
  const brightness=Number(css.match(/\.album-tab\[aria-current=true\][^{]*\{[^}]*brightness\(([\d.]+)\)/)[1]);
  for(const colour of colours){
    const active='#'+[1,3,5].map(i=>Math.min(255,Math.round(parseInt(colour.slice(i,i+2),16)*brightness)).toString(16).padStart(2,'0')).join('');
    assert.ok((luminance(foreground)+.05)/(luminance(active)+.05)>=4.5,`${colour} keeps its label readable even when highlighted`);
  }
  assert.doesNotMatch(css,/--tab-color|\.at-(start|end)|^\.eyebrow /m,'No dead colour fallback, duplicate classes, or second .eyebrow');
});

test('the album keeps its place when it changes between one page and two',async t=>{
  const {w,$,api,trip,press,pages}=await setup(t,{route:[paris],seedStops:[paris,paris,paris,paris]});
  await wait(()=>pages()==='left:inside right:title');
  const setWidth=value=>Object.defineProperty(w,'innerWidth',{configurable:true,writable:true,value});
  const width=async(value,shown)=>{setWidth(value);w.dispatchEvent(new w.Event('resize'));await wait(()=>pages()===shown);};
  press('End');assert.equal(pages(),'left:back right:void');
  await width(700,'single:back');assert.ok($('album-book').classList.contains('closed-back'));
  assert.equal($('album-pages').querySelector('.page-corner'),null,'The closed back cover has nothing to turn');
  press('ArrowLeft');assert.equal(pages(),'single:inside');assert.equal($('album-position').textContent,'Endpapers');
  await width(1024,'left:city right:inside');assert.equal($('album-book').classList.contains('closed-back'),false,'The endpapers stay open');
  await width(700,'single:inside');
  press('End');press('Escape');assert.equal($('photo-panel').open,false);
  // Another voyage is drawn side by side in between, so only the remembered place can reopen this one closed.
  setWidth(1024);const other=(await api('/trips',{method:'POST',body:JSON.stringify({title:'Another time',stops:[madrid]})})).trip;
  for(const [id,title] of [[other.id,'Another time'],[trip.id,'A summer away']]){
    $('trips-button').click();await wait(()=>$('trip-list').querySelector(`[data-trip-id="${id}"] .trip-open`));
    $('trip-list').querySelector(`[data-trip-id="${id}"] .trip-open`).click();await wait(()=>$('trip-title').textContent===title&&!$('trips-button').disabled);
  }
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
  assert.equal(pages(),'left:back right:void','The album reopens closed on its back cover');
  press('Escape');
});

test('a long voyage continues its contents onto further pages and closes on endpapers',async t=>{
  const ports=Array.from({length:10},(_,i)=>({id:`city-port-${i}`,name:`Port ${String.fromCharCode(65+i)}`,country:'Atlantis',latitude:-40+i*8,longitude:-120+i*24}));
  const {w,$,pages,press}=await setup(t,{route:ports,seedStops:ports});
  await wait(()=>pages()==='left:inside right:title');
  $('album-next').click();
  assert.equal(pages(),'left:contents right:contents');
  assert.deepEqual([...$('album-pages').querySelectorAll('.contents-title')].map(el=>el.textContent),['Places','Places, continued']);
  const entries=[...$('album-pages').querySelectorAll('.contents-list button')];
  assert.equal(entries.length,10,'Every port is listed');
  assert.equal(entries[9].querySelector('.contents-page').textContent,'13');
  entries[9].click();
  assert.deepEqual([...$('album-pages').querySelectorAll('.city-name')].map(el=>el.textContent),['Port I','Port J']);
  $('album-next').click();
  assert.equal(pages(),'left:blank right:inside');assert.equal($('album-position').textContent,'Endpapers');
  // A short page holds fewer ports, and the album keeps its place although the pages are renumbered.
  $('album-previous').click();assert.equal($('album-position').textContent,'Port I & Port J · pages 12–13');
  Object.defineProperty($('album-book'),'clientHeight',{configurable:true,get:()=>160});$('album-book').style.padding='10px';
  w.dispatchEvent(new w.Event('resize'));await wait(()=>$('album-position').textContent==='Port I & Port J · pages 14–15');
  press('Home');press('ArrowRight');press('ArrowRight');
  assert.deepEqual([...$('album-pages').querySelectorAll('.contents-list')].map(list=>list.children.length),[3,3]);
});

test('navigation saves postcard edits before moving; failed saves keep the photo and draft open',async t=>{
  const {w,$,storage,api,trip,press,click,tiles,tab}=await setup(t);
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
  await w.RedlinePostcards.close();$('album-view').click();tab(paris.id).click();
  assert.equal($('album-pages').querySelector('figcaption'),null,'Postcard messages never become album captions');
});

test('import review supports bulk assignment, previews, and saving only assigned photos',async t=>{
  const {w,$,choose,change,api,trip,click,pages}=await setup(t,{seed:false});
  await wait(()=>pages()==='left:inside right:title');$('album-next').click();
  assert.equal(pages(),'left:empty right:inside');
  assert.equal($('album-pages').querySelector('.photo-empty p').textContent,'No photos yet');assert.equal($('gallery-toolbar').hidden,true);
  choose(['gps-paris.jpg','one.jpg','two.jpg']);
  await wait(()=>$('photo-review').children.length===3&&!$('choose-photos').disabled);
  assert.equal($('album-pages').hidden,true);assert.equal($('photo-gallery').hidden,true);assert.equal($('gallery-toolbar').hidden,true);
  assert.equal($('photo-selection-count').textContent,'3 selected');assert.equal($('photo-ready-count').textContent,'2 need a city');
  const entries=[...$('photo-review').children];entries[0].querySelector('.photo-image').click();
  assert.equal($('photo-position').textContent,'1 / 3');click('full-photo');assert.equal($('photo-viewer').classList.contains('flipped'),false);
  assert.equal($('print-postcard').disabled,true);await w.RedlinePostcards.close();
  const css=source('public/gallery.css');
  assert.match(css,/\.remove-photo \{[^}]*width: 44px; height: 44px;/,'The remove control keeps a 44px target around its small mark');
  assert.match(css,/\.review-photo:focus-within \.remove-photo svg/);assert.match(css,/@media \(hover: none\), \(any-pointer: coarse\) \{ \.remove-photo svg/);
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
  const swipe=(el,from,to)=>{for(const [type,x] of [['pointerdown',from],['pointerup',to]]){
    const event=new w.Event(type,{bubbles:true});Object.assign(event,{pointerType:'touch',pointerId:1,clientX:x,clientY:100});el.dispatchEvent(event);
  }};
  swipe($('full-photo'),200,100);
  click('full-photo');await wait(()=>$('photo-position').textContent==='2 / 2');
  assert.equal($('photo-viewer').classList.contains('flipped'),false);
  swipe($('viewer-previous'),30,190);await wait(()=>$('photo-position').textContent==='1 / 2');
  assert.match(source('public/gallery.css'),/\.viewer-edge \{[^}]*touch-action: pan-y pinch-zoom;/,'A swipe that starts on an edge arrow is not taken as a browser pan');
  await new Promise(resolve=>setTimeout(resolve,510));click('full-photo');
  assert.equal($('photo-viewer').classList.contains('flipped'),true);assert.equal($('postcard-front').inert,true);
});

test('the viewer opens on the photo, its edge arrows are labelled buttons, and focus survives the ends, the back, and printing',async t=>{
  const {w,$,press,tiles}=await setup(t),focused=()=>w.document.activeElement;
  // Like a browser, opening a dialog focuses its first focusable control. jsdom has no inert, so read the flag postcards.js sets.
  const off=el=>!!el&&((el.inert??el.hasAttribute('inert'))||el.hidden||off(el.parentElement));
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;[...this.querySelectorAll('button,select,input,textarea')].find(el=>!el.disabled&&!off(el))?.focus();};
  tiles()[0].click();
  assert.equal(focused(),$('postcard-front'),'← →, F, and Delete work at once, and the arrows never reach the invisible city picker');
  for(const [edge,label] of [[$('viewer-previous'),'Previous photo'],[$('viewer-next'),'Next photo']]){
    assert.equal(edge.getAttribute('aria-label'),label);assert.equal(edge.hasAttribute('aria-hidden'),false);assert.equal(edge.tabIndex,0);
    assert.equal(edge.querySelector('svg').getAttribute('aria-hidden'),'true');
  }
  assert.match(source('public/gallery.css'),/\.viewer-edge:focus-visible \{ opacity: 1; \}/,'A focused arrow is visible');
  assert.equal($('viewer-previous').hidden,true);assert.equal($('photo-position').hidden,false);
  $('viewer-next').focus();$('viewer-next').click();await wait(()=>$('photo-position').textContent==='2 / 2');
  assert.equal($('viewer-next').hidden,true);assert.equal(focused(),$('viewer-previous'),'A focused arrow that disappears at the end hands focus to the other one');
  press('f',focused());assert.equal(focused(),$('unflip-postcard'));
  let printed=0;w.print=()=>{printed++;};
  $('print-postcard').click();await wait(()=>printed===1);w.dispatchEvent(new w.Event('afterprint'));
  assert.equal($('photo-viewer').open,true);assert.equal(focused(),$('unflip-postcard'),'After printing, focus returns to the Photo button, not its first field');
  w.print=()=>{throw Error('No printer.');};$('print-postcard').click();await wait(()=>$('postcard-error').textContent==='No printer.');
  assert.equal($('photo-viewer').open,true);assert.equal(focused(),$('unflip-postcard'));
  press('ArrowLeft',focused());await wait(()=>$('photo-position').textContent==='1 / 2');
  assert.equal($('photo-viewer').classList.contains('flipped'),false);assert.equal(focused(),$('postcard-front'),'Browsing from the back moves focus to the front it shows');
  await w.RedlinePostcards.close();tiles()[2].click();assert.equal($('photo-caption').textContent,'Madrid');
  assert.deepEqual([$('viewer-previous').hidden,$('viewer-next').hidden,$('photo-position').hidden],[true,true,true],'A single photo has nothing to browse');
  assert.equal(focused(),$('postcard-front'));
});

test('print and share use the browsed photo and preserve the postcard viewer',async t=>{
  const {w,$,press,click,tiles}=await setup(t);let shared=null,printed=0;
  Object.defineProperty(w.navigator,'canShare',{value:()=>true});
  Object.defineProperty(w.navigator,'share',{value:async value=>shared=value});
  tiles()[2].click();assert.equal($('photo-caption').textContent,'Madrid');click('full-photo');
  $('postcard-message').value='An afternoon in Madrid.';$('postcard-message').dispatchEvent(new w.Event('input',{bubbles:true}));
  await wait(()=>!$('share-postcard').disabled);$('share-postcard').click();await wait(()=>shared);
  assert.equal(shared.files[0].name,'Madrid-postcard.jpg');assert.equal(shared.url,undefined);
  const lastPage=source('public/style.css').match(/(\.postcard-print-page:[\w-]+) \{ break-after: auto;/)[1];let unbroken=null;
  w.print=()=>{
    printed++;assert.equal($('photo-viewer').open,false);unbroken=$('postcard-print-root').querySelector(lastPage);
    assert.equal($('postcard-print-root').querySelector('.print-front img').src,$('full-photo').src);
    assert.equal($('postcard-print-root').querySelector('.print-message').textContent,'An afternoon in Madrid.');
  };
  $('print-postcard').click();await wait(()=>printed===1);
  assert.equal(unbroken?.classList.contains('print-back'),true,'Only the back page drops its page break, so no blank sheet follows');
  w.dispatchEvent(new w.Event('afterprint'));
  assert.equal($('photo-viewer').open,true);assert.equal($('photo-caption').textContent,'Madrid');assert.equal($('photo-viewer').classList.contains('flipped'),true);
  press('p',w.document,{metaKey:true});await wait(()=>printed===2);w.dispatchEvent(new w.Event('afterprint'));
});

test('select mode moves and deletes several photos atomically',async t=>{
  const {w,$,api,trip,tiles,change}=await setup(t);
  tiles();$('select-photos').focus();$('select-photos').click();
  assert.equal($('sheet-view').getAttribute('aria-pressed'),'true','Selecting works on the full list of photos');
  assert.equal($('gallery-actions').hidden,false);assert.equal($('gallery-toolbar').hidden,true);
  assert.equal(w.document.activeElement,$('done-selecting'),'Focus leaves the hidden Select button for Done');
  assert.equal($('gallery-selection-count').textContent,'Tap photos to select');assert.equal($('delete-photos').disabled,true);
  assert.equal($('select-photos').hasAttribute('aria-pressed'),false,'Select is a plain button; the Done bar replaces it');
  tiles()[0].click();tiles()[2].dispatchEvent(new w.MouseEvent('click',{bubbles:true,shiftKey:true}));
  assert.equal($('gallery-selection-count').textContent,'3 selected','Shift-click selects every photo in between');
  tiles()[2].click();
  assert.equal($('photo-viewer').open,false,'Selecting never opens the viewer');
  assert.equal($('gallery-selection-count').textContent,'2 selected');assert.equal(tiles()[0].getAttribute('aria-pressed'),'true');
  $('move-photos').focus();change('move-photos',madrid.id);
  await wait(()=>$('photo-message').textContent==='Moved 2 photos to Madrid.');
  await wait(()=>w.document.activeElement===$('select-photos'));
  assert.deepEqual([...$('photo-gallery').querySelectorAll('.gallery-city-count')].map(el=>el.textContent),['3 photos']);
  assert.equal((await api(`/trips/${trip.id}`)).photos.filter(p=>p.stopId===madrid.id).length,3);
  $('select-photos').click();$('select-visible').click();assert.equal($('gallery-selection-count').textContent,'3 selected');
  w.confirm=()=>false;$('delete-photos').click();await tick();assert.equal(tiles().length,3);
  w.confirm=()=>true;tiles()[2].click();$('delete-photos').focus();$('delete-photos').click();
  await wait(()=>$('photo-message').textContent==='2 photos deleted.');
  await wait(()=>w.document.activeElement===$('done-selecting'));assert.equal($('delete-photos').disabled,true,'Focus leaves the emptied selection’s Delete for Done');
  assert.equal(tiles().length,1);assert.equal($('photo-count').textContent,'1');
  assert.equal((await api(`/trips/${trip.id}`)).photos.length,1);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal($('gallery-actions').hidden,true,'Escape leaves select mode first');assert.equal($('photo-panel').open,true);
});

test('the minimal viewer deletes a photo and shows the next photo in its city',async t=>{
  const {w,$,api,trip,tiles}=await setup(t);
  tiles()[0].click();
  assert.equal($('photo-city'),null,'Location management stays in All Photos');
  assert.equal($('close-photo-viewer'),null);assert.equal($('close-postcard'),null);
  assert.ok($('photo-position').classList.contains('sr-only'),'Numbering is announced, not printed on the card');
  w.confirm=()=>true;$('delete-photo').click();
  await wait(()=>$('photo-position').hidden&&$('photo-caption').textContent==='Paris');
  assert.equal($('photo-viewer').open,true);assert.equal((await api(`/trips/${trip.id}`)).photos.length,2);
  $('delete-photo').click();await wait(()=>!$('photo-viewer').open);
  assert.equal((await api(`/trips/${trip.id}`)).photos.length,1);
  assert.equal(tiles().length,1);
});

test('the logbook lists, renames, and deletes voyages, and folds away when you work on the map',async t=>{
  const {w,$,api,trip}=await setup(t);
  await api('/trips',{method:'POST',body:JSON.stringify({title:'Another time',stops:[madrid]})});
  $('trips-button').click();
  assert.equal(!$('trip-panel').hidden,true);assert.equal($('photo-panel').open,false,'Only one sheet at a time');
  assert.equal($('trips-button').getAttribute('aria-expanded'),'true');
  await wait(()=>$('trip-list').querySelectorAll('.trip-card').length===2);
  assert.equal($('trips-summary').textContent,'2 trips kept in this browser');assert.equal($('trip-state').textContent,'All changes saved');
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
  const down=el=>el.dispatchEvent(new w.Event('pointerdown',{bubbles:true}));
  for(const id of ['trip-name','save-trip','photos-button','trips-button','stop-list'])down($(id));
  assert.equal(!$('trip-panel').hidden,true,'Working in the logbook or on the planner tabs keeps the logbook open');
  $('trips-button').click();assert.equal($('trip-panel').hidden,true,'The Logbook tab still folds it away');
  for(const id of ['destination','play','next-city']){
    $('trips-button').click();down($(id));
    assert.equal($('trip-panel').hidden,true,`Pressing #${id} folds the logbook away, so nothing plays or opens behind it`);
  }
  $('trips-button').click();$('play').focus();
  assert.equal($('trip-panel').hidden,true,'Moving keyboard focus elsewhere in the planner folds it away');
  $('trips-button').click();down(w.document.body);
  assert.equal($('trip-panel').hidden,true,'Working on the map folds the logbook away');
  $('trips-button').click();await wait(()=>$('trip-list').querySelectorAll('.trip-delete').length===2);
  w.confirm=()=>true;card().querySelector('.trip-more').click();card().querySelector('.trip-delete').click();
  await wait(()=>$('trip-list').querySelectorAll('.trip-card').length===1);
  assert.equal($('trip-title').textContent,'');assert.equal($('photo-count').textContent,'');
  assert.equal((await api('/trips')).trips.length,1);
  await assert.rejects(api(`/trips/${trip.id}`),e=>e.status===404);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal($('trip-panel').hidden,true);assert.equal(w.document.activeElement,$('trips-button'));
  $('photos-button').click();await wait(()=>!$('trip-panel').hidden);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal($('trip-message').textContent,'Name and save this trip to add photos.','The prompt is not replaced by the list');
  assert.equal($('trip-list').querySelectorAll('.trip-card').length,1);
});

test('renaming the open trip keeps the stale-tab check, and focus stays in the logbook',async t=>{
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
  assert.equal(!$('trip-panel').hidden,true,'Escape in the rename field only cancels the rename');
});

test('saving, exporting, and opening voyages from the logbook keep its list current and focus in place',async t=>{
  const {w,$,api,trip,press}=await setup(t,{seed:false});
  const other=(await api('/trips',{method:'POST',body:JSON.stringify({title:'Another time',stops:[madrid]})})).trip;
  const rome={id:'city-rome-0001',name:'Rome',country:'Italy',latitude:41.9,longitude:12.5},scrolled=[],downloads=[];
  w.Element.prototype.scrollIntoView=function(options){scrolled.push([this,options]);};
  w.HTMLAnchorElement.prototype.click=function(){downloads.push(this.download);};
  const row=id=>[...$('trip-list').querySelectorAll('.trip-card')].find(el=>el.dataset.tripId===id);
  const meta=id=>row(id)?.querySelector('.trip-meta').textContent||'';
  const edit=route=>{w.RedlineApp.setStops(route);w.dispatchEvent(new w.Event('redline:routechange'));};
  $('trips-button').click();await wait(()=>row(other.id));
  edit([paris,madrid,rome]);row(trip.id).querySelector('.trip-open').focus();press('s',w.document.activeElement);
  await wait(()=>/^3 stops/.test(meta(trip.id))&&!$('save-trip').disabled);
  assert.equal(w.document.activeElement,row(trip.id).querySelector('.trip-open'),'Saving with S keeps focus on the same voyage');
  assert.equal($('trip-list').querySelectorAll('button:disabled').length,0);
  const more=row(trip.id).querySelector('.trip-more');more.click();
  assert.ok(scrolled.some(([el,options])=>el===row(trip.id).querySelector('.trip-menu')&&options.block==='nearest'),'The menu is brought into view inside the logbook');
  press('Escape',row(trip.id).querySelector('.trip-menu'));
  $('trip-name').value='Summer in Rome';$('trip-name').dispatchEvent(new w.Event('input',{bubbles:true}));
  const save=$('trip-name-form').querySelector('button');save.focus();save.click();
  await wait(()=>$('trip-title').textContent==='Summer in Rome'&&!$('save-trip').disabled);
  assert.equal(save.disabled,true);assert.equal(w.document.activeElement,$('trip-name'),'Focus leaves the disabled Save button for the name');
  edit([paris,madrid]);row(trip.id).querySelector('.trip-more').click();row(trip.id).querySelector('.trip-export').click();
  await wait(()=>downloads.length===1&&/^2 stops/.test(meta(trip.id)));
  assert.equal(w.document.activeElement,row(trip.id).querySelector('.trip-more'),'Exporting from the menu saves first and keeps focus on its button');
  row(other.id).querySelector('.trip-open').focus();row(other.id).querySelector('.trip-open').click();
  await wait(()=>$('trip-title').textContent==='Another time'&&!$('trips-button').disabled);
  assert.equal($('trip-panel').hidden,true);assert.equal(w.document.activeElement,$('trips-button'),'Focus returns to the Logbook tab, not a hidden button');
});

test('the album closes from its backdrop or Escape, and Escape leaves select mode first',async t=>{
  const {w,$}=await setup(t);
  $('select-photos').click();assert.equal($('gallery-actions').hidden,false);
  $('photo-panel').dispatchEvent(new w.Event('cancel',{cancelable:true}));
  assert.equal($('photo-panel').open,true);assert.equal($('gallery-actions').hidden,true);
  const on=(el,type)=>el.dispatchEvent(new w.Event(type,{bubbles:true}));
  on($('album-pages'),'pointerdown');on($('photo-panel'),'click');assert.equal($('photo-panel').open,true,'A drag that ends on the backdrop does not close');
  on($('photo-panel'),'pointerdown');on($('photo-panel'),'click');
  assert.equal($('photo-panel').open,false);assert.equal(w.document.activeElement,$('map'),'A close by pointer leaves the keys with the map');
});

test('a viewer delete blocks browsing until it finishes, and focus returns to the album',async t=>{
  const {w,$,storage,api,tiles,press}=await setup(t);
  let release;const gate=new Promise(resolve=>release=resolve);
  storage.api=async(path,options)=>{if(options?.method==='DELETE')await gate;return api(path,options);};
  tiles()[1].click();assert.equal($('photo-position').textContent,'2 / 2');
  w.confirm=()=>true;$('delete-photo').click();await tick();
  press('ArrowLeft');$('viewer-previous').click();await tick();assert.equal($('photo-position').textContent,'2 / 2','Browsing waits for the delete');
  assert.equal($('viewer-previous').hidden,false,'The arrows stay put during a delete, so a focused one keeps focus');
  release();await wait(()=>$('photo-caption').textContent==='Paris'&&$('photo-position').hidden);
  await w.RedlinePostcards.close();
  assert.ok(w.document.activeElement===$('photo-panel')||w.document.activeElement?.classList.contains('photo-image'),'Focus is not lost to the page');
});

test('select mode follows route edits, and dragging files never saves route edits',async t=>{
  const {w,$,api,trip}=await setup(t);
  $('select-photos').click();$('select-visible').click();w.confirm=()=>true;$('delete-photos').click();
  await wait(()=>$('photo-message').textContent==='3 photos deleted.');
  assert.equal($('gallery-actions').hidden,true,'Selection ends when no photos are left');
  $('album-view').click();$('album-scrub').value='0';$('album-scrub').dispatchEvent(new w.Event('input'));$('album-next').click();$('album-next').click();
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

test('focus follows the reader: a clicked voyage hands keys to the map, renames survive a save, and turned pages pass focus to the tab',async t=>{
  const rome={id:'city-rome-0001',name:'Rome',country:'Italy',latitude:41.9,longitude:12.5};
  const {w,$,api,trip,pages,tab,tiles}=await setup(t,{route:[paris,madrid,rome],seedStops:[paris,madrid,rome]});
  await wait(()=>pages()==='left:inside right:title');
  // A contents entry turns its page away; focus moves to the port's tab instead of the page body.
  $('album-next').click();const entry=$('album-pages').querySelectorAll('.contents-list button')[2];entry.focus();entry.click();
  assert.equal(pages(),'left:city right:city');assert.equal(w.document.activeElement,tab(rome.id));
  // The chosen city anchors the place when the layout changes, even on the left-hand page.
  tab(madrid.id).click();const setWidth=value=>Object.defineProperty(w,'innerWidth',{configurable:true,writable:true,value});
  setWidth(700);w.dispatchEvent(new w.Event('resize'));await wait(()=>pages()==='single:city');
  assert.equal($('album-pages').querySelector('.city-name').textContent,'Madrid');
  setWidth(1024);w.dispatchEvent(new w.Event('resize'));await wait(()=>pages()==='left:city right:city');
  // A close request in select mode leaves select mode and returns to Select.
  tiles();$('select-photos').click();$('photo-panel').dispatchEvent(new w.Event('cancel',{cancelable:true}));
  assert.equal($('photo-panel').open,true);assert.equal(w.document.activeElement,$('select-photos'));
  // A held Return on an edge arrow does not keep browsing.
  tiles()[0].click();await wait(()=>$('photo-viewer').open);
  const held=new w.KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true});$('viewer-next').dispatchEvent(held);
  assert.equal(held.defaultPrevented,true);
  await w.RedlinePostcards.close();$('photos-button').click();await wait(()=>!$('photo-panel').open);
  // The logbook folds away when focus leaves the planner for the zoom controls.
  $('trips-button').click();assert.equal($('trip-panel').hidden,false);
  w.document.querySelector('.zoom-controls button').focus();assert.equal($('trip-panel').hidden,true);
  // A half-typed rename of another voyage survives a save from the seal.
  const other=(await api('/trips',{method:'POST',body:JSON.stringify({title:'Another time',stops:[madrid]})})).trip;
  const row=id=>[...$('trip-list').querySelectorAll('.trip-card')].find(el=>el.dataset.tripId===id);
  $('trips-button').click();await wait(()=>row(other.id));
  row(other.id).querySelector('.trip-more').click();row(other.id).querySelector('.trip-rename').click();
  row(other.id).querySelector('.trip-rename-form input').value='Another tim';
  w.RedlineApp.setStops([paris,madrid]);w.dispatchEvent(new w.Event('redline:routechange'));
  $('save-trip').click();await wait(()=>/^2 stops/.test(row(trip.id)?.querySelector('.trip-meta').textContent||''));
  assert.equal(row(other.id).querySelector('.trip-rename-form input')?.value,'Another tim','The typed name is kept');
  // A voyage opened with the mouse leaves the keys on the map, so Return sets sail.
  row(other.id).querySelector('.trip-rename-form .text-button').click();
  row(other.id).querySelector('.trip-open').dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1}));
  await wait(()=>$('trip-title').textContent==='Another time'&&!$('trips-button').disabled);
  assert.equal(w.document.activeElement,$('map'));
});

test('closing a panel returns focus where it was opened from, and an open logbook keeps a typed name',async t=>{
  const {w,$,api,press}=await setup(t,{seed:false});
  // Opened from its focused tab with the keyboard, the album returns there; closed with the mouse, the keys go to the map.
  press('Escape');$('photos-button').focus();$('photos-button').click();await wait(()=>$('photo-panel').open);
  press('Escape');assert.equal(w.document.activeElement,$('photos-button'));
  $('photos-button').click();await wait(()=>$('photo-panel').open);
  $('photo-panel').querySelector('[data-close]').dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1}));
  assert.equal($('photo-panel').open,false);assert.equal(w.document.activeElement,$('map'));
  // A logbook opened by a click closes back to the map; one opened from the keyboard returns to its tab.
  $('trips-button').focus();$('trips-button').dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1}));
  press('Escape');assert.equal($('trip-panel').hidden,true);assert.equal(w.document.activeElement,$('map'));
  $('trips-button').focus();$('trips-button').click();press('Escape');assert.equal(w.document.activeElement,$('trips-button'));
  // A travel key pressed on the planner's head folds the logbook before the voyage moves.
  $('trips-button').click();$('save-trip').focus();press('ArrowRight',$('save-trip'));assert.equal($('trip-panel').hidden,true);
  // A new, unsaved course: the seal and the Album tab keep the name being typed, and the seal saves it.
  $('trips-button').click();$('new-trip').click();w.RedlineApp.setStops([paris,madrid]);w.dispatchEvent(new w.Event('redline:routechange'));
  $('photos-button').click();assert.equal($('trip-panel').hidden,false);assert.match($('trip-message').textContent,/Name and save/);
  $('trip-name').value='Pacific crossing';$('photos-button').click();assert.equal($('trip-name').value,'Pacific crossing','Album keeps the typed name');
  // Saving the name goes on to the album the logbook asked for.
  $('save-trip').click();await wait(()=>$('trip-title').textContent==='Pacific crossing'&&$('photo-panel').open);
  assert.equal($('trip-panel').hidden,true);
  const {trips}=await api('/trips');assert.ok(trips.some(other=>other.title==='Pacific crossing'));
});

function controlledMotion(w){
  const running=new Set();
  class Motion {
    constructor(element,options){
      this.element=element;this.options=options;this.reversed=false;this.reverse=()=>{this.reversed=!this.reversed;};
      this.updatePlaybackRate=value=>{this.playbackRate=value;};
      this.done=new Promise((resolve,reject)=>{
        this.finish=()=>{running.delete(this);resolve();};
        this.cancel=()=>{if(running.delete(this))reject(Error('Cancelled'));};
      });this.done.catch(()=>{});running.add(this);
    }
    get finished(){return this.done;}
  }
  w.Animation=Motion;w.Element.prototype.animate=function(frames,options){const animation=new Motion(this,options);animation.frames=frames;return animation;};
  return {running,finish:async()=>{
    if(!running.size&&w.document.getElementById('album-book').dataset.viewMotion)await wait(()=>running.size||!w.document.getElementById('album-book').dataset.viewMotion);
    const layer=w.document.querySelector('.album-view-layer');
    [...running].forEach(item=>item.finish());await tick();
    if(layer)await wait(()=>!layer.isConnected);
  }};
}

test('album and All Photos slide in, keep their spread stable, and slide away after closing',async t=>{
  const {w,$,press,pages,tab}=await setup(t),motion=controlledMotion(w);
  tab(madrid.id).click();await motion.finish();const bookmark=pages();
  for(const view of ['sheet','album']){
    $(view+'-view').click();await motion.finish();await motion.finish();if(view==='sheet')$('photo-scroll').scrollTop=180;
    const paper=$('photo-gallery').firstElementChild,spread=$('album-pages').firstElementChild;
    press('Escape');
    await wait(()=>motion.running.size===3);
    assert.equal($('photo-panel').dataset.motion,'closing');assert.equal($('album-book').dataset.mode,view);
    const scene=$('album-book').querySelector('.album-cover-scene');
    assert.ok(scene.querySelector('.album-cover-front .album-cover'),'The entire front cover folds over this view');
    assert.equal($('gallery-filter').parentElement,scene,'Tabs follow the cover geometrically');
    assert.equal(scene.querySelectorAll('[id]').length,1,'Only the original tab navigation has an ID');
    assert.equal($('photo-gallery').firstElementChild,paper);assert.equal($('album-pages').firstElementChild,spread);
    const closing=[...motion.running];assert.ok(closing.every(animation=>animation.options.duration===1400&&animation.options.direction==='reverse'));
    const reversedFrames=closing.map(animation=>JSON.stringify(animation.frames));
    assert.equal($('photo-panel').dataset.departing,'true');
    assert.equal($('photo-panel').style.getPropertyValue('--album-exit-delay'),'1220ms');
    press('Escape');assert.deepEqual([...motion.running],closing,'A second close does not restart the reverse');
    await motion.finish();assert.equal($('photo-panel').open,false);
    assert.equal($('album-pages').children.length,0);assert.equal($('album-book').querySelector('.album-cover-scene'),null);
    assert.equal($('gallery-filter').parentElement,$('album-book'));
    $('photos-button').click();await wait(()=>motion.running.size===3);
    assert.equal($('photo-panel').dataset.motion,'opening');assert.equal($('album-book').dataset.mode,view);
    const entrance=[...motion.running].find(animation=>animation.element.classList.contains('album-arrival'));
    assert.equal(entrance.options.duration,1400);
    assert.equal(entrance.frames[1].offset,1000/1400,'The slide occupies the first second of the common timeline');
    assert.deepEqual([...motion.running].map(animation=>JSON.stringify(animation.frames)),reversedFrames,'Close reuses the exact opening frames and easing');
    assert.ok([...motion.running].every(animation=>animation.options.direction==='normal'));
    assert.match(entrance.frames[0].transform,/translateY\([1-9]/);assert.equal(entrance.frames.at(-1).transform,'translateY(0px)');
    const arrived=$('album-pages').firstElementChild;
    press('ArrowRight');assert.equal(motion.running.size,3);
    await motion.finish();assert.equal($('photo-panel').dataset.motion,'');assert.equal($('album-book').inert,false);
    if(view==='sheet')assert.equal($('photo-scroll').scrollTop,180,'All Photos reopens at the same prints');
    assert.equal($('album-pages').firstElementChild,arrived,'Opening hands back the same live spread, without replacing photos');
    $('album-view').click();await motion.finish();await motion.finish();assert.equal(pages(),bookmark);
  }
});

test('closing halfway through opening reverses that same cover and preserves the bookmark',async t=>{
  const {w,$,press,pages,tab}=await setup(t);
  tab(madrid.id).click();const bookmark=pages();press('Escape');const motion=controlledMotion(w);
  $('photos-button').click();await wait(()=>motion.running.size===3);
  const scene=$('album-book').querySelector('.album-cover-scene'),animations=[...motion.running];
  press('Escape');assert.equal($('photo-panel').dataset.motion,'closing');
  assert.equal($('album-book').querySelector('.album-cover-scene'),scene);
  assert.ok(animations.every(animation=>animation.reversed),'Reverse in place, without replacing any page');
  assert.ok(animations.every(animation=>animation.playbackRate===undefined),'Reversing preserves the opening speed');
  await motion.finish();await motion.finish();await motion.finish();assert.equal($('photo-panel').open,false);
  $('photos-button').click();await wait(()=>motion.running.size===3);await motion.finish();assert.equal(pages(),bookmark);
  w.matchMedia=()=>({matches:true});press('Escape');assert.equal($('photo-panel').open,false);
  $('photos-button').click();await wait(()=>!$('photo-panel').dataset.motion);
  assert.equal(pages(),bookmark);assert.equal(motion.running.size,0);
});

test('dismissal while storage is loading never reveals late pages or reopens the album',async t=>{
  const {w,$,press,storage,api}=await setup(t);press('Escape');
  const motion=controlledMotion(w);let release;
  storage.api=async(path,options)=>{await new Promise(resolve=>release=resolve);return api(path,options);};
  $('photos-button').click();await wait(()=>!!release);assert.ok($('album-book').querySelector('.album-loading-cover'));
  press('Escape');await wait(()=>!$('photo-panel').open);
  assert.equal($('photo-panel').open,false);release();await tick();
  assert.equal($('photo-panel').open,false);assert.equal($('album-book').querySelector('.album-cover-scene'),null);
  assert.equal($('album-book').querySelector('.album-loading-cover'),null);
});

test('single-page opening and All Photos use the same cover lifecycle and defer redraws',async t=>{
  const {w,$,press}=await setup(t);press('Escape');w.innerWidth=480;w.innerHeight=800;
  const motion=controlledMotion(w);$('photos-button').click();await wait(()=>motion.running.size===3);
  const scene=$('album-book').querySelector('.album-cover-scene');assert.ok(scene.classList.contains('single'));
  const copy=scene.querySelector('.album-snapshot');
  w.dispatchEvent(new w.Event('redline:routechange'));w.dispatchEvent(new w.Event('resize'));await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(scene.querySelector('.album-snapshot'),copy,'Background updates cannot replace moving surfaces');
  await motion.finish();assert.equal($('album-pages').classList.contains('single'),true);
  $('sheet-view').click();await motion.finish();await motion.finish();$('photo-scroll').scrollTop=240;press('Escape');await wait(()=>motion.running.size===3);
  const scroll=$('album-book').querySelector('.album-cover-scene .photo-scroll');assert.equal(scroll.scrollTop,240,'Closing keeps the visible scroll position');
  await motion.finish();await motion.finish();await motion.finish();assert.equal($('photo-panel').open,false);
});

test('postcard Save commits immediately, keeps failed drafts, and the back controls stay in reading order',async t=>{
  const {w,$,api,storage,trip,tiles}=await setup(t);
  tiles()[0].click();$('flip-postcard').click();
  assert.deepEqual([...w.document.querySelectorAll('.postcard-actions button')].map(el=>el.textContent),['← Photo','Print','Share','Save']);
  const photo=(await api(`/trips/${trip.id}`)).photos.find(p=>p.stopId===paris.id);
  const message=$('postcard-message');message.value='An afternoon on the river.';message.dispatchEvent(new w.Event('input'));
  let requested=false;storage.api=async(path,options)=>{if(path.endsWith('/postcard'))requested=true;return api(path,options);};
  $('save-postcard').click();assert.equal(requested,true,'Save does not wait for the autosave debounce');
  await wait(()=>$('postcard-save-status').textContent==='Postcard saved.');
  assert.equal((await api(`/trips/${trip.id}`)).photos.find(p=>p.id===photo.id).postcard.message,message.value);
  message.value='A second note.';message.dispatchEvent(new w.Event('input'));
  storage.api=async()=>{throw Error('Storage unavailable.');};$('save-postcard').click();
  await wait(()=>$('postcard-error').textContent==='Storage unavailable.');
  assert.equal($('photo-viewer').open,true);assert.equal(message.value,'A second note.');assert.equal($('postcard-saved').textContent,'');
  storage.api=api;$('save-postcard').click();await wait(()=>$('postcard-save-status').textContent==='Postcard saved.');
  await w.RedlinePostcards.close();tiles()[0].click();$('flip-postcard').click();assert.equal(message.value,'A second note.');
});


test('the left log edits the actual map route with drag, keyboard reorder, delete, and save',async t=>{
  const rome={id:'city-rome-0001',name:'Rome',country:'Italy',latitude:41.9,longitude:12.5};
  const {w,$,api,trip,press}=await setup(t,{realMap:true,seed:false,route:[paris,madrid,rome]});
  press('Escape');$('trips-button').click();
  assert.equal($('trip-panel').parentElement,$('route-dock').parentElement,'The paper is outside the dock');
  assert.equal($('trip-panel').contains($('stop-list')),true);assert.equal($('route-stops-panel').hidden,false,'An old collapsed preference cannot hide the log');
  const order=()=>Array.from(w.RedlineApp.getStops(),stop=>stop.name);
  let grip=$('stop-list').children[0].querySelector('.stop-grip');grip.focus();press('ArrowDown',grip,{altKey:true});
  assert.deepEqual(order(),['Madrid','Paris','Rome']);assert.equal($('trip-panel').hidden,false);
  const pointer=(type,x,y)=>{const event=new w.MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(event,'pointerId',{value:1});return event;};
  grip=$('stop-list').children[2].querySelector('.stop-grip');w.document.elementFromPoint=()=>$('stop-list').children[0];
  grip.dispatchEvent(pointer('pointerdown',150,350));grip.dispatchEvent(pointer('pointermove',150,250));
  assert.match(w.document.querySelector('.stop-drag-preview').textContent,/Rome/,'A held city visibly follows the pointer');
  grip.dispatchEvent(pointer('pointerup',150,250));assert.deepEqual(order(),['Rome','Madrid','Paris']);assert.equal(w.document.querySelector('.stop-drag-preview'),null);
  $('stop-list').children[1].querySelector('.remove-stop').click();assert.deepEqual(order(),['Rome','Paris']);
  assert.equal($('save-trip').classList.contains('dirty'),true);
  $('save-trip').click();await wait(()=>$('save-trip-label').textContent==='Saved'&&$('trip-list').querySelector('.trip-card.active .trip-meta')?.textContent.startsWith('2 stops'));
  assert.ok($('save-trip').querySelector('svg'),'Saving preserves the floppy icon');
  assert.deepEqual((await api(`/trips/${trip.id}`)).trip.stops.map(stop=>stop.name),['Rome','Paris']);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('redline-route-v1')).map(stop=>stop.name),['Rome','Paris']);
  $('stop-list').children[1].querySelector('.stop-grip').click();assert.equal($('map').dataset.tripStep,'2','A line in the log still visits its city');
});

test('L and A toggle their panels while former keys and text editing are left alone',async t=>{
  const {w,$,press,tiles}=await setup(t);
  press('a');assert.equal($('photo-panel').open,false);
  press('t');press('p');assert.equal($('trip-panel').hidden,true);assert.equal($('photo-panel').open,false);
  press('l');assert.equal($('trip-panel').hidden,false);press('l');assert.equal($('trip-panel').hidden,true);
  press('A');await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
  tiles()[0].click();$('flip-postcard').click();$('postcard-message').focus();press('a',$('postcard-message'));
  assert.equal($('photo-viewer').open,true,'Letters in a postcard are text, not shortcuts');
  $('unflip-postcard').focus();press('a',$('unflip-postcard'));await wait(()=>!$('photo-viewer').open&&!$('photo-panel').open);
  assert.equal($('trips-button').getAttribute('aria-keyshortcuts'),'L');assert.equal($('photos-button').getAttribute('aria-keyshortcuts'),'A');
});

test('trip switching is at the top, and the lower list contains only actual exports or imports',async t=>{
  const {w,$,api,trip,press}=await setup(t,{seed:false});press('Escape');
  const other=(await api('/trips',{method:'POST',body:JSON.stringify({title:'A different trip',stops:[madrid]})})).trip;
  $('trips-button').click();await wait(()=>$('trip-list').children.length===2);
  assert.equal($('trip-list').closest('details'),$('trip-switcher'));
  assert.ok($('trip-switcher').compareDocumentPosition($('trip-name-form'))&w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal($('backup-list').querySelectorAll('button').length,0,'Old exports are not guessed');
  let downloaded=0;w.HTMLAnchorElement.prototype.click=function(){downloaded++;};
  $('export-trip').click();await wait(()=>$('backup-list').querySelectorAll('button').length===1);
  assert.equal(downloaded,1);assert.match($('backup-list').textContent,/A summer away.*Exported/);
  $('backup-trips').click();await wait(()=>$('backup-list').querySelectorAll('button').length===2);
  assert.equal(downloaded,2);
  $('trip-switcher').open=true;$('trip-list').querySelector(`[data-trip-id="${other.id}"] .trip-open`).click();
  await wait(()=>$('trip-title').textContent==='A different trip');assert.equal($('trip-panel').hidden,true);
  assert.equal((await api(`/trips/${trip.id}`)).trip.title,'A summer away');
});

test('route undo restores cleared and edited stops, survives saving, and never crosses trips or native text undo',async t=>{
  const {w,$,api,trip,press}=await setup(t,{realMap:true,seed:false});press('Escape');$('trips-button').click();
  const route=()=>Array.from(w.RedlineApp.getStops(),stop=>stop.id);
  $('clear').click();assert.deepEqual(route(),[]);assert.equal(w.document.activeElement,$('undo-route'));
  press('z',w.document.activeElement,{ctrlKey:true});assert.deepEqual(route(),[paris.id,madrid.id]);
  press('z',$('trip-panel'),{metaKey:true,shiftKey:true});assert.deepEqual(route(),[]);
  $('undo-route').click();assert.deepEqual(route(),[paris.id,madrid.id]);
  let grip=$('stop-list').children[0].querySelector('.stop-grip');press('ArrowDown',grip,{altKey:true});assert.deepEqual(route(),[madrid.id,paris.id]);
  $('stop-list').children[0].querySelector('.remove-stop').click();assert.deepEqual(route(),[paris.id]);
  $('save-trip').click();await wait(()=>!$('save-trip').disabled&&$('save-trip-label').textContent==='Saved');
  assert.deepEqual((await api(`/trips/${trip.id}`)).trip.stops.map(stop=>stop.id),[paris.id]);
  $('undo-route').click();assert.deepEqual(route(),[madrid.id,paris.id],'Saving does not erase route undo');
  $('undo-route').click();assert.deepEqual(route(),[paris.id,madrid.id]);
  $('trip-name').focus();const native=new w.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});$('trip-name').dispatchEvent(native);
  assert.equal(native.defaultPrevented,false);assert.deepEqual(route(),[paris.id,madrid.id]);
  w.RedlineApp.addCity({name:'Rome',country:'Italy',latitude:41.9,longitude:12.5});$('undo-route').click();assert.deepEqual(route(),[paris.id,madrid.id]);
  // A new edit after Undo discards Redo, rather than reviving a removed branch of history.
  $('clear').click();press('z',$('trip-panel'),{metaKey:true,shiftKey:true});assert.deepEqual(route(),[]);
  const other=(await api('/trips',{method:'POST',body:JSON.stringify({title:'Other',stops:[madrid]})})).trip;
  $('trips-button').click();$('trips-button').click();await wait(()=>$('trip-list').querySelector(`[data-trip-id="${other.id}"] .trip-open`));
  $('trip-list').querySelector(`[data-trip-id="${other.id}"] .trip-open`).click();await wait(()=>$('trip-title').textContent==='Other');
  press('z',$('map'),{ctrlKey:true});assert.deepEqual(route(),[madrid.id]);assert.equal($('undo-route').disabled,true);
});

test('photo arrows rest after pointer inactivity and return on movement, without hiding keyboard controls',async t=>{
  const {w,$,tiles}=await setup(t);const realTimeout=w.setTimeout.bind(w),realClear=w.clearTimeout.bind(w),timers=new Map();let next=50000;
  w.setTimeout=(fn,delay,...args)=>{if(delay!==700)return realTimeout(fn,delay,...args);timers.set(++next,fn);return next;};
  w.clearTimeout=id=>{timers.delete(id);realClear(id);};
  tiles()[0].click();const frame=$('full-photo').parentElement;
  const move=pointerType=>{const event=new w.Event('pointermove',{bubbles:true});Object.defineProperty(event,'pointerType',{value:pointerType});frame.dispatchEvent(event);};
  move('mouse');assert.equal(timers.size,1);[...timers.values()][0]();assert.equal(frame.classList.contains('arrows-idle'),true);
  move('mouse');assert.equal(frame.classList.contains('arrows-idle'),false);assert.equal(timers.size,1);
  $('viewer-next').focus();assert.equal(frame.classList.contains('arrows-idle'),false);
  assert.match(source('public/gallery.css'),/\.viewer-photo\.arrows-idle \.viewer-edge:not\(:focus-visible\)/,'A focused keyboard control remains visible');
  move('touch');assert.equal(timers.size,0,'Touch does not require a moving cursor');
  await w.RedlinePostcards.close();assert.equal(timers.size,0);
});

test('front and back cover bookmarks close cleanly and return to the same cover',async t=>{
  for(const end of ['Home','End']){
    const {w,$,press,pages}=await setup(t);press(end);const bookmark=pages(),motion=controlledMotion(w);
    press('Escape');await wait(()=>motion.running.size>0);
    const scene=$('album-book').querySelector('.album-cover-scene');assert.ok(scene.classList.contains('closed-book'));
    await motion.finish();await motion.finish();await motion.finish();assert.equal($('photo-panel').open,false);
    $('photos-button').click();await wait(()=>motion.running.size===3);await motion.finish();assert.equal(pages(),bookmark);
  }
});


test('cover snapshots omit offscreen photos while retaining sheet layout and scroll',async t=>{
  const {w,$,tiles}=await setup(t);tiles();const source=$('album-sheet'),scroll=$('photo-scroll'),all=[...source.querySelectorAll('.photo-tile')];
  const rect=(top,height)=>({top,bottom:top+height,left:0,right:600,width:600,height});
  source.getBoundingClientRect=()=>({...rect(0,600),width:600.5});scroll.getBoundingClientRect=()=>rect(50,500);scroll.scrollTop=123;
  source.querySelectorAll('.gallery-city').forEach(section=>section.getBoundingClientRect=()=>rect(0,1000));
  all.forEach((tile,i)=>tile.getBoundingClientRect=()=>rect(i===0?80:900,100));
  const cover=w.document.createElement('section');cover.className='album-cover';
  const scene=w.RedlineAlbumMotion.create({book:$('album-book'),source,cover,two:true});
  const copies=$('album-book').querySelectorAll('.album-snapshot');assert.equal(copies.length,2);
  for(const copy of copies){assert.equal(copy.style.width,'600.5px');assert.equal(copy.querySelectorAll('img').length,1);assert.equal(copy.querySelectorAll('.photo-tile').length,all.length);assert.equal(copy.querySelector('.photo-scroll').scrollTop,123);}
  scene.dispose();assert.equal(source.querySelectorAll('img').length,all.length,'Original photos stay intact');
});


test('caption editing stays on the photo front, persists separately, and updates the album print',async t=>{
  const {w,$,tab,prints,api,trip,press,storage}=await setup(t);
  tab(paris.id).click();const print=prints()[0].closest('.print'),id=print.dataset.photoId;prints()[0].click();
  const input=$('caption-input'),type=text=>{input.value=text;input.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const footer=$('edit-caption').parentElement.parentElement,tools=$('edit-caption').parentElement;
  $('edit-caption').click();assert.equal($('caption-form').hidden,false);assert.equal(w.document.activeElement,input);
  assert.equal(footer.nextElementSibling,$('caption-form'));assert.equal(footer.contains($('photo-caption')),true);assert.equal($('photo-caption').hidden,false);assert.equal($('photo-caption').textContent,'Paris');assert.equal($('edit-caption').parentElement,tools);
  assert.equal($('photo-viewer').classList.contains('flipped'),false);
  type('Sunrise by the river.');$('save-caption').click();await wait(()=>$('caption-form').hidden);
  assert.equal(print.querySelector('figcaption').textContent,'Sunrise by the river.');assert.equal($('photo-caption').textContent,'Paris','The city name stays after saving a caption');
  assert.equal($('photo-note').hidden,false);assert.equal($('photo-note').textContent,'Sunrise by the river.');
  assert.equal($('photo-caption').nextElementSibling,$('photo-note'));assert.equal(footer.contains($('photo-note')),true,'City and caption share the existing footer');
  assert.equal($('photo-note').tagName,'SPAN');assert.equal($('photo-caption').tagName,'SPAN');assert.equal($('photo-note').parentElement.tagName,'P','Both texts belong to one horizontal paragraph');
  $('flip-postcard').click();$('postcard-message').value='Dear family, this message is private.';$('postcard-message').dispatchEvent(new w.Event('input'));$('save-postcard').click();
  await wait(()=>$('postcard-save-status').textContent==='Postcard saved.');
  assert.equal(print.querySelector('figcaption').textContent,'Sunrise by the river.');
  const photo=(await api(`/trips/${trip.id}`)).photos.find(p=>p.id===id);assert.equal(photo.caption,'Sunrise by the river.');assert.match(photo.postcard.message,/Dear family/);
  $('unflip-postcard').click();$('edit-caption').click();type('The next morning.');
  let fail=true;storage.api=async(path,options)=>{if(fail&&path.endsWith('/caption'))throw Error('Caption could not be saved.');return api(path,options);};
  $('viewer-next').click();await wait(()=>$('postcard-error').textContent==='Caption could not be saved.');
  assert.equal($('photo-position').textContent,'1 / 2');assert.equal(input.value,'The next morning.');
  assert.equal(print.querySelector('figcaption').textContent,'Sunrise by the river.','Failed drafts do not overwrite the saved album caption');
  fail=false;$('save-caption').click();await wait(()=>$('caption-form').hidden);
  await w.RedlinePostcards.close();prints()[0].click();assert.equal($('photo-note').textContent,'The next morning.');assert.equal($('photo-caption').textContent,'Paris');
  $('edit-caption').click();assert.equal(input.value,'The next morning.');assert.equal($('photo-note').hidden,true,'The editor replaces the caption line, keeping the city and tools fixed');
  type('');$('save-caption').click();await wait(()=>$('caption-form').hidden);assert.equal(print.querySelector('figcaption'),null);
  assert.equal($('photo-note').hidden,true);assert.equal($('photo-caption').textContent,'Paris');
  assert.match((await api(`/trips/${trip.id}`)).photos.find(p=>p.id===id).postcard.message,/Dear family/);
  $('edit-caption').click();assert.equal($('save-caption').disabled,false,'Save can finish an editor whose caption already autosaved');type('A final caption.');press('Escape',input);await wait(()=>$('caption-form').hidden);assert.equal($('photo-viewer').open,true);
});

test('city tabs identify their actual chapter page in both album layouts',async t=>{
  const {w,$,tab}=await setup(t);
  for(const city of [paris,madrid]){
    const button=tab(city.id);button.click();
    const page=[...$('album-pages').children].find(el=>el.querySelector('.city-name')?.textContent===city.name);
    assert.equal(Number(button.querySelector('.chip-stop').textContent),Number(page.querySelector('.folio').textContent));
    assert.match(button.getAttribute('aria-label'),/page \d+/);
  }
  w.innerWidth=480;w.innerHeight=800;w.dispatchEvent(new w.Event('resize'));await new Promise(resolve=>setTimeout(resolve,30));
  for(const city of [paris,madrid]){
    tab(city.id).click();assert.equal(Number(tab(city.id).querySelector('.chip-stop').textContent),Number($('album-pages').querySelector('.folio').textContent));
  }
});

test('cover motion waits for decoded snapshots and can close before its first moving frame',async t=>{
  const {w,$,press,tab}=await setup(t);tab(paris.id).click();press('Escape');
  const motion=controlledMotion(w),originalDecode=w.HTMLImageElement.prototype.decode,releases=[];
  w.HTMLImageElement.prototype.decode=function(){return this.closest('.album-snapshot')?new Promise(resolve=>releases.push(resolve)):Promise.resolve();};
  $('photos-button').click();await wait(()=>releases.length>0);
  assert.equal(motion.running.size,0,'No moving frame precedes the decoded spread');
  assert.ok($('album-book').querySelector('.album-loading-cover'),'The original closed cover stays visible during preparation');
  const scene=$('album-book').querySelector('.album-cover-scene');assert.equal(scene.style.visibility,'hidden');
  // Release every pending decode, including a second snapshot of the spread.
  w.HTMLImageElement.prototype.decode=originalDecode;
  press('Escape');assert.equal($('photo-panel').dataset.motion,'closing');
  releases.forEach(resolve=>resolve());await wait(()=>!$('photo-panel').open);
  assert.equal(motion.running.size,0,'A book that never entered does not flash onscreen to leave');
  assert.equal($('album-book').querySelector('.album-cover-scene'),null);
});


test('switching Album and All Photos animates both directions and handles rapid changes and dismissal',async t=>{
  const {w,$,press,pages}=await setup(t),motion=controlledMotion(w),bookmark=pages();
  $('sheet-view').click();assert.equal($('album-book').inert,true);await wait(()=>motion.running.size===4);
  assert.equal($('album-book').dataset.mode,'sheet');
  assert.ok([...motion.running].every(animation=>animation.element!==$('album-book')),'The binding and tabs never fade out or wobble');
  const outgoing=$('album-book').querySelector('.album-view-layer');assert.ok(outgoing);assert.equal(outgoing.querySelectorAll('[id]').length,0);
  const leaf=[...motion.running].find(animation=>animation.element.classList.contains('album-view-leaf'));
  assert.deepEqual(Array.from(leaf.frames,frame=>frame.transform),['rotateY(0deg)','rotateY(-180deg)']);
  assert.ok(outgoing.querySelector('.album-view-front .album-page'));assert.ok(outgoing.querySelector('.album-view-back .album-copy-album-sheet'));
  assert.equal(outgoing.querySelectorAll('.album-copy-album-pages').length,0,'Native half-pages keep the same geometry as a chapter turn');
  assert.equal($('album-sheet').style.visibility,'','The live sheet stays painted beneath the opaque moving leaf');
  assert.equal(outgoing.querySelectorAll('.album-copy-album-sheet').length,1,'Only the turning half needs a copied destination; stationary photos stay live');
  await wait(()=>[...outgoing.querySelectorAll('.photo-image')].every(button=>button.classList.contains('loaded')));
  await motion.finish();assert.equal($('album-book').inert,false);
  assert.equal($('album-book').querySelector('.album-view-layer'),null);
  $('album-view').click();$('sheet-view').click();await motion.finish();await motion.finish();
  await motion.finish();
  assert.equal($('album-book').dataset.mode,'sheet','The most recent choice wins during a transition');
  $('album-view').click();await motion.finish();await motion.finish();assert.equal(pages(),bookmark);
  $('sheet-view').click();press('Escape');await wait(()=>[...motion.running].some(animation=>animation.element.classList.contains('album-cover-leaf')));
  await motion.finish();await motion.finish();await motion.finish();assert.equal($('photo-panel').open,false);
  assert.equal($('album-book').querySelector('.album-arrival'),null);
  assert.equal($('album-book').querySelector('.album-view-layer'),null);
});

test('a stalled image has a bounded preparation window and late results cannot revive a turn',async t=>{
  const {w,$,press,tab}=await setup(t);tab(paris.id).click();const motion=controlledMotion(w),decode=w.HTMLImageElement.prototype.decode,releases=[];
  w.HTMLImageElement.prototype.decode=function(){return this.closest('#album-sheet')?new Promise(resolve=>releases.push(resolve)):decode.call(this);};
  $('sheet-view').click();assert.equal(motion.running.size,0,'The old spread remains still while the next page prepares');
  assert.ok(releases.length>0);const old=$('album-book').querySelector('.album-view-layer');assert.ok(old.querySelector('.print'));
  assert.equal($('album-sheet').style.visibility,'','The incoming sheet remains painted even if one bitmap stalls');
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(motion.running.size,0,'A slow bitmap must not turn as a blank print after the old 240ms deadline');
  await wait(()=>!old.isConnected);assert.equal(motion.running.size,0,'A stalled decoder uses a direct switch, never an incomplete page turn');assert.equal(old.isConnected,false);assert.equal($('album-sheet').style.visibility,'');assert.equal($('album-book').inert,false,'A stalled decoder cannot trap the gallery');
  w.HTMLImageElement.prototype.decode=decode;releases.forEach(resolve=>resolve());await tick();assert.equal(motion.running.size,0);assert.equal(old.isConnected,false);
  $('photo-scroll').scrollTop=160;$('album-view').click();
  assert.equal($('album-book').querySelector('.album-copy-photo-scroll').scrollTop,160,'Outgoing prints retain their exact scroll position');
  press('Escape');await wait(()=>motion.running.size===3);await motion.finish();
  assert.equal($('photo-panel').open,false);assert.equal($('album-book').querySelector('.album-view-layer'),null);assert.equal($('album-pages').style.visibility,'');
});

test('album chapters distribute portrait and landscape prints without changing library order',async t=>{
  const sizes=[...Array.from({length:3},()=>[800,1200]),...Array.from({length:8},()=>[1200,800])];
  const {w,$,tab,press,api,trip,prints}=await setup(t,{route:[paris],seedStops:sizes.map(()=>paris),seedSizes:sizes});
  const original=Array.from((await api(`/trips/${trip.id}`)).photos),byId=new Map(original.map(photo=>[photo.id,photo]));
  const read=()=>{
    const found=[],seen=new Set();tab(paris.id).click();
    for(let page=0;page<20&&!$('album-next').disabled;page++){
      for(const page of $('album-pages').querySelectorAll('.page-city')){
        const ids=[...page.querySelectorAll('.print')].map(print=>print.dataset.photoId);
        if(ids.some(id=>seen.has(id)))continue;
        ids.forEach(id=>seen.add(id));found.push(ids);
      }
      press('ArrowRight');
    }
    assert.equal($('album-next').disabled,true,'Browsing reaches the back cover');
    return found;
  };
  const groups=read(),ordered=groups.flat();assert.deepEqual(groups.map(group=>group.length),[3,4,4]);
  assert.equal(new Set(ordered).size,11);
  for(const group of groups)assert.deepEqual(new Set(group.map(id=>byId.get(id).height>byId.get(id).width)),new Set([true,false]),'Each page has both orientations when available');
  assert.deepEqual(ordered.filter(id=>byId.get(id).height>byId.get(id).width),original.filter(photo=>photo.height>photo.width).map(photo=>photo.id));
  tab(paris.id).click();const first=prints()[0].closest('.print').dataset.photoId;prints()[0].click();
  assert.equal($('photo-position').textContent,'1 / 11');$('viewer-next').click();await wait(()=>$('photo-position').textContent==='2 / 11');
  await w.RedlinePostcards.close();press('Escape');$('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);assert.deepEqual(read().flat(),ordered,'Reopening preserves the arrangement');
  assert.equal(ordered[0],first);$('sheet-view').click();assert.deepEqual([...$('photo-gallery').querySelectorAll('.photo-tile')].map(tile=>tile.dataset.photoId),original.map(photo=>photo.id),'All Photos retains original chronological order');
  assert.deepEqual(Array.from((await api(`/trips/${trip.id}`)).photos,photo=>photo.id),original.map(photo=>photo.id),'No stored order is changed');
});

test('single-page view changes turn paper in both directions and settle safely on resize',async t=>{
  const {w,$,pages}=await setup(t);
  Object.defineProperty(w,'innerWidth',{configurable:true,writable:true,value:700});w.dispatchEvent(new w.Event('resize'));await wait(()=>pages().startsWith('single:'));
  const motion=controlledMotion(w);
  for(const view of ['sheet','album']){
    $(view+'-view').click();await wait(()=>motion.running.size===1);
    const layer=$('album-book').querySelector('.album-view-layer');assert.ok(layer.classList.contains('single'));
    const leaf=[...motion.running].find(animation=>animation.element.classList.contains('album-view-leaf'));
    const frames=Array.from(leaf.frames,frame=>frame.transform);
    assert.deepEqual(frames,view==='sheet'?['perspective(1600px) rotateY(0deg)','perspective(1600px) rotateY(-82deg)']:['perspective(1600px) rotateY(-82deg)','perspective(1600px) rotateY(0deg)']);
    assert.equal(leaf.options.duration,560,'Use the ordinary single-page turn timing');
    await motion.finish();assert.equal(layer.isConnected,false);assert.equal($('album-book').dataset.mode,view);
  }
  $('sheet-view').click();await wait(()=>motion.running.size===1);
  Object.defineProperty(w,'innerWidth',{configurable:true,writable:true,value:1024});w.dispatchEvent(new w.Event('resize'));
  await wait(()=>!$('album-book').dataset.viewMotion);assert.equal(motion.running.size,0);assert.equal($('album-sheet').style.visibility,'');
  assert.equal($('album-book').querySelector('.album-view-layer'),null);assert.equal($('album-book').inert,false);
});


test('long chapters intersperse three-print pages among mostly four-print pages without losing photos',async t=>{
  const {w,$,tab,press,api,trip}=await setup(t,{route:[paris],seedStops:Array.from({length:75},()=>paris)});
  Object.defineProperty(w,'innerWidth',{configurable:true,writable:true,value:700});w.dispatchEvent(new w.Event('resize'));await wait(()=>$('album-pages').classList.contains('single'));
  const ids=[],counts=[];tab(paris.id).click();
  for(let i=0;i<40&&!$('album-next').disabled;i++){
    const prints=[...$('album-pages').querySelectorAll('.print')];
    if(prints.length){counts.push(prints.length);ids.push(...prints.map(print=>print.dataset.photoId));}
    press('ArrowRight');
  }
  assert.equal(ids.length,75);assert.equal(new Set(ids).size,75);
  assert.ok(counts.filter(n=>n===4).length>counts.length/2,'Four prints remain the majority');
  assert.ok(counts.slice(3,-1).includes(3),'Three-print pages recur inside the chapter');
  assert.ok(counts.every(n=>n>=2&&n<=4),'No stray single-photo tail in this chapter');
  assert.deepEqual(new Set(ids),new Set(Array.from((await api(`/trips/${trip.id}`)).photos,photo=>photo.id)));
});

test('returning to All Photos reuses its images and refreshes notes changed in another tab',async t=>{
  const {w,$,api,trip,tiles,storage,press}=await setup(t);
  const first=tiles()[0],id=first.closest('.photo-tile').dataset.photoId;
  $('album-view').click();$('sheet-view').click();assert.equal(tiles()[0],first,'Unchanged images and handlers are retained');
  const {photos}=await api(`/trips/${trip.id}`),photo=photos.find(photo=>photo.id===id);
  await api(`/photos/${id}/caption`,{method:'PUT',body:JSON.stringify({caption:'Changed elsewhere',revision:photo.captionRevision})});
  press('Escape');$('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
  const replacement=tiles().find(button=>button.closest('.photo-tile').dataset.photoId===id);
  assert.notEqual(replacement,first,'Changed notes invalidate the retained gallery');replacement.click();
  assert.equal($('photo-note').textContent,'Changed elsewhere');
});

test('a large All Photos turn locates visible rows without measuring or cloning the entire gallery',async t=>{
  const {w,$,tiles}=await setup(t,{route:[paris],seedStops:Array.from({length:80},()=>paris)});tiles();
  const source=$('album-sheet'),scroll=$('photo-scroll'),all=[...source.querySelectorAll('.photo-tile')];
  const rect=(top,height)=>({top,bottom:top+height,left:0,right:600,width:600,height});
  source.getBoundingClientRect=()=>rect(0,600);scroll.getBoundingClientRect=()=>rect(50,500);scroll.scrollTop=140;
  let reads=0;const decodes=new Map();
  source.querySelectorAll('.gallery-city').forEach(section=>section.getBoundingClientRect=()=>rect(0,4000));
  all.forEach((tile,i)=>tile.getBoundingClientRect=()=>{reads++;return rect(i<6?80:900+i*100,100);});
  w.HTMLImageElement.prototype.decode=function(){decodes.set(this.src,(decodes.get(this.src)||0)+1);return Promise.resolve();};
  const motion=controlledMotion(w);$('album-view').click();await wait(()=>motion.running.size===4);
  assert.ok(reads<=16,'Binary row lookup skips offscreen photos; both halves reuse the measurements');
  assert.equal(decodes.size,6,'Only visible photos need decoding');
  assert.ok([...decodes.values()].every(count=>count===3),'The live image and both actual page faces are decoded before moving');
  assert.equal($('album-book').querySelectorAll('.album-view-layer img').length,12,'Offscreen photographs are absent from moving surfaces');
  await motion.finish();assert.equal(source.querySelectorAll('img').length,80);
});

test('contact-sheet turns freeze sticky headings and visible prints at their exact scrolled positions',async t=>{
  const {w,$,tiles}=await setup(t,{route:[paris],seedStops:Array.from({length:300},()=>paris)});tiles();
  const source=$('album-sheet'),scroll=$('photo-scroll'),section=source.querySelector('.gallery-city'),grid=section.querySelector('.photo-grid');
  const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
  source.getBoundingClientRect=()=>rect(40,40,800,600);scroll.getBoundingClientRect=()=>rect(40,100,800,540);scroll.scrollTop=5600;
  section.getBoundingClientRect=()=>rect(40,100-scroll.scrollTop,800,12900);
  section.querySelector('.gallery-city-heading').getBoundingClientRect=()=>rect(40,100,800,60);
  grid.style.gridTemplateColumns='150px 150px 150px 150px';
  const reads=new Map(),all=[...grid.children];
  all.forEach((tile,index)=>{tile.getBoundingClientRect=()=>{
    reads.set(index,(reads.get(index)||0)+1);
    return rect(68+(index%4)*176,180+Math.floor(index/4)*160-scroll.scrollTop,150,150);
  };});
  const motion=controlledMotion(w);$('album-view').click();await wait(()=>motion.running.size===4);
  const snapshots=[...$('album-book').querySelectorAll('.album-frozen-sheet')];assert.equal(snapshots.length,2);
  const captured=snapshots.flatMap(snapshot=>[...snapshot.querySelectorAll('.photo-tile')]),indices=[...new Set(captured.map(tile=>all.findIndex(original=>original.dataset.photoId===tile.dataset.photoId)))].sort((a,b)=>a-b);
  assert.deepEqual(indices,Array.from({length:20},(_,index)=>index+136),'The two halves retain every visible print');
  assert.equal(captured.length,25,'Only the five prints crossing the gutter are copied onto both faces');
  assert.ok(reads.size<35,'Work is bounded by the visible rows rather than all 300 photos');
  assert.ok([...reads.values()].every(count=>count===1),'No duplicate geometry reads or read/write layout loop');
  for(const snapshot of snapshots){
    const side=parseFloat(snapshot.style.left)<0;
    assert.equal(snapshot.querySelector('.album-copy-photo-scroll').scrollTop,0,'Moving paper has no active scroller');
    assert.equal(snapshot.querySelector('.gallery-city-heading').style.top,'0px','The pinned heading is frozen at the viewport top');
    const first=snapshot.querySelector('.photo-tile');
    assert.equal(first.style.left,side?'380px':'28px');assert.equal(first.style.top,'-80px');assert.equal(first.style.width,'150px');
    assert.equal(snapshot.querySelectorAll('.photo-tile').length,side?10:15);
    assert.equal(snapshot.querySelectorAll('[id]').length,0);
  }
  assert.equal(scroll.scrollTop,0,'The hidden live sheet can reset without moving the captured prints');
  await motion.finish();assert.equal(grid.children.length,300,'The live gallery is retained intact');
});


test('back up all saves the current route first and refuses to omit pending imports',async t=>{
  const {w,$,storage,trip,choose,press}=await setup(t,{seed:false});press('Escape');$('trips-button').click();
  let backup=null,downloads=0;const exportArchive=storage.exportArchive;
  storage.exportArchive=async id=>{backup=await exportArchive(id);return backup;};
  w.HTMLAnchorElement.prototype.click=()=>downloads++;
  w.RedlineApp.setStops([madrid,paris]);w.dispatchEvent(new w.Event('redline:routechange'));
  $('backup-trips').click();await wait(()=>$('backup-list').querySelectorAll('button').length===1);
  const records=await w.RedlineArchive.unpack(backup);assert.deepEqual(Array.from(records[0].trip.stops,stop=>stop.id),[madrid.id,paris.id]);assert.equal(downloads,1);
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);choose(['pending.jpg']);await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  press('Escape');$('trip-list').replaceChildren();$('trips-button').click();await wait(()=>$('trip-list').querySelector('.trip-card'));$('backup-trips').click();await wait(()=>$('trip-message').textContent==='Save the pending photos before exporting.');assert.equal(downloads,1);
});

test('browsing photos does not render large share exports until the postcard back is needed',async t=>{
  const {w,$,tiles}=await setup(t);let rendered=0;
  w.RedlinePostcardExport.render=()=>{rendered++;return {toBlob:callback=>callback(new Blob([jpeg],{type:'image/jpeg'}))};};
  tiles()[0].click();await tick();assert.equal(rendered,0);
  $('viewer-next').click();await wait(()=>$('photo-position').textContent==='2 / 2');assert.equal(rendered,0);
  $('flip-postcard').click();await wait(()=>!$('share-postcard').disabled);assert.equal(rendered,1);
  $('unflip-postcard').click();$('flip-postcard').click();await tick();assert.equal(rendered,1,'An unchanged postcard reuses its ready share file');
});


test('importing a batch appends new prints without rebuilding earlier previews',async t=>{
  const {w,$,choose}=await setup(t,{seed:false});const releases=[];
  w.createImageBitmap=()=>new Promise(resolve=>releases.push(()=>resolve({width:1600,height:1000,close(){}})));
  choose(['one.jpg','two.jpg','three.jpg']);await wait(()=>releases.length===1);releases.shift()();
  await wait(()=>$('photo-review').children.length===1&&releases.length===1);const first=$('photo-review').firstElementChild;
  releases.shift()();await wait(()=>$('photo-review').children.length===2&&releases.length===1);
  assert.equal($('photo-review').firstElementChild,first,'The first preview remains mounted while later files process');
  releases.shift()();await wait(()=>$('photo-review').children.length===3&&!$('choose-photos').disabled);
});


test('three-photo layouts alternate physical sides through long chapters',async t=>{
  const {w,$,tab,press}=await setup(t,{seedStops:[...Array.from({length:38},()=>paris),...Array.from({length:38},()=>madrid)]});
  const seen=new Set(),sides=[],counts=[];tab(paris.id).click();
  for(let i=0;i<40&&!$('album-next').disabled;i++){
    for(const page of $('album-pages').querySelectorAll('.page-city')){
      if(seen.has(page.dataset.page))continue;seen.add(page.dataset.page);
      const count=page.querySelectorAll('.print').length;counts.push(count);
      if(count===3)sides.push(page.classList.contains('left')?'left':'right');
    }
    press('ArrowRight');
  }
  assert.deepEqual(sides,['right','left','right','left']);
  assert.equal(counts.reduce((a,b)=>a+b,0),76);assert.ok(counts.filter(n=>n===4).length>counts.length/2);
});

test('view changes use the ordinary chapter leaf animation, without separate face opacity switches',async t=>{
  const {w,$,tab}=await setup(t,{route:[paris],seedStops:Array.from({length:38},()=>paris)});tab(paris.id).click();const motion=controlledMotion(w);
  $('album-next').click();assert.equal(motion.running.size,4);
  const ordinary=[...motion.running].map(animation=>({frames:animation.frames,options:animation.options}));await motion.finish();
  for(const [button,sign] of [['sheet-view',-1],['album-view',1]]){
    $(button).click();await wait(()=>motion.running.size===4);
    const animations=[...motion.running],leaf=animations[0];
    assert.ok(leaf.element.classList.contains('album-view-leaf'));
    assert.deepEqual(Array.from(leaf.frames,f=>f.transform),['rotateY(0deg)',`rotateY(${sign*180}deg)`]);
    animations.forEach((animation,i)=>{
      assert.equal(JSON.stringify(animation.options),JSON.stringify(ordinary[i].options));
      if(i)assert.equal(JSON.stringify(animation.frames),JSON.stringify(ordinary[i].frames));
    });
    assert.equal(animations.some(animation=>animation.element.classList.contains('album-view-face')),false,'Both faces travel on one physical leaf and one clock');
    await motion.finish();
  }
});


test('All Photos prepares while the album rests and reuses that sheet on the first switch',async t=>{
  const {$}=await setup(t);await wait(()=>$('photo-gallery').querySelector('.photo-image'));
  assert.equal($('album-sheet').hidden,true);const prepared=$('photo-gallery').firstElementChild;
  $('sheet-view').click();assert.equal($('photo-gallery').firstElementChild,prepared);assert.equal($('album-sheet').hidden,false);
});

test('the actual turning faces decode before movement even when image bytes are already complete',async t=>{
  const {w,$,tab}=await setup(t);tab(paris.id).click();const motion=controlledMotion(w),releases=[];
  Object.defineProperty(w.HTMLImageElement.prototype,'complete',{configurable:true,get:()=>true});
  w.HTMLImageElement.prototype.decode=function(){return this.closest('.album-view-layer')?new Promise(resolve=>releases.push(resolve)):Promise.resolve();};
  $('sheet-view').click();assert.equal(motion.running.size,0);assert.ok(releases.length>0,'Complete images still need a decoded bitmap');
  const layer=$('album-book').querySelector('.album-view-layer');assert.ok(layer);assert.equal($('album-book').inert,true);
  await tick();assert.equal(motion.running.size,0,'The paper cannot move before its images are ready');
  releases.forEach(resolve=>resolve());await wait(()=>motion.running.size===4);
  assert.ok([...layer.querySelectorAll('.photo-image')].every(image=>image.classList.contains('loaded')));
  await motion.finish();assert.equal($('album-book').inert,false);
});

test('closing during thumbnail preparation cancels the pending turn without late animation or image changes',async t=>{
  const {w,$,press}=await setup(t),motion=controlledMotion(w),releases=[];
  w.HTMLImageElement.prototype.decode=function(){return this.closest('.album-view-layer')?new Promise(resolve=>releases.push(resolve)):Promise.resolve();};
  $('sheet-view').click();const layer=$('album-book').querySelector('.album-view-layer');assert.equal(motion.running.size,0);
  press('Escape');await wait(()=>motion.running.size===3);await motion.finish();await wait(()=>!$('photo-panel').open);
  const before=[...layer.querySelectorAll('.photo-image')].map(image=>image.className);
  releases.forEach(resolve=>resolve());await tick();await tick();
  assert.equal(motion.running.size,0);assert.equal(layer.isConnected,false);
  assert.deepEqual([...layer.querySelectorAll('.photo-image')].map(image=>image.className),before);
});

test('thumbnail warming retains decoded images, bounds memory, retries failures, and releases on close',async t=>{
  const {w,$,press}=await setup(t),counts=new Map(),cache=w.RedlineAlbumMotion;
  cache.clearPreloads();
  w.HTMLImageElement.prototype.decode=function(){counts.set(this.src,(counts.get(this.src)||0)+1);return Promise.resolve();};
  const urls=Array.from({length:48},(_,i)=>`https://redline.test/thumb-${i}.jpg`);
  await cache.preload(urls);await cache.preload(urls);assert.equal([...counts.values()].reduce((a,b)=>a+b,0),48,'Warm images are retained and reused');
  await cache.preload(['https://redline.test/next.jpg']);await cache.preload([urls[0]]);assert.equal(counts.get(urls[0]),2,'The oldest thumbnail is evicted beyond the cache limit');
  let attempts=0;w.HTMLImageElement.prototype.decode=()=>++attempts===1?Promise.reject(Error('Temporary decoder failure')):Promise.resolve();
  await cache.preload(['https://redline.test/retry.jpg']);await cache.preload(['https://redline.test/retry.jpg']);assert.equal(attempts,2);
  press('Escape');assert.equal($('photo-panel').open,false);await cache.preload([urls[1]]);assert.equal(attempts,3,'Closing releases retained thumbnails');cache.clearPreloads();
});

test('thumbnail warming limits concurrent decodes so background work cannot flood the page turn',async t=>{
  const {w}=await setup(t),cache=w.RedlineAlbumMotion,releases=[];cache.clearPreloads();let active=0,peak=0;
  w.HTMLImageElement.prototype.decode=()=>new Promise(resolve=>{peak=Math.max(peak,++active);releases.push(()=>{active--;resolve();});});
  const ready=cache.preload(Array.from({length:12},(_,i)=>`https://redline.test/batch-${i}.jpg`));
  await tick();assert.equal(releases.length,3);
  for(let batch=0;batch<4;batch++){releases.splice(0).forEach(release=>release());await tick();}
  await ready;assert.equal(peak,3);cache.clearPreloads();
});

test('the atlas paints connected landmasses once and keeps country borders out of its colour fills',async t=>{
  const {w,$}=await setup(t,{realMap:true});
  const land=[...$('land').children];assert.equal(land.length,w.ATLAS_LAND.length);
  assert.ok(land.every((path,i)=>path.getAttribute('d')===w.ATLAS_LAND[i]));
  assert.equal($('country-borders').children.length,w.ATLAS_BORDERS.length);
  assert.ok(land.every(path=>!path.style.fill),'Plain vector fills never invoke an image-backed pattern for each landmass');
  assert.equal($('map').querySelectorAll('image').length,0,'The map has no raster wash or image-backed colour effects');
  assert.equal($('map').querySelectorAll('pattern image, filter, mask').length,0,'Zoom cannot allocate world-sized image pattern tiles or nested SVG documents');
  assert.equal($('atlas-land-clip'),null);assert.equal($('land-washes'),null,'Camera frames have no full-world gradient clipping passes');
});

test('photo-view turns pause background thumbnail work and resume it after settling or dismissal',async t=>{
  const {w,$,press}=await setup(t),motion=controlledMotion(w),cache=w.RedlineAlbumMotion;
  for(const dismiss of [false,true]){
    cache.clearPreloads();const releases=[];let started=0;
    w.HTMLImageElement.prototype.decode=function(){
      return this.src.includes('/idle-')?new Promise(resolve=>{started++;releases.push(resolve);}):Promise.resolve();
    };
    const warmed=cache.preload(Array.from({length:6},(_,i)=>`https://redline.test/idle-${dismiss}-${i}.jpg`));
    await tick();assert.equal(started,3);
    $(dismiss?'album-view':'sheet-view').click();await wait(()=>motion.running.size===4);
    releases.splice(0).forEach(resolve=>resolve());await tick();
    assert.equal(started,3,'No new background decode competes with the moving leaf');
    if(dismiss){press('Escape');await wait(()=>motion.running.size===3);}
    else await motion.finish();
    if(dismiss){
      await tick();assert.equal(started,3,'The closing cover also keeps background decoding paused');
      await motion.finish();await wait(()=>!$('photo-panel').open);await warmed;
      assert.equal(started,3,'Dismissal cancels queued previews instead of decoding an invisible gallery');
    }else{await wait(()=>started===6);releases.splice(0).forEach(resolve=>resolve());await warmed;}
  }
});

test('opening a cover carries its binding on the turning leaf and cleans up on reversal, resize, and dismissal',async t=>{
  const {w,$,press,pages}=await setup(t);press('Home');
  const motion=controlledMotion(w),book=$('album-book'),root=$('album-pages');
  $('album-next').click();assert.equal(motion.running.size,4);
  const leaf=root.querySelector('.cover-turn');assert.ok(leaf);
  assert.equal(leaf.querySelector('.leaf-front > .album-page').dataset.type,'cover');
  assert.equal(leaf.querySelector('.leaf-back > .album-page').dataset.type,'inside');
  assert.equal(root.querySelectorAll('.album-bound-page').length,4,'Backing is local to both stationary pages and both rotating faces');
  assert.equal(root.children[0].dataset.type,'void','No stationary board is exposed to the left of the opening cover');
  await motion.finish();assert.equal(pages(),'left:inside right:title');assert.equal(root.querySelector('.album-bound-page'),null);
  $('album-previous').click();assert.equal(root.querySelector('.leaf-back > .album-page').dataset.type,'cover');
  $('album-next').click();assert.equal(motion.running.size,4,'Reversal discards the previous leaf');
  await motion.finish();assert.equal(pages(),'left:inside right:title');
  press('End');await motion.finish();assert.equal(pages(),'left:back right:void');
  $('album-previous').click();assert.equal(root.querySelector('.leaf-front > .album-page').dataset.type,'back');
  w.dispatchEvent(new w.Event('resize'));await wait(()=>!root.querySelector('.cover-turn'));
  assert.equal(root.querySelector('.album-bound-page'),null);assert.equal(motion.running.size,0);
  press('Home');press('Escape');await wait(()=>motion.running.size===3);
  assert.equal(root.querySelector('.cover-turn'),null,'Closing the album settles a turning cover before capturing it');
  await motion.finish();await wait(()=>!$('photo-panel').open);assert.equal(book.querySelector('.album-bound-page'),null);
  Object.defineProperty(w,'innerWidth',{configurable:true,writable:true,value:700});
  $('photos-button').click();await wait(()=>motion.running.size===3);await motion.finish();
  assert.equal(pages(),'single:cover');$('album-next').click();assert.equal(motion.running.size,1);
  assert.ok(root.querySelector('.cover-turn.album-bound-page.single > .album-cover'));
  await motion.finish();assert.equal(pages(),'single:inside');assert.equal(root.querySelector('.album-bound-page'),null);
});

test('view faces stay in the same compositor stack from preparation through the final frame',async t=>{
  const {w,$,tab}=await setup(t);tab(paris.id).click();const motion=controlledMotion(w),releases=[];
  w.HTMLImageElement.prototype.decode=function(){return this.closest('.album-view-layer')?new Promise(resolve=>releases.push(resolve)):Promise.resolve();};
  $('sheet-view').click();const layer=$('album-book').querySelector('.album-view-layer'),leaf=layer.querySelector('.album-view-leaf');
  assert.ok(leaf,'The final hinged leaf exists before thumbnail decoding finishes');
  const images=[...layer.querySelectorAll('img')],parents=images.map(image=>image.parentNode);
  const changes=[],observer=new w.MutationObserver(records=>changes.push(...records));observer.observe(layer,{subtree:true,childList:true});
  assert.equal(motion.running.size,0);releases.forEach(resolve=>resolve());await wait(()=>motion.running.size===4);
  assert.equal(changes.length+observer.takeRecords().length,0,'Starting the turn does not remove, insert, or reparent any moving content');
  assert.ok(images.every((image,i)=>image.parentNode===parents[i]));assert.equal(layer.querySelector('.album-view-leaf'),leaf);
  observer.disconnect();await motion.finish();
});

test('view turns keep the live destination painted throughout and retire the old half before the final leaf, in both directions',async t=>{
  const {w,$,tab,press}=await setup(t);tab(paris.id).click();const motion=controlledMotion(w),nativeFrame=w.requestAnimationFrame;
  for(const [button,target] of [['sheet-view','album-sheet'],['album-view','album-pages']]){
    $(button).click();await wait(()=>motion.running.size===4);
    const layer=$('album-book').querySelector('.album-view-layer'),frames=[];
    assert.equal($(target).style.visibility,'','No hidden-to-visible layer replacement is needed at arrival');
    assert.equal($(target).hidden,false);
    w.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
    [...motion.running].forEach(animation=>animation.finish());await tick();
    assert.equal($(target).style.visibility,'','The live destination is ready beneath the last frame');
    assert.equal(layer.dataset.handoff,'true');assert.equal(layer.isConnected,true);
    assert.equal(layer.querySelector(':scope > .album-view-surface > .album-snapshot'),null,'The outgoing stationary half is retired while the final turning face still covers its side');
    frames.shift()(w.performance.now());await tick();
    assert.equal(layer.isConnected,true,'The completed leaf covers the live page for a full paint opportunity');
    frames.shift()(w.performance.now());await wait(()=>!layer.isConnected);
    assert.equal($('album-book').inert,false);w.requestAnimationFrame=nativeFrame;
  }
  $('sheet-view').click();await wait(()=>motion.running.size===4);
  const layer=$('album-book').querySelector('.album-view-layer'),frames=[];
  w.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
  [...motion.running].forEach(animation=>animation.finish());await tick();assert.equal(layer.dataset.handoff,'true');
  w.requestAnimationFrame=nativeFrame;press('Escape');frames.forEach(callback=>callback(w.performance.now()));
  await wait(()=>motion.running.size===3);await motion.finish();
  assert.equal($('photo-panel').open,false);assert.equal(layer.isConnected,false);
  assert.equal($('album-book').querySelector('.album-view-layer'),null,'A late handoff cannot revive a dismissed album');
});

test('closing releases gallery image elements while reopening restores saved photos and their city',async t=>{
  const {$,tiles,press,tab,api,trip}=await setup(t);tiles();tab(madrid.id).click();
  const before=await api(`/trips/${trip.id}`),ids=before.photos.map(photo=>photo.id);
  assert.equal($('photo-gallery').querySelectorAll('img').length,3);press('Escape');
  assert.equal($('photo-gallery').children.length,0,'The closed gallery no longer retains its decoded image elements');
  assert.equal($('album-pages').children.length,0);
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
  assert.equal($('photo-gallery').querySelectorAll('img').length,3);assert.equal(tab(madrid.id).getAttribute('aria-current'),'true');
  const after=await api(`/trips/${trip.id}`);assert.deepEqual(after.photos.map(photo=>photo.id),ids,'Releasing previews never deletes stored photos');
});

test('legacy thumbnail generation waits for a page turn to finish',async t=>{
  const {w,$,tab,storage,api}=await setup(t);tab(paris.id).click();const motion=controlledMotion(w);let writes=0;
  storage.api=(path,options)=>{if(path.endsWith('/thumb'))writes++;return api(path,options);};
  $('sheet-view').click();await wait(()=>motion.running.size===4);
  $('photo-gallery').querySelector('img').dispatchEvent(new w.Event('load'));
  await tick();await tick();assert.equal(writes,0,'Canvas encoding and IndexedDB writes wait while paper is moving');
  await motion.finish();await wait(()=>writes===1);
});

test('map frames read layout before painting, skip unchanged scenes, and defer hidden map work until the album closes',async t=>{
  const {w,$,press}=await setup(t,{realMap:true}),frames=new Map();let next=10000,time=w.performance.now();
  w.requestAnimationFrame=callback=>{const id=++next;frames.set(id,callback);return id;};w.cancelAnimationFrame=id=>frames.delete(id);
  const frame=()=>{time+=16;for(const id of [...frames.keys()]){const callback=frames.get(id);frames.delete(id);callback?.(time);}};
  press('Escape');await tick();frame();await tick();
  const map=$('map'),mutations=[],observer=new w.MutationObserver(records=>mutations.push(...records));observer.observe(map,{attributes:true,subtree:true});
  map.getScreenCTM=()=>{throw Error('Camera input must not force SVG layout');};
  w.RedlineApp.refreshLayout();frame();await tick();assert.equal(mutations.length,0,'An unchanged scene does not rewrite SVG geometry, labels, or dots');
  const read=w.Element.prototype.getBoundingClientRect,write=w.Element.prototype.setAttribute;let activity=[];
  w.Element.prototype.getBoundingClientRect=function(){activity.push('read');return read.call(this);};
  w.Element.prototype.setAttribute=function(...args){if(this===map||map.contains(this))activity.push('write');return write.apply(this,args);};
  $('zoom-in').click();
  for(let i=0;i<90;i++){
    activity=[];frame();const firstWrite=activity.indexOf('write');
    if(firstWrite>=0)assert.ok(!activity.slice(firstWrite).includes('read'),'A zoom frame never forces layout after changing SVG attributes');
  }
  await tick();assert.ok(mutations.some(record=>record.target===map&&record.attributeName==='viewBox'));
  const old=map.getAttribute('viewBox').split(' ').map(Number),anchor=[old[0]+old[2]*.2,old[1]+old[3]*.3];
  map.dispatchEvent(new w.WheelEvent('wheel',{clientX:288,clientY:270,deltaY:-100,bubbles:true,cancelable:true}));
  for(let i=0;i<90;i++)frame();await tick();
  const zoomed=map.getAttribute('viewBox').split(' ').map(Number);
  assert.ok(Math.abs((anchor[0]-zoomed[0])/zoomed[2]-.2)<1e-6&&Math.abs((anchor[1]-zoomed[1])/zoomed[3]-.3)<1e-6,'Wheel zoom preserves the point beneath the cursor');
  const before=map.getAttribute('viewBox');mutations.length=0;
  $('photo-panel').showModal();await tick();$('zoom-in').click();
  for(let i=0;i<90;i++)frame();await tick();
  assert.equal(mutations.length,0,'The open album has the rendering budget; camera state can advance without painting the dimmed map');
  assert.equal(map.getAttribute('viewBox'),before);
  $('photo-panel').close();await tick();frame();await tick();
  assert.notEqual(map.getAttribute('viewBox'),before,'Closing immediately paints the current camera position');
  observer.disconnect();
});

test('crowded route names retain safe widths and clear one another through camera zooms',async t=>{
  const cities=[['Puerto Ayora',-.74,-90.31],['Quito',-.18,-78.47],['Vienna',48.21,16.37],['Bratislava',48.15,17.11],['Budapest',47.5,19.04],['Prague',50.08,14.44],['Berlin',52.52,13.4],['Munich',48.14,11.58],['Salzburg',47.8,13.04]];
  const route=cities.map(([name,latitude,longitude],i)=>({id:`cluster-${i}`,name,latitude,longitude,country:'Test'}));
  const {w,$,press}=await setup(t,{realMap:true,route,seed:false,textLength:2}),frames=new Map();let next=10000,time=0;
  w.requestAnimationFrame=callback=>{frames.set(++next,callback);return next;};w.cancelAnimationFrame=id=>frames.delete(id);
  const frame=()=>{time+=16;for(const [id,callback] of [...frames]){frames.delete(id);callback(time);}};
  press('Escape');await tick();$('zoom-in').click();for(let i=0;i<120;i++)frame();$('zoom-out').click();for(let i=0;i<120;i++)frame();
  for(let zoom=0;zoom<5;zoom++){
    const [vx,vy,vw,vh]=$('map').getAttribute('viewBox').split(' ').map(Number),boxes=[];
    for(const group of $('route-stops').children){
      const text=group.querySelector('text');assert.ok(text._width>=text.textContent.length*8.3,'A short browser measurement never poisons the cached width');
      if(text.classList.contains('label-hidden'))continue;
      const anchor=text.getAttribute('text-anchor'),width=text._width,[x,y]=group._point;
      const box={x:(x-vx)*1440/vw+Number(text.getAttribute('x'))-(anchor==='end'?width:anchor==='middle'?width/2:0)-3,y:(y-vy)*900/vh+Number(text.getAttribute('y'))-17,w:width+6,h:23};
      for(const other of boxes)assert.equal(w.RedlineLabels.overlaps(box,other),false,`${text.textContent} has a clear label at zoom ${zoom}`);
      boxes.push(box);
    }
    assert.ok(boxes.length>0);
    $('map').dispatchEvent(new w.WheelEvent('wheel',{clientX:785,clientY:245,deltaY:-200,bubbles:true,cancelable:true}));for(let i=0;i<120;i++)frame();
  }
});

test('geographic headings yield to route city labels instead of drawing through them',async t=>{
  const route=[{id:'atlas-conflict',name:'A very long city label',country:'Test',longitude:16,latitude:51.5}];
  const {w,$,press}=await setup(t,{realMap:true,route,seed:false});
  const frames=new Map();let next=10000,time=0;
  w.requestAnimationFrame=callback=>{frames.set(++next,callback);return next;};w.cancelAnimationFrame=id=>frames.delete(id);
  press('Escape');await tick();
  for(const id of ['zoom-in','zoom-out']){$(id).click();for(let i=0;i<120;i++){time+=16;for(const [frame,callback] of [...frames]){frames.delete(frame);callback(time);}}}
  const europe=[...$('map-labels').children].find(label=>label.textContent==='EUROPE');
  assert.equal(europe.style.visibility,'hidden','The atlas heading shares the city collision layout');
  assert.equal($('route-stops').querySelector('text').classList.contains('label-hidden'),false,'The trip keeps priority over decorative names');
});

test('turning pages keep their measured padding when removed from the live grid',async t=>{
  const {w,$,tab}=await setup(t);tab(paris.id).click();
  const native=w.getComputedStyle;
  w.getComputedStyle=element=>{
    const result=native(element);
    if(element.matches('#album-pages > .album-page'))return {getPropertyValue:property=>({'padding-top':'31px','padding-right':'34px','padding-bottom':'39px','padding-left':'34px'}[property]||result.getPropertyValue(property))};
    return result;
  };
  const motion=controlledMotion(w);$('sheet-view').click();await wait(()=>motion.running.size===4);
  for(const copy of $('album-book').querySelectorAll('.album-view-layer .album-page')){
    assert.equal(copy.style.paddingTop,'31px');assert.equal(copy.style.paddingRight,'34px');
    assert.equal(copy.style.paddingBottom,'39px');assert.equal(copy.style.paddingLeft,'34px');
  }
  await motion.finish();
});

test('a failed thumbnail decode never starts a blank page turn or traps the controls',async t=>{
  const {w,$,tab}=await setup(t);tab(paris.id).click();const motion=controlledMotion(w);
  w.HTMLImageElement.prototype.decode=function(){return this.closest('.album-view-layer')?Promise.reject(Error('Decode failed')):Promise.resolve();};
  $('sheet-view').click();await wait(()=>!$('album-book').dataset.viewMotion);
  assert.equal(motion.running.size,0);assert.equal($('album-sheet').hidden,false);assert.equal($('album-book').inert,false);
});
