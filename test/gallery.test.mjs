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

async function setup(t,{seed=true,route=[paris,madrid],seedStops=[madrid,paris,paris],realMap=false}={}){
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
    w.localStorage.setItem('redline-route-v1',JSON.stringify(route));
    w.localStorage.setItem('redline-cities-collapsed','true');
    w.matchMedia=()=>({matches:false});w.ResizeObserver=class{observe(){}};
    let frame=0;w.requestAnimationFrame=()=>++frame;w.cancelAnimationFrame=()=>{};
    w.Element.prototype.getBoundingClientRect=function(){
      const [left,top,width,height]=this.id==='route-dock'?[370,760,700,116]:this.closest?.('#trip-panel')?[24,24,380,600]:[0,0,1440,900];
      return {left,top,width,height,right:left+width,bottom:top+height};
    };
    w.SVGElement.prototype.getScreenCTM=function(){const [x,y,width,height]=$('map').getAttribute('viewBox').split(' ').map(Number);return {a:1440/width,b:0,c:0,d:900/height,e:-x*1440/width,f:-y*900/height};};
    w.Element.prototype.setPointerCapture=function(){};w.Element.prototype.hasPointerCapture=()=>false;
    for(const name of ['vendor/geo','map-layout','world','trace','labels','app'])w.eval(source(`public/${name}.js`));
    stops=w.RedlineApp.getStops();
  }
  for(const name of ['jpeg','archive','storage'])w.eval(source(`public/${name}.js`));
  const storage=w.RedlineStorage,api=storage.api;
  const {trip}=await api('/trips',{method:'POST',body:JSON.stringify({title:'A summer away',stops})});
  if(seed)for(const stop of seedStops){
    const form=new FormData();form.append('photo',new Blob([jpeg],{type:'image/jpeg'}));form.append('stopId',stop.id);
    await api(`/trips/${trip.id}/photos`,{method:'POST',body:form});
  }
  w.localStorage.setItem('redline-saved-trip',JSON.stringify({id:trip.id,title:trip.title,revision:trip.revision,hash:JSON.stringify(stops)}));
  w.eval(source('public/postcards.js'));w.eval(source('public/trips.js'));
  await wait(()=>$('trip-title').textContent===trip.title&&(!seed||$('photo-count').textContent===String(seedStops.length)));
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
  assert.deepEqual([...$('gallery-filter').children].map(el=>el.textContent),['01Paris2','02Madrid1']);
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
  assert.ok(scrolled.some(([el,options])=>el===tab(madrid.id)&&options.block==='nearest'&&options.inline==='nearest'),'The current tab scrolls into view');
  tab(rome.id).click();assert.equal(tab(rome.id).getAttribute('aria-current'),'true','A chosen city on the same pages keeps its tab');
  assert.equal($('album-position').textContent,'Madrid & Rome · pages 4–5');
  // Turns animate from here on, and finish only when the test says so.
  const running=new Set();
  class Turn{constructor(){this.ended=new Promise((resolve,reject)=>{this.finish=()=>{running.delete(this);resolve(this);};this.cancel=()=>{if(running.delete(this))reject(Error('Cancelled'));};});this.ended.catch(()=>{});running.add(this);}get finished(){return this.ended;}}
  w.Animation=Turn;w.Element.prototype.animate=()=>new Turn();
  const finish=async()=>{[...running].forEach(turn=>turn.finish());await tick();};
  tab(paris.id).focus();tab(paris.id).click();const turning=[...running];assert.equal(turning.length,4);
  tab(paris.id).click();assert.deepEqual([...running],turning,'A second press toward the same page lets the turn finish');
  await finish();assert.equal(pages(),'left:contents right:city');
  assert.equal(w.document.activeElement,tab(paris.id),'Keyboard focus stays on the tab after an animated turn');
  press('End');const closing=[...running];press('End');assert.deepEqual([...running],closing);
  await finish();assert.equal(pages(),'left:back right:void');
  $('sheet-view').click();assert.equal($('album-foot').inert,true,'Hidden page controls leave the tab order');
  $('album-view').click();assert.equal($('album-foot').inert,false);
});

test('the divider tabs are coloured book cloth with readable labels',()=>{
  const css=source('public/gallery.css'),rule=css.match(/\.album-tab \{[^}]*\}/)[0];
  assert.match(rule,/var\(--tab\b/,'Each tab takes its colour from its --tab index');
  const colours=rule.match(/linear-gradient\(([^;]*)\)/)[1].match(/#[0-9a-f]{6}/gi);assert.equal(colours.length,6);
  const luminance=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=.03928?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
  for(const colour of colours)assert.ok((luminance('#fbf4e6')+.05)/(luminance(colour)+.05)>=4.5,`${colour} keeps the tab label readable`);
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
  await width(1024,'left:blank right:inside');assert.equal($('album-book').classList.contains('closed-back'),false,'The endpapers stay open');
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
  assert.equal($('album-pages').querySelector('figcaption').textContent,'A memory worth keeping.','The album captions a print with its postcard');
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
      this.element=element;this.options=options;
      this.done=new Promise((resolve,reject)=>{
        this.finish=()=>{running.delete(this);resolve();};
        this.cancel=()=>{if(running.delete(this))reject(Error('Cancelled'));};
      });this.done.catch(()=>{});running.add(this);
    }
    get finished(){return this.done;}
  }
  w.Animation=Motion;w.Element.prototype.animate=function(frames,options){return new Motion(this,options);};
  return {running,finish:async()=>{[...running].forEach(item=>item.finish());await tick();}};
}

test('every album visit opens its cover to the bookmark, and dismissing folds it before closing',async t=>{
  const {w,$,press,pages,tab}=await setup(t),motion=controlledMotion(w);
  tab(madrid.id).click();await motion.finish();
  const bookmark=pages();assert.equal(bookmark,'left:city right:inside');
  assert.equal($('gallery-filter').parentElement,$('album-book'),'Tabs travel with the physical book');
  for(let visit=0;visit<2;visit++){
    // Also exercise closing from All Photos, without losing the album bookmark.
    if(visit===0)$('sheet-view').click();
    const paper=$('photo-gallery').firstElementChild;
    const outside=type=>$('photo-panel').dispatchEvent(new w.MouseEvent(type,{bubbles:true}));
    outside('pointerdown');outside('click');
    assert.equal($('photo-panel').open,true);assert.equal($('photo-panel').dataset.motion,'closing');
    if(visit===0){assert.equal($('album-book').dataset.mode,'sheet');assert.equal($('photo-gallery').firstElementChild,paper,'All Photos stays intact throughout dismissal');}
    else assert.ok($('album-pages').querySelector('.album-leaf'),'The cover folds before the dialog goes away');
    assert.equal($('album-book').inert,true);
    const fade=[...motion.running].find(item=>item.element===$('album-book'));assert.ok(fade);assert.ok(fade.options.duration<=520,'Closing is snappy');
    press('Escape');await motion.finish();
    assert.equal($('photo-panel').open,false,'Closing ends in one sequence, with no second fade');
    assert.equal($('album-pages').children.length,0,'No old page surfaces remain to flash');
    $('photos-button').click();
    assert.equal(pages(),'left:void right:cover','Each visit begins on the cover');
    await wait(()=>motion.running.size===4);
    assert.equal($('photo-panel').dataset.motion,'opening');
    press('ArrowRight');assert.equal(motion.running.size,4,'Travel keys cannot interrupt the opening');
    await motion.finish();
    assert.equal($('photo-panel').dataset.motion,'');assert.equal($('album-book').inert,false);
    assert.equal($('album-book').dataset.mode,visit===0?'sheet':'album','The view preference is retained');
    $('album-view').click();assert.equal(pages(),bookmark);
  }
});

test('closing during an opening cancels cleanly and keeps the intended page for next time',async t=>{
  const {w,$,press,pages,tab}=await setup(t);
  tab(madrid.id).click();const bookmark=pages();press('Escape');
  const motion=controlledMotion(w);
  $('photos-button').click();await wait(()=>motion.running.size===4);
  press('Escape');assert.equal($('photo-panel').dataset.motion,'closing');
  await motion.finish();await motion.finish();assert.equal($('photo-panel').open,false);
  $('photos-button').click();await wait(()=>motion.running.size===4);await motion.finish();
  assert.equal(pages(),bookmark);assert.equal($('album-book').inert,false);
  // Reduced motion skips the cover and dismissal animation entirely.
  w.matchMedia=()=>({matches:true});press('Escape');assert.equal($('photo-panel').open,false);
  $('photos-button').click();await wait(()=>!$('photo-panel').dataset.motion);
  assert.equal(pages(),bookmark);assert.equal(motion.running.size,0);
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
  $('save-trip').click();await wait(()=>$('save-trip-label').textContent==='Saved');
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
  w.setTimeout=(fn,delay,...args)=>{if(delay!==1800)return realTimeout(fn,delay,...args);timers.set(++next,fn);return next;};
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

test('closing an already closed cover does not turn it across the screen',async t=>{
  const {w,$,press}=await setup(t);press('End');const motion=controlledMotion(w);
  press('Escape');assert.equal(motion.running.size,1,'Only the book departure runs');
  assert.equal($('album-pages').querySelector('.album-leaf'),null);
  assert.equal([...motion.running][0].options.duration,280);
  await motion.finish();assert.equal($('photo-panel').open,false);
});
