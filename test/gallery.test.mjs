import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
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
// The camera as the painted map last received it, and the names lettered with it.
const camera=w=>({...w.RedlineApp.atlas.view});
const lettered=w=>w.RedlineApp.atlas.labels.map(label=>label.text);
// Runs the page's animation frames by hand on a clock the test owns, so no pacing depends on this machine.
function mapClock(w){
  const frames=w.testFrames;let now=w.performance.now();
  Object.defineProperty(w.performance,'now',{configurable:true,value:()=>now});
  const frame=(ms=16)=>{now+=ms;for(const [key,callback] of [...frames]){frames.delete(key);callback(now);}};
  const settle=(limit=5000)=>{const began=now;while(frames.size&&now-began<limit)frame();assert.equal(frames.size,0,'The camera comes to rest');return now-began;};
  return {frame,settle,run:count=>{for(let i=0;i<count;i++)frame();},get now(){return now;}};
}

// With a profile, the page opens on an existing library instead of a new one: its database, its localStorage and its tab's sessionStorage, and no album opened.
async function setup(t,{seed=true,route=[paris,madrid],seedStops=[madrid,paris,paris],seedSizes=[],realMap=false,textLength=null,profile=null,atlas=null}={}){
  const dom=new JSDOM(source('map.html'),{url:'https://redline.test/Redline/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,$=id=>w.document.getElementById(id),objects=new Set();let stops=route;
  Object.assign(w,{Blob,File,FormData,TextEncoder,TextDecoder,indexedDB:profile?.idb||new IDBFactory()});
  for(const [store,kept] of [[w.localStorage,profile?.local],[w.sessionStorage,profile?.session]])for(const [key,value] of Object.entries(kept||{}))store.setItem(key,value);
  w.URL.createObjectURL=blob=>{const url=URL.createObjectURL(blob);objects.add(url);return url;};
  w.URL.revokeObjectURL=url=>{objects.delete(url);URL.revokeObjectURL(url);};
  // Work the page has under way when a test ends, such as refreshing the logbook after an export, would otherwise meet a closed window with nobody to hear the error.
  let inFlight=0;
  t.after(async()=>{for(let i=0;i<200&&inFlight;i++)await tick();dom.window.close();for(const url of objects)URL.revokeObjectURL(url);});
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
    w.matchMedia=()=>({matches:false});w.ResizeObserver=class{constructor(callback){(w.testResizes??=[]).push(callback);}observe(){}};
    // Frames wait here until a test runs them; one requested during load is not silently lost.
    w.testFrames=new Map();let frame=0;w.requestAnimationFrame=callback=>{w.testFrames.set(++frame,callback);return frame;};w.cancelAnimationFrame=id=>w.testFrames.delete(id);
    w.Element.prototype.getBoundingClientRect=function(){
      const [left,top,width,height]=this.id==='route-dock'?[370,760,700,116]:this.matches('.zoom-controls')?[1380,790,36,76]:this.closest?.('#trip-panel')?[24,24,380,600]:[0,0,1440,900];
      return {left,top,width,height,right:left+width,bottom:top+height};
    };
    w.Element.prototype.setPointerCapture=function(){};w.Element.prototype.hasPointerCapture=()=>false;
    for(const name of ['vendor/geo','map-layout','atlas-geography','trace','labels','atlas-names','atlas-view','app'])w.eval(source(`public/${name}.js`));
    stops=w.RedlineApp.getStops();
  }
  for(const name of ['jpeg','archive','storage'])w.eval(source(`public/${name}.js`));
  const storage=w.RedlineStorage,realApi=storage.api;
  storage.api=(...args)=>{inFlight++;return realApi(...args).finally(()=>{inFlight--;});};
  const api=storage.api;
  const {trip}=profile?{trip:null}:await api('/trips',{method:'POST',body:JSON.stringify({title:'A summer away',stops})});
  if(seed&&!profile)for(const [i,stop] of seedStops.entries()){
    const form=new FormData();form.append('photo',new Blob([jpeg],{type:'image/jpeg'}));form.append('stopId',stop.id);
    if(seedSizes[i]){form.append('width',String(seedSizes[i][0]));form.append('height',String(seedSizes[i][1]));}
    await api(`/trips/${trip.id}/photos`,{method:'POST',body:form});
  }
  if(!profile)w.localStorage.setItem('redline-saved-trip',JSON.stringify({id:trip.id,title:trip.title,revision:trip.revision,hash:JSON.stringify(stops)}));
  if(atlas)w.RedlineApp.atlas=atlas;
  w.eval(source('public/postcards.js'));w.eval(source('public/album-motion.js'));w.eval(source('public/trips.js'));
  if(!profile){
    await wait(()=>$('trip-title').textContent===trip.title&&(!seed||$('photo-count').textContent===String(seedStops.length)));
    $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
  }
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
  assert.deepEqual([...$('gallery-filter').children].map(el=>[el.querySelector('.chip-stop').textContent,el.querySelector('.tab-name').textContent,el.title,el.getAttribute('aria-label')]),[['3','Paris','Paris · page 3 · 2 photos','Paris · page 3 · 2 photos'],['4','Madrid','Madrid · page 4 · 1 photo','Madrid · page 4 · 1 photo']],'A tab shows its page and city, and names its photo count');
  assert.deepEqual([...$('gallery-filter').children].map(el=>[el.style.getPropertyValue('--tab-column'),el.style.getPropertyValue('--tab-row')]),[['0','0'],['0','1']],'Tabs are placed by their own column and row');
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
  const css=source('public/gallery.css'),rule=css.match(/^\.album-tab \{[^}]*\}/m)[0],rail=css.match(/^\.album-tabs \{[^}]*\}/m)[0];
  assert.match(rule,/background:[^;]*var\(--cloth\)/,'Each tab is backed by its own --cloth');
  const colours=[...css.matchAll(/^\.album-tab(?::nth-child\(6n\+\d\))? \{ --cloth: (#[0-9a-f]{6})/gim)].map(match=>match[1]);
  assert.equal(colours.length,6);assert.equal(new Set(colours).size,6,'Six cloths in rotation');
  assert.match(rule,/position: absolute/);assert.match(rule,/top: calc\(var\(--tab-row\b/);assert.match(rule,/width: calc\([^;]*var\(--tab-column\b/,'Each tab is placed absolutely by its row and column');
  assert.doesNotMatch(rail,/display: grid/,'The rail itself no longer lays tabs out');
  const channels=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
  const luminance=rgb=>rgb.map(c=>c/255).map(c=>c<=.03928?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
  const contrast=(a,b)=>{const [light,dark]=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (light+.05)/(dark+.05);};
  const foreground=channels(rule.match(/color:\s*(#[0-9a-f]{6})/)[1]);
  const [,brightness,saturation]=css.match(/\.album-tab\[aria-current=true\][^{]*\{[^}]*brightness\(([\d.]+)\) saturate\(([\d.]+)\)/).map(Number);
  // A CSS filter acts on the whole tab, so the highlighted label brightens along with its cloth.
  const clamp=value=>Math.max(0,Math.min(255,value));
  const filtered=rgb=>{
    const [r,g,b]=rgb.map(c=>clamp(c*brightness)),s=saturation,grey=[.2126*(1-s),.7152*(1-s),.0722*(1-s)],mix=grey[0]*r+grey[1]*g+grey[2]*b;
    return [mix+s*r,mix+s*g,mix+s*b].map(clamp);
  };
  for(const colour of colours){
    assert.ok(contrast(foreground,channels(colour))>=4.5,`${colour} keeps its label readable`);
    assert.ok(contrast(filtered(foreground),filtered(channels(colour)))>=4.5,`${colour} keeps its label readable even when highlighted`);
  }
  assert.doesNotMatch(css,/--tab-color|\.at-(start|end)|^\.eyebrow |chip-count/m,'No dead colour fallback, duplicate classes, second .eyebrow, or old photo-count chip');
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
  const records=await w.RedlineArchive.unpack((await storage.exportParts(trip.id))[0]);
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

test('a stalled metadata reader cannot block photo review and can be retried',async t=>{
  const {w,$,choose,change,api,trip}=await setup(t,{seed:false});
  delete w.exifr;
  const originalTimeout=w.setTimeout.bind(w);let expire;
  w.setTimeout=(callback,delay,...args)=>delay===3000?(expire=callback,0):originalTimeout(callback,delay,...args);
  choose(['one.jpg']);
  assert.equal(typeof expire,'function','Optional metadata loading has a bounded wait');
  const first=w.document.querySelector('script[src="vendor/exifr.js"]');assert.ok(first);
  expire();
  await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  assert.equal(first.isConnected,false);
  assert.equal($('photo-ready-count').textContent,'1 needs a city');
  change('bulk-photo-city',paris.id);$('upload-photos').click();
  await wait(()=>!$('album-pages').hidden&&!$('choose-photos').disabled);
  assert.equal((await api(`/trips/${trip.id}`)).photos.length,1);
  choose(['gps-paris.jpg']);
  const retry=w.document.querySelector('script[src="vendor/exifr.js"]');assert.ok(retry&&retry!==first);
  w.exifr={gps:async()=>paris};retry.dispatchEvent(new w.Event('load'));
  await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  assert.equal($('photo-review').querySelector('select').value,paris.id);
});

test('a slow city download never holds a batch past 3 s, says GPS was skipped, and still serves a later batch',async t=>{
  const {w,$,choose}=await setup(t,{seed:false});
  const location={latitude:51.5,longitude:-.12};w.exifr.gps=async()=>location;
  let requests=0,expire,signal,arrive;
  w.fetch=async(url,options)=>{assert.equal(url,'photo-cities.json');requests++;signal=options?.signal;return {ok:true,json:()=>new Promise(resolve=>{arrive=resolve;})};};
  const originalTimeout=w.setTimeout.bind(w);
  w.setTimeout=(callback,delay,...args)=>delay===3000?(expire=callback,0):originalTimeout(callback,delay,...args);
  choose(['one.jpg','two.jpg']);await wait(()=>requests===1);
  assert.equal(typeof expire,'function','The city download, including its body, has a bounded wait');expire();
  await wait(()=>$('photo-review').children.length===2&&!$('choose-photos').disabled);
  assert.equal(requests,1,'An unavailable index does not delay every photo in a large batch');assert.equal(signal.aborted,false,'The download carries on, so a slow link is not restarted from zero');
  assert.equal($('photo-ready-count').textContent,'2 need a city');
  assert.match($('photo-message').textContent,/GPS was not used/,'The photos needing a city by hand are explained');assert.equal($('photo-message').classList.contains('error'),true);
  expire=null;choose(['more.jpg']);await wait(()=>expire);expire();await wait(()=>$('photo-review').children.length===3&&!$('choose-photos').disabled);
  assert.equal(requests,1,'A batch during the download joins it rather than restarting from zero');
  arrive([['London',51.5,-.12,'United Kingdom']]);await tick();
  choose(['three.jpg']);await wait(()=>$('photo-review').children.length===4&&!$('choose-photos').disabled);
  assert.equal(requests,1,'The batch uses the download that finished in the background');assert.equal($('photo-review').lastElementChild.querySelector('select').value,'match');
  assert.equal($('photo-message').textContent,'');
});

test('a truly hung city download is abandoned in the background, and the next batch retries',async t=>{
  const {w,$,choose}=await setup(t,{seed:false});
  const location={latitude:51.5,longitude:-.12};w.exifr.gps=async()=>location;
  let requests=0,giveUp,signal,expire;
  w.fetch=async(url,options)=>{requests++;signal=options?.signal;return {ok:true,json:()=>new Promise(()=>{})};};
  const originalTimeout=w.setTimeout.bind(w);
  w.setTimeout=(callback,delay,...args)=>delay===3000?(expire=callback,0):delay===120000?(giveUp=callback,0):originalTimeout(callback,delay,...args);
  choose(['one.jpg']);await wait(()=>requests===1);expire();
  await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  assert.equal(signal.aborted,false);assert.equal(typeof giveUp,'function');giveUp();assert.equal(signal.aborted,true);
  w.fetch=async()=>{requests++;return {ok:true,json:async()=>[['London',51.5,-.12,'United Kingdom']]};};
  choose(['two.jpg']);await wait(()=>$('photo-review').children.length===2&&!$('choose-photos').disabled);
  assert.equal(requests,2);assert.equal($('photo-review').lastElementChild.querySelector('select').value,'match');
});

test('a city list that cannot be fetched is requested once a batch, not once a photo',async t=>{
  const {w,$,choose}=await setup(t,{seed:false});
  w.exifr.gps=async()=>({latitude:51.5,longitude:-.12});let requests=0;
  w.fetch=async()=>{requests++;throw Error('offline');};
  choose(['one.jpg','two.jpg','three.jpg']);await wait(()=>$('photo-review').children.length===3&&!$('choose-photos').disabled);
  assert.equal(requests,1);assert.match($('photo-message').textContent,/GPS was not used/);
  choose(['four.jpg']);await wait(()=>$('photo-review').children.length===4&&!$('choose-photos').disabled);
  assert.equal(requests,2);
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
  const restored=await w.RedlineArchive.unpack((await storage.exportParts(trip.id))[0]);assert.equal(restored[0].photos.length,3);
});

test('a single large import reviews in pages and saves every page into an existing trip',async t=>{
  const {w,$,choose,api,trip,change}=await setup(t);
  choose(Array.from({length:320},(_,i)=>`vacation-${i+1}.jpg`));
  await wait(()=>$('photo-selection-count').textContent==='320 selected'&&!$('choose-photos').disabled);
  const review=$('photo-review');
  assert.equal(review.children.length,70);
  assert.equal($('review-range').textContent,'1–70 of 320');
  change('bulk-photo-city',paris.id);
  $('review-next').click();
  assert.equal($('review-range').textContent,'71–140 of 320');
  const select=review.querySelector('select');
  assert.equal(select.value,paris.id);
  select.value=madrid.id;select.dispatchEvent(new w.Event('change'));
  $('review-prev').click();
  assert.equal($('upload-photos').textContent,'Save 320 photos');
  $('upload-photos').click();await wait(()=>$('photo-count').textContent==='323'&&!$('choose-photos').disabled);
  const photos=(await api(`/trips/${trip.id}`)).photos;
  assert.equal(photos.length,323);
  assert.equal(photos.filter(photo=>photo.stopId===madrid.id).length,2);
  assert.equal($('review-pager').hidden,true);
});

test('large file selections can be extended by dropping more files, then cancelled',async t=>{
  const {w,$,choose,api,trip}=await setup(t);
  choose(Array.from({length:31},(_,i)=>`${i}.jpg`));
  await wait(()=>$('photo-review').children.length===31&&!$('choose-photos').disabled);
  const event=new w.Event('drop',{bubbles:true,cancelable:true});
  Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],files:[new File([jpeg],'drop.jpg',{type:'image/jpeg'}),new File(['no'],'notes.txt',{type:'text/plain'})]}});
  $('photo-panel').dispatchEvent(event);
  await wait(()=>$('photo-review').children.length===32&&!$('choose-photos').disabled);
  assert.equal(event.defaultPrevented,true);assert.match($('photo-message').textContent,/1 photo could not be read/);
  w.confirm=()=>false;$('cancel-photo-import').click();assert.equal($('photo-review').children.length,32);
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
  assert.equal($('trip-state').textContent,'All changes saved');
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
  assert.equal(JSON.parse(w.sessionStorage.getItem('redline-tab-state-v1')).current.revision,1,'The stale revision is kept, so the next save also refuses to overwrite');
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
    const closing=[...motion.running];assert.ok(closing.every(animation=>animation.options.duration===1000&&animation.options.direction==='reverse'));
    const reversedFrames=closing.map(animation=>JSON.stringify(animation.frames));
    assert.equal($('photo-panel').dataset.departing,'true');
    assert.equal($('photo-panel').style.getPropertyValue('--album-exit-delay'),'820ms');
    press('Escape');assert.deepEqual([...motion.running],closing,'A second close does not restart the reverse');
    await motion.finish();assert.equal($('photo-panel').open,false);
    assert.equal($('album-pages').children.length,0);assert.equal($('album-book').querySelector('.album-cover-scene'),null);
    assert.equal($('gallery-filter').parentElement,$('album-book'));
    $('photos-button').click();await wait(()=>motion.running.size===3);
    assert.equal($('photo-panel').dataset.motion,'opening');assert.equal($('album-book').dataset.mode,view);
    const entrance=[...motion.running].find(animation=>animation.element.classList.contains('album-arrival'));
    assert.equal(entrance.options.duration,1000);
    assert.equal(entrance.frames[1].offset,.72,'The slide occupies the first part of the common timeline');
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

test('the cover rises before storage answers, and dismissal then never reveals late pages or reopens the album',async t=>{
  const {w,$,press,storage,api}=await setup(t);press('Escape');
  const motion=controlledMotion(w);let release;
  storage.api=async(path,options)=>{await new Promise(resolve=>release=resolve);return api(path,options);};
  $('photos-button').click();
  const scene=$('album-book').querySelector('.album-cover-scene');
  assert.ok(scene,'The cover is built in the click itself');assert.equal(motion.running.size,1,'Only the rise runs, and it needs no photos');
  assert.ok([...motion.running][0].element.classList.contains('album-arrival'));
  assert.equal(scene.querySelector('.album-snapshot'),null,'No spread yet');assert.equal(scene.style.visibility,'');
  assert.equal($('album-book').dataset.preparing,undefined);assert.equal($('gallery-filter').parentElement,scene,'The tabs travel with it from the first frame');
  assert.equal(scene.querySelector('.cover-meta').textContent,'2 stops · 3 photos','Its list is already known');
  press('Escape');assert.equal($('photo-panel').dataset.motion,'closing');assert.ok([...motion.running][0].reversed);
  await wait(()=>!!release);await motion.finish();await wait(()=>!$('photo-panel').open);
  release();await tick();
  assert.equal($('photo-panel').open,false);assert.equal($('album-book').querySelector('.album-cover-scene'),null);
  assert.equal($('album-book').dataset.preparing,undefined);
});

test('the spread comes in behind the shut cover, and the leaf keeps to the clock or starts from its hold if the read is late',async t=>{
  const {w,$,press,storage,api}=await setup(t);press('Escape');
  const motion=controlledMotion(w);let release;
  // A timeline the test can move: the leaf is stamped against it.
  let now=5000;Object.defineProperty(w.document,'timeline',{configurable:true,get:()=>({currentTime:now})});
  storage.api=async(path,options)=>{await new Promise(resolve=>release=resolve);return api(path,options);};
  $('photos-button').click();await wait(()=>!!release);now+=600;release();
  await wait(()=>motion.running.size===3);
  const [rise,leaf,book]=[...motion.running];
  assert.equal(rise.startTime,5000);assert.equal(leaf.startTime,5350,'250ms of hold have passed, so it turns at once and does not jump');assert.equal(book.startTime,5350);
  assert.ok($('album-book').querySelector('.album-cover-scene .album-cover-still .album-snapshot'));assert.ok($('album-book').querySelector('.album-cover-back .album-snapshot'));
  await motion.finish();await wait(()=>!$('photo-panel').dataset.motion);assert.equal($('album-book').querySelector('.album-cover-scene'),null);
  press('Escape');await wait(()=>motion.running.size===3);await motion.finish();await wait(()=>!$('photo-panel').open);
  storage.api=async(path,options)=>{await new Promise(resolve=>release=resolve);return api(path,options);};release=null;now=9000;
  $('photos-button').click();await wait(()=>!!release);now+=40;release();await wait(()=>motion.running.size===3);
  assert.deepEqual([...motion.running].map(animation=>animation.startTime),[9000,9000,9000],'On time, every channel shares one clock');
  await motion.finish();await wait(()=>!$('photo-panel').dataset.motion);
});

test('with no list yet the cover waits a moment for the read, then goes on sized for the route, and the list corrects it',async t=>{
  const {w,$,press,storage,api}=await setup(t);press('Escape');
  const motion=controlledMotion(w);let release=null;
  $('trips-button').click();$('new-trip').click();w.RedlineApp.setStops([paris,madrid]);w.dispatchEvent(new w.Event('redline:routechange'));$('photos-button').click();$('trip-name').value='Pacific crossing';
  storage.api=async(path,options)=>{if(/^\/trips\/[^/]+$/.test(path)&&!options?.method)await new Promise(resolve=>release=resolve);return api(path,options);};
  $('save-trip').click();await wait(()=>!!release&&motion.running.size===1);
  const scene=$('album-book').querySelector('.album-cover-scene');
  assert.equal(scene.querySelector('.cover-meta').textContent,'2 stops','A count it does not have is not guessed at');
  assert.equal($('album-book').style.getPropertyValue('--tab-width'),'45px','One column, as two stops would need');
  release();await wait(()=>motion.running.size===3);
  assert.equal(scene.querySelector('.cover-meta').textContent,'2 stops · 0 photos');
  await motion.finish();await wait(()=>!$('photo-panel').dataset.motion);assert.equal($('photo-panel').open,true);
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
  assert.equal($('trip-panel').contains($('stop-list')),true);assert.equal($('route-stops-panel').hidden,false,'An old collapsed preference cannot hide the log');assert.equal(w.localStorage.getItem('redline-cities-collapsed'),null,'And is forgotten');
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

test('cover motion never waits for decoding, a print appears when its bitmap arrives, and a stuck decode still ends the opening',async t=>{
  const {w,$,press,tab}=await setup(t);tab(paris.id).click();press('Escape');
  const motion=controlledMotion(w),originalDecode=w.HTMLImageElement.prototype.decode,releases=[];
  w.HTMLImageElement.prototype.decode=function(){return this.closest('.album-snapshot')?new Promise(resolve=>releases.push(resolve)):Promise.resolve();};
  $('photos-button').click();await wait(()=>motion.running.size===3&&releases.length>0);
  const scene=$('album-book').querySelector('.album-cover-scene'),copies=[...scene.querySelectorAll('.photo-image')];
  assert.ok(copies.length);assert.equal(scene.style.visibility,'','Motion did not wait for it');
  for(const copy of copies)copy.classList.remove('loaded');
  releases.forEach(resolve=>resolve());await wait(()=>copies.every(copy=>copy.classList.contains('loaded')));
  w.HTMLImageElement.prototype.decode=originalDecode;
  press('Escape');assert.equal($('photo-panel').dataset.motion,'closing');await motion.finish();await wait(()=>!$('photo-panel').open);
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
  let backup=null,downloads=0;const exportParts=storage.exportParts;
  storage.exportParts=async id=>{const parts=await exportParts(id);backup=parts[0];return parts;};
  w.HTMLAnchorElement.prototype.click=()=>downloads++;
  w.RedlineApp.setStops([madrid,paris]);w.dispatchEvent(new w.Event('redline:routechange'));
  $('backup-trips').click();await wait(()=>$('backup-list').querySelectorAll('button').length===1);
  const records=await w.RedlineArchive.unpack(backup);assert.deepEqual(Array.from(records[0].trip.stops,stop=>stop.id),[madrid.id,paris.id]);assert.equal(downloads,1);
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);choose(['pending.jpg']);await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  press('Escape');$('trip-list').replaceChildren();$('trips-button').click();await wait(()=>$('trip-list').querySelector('.trip-card'));$('backup-trips').click();await wait(()=>$('trip-message').textContent==='Save or cancel the pending photos before exporting.');assert.equal(downloads,1);
});

const tokyo={id:'city-tokyo-001',name:'Tokyo',country:'Japan',latitude:35.68,longitude:139.69};
const osaka={id:'city-osaka-001',name:'Osaka',country:'Japan',latitude:34.69,longitude:135.5};
const rome={id:'city-rome-0001',name:'Rome',country:'Italy',latitude:41.9,longitude:12.5};
const keptIn=store=>Object.fromEntries(Array.from({length:store.length},(_,i)=>[store.key(i),store.getItem(store.key(i))]));
// Reloads a tab: the shared database and localStorage (last written by `writer`), its own sessionStorage, and the route draft app.js reads back.
const reload=(t,tab,{writer=tab,route}={})=>setup(t,{route:route||JSON.parse(keptIn(writer.localStorage)['redline-tab-state-v1']).draft,seed:false,profile:{idb:tab.indexedDB,local:keptIn(writer.localStorage),session:keptIn(tab.sessionStorage)}});

test('reloading the map keeps its photo count without materializing photos until the album opens',async t=>{
  const first=await setup(t,{seedStops:Array.from({length:24},()=>paris)});
  const again=await reload(t,first.w),{$,objects}=again;
  await wait(()=>$('photo-count').textContent==='24');
  assert.equal($('photo-panel').open,false);assert.equal(objects.size,0,'The map creates no photo object URLs');
  $('photos-button').click();await wait(()=>!!$('album-pages').querySelector('.title-meta'));
  assert.equal($('photo-count').textContent,'24');assert.match($('album-pages').textContent,/24 photos/);
  assert.ok(objects.size>=24,'The album reads its images on demand');
});
const routeIs=(w,route)=>assert.deepEqual(JSON.parse(JSON.stringify(w.RedlineApp.getStops().map(stop=>stop.id))),route.map(stop=>stop.id));
const editRoute=(w,route)=>{w.RedlineApp.setStops(route);w.dispatchEvent(new w.Event('redline:routechange'));};
const savedRoute=async(api,id)=>Array.from((await api(`/trips/${id}`)).trip.stops,stop=>stop.id);
const downloadsOf=w=>{const names=[];w.HTMLAnchorElement.prototype.click=function(){names.push(this.download);};return names;};
const openLogbook=async($,w)=>{if($('photo-panel').open){w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await wait(()=>!$('photo-panel').open);}if($('trip-panel').hidden)$('trips-button').click();};
const outOfStorage=()=>Object.assign(Error('This browser is out of storage. Export a backup before clearing anything.'),{status:507});
// Lets a logbook list or a restore still reading the library finish before the test closes its page.
const settled=()=>new Promise(resolve=>setTimeout(resolve,40));

test('two tabs on different trips keep their own routes through a reload, and a backup never crosses them',async t=>{
  const a=await setup(t,{seed:false}),japan=(await a.api('/trips',{method:'POST',body:JSON.stringify({title:'Japan',stops:[tokyo,osaka]})})).trip;
  const b=await reload(t,a.w);
  await wait(()=>b.$('trip-title').textContent==='A summer away');
  await openLogbook(b.$,b.w);await wait(()=>[...b.$('trip-list').querySelectorAll('.trip-card')].some(row=>row.dataset.tripId===japan.id));
  [...b.$('trip-list').querySelectorAll('.trip-card')].find(row=>row.dataset.tripId===japan.id).querySelector('.trip-open').click();
  await wait(()=>b.$('trip-title').textContent==='Japan');
  editRoute(a.w,[paris]);assert.equal(JSON.parse(keptIn(a.w.localStorage)['redline-tab-state-v1']).current.id,a.trip.id);
  // Tab A wrote last, and tab B reloads with tab A's draft in the shared key.
  const again=await reload(t,b.w,{writer:a.w,route:[paris]});
  await wait(()=>again.$('trip-title').textContent==='Japan');routeIs(again.w,[tokyo,osaka]);
  await wait(()=>again.$('trip-state').textContent==='All changes saved');
  const names=downloadsOf(again.w);again.$('backup-trips').click();await wait(()=>names.length===1);await wait(()=>!again.$('backup-trips').disabled);
  assert.deepEqual(await savedRoute(a.api,japan.id),[tokyo.id,osaka.id],'The other tab’s edit never reaches this trip');
  assert.deepEqual(await savedRoute(a.api,a.trip.id),[paris.id,madrid.id],'and it stays unsaved in its own tab');
  const fresh=await reload(t,a.w,{route:[paris]});await wait(()=>fresh.$('trip-title').textContent==='A summer away');routeIs(fresh.w,[paris]);
  assert.equal(fresh.$('trip-state').textContent,'Unsaved changes','Reloading keeps the unsaved edit with its own trip');
  const blocked=await setup(t,{seed:false,route:[paris],profile:{idb:a.w.indexedDB,local:{'redline-tab-state-v1':'{not json'},session:{'redline-tab-state-v1':JSON.stringify({current:null,draft:[{name:'Bad',latitude:999,longitude:0}]})}}});
  await wait(()=>blocked.$('trip-state').textContent!=='');routeIs(blocked.w,[paris]);await settled();
});

test('a reload cannot defeat the revision check, and choosing the row reloads the newer save',async t=>{
  const {w,$,api,trip}=await setup(t,{seed:false});
  await openLogbook($,w);await wait(()=>$('trip-list').querySelector('.trip-card'));
  // Another tab saves a newer route, and writes the newer revision into the shared storage.
  const other=await reload(t,w);await wait(()=>other.$('trip-title').textContent===trip.title);
  editRoute(other.w,[paris,madrid,rome]);other.$('save-trip').click();await wait(()=>other.$('trip-state').textContent==='All changes saved');
  assert.equal(JSON.parse(keptIn(other.w.localStorage)['redline-tab-state-v1']).current.revision,2);
  editRoute(w,[paris]);$('save-trip').click();
  await wait(()=>/another tab/.test($('trip-message').textContent));assert.match($('trip-message').textContent,/Choose it in the logbook/);
  assert.deepEqual(await savedRoute(api,trip.id),[paris.id,madrid.id,rome.id]);
  const after=await reload(t,w,{writer:other.w,route:[paris]});await wait(()=>after.$('trip-title').textContent===trip.title);routeIs(after.w,[paris]);
  await openLogbook(after.$,after.w);await wait(()=>after.$('trip-list').querySelector('.trip-card'));
  after.$('save-trip').click();await wait(()=>/another tab/.test(after.$('trip-message').textContent));
  assert.deepEqual(await savedRoute(after.api,trip.id),[paris.id,madrid.id,rome.id],'A reload keeps this tab’s old revision, so the save is still refused');
  let asked=0;after.w.confirm=()=>{asked++;return false;};
  await wait(()=>after.$('trip-list').querySelector('.trip-open:not(:disabled)'));after.$('trip-list').querySelector('.trip-open').click();await tick();
  assert.equal(asked,1,'Discarding edits is asked first');routeIs(after.w,[paris]);
  after.w.confirm=()=>true;after.$('trip-list').querySelector('.trip-open').click();
  await wait(()=>after.$('trip-state').textContent==='All changes saved');routeIs(after.w,[paris,madrid,rome]);
  editRoute(after.w,[paris,rome]);after.$('save-trip').click();await wait(()=>after.$('trip-state').textContent==='All changes saved');
  assert.deepEqual(await savedRoute(after.api,trip.id),[paris.id,rome.id],'After loading the latest, saving works again');
  await openLogbook(after.$,after.w);await wait(()=>after.$('trip-list').querySelector('.trip-open:not(:disabled)'));
  after.$('trip-list').querySelector('.trip-open').click();assert.equal(after.$('trip-panel').hidden,true,'The open trip’s row folds the logbook again');await settled();
});

test('a route never saved stays protected after a reload; the untouched starter route does not nag',async t=>{
  const first=await setup(t,{seed:false,profile:{},route:[tokyo,osaka,rome,paris]});
  await wait(()=>first.$('trip-state').textContent==='4 stops · not saved yet');
  const unload=new first.w.Event('beforeunload',{cancelable:true});first.w.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true,'Leaving warns');
  await first.api('/trips',{method:'POST',body:JSON.stringify({title:'Saved',stops:[madrid]})});
  let asked=0;first.w.confirm=()=>{asked++;return false;};
  await openLogbook(first.$,first.w);await wait(()=>first.$('trip-list').querySelector('.trip-open:not(:disabled)'));
  first.$('trip-list').querySelector('.trip-open').click();await tick();assert.equal(asked,1);routeIs(first.w,[tokyo,osaka,rome,paris]);
  first.$('new-trip').click();assert.equal(asked,2,'+ New trip asks too');routeIs(first.w,[tokyo,osaka,rome,paris]);
  // Back up all covers saved trips only, and says so about the route on screen.
  let file;const exportParts=first.storage.exportParts;first.storage.exportParts=async id=>{const parts=await exportParts(id);file=parts[0];return parts;};
  const names=downloadsOf(first.w);first.$('backup-trips').click();await wait(()=>names.length===1);await wait(()=>/Your unsaved route is not in this backup\. Name and save it first to include it\./.test(first.$('trip-message').textContent));
  assert.deepEqual(Array.from(await first.w.RedlineArchive.unpack(file),record=>record.trip.title),['Saved']);routeIs(first.w,[tokyo,osaka,rome,paris]);
  const empty=await setup(t,{seed:false,profile:{},route:[]});await tick();
  const clean=new empty.w.Event('beforeunload',{cancelable:true});empty.w.dispatchEvent(clean);assert.equal(clean.defaultPrevented,false,'An empty draft is clean');
  const starter=await setup(t,{seed:false,profile:{},route:null,realMap:true});await tick();
  assert.equal(starter.w.RedlineApp.isStarterRoute(),true);
  const calm=new starter.w.Event('beforeunload',{cancelable:true});starter.w.dispatchEvent(calm);assert.equal(calm.defaultPrevented,false,'The first-run starter route is clean');
  const real=await setup(t,{seed:false,profile:{},route:[tokyo,osaka],realMap:true});await tick();
  assert.equal(real.w.RedlineApp.isStarterRoute(),false);
  const warned=new real.w.Event('beforeunload',{cancelable:true});real.w.dispatchEvent(warned);assert.equal(warned.defaultPrevented,true,'A real route in the real app is protected');await settled();
});

test('a backup that would commit removing stops asks first, and Cancel backs up the saved route untouched',async t=>{
  const {w,$,api,trip,storage}=await setup(t,{seed:false,route:[paris,madrid,rome]});
  await openLogbook($,w);const names=downloadsOf(w);let backup,asked='';
  const exportParts=storage.exportParts;storage.exportParts=async id=>{const parts=await exportParts(id);backup=parts[0];return parts;};
  w.confirm=text=>{asked=text;return false;};
  editRoute(w,[]);$('backup-trips').click();await wait(()=>names.length===1);await wait(()=>!$('backup-trips').disabled);
  assert.match(asked,/removing 3 stops from “A summer away”/);
  assert.deepEqual(await savedRoute(api,trip.id),[paris.id,madrid.id,rome.id],'The saved route survives');
  assert.deepEqual(Array.from((await w.RedlineArchive.unpack(backup))[0].trip.stops,stop=>stop.id),[paris.id,madrid.id,rome.id],'and so does the file');
  assert.match($('trip-message').textContent,/Your unsaved route changes are not in it/);assert.equal($('trip-message').classList.contains('error'),true);
  assert.equal($('trip-state').textContent,'Unsaved changes');
  w.confirm=text=>{asked=text;return true;};editRoute(w,[paris,madrid]);asked='';$('export-trip').click();await wait(()=>names.length===2);await wait(()=>!$('export-trip').disabled);
  assert.match(asked,/removing 1 stop from/);assert.deepEqual(await savedRoute(api,trip.id),[paris.id,madrid.id],'OK saves as before');
  assert.equal($('trip-state').textContent,'All changes saved');assert.match($('trip-message').textContent,/^Backup sent to your browser’s downloads\. Check that the file arrived/);assert.equal($('trip-message').classList.contains('error'),false);
  asked='';editRoute(w,[madrid,paris]);$('backup-trips').click();await wait(()=>names.length===3);await wait(()=>!$('backup-trips').disabled);assert.equal(asked,'','Reordering removes nothing, so it does not ask');
  w.confirm=()=>true;
  // Finishing a backup goes on to refresh the logbook, which must end before the page is torn down.
  await api('/trips');await tick();
});

test('out of storage, both exports still download and say what is missing',async t=>{
  const {w,$,api,trip,storage}=await setup(t,{seed:false});
  await openLogbook($,w);const names=downloadsOf(w),realApi=storage.api;
  storage.api=async(path,options)=>{if(options?.method==='PUT')throw outOfStorage();return realApi(path,options);};
  editRoute(w,[paris,madrid,rome]);
  for(const [id,count] of [['backup-trips',1],['export-trip',2]]){
    $(id).click();await wait(()=>names.length===count);await wait(()=>!$(id).disabled);
    assert.match($('trip-message').textContent,/Your latest route edits could not be saved and are not in it/);
  }
  const record=storage.recordBackup;storage.recordBackup=async()=>{throw outOfStorage();};
  $('backup-trips').click();await wait(()=>names.length===3);await wait(()=>!$('backup-trips').disabled);
  assert.match($('trip-message').textContent,/date could not be recorded.*could not be saved and are not in it/,'A failed receipt keeps the warning');
  storage.recordBackup=record;storage.api=realApi;
  // A newer save elsewhere does not block a backup either.
  await api(`/trips/${trip.id}`,{method:'PUT',body:JSON.stringify({title:trip.title,stops:[paris],revision:1})});
  $('backup-trips').click();await wait(()=>names.length===4);await wait(()=>!$('backup-trips').disabled);
  assert.match($('trip-message').textContent,/could not be saved and are not in it/);assert.deepEqual(await savedRoute(api,trip.id),[paris.id]);
});

test('pending photos refuse an export before anything changes, unless they could not be saved for lack of room',async t=>{
  const {w,$,api,trip,choose,storage,press}=await setup(t,{seed:false});
  choose(['pending.jpg']);await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  press('Escape');await wait(()=>!$('photo-panel').open);
  const names=downloadsOf(w);$('trips-button').click();editRoute(w,[paris]);
  await wait(()=>$('trip-list').querySelector('.trip-card'));
  $('backup-trips').click();await wait(()=>/^Save or cancel the pending photos/.test($('trip-message').textContent));
  assert.equal(names.length,0);assert.deepEqual(await savedRoute(api,trip.id),[paris.id,madrid.id],'A refused backup commits nothing');
  editRoute(w,[paris,madrid]);
  const realApi=storage.api;storage.api=async(path,options)=>{if(/\/photos$/.test(path)&&options?.method==='POST')throw outOfStorage();return realApi(path,options);};
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion&&$('photo-review').children.length===1);
  $('photo-review').querySelector('select').value=paris.id;$('photo-review').querySelector('select').dispatchEvent(new w.Event('change',{bubbles:true}));
  $('upload-photos').click();await wait(()=>/out of storage/.test($('photo-message').textContent));
  press('Escape');await wait(()=>!$('photo-panel').open);$('trips-button').click();await wait(()=>!$('backup-trips').disabled);
  $('backup-trips').click();await wait(()=>names.length===1);await wait(()=>!$('backup-trips').disabled);
  assert.match($('trip-message').textContent,/The pending photos are not in it/);
  storage.api=realApi;$('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion&&!$('upload-photos').disabled);
  $('upload-photos').click();await wait(()=>/1 photo saved/.test($('photo-message').textContent));
  choose(['another.jpg']);await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  press('Escape');await wait(()=>!$('photo-panel').open);$('trips-button').click();await wait(()=>!$('backup-trips').disabled);
  $('backup-trips').click();await wait(()=>/^Save or cancel the pending photos/.test($('trip-message').textContent));assert.equal(names.length,1,'A later save clears the out-of-room state');await settled();
});

test('a trip deleted elsewhere detaches with an explanation, keeps the route and pending photos, and can be saved again',async t=>{
  const {w,$,api,trip,choose,press}=await setup(t,{seed:false});
  choose(['pending.jpg']);await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  press('Escape');await wait(()=>!$('photo-panel').open);$('trips-button').click();await wait(()=>$('trip-list').querySelector('.trip-card'));
  await api('/trips',{method:'POST',body:JSON.stringify({title:'Kept',stops:[madrid]})});
  await api(`/trips/${trip.id}`,{method:'DELETE'});editRoute(w,[paris,madrid,rome]);
  $('save-trip').click();await wait(()=>/no longer in this browser/.test($('trip-message').textContent));
  assert.equal($('trip-title').textContent,'');routeIs(w,[paris,madrid,rome]);assert.equal($('trip-state').textContent,'3 stops · not saved yet');
  const names=downloadsOf(w);$('backup-trips').click();await wait(()=>names.length===1);await wait(()=>!$('backup-trips').disabled);
  assert.match($('trip-message').textContent,/The pending photos are not in it\. Your unsaved route is not in this backup/,'The next backup says what it leaves out');
  $('trip-name').value='Saved again';$('trip-name-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>$('trip-title').textContent==='Saved again');
  const saved=(await api('/trips')).trips.find(item=>item.title==='Saved again');assert.deepEqual(await savedRoute(api,saved.id),[paris.id,madrid.id,rome.id]);
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion&&$('photo-review').children.length===1);
  $('photo-review').querySelector('select').value=paris.id;$('photo-review').querySelector('select').dispatchEvent(new w.Event('change',{bubbles:true}));
  $('upload-photos').click();await wait(()=>/1 photo saved/.test($('photo-message').textContent));assert.equal((await api(`/trips/${saved.id}`)).photos.length,1,'The pending photos go into the new trip');
});

test('a reload with its trip gone opens the logbook to say so, and the route stays protected',async t=>{
  const {w,api,trip}=await setup(t,{seed:false}),state=keptIn(w.sessionStorage);
  await api(`/trips/${trip.id}`,{method:'DELETE'});
  const after=await setup(t,{seed:false,route:[paris,madrid],profile:{idb:w.indexedDB,session:state}});
  await wait(()=>/no longer in this browser/.test(after.$('trip-message').textContent));
  assert.equal(after.$('trip-panel').hidden,false);assert.equal(after.$('trip-title').textContent,'');routeIs(after.w,[paris,madrid]);
  const unload=new after.w.Event('beforeunload',{cancelable:true});after.w.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);await settled();
});

test('a photo save or move on a deleted trip explains itself rather than repeating Trip not found',async t=>{
  const {w,$,api,trip,choose}=await setup(t,{seed:false});
  choose(['one.jpg']);await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  $('photo-review').querySelector('select').value=paris.id;$('photo-review').querySelector('select').dispatchEvent(new w.Event('change',{bubbles:true}));
  await api(`/trips/${trip.id}`,{method:'DELETE'});
  $('upload-photos').click();await wait(()=>/no longer in this browser/.test($('photo-message').textContent));
  assert.equal($('photo-review').children.length,1,'The unsaved photo stays in review');
  // With no trip left, Save leads to naming one rather than failing on it.
  await wait(()=>!$('upload-photos').disabled);$('upload-photos').click();
  await wait(()=>$('trip-message').textContent==='Name and save this trip to add photos.');await settled();
});

test('adding more photos after the trip was deleted elsewhere leads to naming one, and keeps those already in review',async t=>{
  const {w,$,api,trip,choose}=await setup(t,{seed:false});
  choose(['one.jpg']);await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
  $('photo-review').querySelector('select').value=paris.id;$('photo-review').querySelector('select').dispatchEvent(new w.Event('change',{bubbles:true}));
  await api(`/trips/${trip.id}`,{method:'DELETE'});
  $('upload-photos').click();await wait(()=>/no longer in this browser/.test($('photo-message').textContent)&&!$('choose-photos').disabled);
  choose(['two.jpg']);await wait(()=>$('trip-message').textContent==='Name and save this trip to add photos.');
  assert.equal($('photo-panel').open,false);$('trip-name').value='Named at last';$('trip-name-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await wait(()=>$('trip-title').textContent==='Named at last'&&$('photo-panel').open&&!$('photo-panel').dataset.motion);
  assert.equal($('photo-review').children.length,1,'The album returns with the photo still waiting');await settled();
});

test('a postcard draft kept in this tab follows the album’s rebuilt photos, so saved text stays visible and revisions stay right',async t=>{
  const {w,$,api,trip,storage,prints,tab,press}=await setup(t);
  const realApi=storage.api;tab(paris.id).click();prints()[0].click();$('flip-postcard').click();
  const field=$('postcard-message');
  field.value='old text';field.dispatchEvent(new w.Event('input'));$('save-postcard').click();await wait(()=>$('postcard-save-status').textContent==='Postcard saved.');
  storage.api=async(path,options)=>{if(path.endsWith('/postcard'))throw outOfStorage();return realApi(path,options);};
  field.value='NEW TEXT';field.dispatchEvent(new w.Event('input'));
  w.confirm=()=>true;await w.RedlinePostcards.close();assert.equal($('photo-viewer').open,false,'The draft is kept in this tab');
  press('Escape');await wait(()=>!$('photo-panel').open);
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
  prints()[0].click();assert.equal(field.value,'NEW TEXT','The draft comes back');$('flip-postcard').click();
  storage.api=realApi;$('save-postcard').click();await wait(()=>$('postcard-save-status').textContent==='Postcard saved.');
  const stored=photos=>photos.find(photo=>photo.postcard?.message==='NEW TEXT');
  const saved=stored((await api(`/trips/${trip.id}`)).photos);assert.ok(saved);assert.equal(saved.postcardRevision,3);
  await w.RedlinePostcards.close();prints()[0].click();assert.equal(field.value,'NEW TEXT','The saved text is what reopens');
  field.value='NEWER';field.dispatchEvent(new w.Event('input'));$('flip-postcard').click();$('save-postcard').click();
  await wait(()=>$('postcard-save-status').textContent==='Postcard saved.');assert.equal($('postcard-error').textContent,'','No false conflict');
  assert.equal((await api(`/trips/${trip.id}`)).photos.find(photo=>photo.id===saved.id).postcardRevision,4);
});

test('a backup reports what is known, and the list marks a trip changed since its backup',async t=>{
  const {w,$,api,trip}=await setup(t,{seed:false});await openLogbook($,w);downloadsOf(w);
  $('backup-trips').click();await wait(()=>$('backup-list').querySelector('button'));
  assert.match($('trip-message').textContent,/^Backup sent to your browser’s downloads\. Check that the file arrived, and keep it somewhere private\.$/);
  assert.match($('backup-list').textContent,/Exported /);assert.doesNotMatch($('backup-list').textContent,/changed since/);
  await new Promise(resolve=>setTimeout(resolve,3));
  const form=new FormData();form.append('photo',new Blob([jpeg],{type:'image/jpeg'}));form.append('stopId',paris.id);await api(`/trips/${trip.id}/photos`,{method:'POST',body:form});
  $('trips-button').click();$('trips-button').click();await wait(()=>/changed since/.test($('backup-list').textContent));
  $('backup-trips').click();await wait(()=>!/changed since/.test($('backup-list').textContent)&&!$('backup-trips').disabled);
});

test('a failure after the logbook folds reopens it to say so, for exports and imports alike',async t=>{
  const {w,$,storage}=await setup(t,{seed:false});await openLogbook($,w);
  const down=el=>el.dispatchEvent(new w.Event('pointerdown',{bubbles:true}));
  let fail;const exportParts=storage.exportParts;storage.exportParts=()=>new Promise((resolve,reject)=>{fail=reject;});
  $('backup-trips').click();await wait(()=>fail);down(w.document.body);assert.equal($('trip-panel').hidden,true);
  fail(Error('The export went wrong.'));await wait(()=>$('trip-message').textContent==='The export went wrong.');
  assert.equal($('trip-panel').hidden,false);assert.equal($('trip-message').classList.contains('error'),true);storage.exportParts=exportParts;
  await wait(()=>!$('backup-trips').disabled);
  const importArchive=storage.importArchive;fail=null;storage.importArchive=()=>new Promise((resolve,reject)=>{fail=reject;});
  Object.defineProperty($('trip-backup-file'),'files',{configurable:true,value:[new File(['broken'],'broken.redline')]});
  $('trip-backup-file').dispatchEvent(new w.Event('change',{bubbles:true}));await wait(()=>fail);down(w.document.body);assert.equal($('trip-panel').hidden,true);
  fail(Error('This is not a complete Redline backup.'));await wait(()=>$('trip-message').textContent==='This is not a complete Redline backup.');
  assert.equal($('trip-panel').hidden,false);storage.importArchive=importArchive;
});

test('saving an import that would pass 100 stops changes nothing and says why',async t=>{
  const route=Array.from({length:98},(_,i)=>({id:`city-route-${String(i).padStart(4,'0')}`,name:`Stop ${i}`,country:'',latitude:i-49,longitude:0}));
  const {w,$,api,trip,choose}=await setup(t,{seed:false,route});
  const places=[['North',60,10,'A'],['East',61,20,'B'],['South',62,30,'C']];
  w.fetch=async()=>({ok:true,json:async()=>places});
  w.exifr.gps=async file=>{const place=places[Number(file.name[0])];return {latitude:place[1],longitude:place[2]};};
  let added=0;w.RedlineApp.addCity=place=>{added++;const stop={...place,id:`city-added-${String(added).padStart(4,'0')}`};editRoute(w,[...w.RedlineApp.getStops(),stop]);return stop;};
  choose(['0.jpg','1.jpg','2.jpg','0b.jpg']);await wait(()=>$('photo-review').children.length===4&&!$('choose-photos').disabled);
  $('upload-photos').click();await wait(()=>/would add 3 stops, and a trip holds 100/.test($('photo-message').textContent));
  assert.equal(added,0);assert.equal(w.RedlineApp.getStops().length,98,'The route is untouched');assert.equal((await api(`/trips/${trip.id}`)).photos.length,0);
  assert.equal($('upload-photos').disabled,false,'Choosing existing stops for some of them is still possible');
  $('photo-review').querySelectorAll('select')[0].value=route[0].id;$('photo-review').querySelectorAll('select')[0].dispatchEvent(new w.Event('change',{bubbles:true}));
  $('photo-review').querySelectorAll('select')[3].value=route[0].id;$('photo-review').querySelectorAll('select')[3].dispatchEvent(new w.Event('change',{bubbles:true}));
  $('upload-photos').click();await wait(()=>/4 photos saved/.test($('photo-message').textContent));
  assert.equal(added,2);assert.equal((await api(`/trips/${trip.id}`)).photos.length,4);assert.equal((await api(`/trips/${trip.id}`)).trip.stops.length,100);
});

test('a stop removed during a paged import releases its photos on unseen pages',async t=>{
  const {w,$,api,trip,choose,change,press}=await setup(t,{seed:false});
  choose(Array.from({length:72},(_,i)=>`p${i}.jpg`));await wait(()=>$('review-range').textContent==='1–70 of 72'&&!$('choose-photos').disabled);
  change('bulk-photo-city',madrid.id);assert.equal($('upload-photos').textContent,'Save 72 photos');
  [...$('photo-review').querySelectorAll('select')].slice(0,3).forEach(select=>{select.value=paris.id;select.dispatchEvent(new w.Event('change',{bubbles:true}));});
  press('Escape');await wait(()=>!$('photo-panel').open);editRoute(w,[paris]);
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
  assert.equal($('upload-photos').textContent,'Save 3 photos','Photos on page 2 no longer count as ready');assert.equal($('photo-ready-count').textContent,'69 need a city');
  $('upload-photos').click();await wait(()=>/Choose a city for the remaining photos/.test($('photo-message').textContent));
  assert.equal((await api(`/trips/${trip.id}`)).photos.length,3);assert.equal($('photo-message').classList.contains('error'),false);
});

test('photos that cannot be read are named, and backup files keep readable names',async t=>{
  const {w,$,choose}=await setup(t,{seed:false});
  w.createImageBitmap=async file=>{if(/^bad/.test(file.name))throw Error('Cannot decode');return {width:1600,height:1000,close(){}};};
  w.Image=class{set src(_){this.onerror?.();}};
  choose(['ok1.jpg','bad-IMG_0042.jpg','ok2.jpg']);await wait(()=>$('photo-review').children.length===2&&!$('choose-photos').disabled);
  assert.match($('photo-message').textContent,/^1 photo could not be read and was not added: bad-IMG_0042\.jpg\. /);
  choose(Array.from({length:12},(_,i)=>`bad-${i}.jpg`));await wait(()=>/12 photos/.test($('photo-message').textContent)&&!$('choose-photos').disabled);
  assert.match($('photo-message').textContent,/^12 photos could not be read and were not added: bad-0\.jpg, .*bad-9\.jpg and 2 more\. /);
  $('cancel-photo-import').click();
  await openLogbook($,w);const names=downloadsOf(w);
  for(const [title,file] of [['東京の旅','東京の旅'],['Kraków 2026','Kraków-2026'],['Йошкар-Ола','Йошкар-Ола'],['★★★','Redline-trip'],['Plain_name-1','Plain_name-1']]){
    const count=names.length;await wait(()=>!$('export-trip').disabled);$('trip-name').value=title;$('trip-name-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await wait(()=>$('trip-title').textContent===title&&!$('export-trip').disabled);await wait(()=>$('trip-list').querySelector('.trip-name')?.textContent===title);
    $('export-trip').click();await wait(()=>names.length===count+1);assert.equal(names.at(-1),`${file}.redline`);
    await wait(()=>!$('export-trip').disabled);
  }
});

test('a backup too big for one file goes out a part per click, and only the last part counts it as done',async t=>{
  const {w,$,api,trip,storage}=await setup(t);await openLogbook($,w);
  const names=downloadsOf(w),{size}=await (await fetch((await api(`/trips/${trip.id}`)).photos[0].url)).blob();
  const split=w.RedlineArchive.split;w.RedlineArchive.split=records=>split(records,{bytes:size*1.2});
  let blobs=[];const exportParts=storage.exportParts;storage.exportParts=async id=>blobs=await exportParts(id);
  editRoute(w,[paris]);$('backup-trips').click();await wait(()=>names.length===1);await wait(()=>$('trip-message').querySelector('button'));
  assert.equal(blobs.length,3);assert.deepEqual([...names],['Redline-backup-part-1-of-3.redline']);
  assert.match($('trip-message').textContent,/needs 3 files.*not complete until you have them all/);
  assert.equal($('trip-message').querySelector('button').textContent,'Download part 2 of 3');
  await wait(()=>!$('backup-trips').disabled);assert.equal((await api(`/trips/${trip.id}`)).trip.backedUpAt,undefined,'One part is not a backup');
  // Folding the logbook keeps the offer, because a forgotten part would be a lost part.
  $('trips-button').click();assert.equal($('trip-panel').hidden,true);$('trips-button').click();
  await wait(()=>$('trip-message').querySelector('button'));
  $('trip-message').querySelector('button').click();assert.equal(names.at(-1),'Redline-backup-part-2-of-3.redline');assert.equal(names.length,2,'Each click sends one file');
  assert.equal($('trip-message').querySelector('button').textContent,'Download part 3 of 3');assert.equal(w.document.activeElement,$('trip-message').querySelector('button'));
  assert.equal((await api(`/trips/${trip.id}`)).trip.backedUpAt,undefined);
  $('trip-message').querySelector('button').click();assert.equal(names.at(-1),'Redline-backup-part-3-of-3.redline');
  await wait(()=>/Check that all 3 files arrived, and keep them somewhere private/.test($('trip-message').textContent));
  assert.ok((await api(`/trips/${trip.id}`)).trip.backedUpAt,'The last part records the backup');assert.equal($('trip-message').querySelector('button'),null);
  const target=await setup(t,{seed:false});let restored=0;for(const blob of blobs)restored+=(await target.storage.importArchive(blob)).photoCount;
  assert.equal(restored,3,'Every photo comes back');
  assert.ok((await target.api('/trips')).trips.some(saved=>saved.title==='A summer away (part 2)'));
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

test('the map is one painted canvas, and only the land thumbnails need stay in the page',async t=>{
  const {w,$}=await setup(t,{realMap:true});
  const land=[...$('land').children];assert.equal(land.length,w.ATLAS_LAND.length);
  assert.ok(land.every((path,i)=>path.getAttribute('d')===w.ATLAS_LAND[i]));
  assert.ok(land.every(path=>!path.style.fill),'Plain vector fills never invoke an image-backed pattern for each landmass');
  const source=$('land').closest('svg');
  assert.ok(source.classList.contains('atlas-source'));assert.equal($('land').parentElement.tagName.toLowerCase(),'defs','Thumbnails reference the land without it ever rendering');
  assert.equal($('map').tagName,'CANVAS');assert.equal($('map').childElementCount,0);
  assert.equal(w.ATLAS_BORDERS,undefined);assert.equal(w.REGION_PATHS,undefined,'Borders and regions ship only to the worker');
  for(const id of ['country-borders','regions','atlas-tones','atlas-overview','atlas-relief','map-labels','background-labels','map-artwork','atlas-land-clip','land-washes'])assert.equal($(id),null,`#${id} is gone`);
  assert.equal(w.document.querySelectorAll('.atlas-source :is(image, pattern, filter, mask), #place-labels :is(image, pattern, filter, mask)').length,0,'What remains of the map in the page allocates no images or filters');
  assert.equal($('place-labels').hasAttribute('viewBox'),false,'The route overlay stays in CSS pixels');
  assert.equal(w.RedlineApp.atlas.supported,false,'Under jsdom the view is inert, and the map still works');
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
    assert.equal(layer.isConnected,true);
    assert.equal(layer.querySelector(':scope > .album-view-surface > .album-snapshot'),null,'The outgoing stationary half is retired while the final turning face still covers its side');
    frames.shift()(w.performance.now());await tick();
    assert.equal(layer.isConnected,true,'The completed leaf covers the live page for a full paint opportunity');
    frames.shift()(w.performance.now());await wait(()=>!layer.isConnected);
    assert.equal($('album-book').inert,false);w.requestAnimationFrame=nativeFrame;
  }
  $('sheet-view').click();await wait(()=>motion.running.size===4);
  const layer=$('album-book').querySelector('.album-view-layer'),frames=[];
  w.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
  [...motion.running].forEach(animation=>animation.finish());await tick();assert.equal(layer.querySelector(':scope > .album-view-surface > .album-snapshot'),null);
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
  const {w,$,press}=await setup(t,{realMap:true}),{frame}=mapClock(w);
  press('Escape');await tick();frame();await tick();
  const map=$('map'),overlay=$('place-labels'),atlas=w.RedlineApp.atlas,mutations=[],observer=new w.MutationObserver(records=>mutations.push(...records));
  for(const node of [map,overlay])observer.observe(node,{attributes:true,childList:true,subtree:true});
  const update=atlas.update,release=atlas.release;let activity=[],updates=0,releases=0;
  atlas.update=(...args)=>{updates++;activity.push('write');return update(...args);};
  atlas.release=()=>{releases++;return release();};
  const read=w.Element.prototype.getBoundingClientRect,write=w.Element.prototype.setAttribute;
  w.Element.prototype.getBoundingClientRect=function(){activity.push('read');return read.call(this);};
  w.Element.prototype.setAttribute=function(...args){if(this===map||overlay.contains(this))activity.push('write');return write.apply(this,args);};
  w.RedlineApp.refreshLayout();frame();await tick();assert.ok(activity.includes('read'),'The frame really ran');
  assert.equal(mutations.length,0,'An unchanged scene does not rewrite the overlay, labels, or dots');
  assert.equal(updates,0,'Nor does it repaint the atlas');
  $('zoom-in').click();
  for(let i=0;i<90;i++){
    activity=[];frame();const firstWrite=activity.indexOf('write');
    if(firstWrite>=0)assert.ok(!activity.slice(firstWrite).includes('read'),'A zoom frame never forces layout after changing the overlay or the atlas');
  }
  await tick();assert.ok(updates>5,'Camera motion reaches the painted map');
  assert.ok(mutations.every(({target,type,attributeName})=>type==='attributes'&&(target!==map||attributeName==='class')),'Camera motion goes through atlas.update: the canvas keeps its attributes and no overlay nodes are rebuilt');
  assert.equal(map.childElementCount,0);
  const old=camera(w),anchor=[old.x+old.w*.2,old.y+old.h*.3];
  map.dispatchEvent(new w.WheelEvent('wheel',{clientX:288,clientY:270,deltaY:-100,bubbles:true,cancelable:true}));
  for(let i=0;i<90;i++)frame();await tick();
  const zoomed=camera(w);
  assert.ok(zoomed.w<old.w,'The wheel zooms');
  assert.ok(Math.abs((anchor[0]-zoomed.x)/zoomed.w-.2)<1e-6&&Math.abs((anchor[1]-zoomed.y)/zoomed.h-.3)<1e-6,'Wheel zoom preserves the point beneath the cursor');
  const before=camera(w);mutations.length=0;updates=0;
  $('photo-panel').showModal();await tick();assert.equal(releases,1,'The album takes back the memory of the close-up tiles');
  $('zoom-in').click();
  for(let i=0;i<90;i++)frame();await tick();
  assert.equal(mutations.length,0,'The open album has the rendering budget; camera state can advance without painting the dimmed map');
  assert.equal(updates,0,'The atlas is not asked to paint behind the album');
  assert.deepEqual(camera(w),before);
  $('photo-panel').close();await tick();frame();await tick();
  assert.ok(updates>0);assert.notDeepEqual(camera(w),before,'Closing immediately paints the current camera position');
  assert.equal(releases,1);
  observer.disconnect();
});

test('crowded route names retain safe widths and clear one another through camera zooms',async t=>{
  const cities=[['Puerto Ayora',-.74,-90.31],['Quito',-.18,-78.47],['Vienna',48.21,16.37],['Bratislava',48.15,17.11],['Budapest',47.5,19.04],['Prague',50.08,14.44],['Berlin',52.52,13.4],['Munich',48.14,11.58],['Salzburg',47.8,13.04]];
  const route=cities.map(([name,latitude,longitude],i)=>({id:`cluster-${i}`,name,latitude,longitude,country:'Test'}));
  const {w,$,press}=await setup(t,{realMap:true,route,seed:false,textLength:2}),clock=mapClock(w);
  press('Escape');await tick();clock.frame();$('zoom-in').click();clock.settle();$('zoom-out').click();clock.settle();
  for(let zoom=0;zoom<5;zoom++){
    const {x:vx,y:vy,w:vw,h:vh}=camera(w),boxes=[];
    for(const group of $('route-stops').children){
      const text=group.querySelector('text');assert.ok(text._width>=text.textContent.length*8.3,'A short browser measurement never poisons the cached width');
      if(text.classList.contains('label-hidden'))continue;
      const anchor=text.getAttribute('text-anchor'),width=text._width,[x,y]=group._point;
      // The lettering's own extent: capitals standing on the baseline, with their halo.
      const box={x:(x-vx)*1440/vw+Number(text.getAttribute('x'))-(anchor==='end'?width:anchor==='middle'?width/2:0)-2,y:(y-vy)*900/vh+Number(text.getAttribute('y'))-11,w:width+4,h:15};
      for(const other of boxes)assert.equal(w.RedlineLabels.overlaps(box,other),false,`${text.textContent} has a clear label at zoom ${zoom}`);
      boxes.push(box);
    }
    assert.ok(boxes.length>0);
    // Zoom on the cluster itself: at today's wheel gain anywhere else carries it out of the window.
    $('map').dispatchEvent(new w.WheelEvent('wheel',{clientX:785,clientY:205,deltaY:-200,bubbles:true,cancelable:true}));clock.settle();
  }
});

test('geographic headings yield to route city labels instead of drawing through them',async t=>{
  const names=async(...places)=>{
    const route=places.map(([longitude,latitude],i)=>({id:`atlas-conflict-${i}`,name:'A very long city label',country:'Test',longitude,latitude}));
    const {w,$,press}=await setup(t,{realMap:true,route,seed:false}),clock=mapClock(w);
    press('Escape');await tick();clock.frame();
    for(const id of ['zoom-in','zoom-out']){$(id).click();clock.settle();}
    assert.equal($('route-stops').querySelector('text').classList.contains('label-hidden'),false,'The trip keeps priority over decorative names');
    assert.deepEqual(camera(w),{x:0,y:0,w:1440,h:720});
    const atlas=w.RedlineApp.atlas,boxOf=text=>{const label=atlas.labels.find(l=>l.text===text);if(!label)return null;const {w:width,h}=atlas.measure(label.kind,text);return {x:label.x-width/2,y:label.y-h/2,w:width,h,home:label};};
    return {boxOf,w,$};
  };
  const home=await names([-150,-50]),europe=home.boxOf('Europe');
  assert.equal(europe.home.x,790,'With the route elsewhere the heading is at home');
  const moved=await names([16,51.5]),aside=moved.boxOf('Europe');
  assert.ok(aside,'A continent steps aside for a port rather than leaving the chart');assert.notDeepEqual([aside.home.x,aside.home.y],[europe.home.x,europe.home.y]);
  const group=moved.$('route-stops').children[0],label=group._label,[gx,gy]=group._point,width=label._width,anchor=label.getAttribute('text-anchor'),left=gx+Number(label.getAttribute('x'))-(anchor==='end'?width:anchor==='middle'?width/2:0),top=gy*900/720+Number(label.getAttribute('y'))-11;
  assert.equal(moved.w.RedlineLabels.overlaps(aside,{x:left,y:top,w:width,h:15}),false,'And is clear of its name');
  const crossing=await names([0,7.5],[40,7.5]),africa=crossing.boxOf('Africa'),y=7.5;
  if(africa){const lineY=(90-y)*4*900/720;assert.ok(africa.y>lineY||africa.y+africa.h<lineY,'A heading never sits under the red line either');}
  assert.ok(crossing.boxOf('Europe'));
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

test('import review turns between distinct pages without losing location assignments',async t=>{
  const {w,$,choose,change,press}=await setup(t);
  choose(Array.from({length:75},(_,i)=>`travel-${i+1}.jpg`));
  await wait(()=>$('photo-selection-count').textContent==='75 selected'&&!$('choose-photos').disabled);
  change('bulk-photo-city',paris.id);
  const first=$('photo-review').firstElementChild.dataset.pendingId,motion=controlledMotion(w);
  $('review-next').click();await wait(()=>motion.running.size===4);
  const layer=$('album-book').querySelector('.album-view-layer'),second=$('photo-review').firstElementChild.dataset.pendingId;
  assert.notEqual(first,second);assert.ok(layer.querySelector(`.album-view-front [data-pending-id="${first}"]`));
  assert.ok(layer.querySelector(`.album-view-back [data-pending-id="${second}"]`));
  assert.equal($('review-range').textContent,'71–75 of 75');await motion.finish();
  press('ArrowLeft');await wait(()=>motion.running.size===4);await motion.finish();assert.equal($('review-range').textContent,'1–70 of 75');
  assert.equal($('photo-review').querySelector('select').value,paris.id);assert.equal($('album-book').inert,false);
});

test('review arrows queue during a turn, work on checkboxes, and leave city pickers alone',async t=>{
  const {w,$,choose,press}=await setup(t);
  choose(Array.from({length:144},(_,i)=>`review-${i}.jpg`));
  await wait(()=>$('photo-selection-count').textContent==='144 selected'&&!$('choose-photos').disabled);
  const motion=controlledMotion(w),review=$('photo-review');
  assert.equal(press('ArrowRight',review.querySelector('select')),true);
  press('ArrowRight',review.querySelector('input'));
  await wait(()=>motion.running.size===4);
  assert.equal($('review-range').textContent,'71–140 of 144');
  const copies=$('album-book').querySelectorAll('.album-view-layer select');
  assert.ok(copies.length>0&&[...copies].every(select=>select.options.length<=1));
  press('ArrowRight');await motion.finish();await wait(()=>motion.running.size===4);
  assert.equal($('review-range').textContent,'141–144 of 144');
  press('ArrowLeft');await motion.finish();await wait(()=>motion.running.size===4);
  await motion.finish();assert.equal($('review-range').textContent,'71–140 of 144');
  assert.equal($('album-book').inert,false);
});

test('the fullscreen front cover keeps its index usable until the book opens',async t=>{
  const {w,$,press,tab}=await setup(t),panel=$('photo-panel'),book=$('album-book');
  press('Home');press('f');
  assert.ok(panel.classList.contains('cover-view'));
  assert.equal($('gallery-filter').inert,false);assert.equal($('album-drawer').inert,false);
  const chip=tab(paris.id).querySelector('.chip-stop');
  assert.equal(chip.textContent,'3');assert.equal(chip.hasAttribute('title'),false);assert.equal(chip.getAttribute('aria-hidden'),'true','The tab itself speaks for its page number');
  assert.equal(tab(paris.id).querySelector('.chip-count'),null);
  assert.equal(tab(paris.id).title,'Paris · page 3 · 2 photos');assert.equal(tab(paris.id).getAttribute('aria-label'),tab(paris.id).title);
  $('album-edge').dispatchEvent(new w.Event('pointerenter'));
  assert.equal(panel.classList.contains('index-open'),false,'The cover index needs no sliding reveal');
  tab(paris.id).click();
  assert.equal(book.classList.contains('closed-front'),false);
  assert.equal(panel.classList.contains('cover-view'),false);assert.equal($('gallery-filter').inert,true);
  press('Home');assert.ok(panel.classList.contains('cover-view'));assert.equal($('gallery-filter').inert,false);
  press('f');assert.equal(panel.classList.contains('cover-view'),false);assert.equal($('gallery-filter').inert,false);
});

test('fullscreen resizes reverse cleanly and settle a page turn before changing size',async t=>{
  const {w,$,press}=await setup(t),panel=$('photo-panel'),book=$('album-book'),motion=controlledMotion(w);
  book.getBoundingClientRect=()=>panel.classList.contains('expanded')?{left:4,top:4,width:1200,height:800}:{left:160,top:90,width:880,height:560};
  press('f');const first=[...motion.running].find(item=>item.element===book);
  assert.ok(first);assert.match(first.frames[0].transform,/scale\(0\.733/);
  assert.equal(book.dataset.windowMotion,'true');
  press('f');const second=[...motion.running].find(item=>item.element===book);
  assert.ok(second&&second!==first);assert.equal(motion.running.has(first),false);
  await tick();assert.equal(book.dataset.windowMotion,'true','A cancelled resize cannot clear its replacement');
  await motion.finish();assert.equal(book.dataset.windowMotion,undefined);assert.equal(panel.classList.contains('expanded'),false);
  press('ArrowRight');assert.ok(motion.running.size>0);
  press('f');assert.ok(panel.classList.contains('expanded'));
  assert.match($('album-position').textContent,/Paris/);
  assert.ok([...motion.running].every(item=>item.element===book),'Resize settles all old turning leaves');
  await motion.finish();assert.equal(book.dataset.windowMotion,undefined);assert.equal(book.inert,false);
  w.matchMedia=()=>({matches:true});press('f');assert.equal(motion.running.size,0,'Reduced motion changes size immediately');
});

test('window reading view keeps the current spread, opens full photos and leaves browser fullscreen alone',async t=>{
  const {w,$,press,tab,prints}=await setup(t),button=$('album-fullscreen'),display=$('album-display');
  let nativeCalls=0;display.requestFullscreen=display.webkitRequestFullscreen=()=>{nativeCalls++;};
  tab(paris.id).click();
  const page=$('album-position').textContent;
  button.click();
  assert.ok($('photo-panel').classList.contains('expanded'));assert.equal(nativeCalls,0);
  assert.equal($('album-position').textContent,page);assert.equal($('album-drawer').inert,true);
  assert.equal($('gallery-filter').parentElement,$('album-book'),'Tabs stay attached to the same book in window view');
  assert.equal($('album-drawer').parentElement,$('album-book'));
  assert.equal($('gallery-filter').inert,true);
  prints()[0].click();assert.ok($('photo-viewer').open);
  assert.equal(prints()[0].querySelector('img').src,$('full-photo').src);
  $('photo-viewer').dispatchEvent(new w.Event('cancel',{cancelable:true}));
  await wait(()=>!$('photo-viewer').open);assert.ok($('photo-panel').classList.contains('expanded'));
  press('ArrowRight');assert.notEqual($('album-position').textContent,page);
  press('ArrowLeft');assert.equal($('album-position').textContent,page);
  press('Escape');assert.equal(button.getAttribute('aria-pressed'),'false');assert.equal(w.document.activeElement,button);
  assert.equal($('gallery-filter').parentElement,$('album-book'));assert.equal($('photo-panel').open,true);
});

test('the window edge keeps tabs reachable across the gap and closes only after leaving the corridor',async t=>{
  const {w,$,tab}=await setup(t),edge=$('album-edge'),drawer=$('album-drawer'),button=$('album-fullscreen');
  button.click();edge.dispatchEvent(new w.Event('pointerenter'));assert.equal(drawer.inert,false);
  assert.equal($('photo-panel').classList.contains('index-open'),true);
  assert.equal($('gallery-filter').inert,false);
  edge.dispatchEvent(new w.MouseEvent('pointerleave',{relatedTarget:tab(madrid.id)}));
  assert.equal($('photo-panel').classList.contains('index-open'),true,'Crossing from the edge onto an attached tab keeps the book shifted');
  $('album-index').dispatchEvent(new w.MouseEvent('pointerleave',{relatedTarget:$('album-book')}));
  $('photo-panel').dispatchEvent(new w.MouseEvent('pointermove',{clientX:w.innerWidth-80,bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,260));
  assert.equal(drawer.inert,false,'Crossing empty space between the screen edge and tabs must not hide them');
  $('gallery-filter').getBoundingClientRect=()=>({left:w.innerWidth-160});
  $('photo-panel').dispatchEvent(new w.MouseEvent('pointermove',{clientX:100,bubbles:true}));
  assert.equal(drawer.inert,false,'A brief pointer excursion does not snap the book closed');
  await new Promise(resolve=>setTimeout(resolve,260));assert.equal(drawer.inert,true);
  assert.equal($('photo-panel').classList.contains('index-open'),false);
  edge.click();assert.equal(edge.getAttribute('aria-expanded'),'true');tab(madrid.id).click();
  assert.match($('album-position').textContent,/Madrid/);assert.equal(drawer.inert,true);
  edge.click();$('album-restore').click();assert.equal(button.getAttribute('aria-pressed'),'false');
  button.click();$('photo-panel').querySelector('[data-close]').click();
  assert.equal($('photo-panel').open,false);assert.equal($('gallery-filter').parentElement,$('album-book'));
});

test('Escape is consumed on keydown and keyup while retaining local dialog dismissal',async t=>{
  const {w,$,press}=await setup(t,{realMap:true});
  assert.equal(press('Escape'),false);await tick();
  assert.equal($('photo-panel').open,false);
  assert.equal(press('Escape'),false,'An unhandled map Escape cannot fall through to the browser');
  const release=new w.KeyboardEvent('keyup',{key:'Escape',bubbles:true,cancelable:true});
  w.document.dispatchEvent(release);assert.ok(release.defaultPrevented);
  $('info-dialog').showModal();assert.equal(press('Escape'),false);assert.equal($('info-dialog').open,false);
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('album-fullscreen').disabled);
  $('album-fullscreen').click();assert.equal($('photo-panel').classList.contains('expanded'),true);assert.equal(press('Escape'),false);
  assert.equal($('photo-panel').classList.contains('expanded'),false);assert.equal($('photo-panel').open,true);
});

test('a first-open photo stays visible when the browser has not finished decoding its bitmap',async t=>{
  const {w,$,tab,prints}=await setup(t);tab(paris.id).click();controlledMotion(w);
  w.HTMLImageElement.prototype.decode=()=>new Promise(()=>{});
  prints()[0].click();assert.ok($('photo-viewer').open);assert.notEqual($('photo-viewer').style.opacity,'0');
  assert.ok($('full-photo').src.startsWith('blob:'));
});

test('F toggles the full scrolling gallery while leaving photo and editing shortcuts in context',async t=>{
  const {w,$,press,tab}=await setup(t,{seedStops:Array(23).fill(paris).concat(madrid)});
  $('sheet-view').click();
  const root=$('photo-gallery'),scroll=$('photo-scroll'),first=root.querySelector('.photo-image'),edge=$('album-top-edge');
  scroll.scrollTop=120;press('f');assert.ok($('photo-panel').classList.contains('expanded'));
  assert.equal(scroll.scrollTop,120);assert.equal(root.querySelectorAll('.photo-image').length,24);
  assert.equal(root.querySelector('.photo-image'),first,'Entering window view retains loaded thumbnails');
  press('F',w.document,{repeat:true});assert.ok($('photo-panel').classList.contains('expanded'));
  let travel;scroll.scrollBy=options=>{travel=options.top;};Object.defineProperty(scroll,'clientHeight',{value:300});
  press('ArrowRight');assert.equal(travel,270);press('ArrowLeft');assert.equal(travel,-270);
  edge.dispatchEvent(new w.Event('pointerenter'));assert.equal($('album-toolbar').inert,false);
  $('album-edge').click();tab(madrid.id).click();assert.equal(root.querySelectorAll('.gallery-city').length,2);
  first.click();press('f');assert.ok($('photo-panel').classList.contains('expanded'));
  assert.ok($('photo-viewer').classList.contains('flipped'),'F on a photo still turns its postcard');
  await w.RedlinePostcards.close();press('f',$('trip-name'));assert.ok($('photo-panel').classList.contains('expanded'));
  press('F');assert.ok(!$('photo-panel').classList.contains('expanded'));assert.equal(root.querySelectorAll('.photo-image').length,24);
});

test('rapid next-city taps keep the 9px city markers outside the zooming world view',async t=>{
  const route=[paris,{...paris,id:'near-paris',name:'Saint-Denis',latitude:48.9362,longitude:2.3574},madrid];
  const {w,$,press}=await setup(t,{realMap:true,route,seed:false});
  press('Escape');await tick();
  for(let i=0;i<12;i++){
    $('next-city').click();
    const layer=$('route-stops');assert.equal(layer.ownerSVGElement,$('place-labels'));
    const ink=$('route-lines');assert.equal(ink.ownerSVGElement,$('place-labels'),'The red line and its round caps cannot scale during camera jumps');
    for(const [j,path] of [...ink.children].entries()){
      if(path.style.visibility==='hidden'||!path.getAttribute('d'))continue;
      const end=path.getAttribute('d').match(/[-\d.]+/g).map(Number).slice(-2),pin=layer.children[j+1].getAttribute('transform').slice(10,-1).split(' ').map(Number);
      assert.ok(Math.hypot(end[0]-pin[0],end[1]-pin[1])<.02,'The complete stroke lands on the fixed-size city pin');
    }
    assert.equal(layer.ownerSVGElement.hasAttribute('viewBox'),false,'The overlay uses CSS pixel coordinates');
    for(const pin of layer.children){
      assert.equal(pin.querySelector('circle').getAttribute('r'),'4.5');
      if(!pin.hasAttribute('visibility'))assert.match(pin.getAttribute('transform'),/^translate\([-.\d e+]+\)$/);
    }
  }
  assert.equal(w.document.querySelectorAll('#route-stops [role=button]').length,3);
});

test('Backspace returns to the overview faster while preserving its exact final framing',async t=>{
  const route=[paris,{...paris,id:'near-paris',name:'Saint-Denis',latitude:48.9362,longitude:2.3574},madrid];
  const {w,$,press}=await setup(t,{realMap:true,route,seed:false});
  press('Escape');await tick();
  const clock=mapClock(w),world={x:0,y:0,w:1440,h:720};
  assert.deepEqual(camera(w),world);
  const returning=key=>{
    $('next-city').click();$('next-city').click();$('next-city').click();
    assert.notDeepEqual(camera(w),world);
    const start=clock.now;press(key);
    assert.notDeepEqual(camera(w),world,'The shortcut still glides instead of jumping');
    const far=camera(w).w;clock.frame();assert.ok(camera(w).w>far,`The camera answers on the very first frame (${camera(w).w/far})`);
    while(JSON.stringify(camera(w))!==JSON.stringify(world)&&clock.now-start<12000)clock.frame();
    assert.deepEqual(camera(w),world);return clock.now-start;
  };
  const normal=returning('Home'),quick=returning('Backspace');
  assert.ok(quick>normal*.7&&quick<normal*.78,`${quick}ms versus ${normal}ms`);
  assert.ok(normal<6000,`Even from a close-up, the whole world is ${normal}ms away`);
  // An ordinary camera hop takes 300 to 820ms, however far it goes.
  for(const hop of [paris.id,'near-paris',madrid.id,paris.id]){w.RedlineApp.focusStop(hop);const took=clock.settle();assert.ok(took>=300&&took<=836,`A hop took ${took}ms`);}
});

test('wheel zoom holds the point under the cursor still and reaches a large zoom quickly',async t=>{
  const {w,$,press}=await setup(t,{realMap:true,seed:false}),clock=mapClock(w),map=$('map');
  press('Escape');await tick();clock.frame();assert.equal(camera(w).w,1440);
  const wheel=(deltaY,extra={})=>map.dispatchEvent(new w.WheelEvent('wheel',{clientX:288,clientY:270,deltaY,bubbles:true,cancelable:true,...extra}));
  const began=clock.now;let reached=null;
  for(let i=0;i<40;i++){
    if(i<6)assert.equal(wheel(-160),false,'The wheel zooms the map, never the page');
    clock.frame();
    const {x,y,w:width,h:height}=camera(w);
    assert.ok(Math.abs(x+width*.2-288)<1e-6&&Math.abs(y+height*.3-216)<1e-6,`The point under the cursor stays put (frame ${i})`);
    if(reached===null&&1440/width>=20)reached=clock.now-began;
  }
  assert.ok(reached!==null&&reached<400,`Six firm notches reach 20× in ${reached}ms`);
  // Gains, with the camera already well inside its limits so nothing clamps.
  const near=(actual,expected,message)=>assert.ok(Math.abs(actual/expected-1)<1e-9,`${message}: ${actual} versus ${expected}`);
  const step=(...args)=>{const before=camera(w).w;wheel(...args);clock.settle();return camera(w).w/before;};
  near(step(100),Math.exp(.34),'A wheel tick');near(step(-100),Math.exp(-.34),'And back');
  near(step(-100,{ctrlKey:true}),Math.exp(-1.2),'A trackpad pinch arrives as a much smaller control-wheel');near(step(100,{ctrlKey:true}),Math.exp(1.2),'And back');
  near(step(-3,{deltaMode:1}),Math.exp(-99*.0034),'A line is 33 pixels');near(step(3,{deltaMode:1}),Math.exp(99*.0034),'And back');
  near(step(-900),Math.exp(-160*.0034),'One event is capped');near(step(900),Math.exp(160*.0034),'And back');
  const before=camera(w).w;assert.equal(step(0),1,'A sideways scroll does not zoom');assert.equal(camera(w).w,before);
  // The +/- buttons take a confident step and settle fast on the idle spring.
  const press1=id=>{const width=camera(w).w;$(id).click();const took=clock.settle();return [camera(w).w/width,took];};
  const [inward,inTime]=press1('zoom-in'),[outward,outTime]=press1('zoom-out');
  near(inward,.6,'Zoom in');near(outward,1/.6,'Zoom out');
  assert.ok(inTime<=300&&outTime<=300,`The buttons settle in ${inTime} and ${outTime}ms`);
});

test('two touch pointers pinching apart zoom in around their midpoint',async t=>{
  const {w,$,press}=await setup(t,{realMap:true,seed:false}),clock=mapClock(w),map=$('map');
  press('Escape');await tick();clock.frame();
  const touch=(type,id,x,y)=>{
    const event=new w.MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,cancelable:true});
    Object.defineProperties(event,{pointerId:{value:id},pointerType:{value:'touch'}});map.dispatchEvent(event);
  };
  const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} versus ${expected}`);
  touch('pointerdown',1,600,450);touch('pointerdown',2,700,450);
  assert.equal(camera(w).w,1440,'Two fingers landing do not move the map');
  touch('pointermove',2,800,450);clock.settle();
  let view=camera(w);near(view.w,720);near(view.h,360);
  near(view.x+view.w*700/1440,700);near(view.y+view.h*.5,360);
  const spread=view.x+view.w*600/1440;touch('pointermove',1,400,450);clock.settle();
  view=camera(w);near(view.w,360);near(view.x+view.w*600/1440,spread);
  touch('pointermove',1,600,450);touch('pointermove',2,700,450);clock.settle();
  view=camera(w);near(view.w,1440);
  // A lifted finger ends the pinch instead of turning the other one into a zoom.
  touch('pointerup',1,600,450);touch('pointermove',2,900,450);clock.settle();assert.equal(camera(w).w,view.w);
  touch('pointerup',2,900,450);
  // From a close-up, one finger drags until the second lands.
  touch('pointerdown',1,600,450);touch('pointerdown',2,700,450);touch('pointermove',2,900,450);clock.settle();
  near(camera(w).w,480);touch('pointerup',1,600,450);touch('pointerup',2,900,450);
  touch('pointerdown',1,600,450);assert.ok(map.classList.contains('dragging'),'One finger drags a close-up');
  touch('pointerdown',2,700,450);assert.equal(map.classList.contains('dragging'),false,'A second finger takes over from the drag');
  touch('pointermove',2,800,450);clock.settle();near(camera(w).w,240);
});

test('a mouse double-click zooms in unless the controls are hidden, where it brings them back',async t=>{
  const {w,$,press}=await setup(t,{realMap:true,seed:false}),clock=mapClock(w),map=$('map');
  press('Escape');await tick();clock.frame();
  const double=(extra={})=>{map.dispatchEvent(new w.MouseEvent('dblclick',{clientX:360,clientY:450,bubbles:true,...extra}));clock.settle();return camera(w);};
  const zoomed=double();assert.equal(zoomed.w,720);assert.ok(Math.abs(zoomed.x+zoomed.w*.25-360)<1e-6&&Math.abs(zoomed.y+zoomed.h*.5-360)<1e-6,'At the pointer');
  assert.equal(double({shiftKey:true}).w,1440,'Shift zooms back out');
  press('h');assert.ok(w.document.body.classList.contains('map-only'));assert.equal(w.document.querySelector('.zoom-controls').inert,true);
  const hidden=camera(w);assert.deepEqual(double(),hidden,'With the controls hidden it does not zoom');
  assert.equal(w.document.body.classList.contains('map-only'),false,'It brings them back');assert.equal(w.document.querySelector('.zoom-controls').inert,false);
  assert.equal(double().w,720,'And then zooms as usual');
});

test('every great name lettered at world view is inside the sheet, and an empty chart has its headings',async t=>{
  const {w,press}=await setup(t,{realMap:true,route:[],seed:false}),clock=mapClock(w);
  press('Escape');await tick();clock.frame();
  assert.equal(w.RedlineApp.getStops().length,0);assert.deepEqual(camera(w),{x:0,y:0,w:1440,h:720});
  const atlas=w.RedlineApp.atlas,great=atlas.labels.filter(label=>label.kind==='continent'||label.kind==='ocean'),names=great.map(label=>label.text.replace(/\s+/g,' '));
  for(const name of ['Europe','Atlantic Ocean'])assert.ok(names.includes(name),`${name} is lettered: ${names}`);
  assert.equal(names.includes('EUROPE'),false,'Names are stored in natural case; capitals are the lettering\'s business');
  assert.equal(new Set(names).size,names.length);assert.ok(names.length>=8,`Most of the great names fit: ${names}`);
  for(const label of great){
    // Measured as the lettering is drawn, turned to its angle, within the chart's graduated border (6px inset, 4.5px bar).
    const {w:width,h:height}=atlas.measure(label.kind,label.text,label.angle,label.curve),turn=label.angle*Math.PI/180,cos=Math.abs(Math.cos(turn)),sin=Math.abs(Math.sin(turn));
    const halfW=(width*cos+height*sin)/2,halfH=(width*sin+height*cos)/2;
    assert.ok(label.x-halfW>=10.5&&label.x+halfW<=1429.5&&label.y-halfH>=10.5&&label.y+halfH<=889.5,`${label.text} stays on the sheet at ${label.x},${label.y}`);
  }
});

test('a seven-stop trip uses the original flowing trace pace, and holding Return hurries it',async t=>{
  const cities=[['New York',-74.006,40.7128],['London',-.1257,51.5085],['Cairo',31.2497,30.0626],['Delhi',77.2315,28.6519],['Tokyo',139.6917,35.6895],['Sydney',151.2073,-33.8679],['Rio de Janeiro',-43.1729,-22.9068]];
  const route=cities.map(([name,longitude,latitude],i)=>({id:`world-stop-${i}`,name,country:'Test',longitude,latitude}));
  const {w,$,press}=await setup(t,{realMap:true,route,seed:false}),clock=mapClock(w);
  press('Escape');await tick();clock.frame();
  const sail=start=>{
    const began=clock.now;start();assert.equal($('play-label').textContent,'Pause');
    while($('play-label').textContent==='Pause'&&clock.now-began<60000)clock.frame();
    assert.deepEqual(camera(w),{x:0,y:0,w:1440,h:720},'Every trip ends on the whole world');return clock.now-began;
  };
  const normal=sail(()=>$('play').click());assert.ok(normal>13000&&normal<15000,`The trip took ${normal}ms`);
  const hurried=sail(()=>press('Enter'));w.document.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Enter',bubbles:true}));
  assert.ok(hurried<normal/1.9&&hurried>normal/2.6,`Held, ${hurried}ms against ${normal}ms: 2× after a moment's grace`);
  assert.ok(Math.abs(sail(()=>$('play').click())-normal)<50,'Letting go returns to normal speed');
  // However far an ordinary hop goes, it is over in 820ms.
  w.RedlineApp.focusStop('world-stop-0');clock.settle();
  for(let i=0;i<4;i++)$('map').dispatchEvent(new w.WheelEvent('wheel',{clientX:720,clientY:450,deltaY:-160,bubbles:true,cancelable:true}));clock.settle();
  w.RedlineApp.focusStop('world-stop-5');const across=clock.settle();assert.ok(Math.abs(across-820)<=16,`New York to Sydney took ${across}ms`);
});

test('a trace zoomed in by hand slows to less than half pace at most, and settles promptly at each port',async t=>{
  const cities=[['London',-.1257,51.5085],['Cairo',31.2497,30.0626],['Delhi',77.2315,28.6519],['Tokyo',139.6917,35.6895]];
  const route=cities.map(([name,longitude,latitude],i)=>({id:`manual-stop-${i}`,name,country:'Test',longitude,latitude}));
  const {w,$,press}=await setup(t,{realMap:true,route,seed:false}),clock=mapClock(w),map=$('map');
  press('Escape');await tick();clock.frame();
  const until=step=>{const began=clock.now;while(map.dataset.tripStep!==String(step)&&clock.now-began<20000)clock.frame();assert.equal(map.dataset.tripStep,String(step));return clock.now-began;};
  const legTime=(a,b)=>w.RedlineTrace.duration(w.RedlineTrace.measure(w.RedlineLayout.route(w.RedlineGeo.geoInterpolate(a,b))).length);
  $('play').click();clock.run(3);
  for(let i=0;i<12;i++)map.dispatchEvent(new w.WheelEvent('wheel',{clientX:720,clientY:450,deltaY:-160,bubbles:true,cancelable:true}));
  assert.equal($('play-label').textContent,'Pause','Zooming does not interrupt the voyage');
  until(2);
  for(const leg of [1,2]){
    const nominal=legTime(cities[leg].slice(1),cities[leg+1].slice(1)),took=until(leg+2);
    assert.ok(took>=nominal/.45&&took<=620+nominal/.45+32,`Leg ${leg}: ${took}ms for a ${nominal}ms leg at the .45 pace floor, after a pause of 400ms and a settle of at most 620ms`);
    const stop=w.RedlineLayout.project(cities[leg+1].slice(1)),view=camera(w);
    assert.ok(view.w<7,`The chosen close-up is kept (${view.w})`);
    assert.ok(Math.abs(stop[0]-view.x-view.w/2)<view.w&&Math.abs(stop[1]-view.y-view.h/2)<view.h,'At full zoom the camera still keeps within a window of the ink');
  }
});

test('a port far from a sudden close-up gets 620ms of settling at most, counted faster while Return is held',async t=>{
  // Crossing the date line frames the whole sheet, leaving the port at its far edge.
  const cities=[['Suva',178.44,-18.14],['Apia',-171.77,-13.83],['Tokyo',139.6917,35.6895]];
  const route=cities.map(([name,longitude,latitude],i)=>({id:`settle-stop-${i}`,name,country:'Test',longitude,latitude}));
  const {w,$,press}=await setup(t,{realMap:true,route,seed:false}),clock=mapClock(w),map=$('map');
  press('Escape');await tick();clock.frame();
  const arrived=()=>map.dataset.tripStep==='2',drawing=()=>$('route-lines').children[1].style.visibility!=='hidden'&&Boolean($('route-lines').children[1].getAttribute('d'));
  const home=()=>{$('play').click();w.document.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Enter',bubbles:true}));press('Home');clock.settle();assert.deepEqual(camera(w),{x:0,y:0,w:1440,h:720});};
  const settling=start=>{
    // The first voyage times the leg, so the second can zoom in hard on its last frame before landing.
    let began=clock.now;start();while(!arrived()&&clock.now-began<20000)clock.frame();const leg=clock.now-began;assert.ok(arrived());home();
    began=clock.now;start();while(clock.now-began<leg-32)clock.frame();assert.equal(arrived(),false);
    for(let i=0;i<12;i++)map.dispatchEvent(new w.WheelEvent('wheel',{clientX:720,clientY:450,deltaY:-160,bubbles:true,cancelable:true}));
    while(!arrived()&&clock.now-began<20000)clock.frame();assert.ok(arrived());
    const landed=clock.now;while(!drawing()&&clock.now-landed<5000)clock.frame();
    assert.ok(camera(w).w<7,'The chosen close-up carries on');const took=clock.now-landed;home();return took;
  };
  const normal=settling(()=>$('play').click());assert.ok(normal>0&&normal<=656,`The camera waited ${normal}ms before the next leg`);
  const held=settling(()=>press('Enter'));assert.ok(held>0&&held<=352,`Held, the 620ms cap is reached in ${held}ms, cutting the camera's chase short`);
});

// The map's own trips: names and places in the order the sheet wants them.
const LONDON=['London',-.1257,51.5085],PARIS=['Paris',2.3488,48.8534],ROME=['Rome',12.5113,41.8919],ATHENS=['Athens',23.7278,37.9838],CAIRO=['Cairo',31.2497,30.0626],TOKYO=['Tokyo',139.6917,35.6895],SYDNEY=['Sydney',151.2073,-33.8679],HONOLULU=['Honolulu',-157.8583,21.3069];
const voyage=places=>places.map(([name,longitude,latitude],i)=>({id:`voyage-stop-${i}`,name,country:'Test',longitude,latitude}));
async function chart(t,places){
  const opened=await setup(t,{realMap:true,route:voyage(places),seed:false}),{w,$,press}=opened,clock=mapClock(w),map=$('map');
  press('Escape');await tick();clock.frame();
  const wheel=(deltaY=-160,x=720,y=450)=>map.dispatchEvent(new w.WheelEvent('wheel',{clientX:x,clientY:y,deltaY,bubbles:true,cancelable:true}));
  const pointer=(type,x,y,{id=1,kind='mouse',target=map}={})=>{const event=new w.MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true,cancelable:true});Object.defineProperties(event,{pointerId:{value:id},pointerType:{value:kind}});target.dispatchEvent(event);};
  const until=(step,limit=20000)=>{const began=clock.now;while(map.dataset.tripStep!==String(step)&&clock.now-began<limit)clock.frame();assert.equal(map.dataset.tripStep,String(step));};
  return {...opened,clock,map,wheel,pointer,until,sailing:()=>$('play-label').textContent==='Pause',stop:i=>$('route-stops').children[i]};
}

test('the reference voyages restore the original pace: 5.7, 33.6, 16.7, 13.7 and 18.9 seconds',async t=>{
  const trips={
    starter:[5700,[['New York',-74.006,40.7128],['London',-.1257,51.5085],['Cairo',31.2497,30.0626]]],
    voyage:[33600,[['Lisbon',-9.1393,38.7223],['Seville',-5.9845,37.3891],['Marrakesh',-7.9811,31.6295],['Cadiz',-6.2886,36.5271],['Rome',12.5113,41.8919],['Athens',23.7278,37.9838],['Istanbul',28.9784,41.0082],['Cairo',31.2497,30.0626],['Muscat',58.4059,23.5859],['Mumbai',72.8777,19.076],['Kathmandu',85.324,27.7172],['Bangkok',100.5018,13.7563],['Singapore',103.8198,1.3521],['Rio de Janeiro',-43.1729,-22.9068]]],
    europe:[16700,[['London',-.1257,51.5085],['Paris',2.3488,48.8534],['Amsterdam',4.9041,52.3676],['Berlin',13.405,52.52],['Prague',14.4208,50.088],['Vienna',16.3738,48.2082]]],
    world:[13700,[['New York',-74.006,40.7128],['London',-.1257,51.5085],['Cairo',31.2497,30.0626],['Delhi',77.2315,28.6519],['Tokyo',139.6917,35.6895],['Sydney',151.2073,-33.8679],['Rio de Janeiro',-43.1729,-22.9068]]],
    italy:[18900,[['Milan',9.19,45.4642],['Venice',12.3155,45.4408],['Florence',11.2558,43.7696],['Siena',11.3308,43.3188],['Rome',12.4964,41.9028],['Naples',14.2681,40.8518],['Bari',16.8719,41.1171]]],
  };
  for(const [name,[target,places]] of Object.entries(trips)){
    const {$,w,clock,sailing}=await chart(t,places),began=clock.now;$('play').click();
    while(sailing()&&clock.now-began<60000)clock.frame();
    assert.deepEqual(camera(w),{x:0,y:0,w:1440,h:720},name);
    assert.ok(Math.abs(clock.now-began-target)<target*.08,`${name} took ${clock.now-began}ms against about ${target}ms`);
  }
});

test('the original trace flows through ports, reveals arrival names, and still pauses and resumes',async t=>{
  const {w,$,clock,map,sailing,until,stop}=await chart(t,[LONDON,PARIS,ROME,ATHENS]);
  $('play').click();until(2);
  assert.equal(stop(1).style.opacity,'1');assert.equal(stop(1)._label.classList.contains('label-hidden'),false);
  const at=camera(w);clock.run(4);assert.notDeepEqual(camera(w),at,'The next leg begins without the added dwell');
  $('play').click();const paused=camera(w);clock.run(40);assert.deepEqual(camera(w),paused);assert.equal(sailing(),false);
  $('play').click();until(3);assert.equal(map.dataset.tripStep,'3');
});

test('stepping with the arrows stays quick though the voyage is slower, and a second press still lands at once',async t=>{
  const {w,$,press,clock,map,sailing,until}=await chart(t,[LONDON,PARIS,ROME,ATHENS]);
  press('ArrowRight');assert.equal(map.dataset.tripStep,'1');clock.settle();
  let began=clock.now;press('ArrowRight');until(2);const hop=clock.now-began;clock.settle();
  assert.ok(hop<5500,`The first step, with its long zoom, takes ${hop}ms`);
  began=clock.now;press('ArrowRight');until(3);const next=clock.now-began;clock.settle();
  assert.ok(next>=1500&&next<4500,`A step from port to port takes ${next}ms`);assert.equal(sailing(),false,'And stops there');
  press('ArrowRight');assert.ok(sailing());press('ArrowRight');assert.equal(sailing(),false,'The second press lands');assert.equal(map.dataset.tripStep,'4');
  press('Home');clock.settle();assert.deepEqual(camera(w),{x:0,y:0,w:1440,h:720});
});

test('Escape acts on the innermost dialog: the photo first, then the album',async t=>{
  const {$,press,prints,tab}=await setup(t,{realMap:true});
  tab(paris.id).click();prints()[0].click();assert.equal($('photo-viewer').open,true);
  press('Escape');await wait(()=>!$('photo-viewer').open);
  assert.equal($('photo-panel').open,true,'The album behind the photo stays open');
  $('album-fullscreen').click();assert.ok($('photo-panel').classList.contains('expanded'));
  prints()[0].click();assert.equal($('photo-viewer').open,true);
  press('Escape');await wait(()=>!$('photo-viewer').open);
  assert.ok($('photo-panel').classList.contains('expanded'),'And keeps its window view');
  press('Escape');assert.equal($('photo-panel').classList.contains('expanded'),false);assert.equal($('photo-panel').open,true);
  press('Escape');await wait(()=>!$('photo-panel').open);
});

test('Space taps pause and resume, while a hold boosts without pausing on press or release',async t=>{
  const {$,w,press,clock,map,sailing,stop}=await chart(t,[LONDON,PARIS,ROME,ATHENS]);
  // Chrome and Firefox focus a clicked button.
  $('play').focus();$('play').dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1}));assert.ok(sailing());
  assert.equal(w.document.activeElement,map,'A pointer click leaves the keys with the map');
  press(' ',map);press(' ',map,{repeat:true});clock.run(20);assert.ok(sailing(),'Holding Space does not stop the voyage');
  w.document.dispatchEvent(new w.KeyboardEvent('keyup',{key:' ',bubbles:true}));
  assert.ok(sailing(),'Releasing a hold keeps the trace running');
  const tap=target=>{press(' ',target);w.document.dispatchEvent(new w.KeyboardEvent('keyup',{key:' ',bubbles:true,cancelable:true}));};
  tap(map);assert.equal(sailing(),false,'A single Space tap pauses from the map');
  const frozen=camera(w);clock.run(20);assert.deepEqual(camera(w),frozen,'The paused camera stays still');
  tap(map);assert.ok(sailing(),'Another tap resumes');
  $('play').focus();tap($('play'));assert.equal(sailing(),false,'The focused play button behaves the same way');
  press('Home');clock.settle();
  // Return on a focused port looks at it, then sets sail; the next key must not fly back to it.
  stop(0).focus();press('Enter',stop(0));w.document.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Enter',bubbles:true}));clock.settle();press('Enter',stop(0));assert.ok(sailing());
  w.document.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Enter',bubbles:true}));
  tap(stop(0));assert.equal(sailing(),false,'Space on an active route stop also pauses');
  tap(stop(0));assert.ok(sailing(),'And resumes the current voyage without jumping back');
});

test('a zoom chosen at rest carries into the next leg and the next trace, and the whole world hands back to the automatic camera',async t=>{
  const {w,$,press,clock,wheel,until,sailing,map}=await chart(t,[LONDON,PARIS,ROME,ATHENS]);
  const width=()=>camera(w).w,zoomIn=()=>{for(let i=0;i<4;i++)wheel();clock.settle();return width();};
  const near=(actual,expected,message)=>assert.ok(Math.abs(actual/expected-1)<.002,`${message}: ${actual} versus ${expected}`);
  // Paused during travel.
  $('play').click();clock.run(10);wheel();clock.run(5);$('play').click();assert.equal(sailing(),false);
  let chosen=zoomIn();$('play').click();clock.run(40);near(width(),chosen,'Resumed after a pause');
  press('Home');clock.settle();assert.equal(width(),1440);
  // At a stop, sailing on with an arrow.
  press('ArrowRight');press('ArrowRight');press('ArrowRight');assert.equal(map.dataset.tripStep,'2');clock.settle();
  chosen=zoomIn();press('ArrowRight');until(3);clock.settle();near(width(),chosen,'After a leg from a stop');
  press('Home');clock.settle();
  // On the whole-trip view, then Trace route.
  chosen=zoomIn();$('play').click();clock.run(40);near(width(),chosen,'In the next trace');
  $('play').click();press('Home');clock.settle();
  // Choosing a zoom and then a port keeps both.
  chosen=zoomIn();w.RedlineApp.focusStop('voyage-stop-1');clock.settle();near(width(),chosen,'Flying to a port');
  $('play').click();clock.run(40);near(width(),chosen,'And sailing from it');
  $('play').click();press('Home');clock.settle();
  // Backing all the way out leaves the choice to the automatic camera, which comes in for a regional trip.
  zoomIn();for(let i=0;i<8;i++)wheel(160);clock.settle();assert.equal(width(),1440);
  $('play').click();until(2);assert.ok(width()<1440/2,`The automatic camera came in (${width()})`);
});

test('switching trips while zoomed in shows the new route from the whole world',async t=>{
  const {w,clock,wheel}=await chart(t,[LONDON,PARIS]);
  for(let i=0;i<6;i++)wheel(-160,720,200);clock.settle();assert.ok(camera(w).w<300);
  w.RedlineApp.setStops(voyage([TOKYO,SYDNEY]));clock.settle();
  assert.deepEqual(camera(w),{x:0,y:0,w:1440,h:720});
  for(let i=0;i<6;i++)wheel(-160,720,200);clock.settle();const close=camera(w);
  w.RedlineApp.setStops(voyage([TOKYO,SYDNEY]),{preserveHistory:true});clock.settle();assert.deepEqual(camera(w),close,'A save rewriting the same trip keeps the view');
});

test('removing a middle stop leaves two stops in one place: the trace neither dives at it nor dawdles',async t=>{
  const {$,w,clock}=await chart(t,[LONDON,PARIS,LONDON,ROME]);
  $('stop-list').children[1].querySelector('.remove-stop').click();clock.frame();
  const began=clock.now;let closest=1440;$('play').click();
  while($('map').dataset.tripStep!=='2'&&clock.now-began<20000){clock.frame();closest=Math.min(closest,camera(w).w);}
  assert.ok(clock.now-began<3200,`The leg to nowhere took ${clock.now-began}ms`);
  assert.ok(1440/closest<14,`The camera came in only to frame the next leg (${1440/closest}×)`);
});

test('a hand-zoomed trace cuts across the date line instead of sweeping the sheet',async t=>{
  const {w,$,clock,wheel}=await chart(t,[HONOLULU,TOKYO,SYDNEY]);
  // Close in over Honolulu first, so that the only long way to go is over the date line.
  for(let i=0;i<4;i++)wheel(-160,88,343);clock.settle();
  $('play').click();
  let last=camera(w),big=0,frames=0;
  while($('map').dataset.tripStep!=='2'&&frames<3000){
    clock.frame();frames++;const now=camera(w);
    if(Math.abs(now.x-last.x)*1440/now.w>200)big++;last=now;
  }
  assert.equal($('map').dataset.tripStep,'2');
  assert.ok(big<=1,`${big} frames swept more than 200px`);
});

test('a plain press on the map leaves the voyage sailing; only a real drag takes the camera',async t=>{
  const {w,$,clock,pointer,wheel,sailing}=await chart(t,[LONDON,PARIS,ROME,ATHENS]);
  $('play').click();clock.run(60);assert.ok(camera(w).w<1440&&sailing());
  pointer('pointerdown',500,500);clock.frame();pointer('pointermove',502,501);clock.frame();
  assert.ok(sailing(),'A press with a tremor is not a drag');pointer('pointerup',502,501);clock.frame();assert.ok(sailing());
  pointer('pointerdown',500,500);clock.run(3);pointer('pointermove',530,500);
  assert.equal(sailing(),false,'A drag takes over');
  const held=camera(w);pointer('pointermove',560,500);clock.frame();
  assert.ok(Math.abs((held.x-camera(w).x)*1440/held.w-30)<.01,'And pans from where the camera had got to');pointer('pointerup',560,500);
  // A wheel in the middle of a drag leaves the drag behind rather than throwing the map.
  pointer('pointerdown',500,500);pointer('pointermove',540,500);clock.frame();wheel(-160,500,500);clock.settle();
  const zoomed=camera(w);pointer('pointermove',541,500);clock.frame();assert.deepEqual(camera(w),zoomed,'The next move does not jump');pointer('pointerup',541,500);
  assert.equal($('map').classList.contains('dragging'),false);
});

test('the glide back to the world finishes rather than strands, whatever interrupts it',async t=>{
  const {w,$,clock,pointer,press,until,sailing,map}=await chart(t,[LONDON,PARIS,ROME]);
  const glide=()=>{$('play').click();until(3);clock.frame();assert.ok(sailing()&&camera(w).w<1440,'Gliding home');};
  const world={x:0,y:0,w:1440,h:720};
  glide();$('play').click();assert.equal(sailing(),false);assert.deepEqual(camera(w),world);assert.equal(map.dataset.tripStep,'0');
  glide();press('Escape');assert.equal(sailing(),false);assert.deepEqual(camera(w),world,'Escape finishes it too');assert.equal(map.dataset.tripStep,'0');
  glide();press(' ',map);w.document.dispatchEvent(new w.KeyboardEvent('keyup',{key:' ',bubbles:true}));assert.equal(sailing(),false);assert.equal(map.dataset.tripStep,'0','A Space tap finishes the home glide and pauses');
  press(' ',map);w.document.dispatchEvent(new w.KeyboardEvent('keyup',{key:' ',bubbles:true}));assert.ok(sailing());assert.equal(map.dataset.tripStep,'1','The next tap sets out again from the first port');
  press('Home');clock.settle();
  glide();pointer('pointerdown',500,500);pointer('pointermove',540,500);assert.equal(sailing(),false);
  assert.equal(map.dataset.tripStep,'0','A drag takes the whole trip with it, not a stranded port');assert.equal($('route-lines').children[1].style.visibility,'');pointer('pointerup',540,500);
});

test('stepping back keeps the port you are sailing to on the map, while a forward leg still reveals it',async t=>{
  const {$,clock,press}=await chart(t,[LONDON,PARIS,ROME,ATHENS]);
  const shown=()=>[...$('route-stops').children].map(node=>node.style.opacity);
  press('ArrowRight');press('ArrowRight');assert.equal($('map').dataset.tripStep,'1');clock.frame();
  assert.deepEqual(shown().slice(0,2),['1','0'],'Forward, the next port waits for the ink');
  press('ArrowRight');assert.equal($('map').dataset.tripStep,'2');press('ArrowRight');press('ArrowRight');assert.equal($('map').dataset.tripStep,'3');
  press('ArrowLeft');clock.run(3);assert.deepEqual(shown(),['1','1','1','0'],'Backward, the one you are leaving goes last');
});

test('the first arrow from the overview re-lays the names, and every arrival shows its port',async t=>{
  const {w,$,clock,press,until}=await chart(t,[LONDON,PARIS,ROME]);
  clock.settle();assert.equal(w.testFrames.size,0);
  press('ArrowRight');assert.equal($('map').dataset.tripStep,'1');assert.equal(w.testFrames.size,1,'Labels are laid out for the route as it now stands');clock.frame();
  press('ArrowRight');until(2);assert.equal(w.testFrames.size,1,'Arrival makes the new port the priority on the next frame');
});

test('touching a port closes the search suggestions, and a port has a finger-sized target',async t=>{
  const {w,$,pointer,stop}=await chart(t,[LONDON,PARIS]);
  $('destination').value='Par';$('destination').dispatchEvent(new w.Event('input',{bubbles:true}));assert.equal($('suggestion-panel').hidden,false);
  pointer('pointerdown',500,500,{target:stop(1)});assert.equal($('suggestion-panel').hidden,true);
  const [dot,target]=stop(1).querySelectorAll('circle');assert.equal(dot.getAttribute('r'),'4.5');assert.equal(target.getAttribute('r'),'12');assert.equal(target.getAttribute('fill'),'transparent');assert.equal(target.hasAttribute('pointer-events'),false);
});

test('holding H toggles the controls once',async t=>{
  const {w,press}=await chart(t,[LONDON,PARIS]);
  press('h');for(let i=0;i<9;i++)press('h',w.document,{repeat:true});
  assert.equal(w.document.body.classList.contains('map-only'),true);
});

test('with reduced motion Trace route lands on the last port with the route drawn',async t=>{
  const {w,$,clock,sailing}=await chart(t,[LONDON,PARIS,ROME]);
  w.matchMedia=()=>({matches:true});$('play').click();clock.frame();
  assert.equal($('map').dataset.tripStep,'3');assert.equal(sailing(),false);assert.notDeepEqual(camera(w),{x:0,y:0,w:1440,h:720});
  assert.ok([...$('route-lines').children].every(path=>path.getAttribute('d')),'Every leg is drawn');
});

test('dragging the window edge during a trace does not hold the ink back',async t=>{
  const {w,$,clock,sailing}=await chart(t,[LONDON,PARIS,ROME]);
  $('play').click();
  let frames=0;while($('map').dataset.tripStep==='0'||$('map').dataset.tripStep==='1'){for(const resized of w.testResizes)resized();clock.frame();assert.ok(++frames<450,'The voyage still reaches its next port');}
  await new Promise(resolve=>setTimeout(resolve,170));assert.ok(sailing(),'The camera recomposes once the window has settled');clock.frame();assert.ok(sailing());
});

test('legs wholly off screen are not rewritten as the camera moves',async t=>{
  const {w,$,clock,wheel}=await chart(t,[LONDON,PARIS,TOKYO,SYDNEY]);
  const far=$('route-lines').children[2],near=$('route-lines').children[0];
  assert.ok(far.getAttribute('d')&&near.getAttribute('d'),'At world view every leg is drawn');
  for(let i=0;i<6;i++)wheel(-160,720,200);clock.settle();
  assert.equal(far.getAttribute('d'),'');assert.equal(far.style.visibility,'hidden');assert.ok(near.getAttribute('d'));assert.equal(near.style.visibility,'');
  let writes=0;const write=far.setAttribute;far.setAttribute=function(...args){writes++;return write.apply(this,args);};
  wheel(-160,720,200);clock.settle();assert.ok(writes===0,'Moving on costs it nothing');
  for(let i=0;i<8;i++)wheel(160);clock.settle();assert.equal(camera(w).w,1440);assert.ok(far.getAttribute('d'),'Back in view it is drawn again');assert.equal(far.style.visibility,'');
});

test('tabbing to a port out of view brings it into view at the same zoom',async t=>{
  const {w,clock,wheel,stop}=await chart(t,[LONDON,PARIS,TOKYO]);
  for(let i=0;i<6;i++)wheel(-160,720,200);clock.settle();const {w:width}=camera(w),[x,y]=stop(2)._point;
  assert.ok(x>camera(w).x+width);
  stop(2).focus();clock.settle();const view=camera(w);
  assert.ok(Math.abs(view.w-width)<1e-6,'The zoom stays');assert.ok(x>=view.x&&x<=view.x+view.w&&y>=view.y&&y<=view.y+view.h,'And the port is in the window');
});

test('the zoom settles without a final snap, and promptly',async t=>{
  const {w,$,clock}=await chart(t,[LONDON,PARIS]);
  for(const id of ['zoom-in','zoom-in','zoom-in','zoom-out']){
    $(id).click();let last=camera(w).w,step=0,frames=0;
    while(w.testFrames.size){clock.frame();const now=camera(w).w;if(now!==last){step=Math.abs(now-last)*1440/now;last=now;frames++;}}
    assert.ok(step<1.2,`The last frame moves the edge of the window ${step}px`);assert.ok(frames<=20,`${frames} frames`);
  }
});

test('a port as a hub keeps its name when its spokes cover every slot',async t=>{
  // A hub at the map's centre with a leg out and back to places all around it.
  const out=[['A',-60,50],['B',-20,75],['C',60,70],['D',90,10],['E',60,-40],['F',-20,-60],['G',-90,-30],['H',-110,30]],hub=['London',-.1257,51.5085];
  const {$,clock}=await chart(t,out.flatMap(place=>[hub,place]).concat([hub]));
  clock.frame();const owner=[...$('route-stops').children].filter(node=>node.querySelector('text').textContent==='LONDON'&&!node.querySelector('text').classList.contains('label-hidden'));
  assert.equal(owner.length,1,'Named once, even with every side crossed by the red line');
});

test('with the logbook open a removed stop keeps the keys in the list, and Space on the page folds it first',async t=>{
  const {w,$,press,sailing}=await chart(t,[LONDON,PARIS,ROME]);
  $('trips-button').click();assert.equal($('trip-panel').hidden,false);await wait(()=>$('trip-list').querySelector('.trip-card'));
  const row=i=>$('stop-list').children[i],focused=()=>w.document.activeElement;
  row(1).querySelector('.remove-stop').focus();row(1).querySelector('.remove-stop').dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:0}));
  assert.equal(focused(),row(1).querySelector('.remove-stop'),'Focus lands on the same row\'s ×');assert.equal(row(1).querySelector('.stop-grip').textContent.slice(2),'Rome');
  press(' ',focused());assert.equal(sailing(),false,'Space on that × does not set sail behind the logbook');
  row(0).querySelector('.stop-grip').focus();press('z',focused(),{ctrlKey:true});assert.equal($('stop-list').children.length,3);
  assert.equal(focused(),row(0).querySelector('.stop-grip'),'Undo from a row stays on that row');
  // A pointer leaves the panel with the keys, not the next ×.
  row(2).querySelector('.remove-stop').focus();row(2).querySelector('.remove-stop').dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1}));assert.equal(focused(),$('trip-panel'));
  for(const index of [1,0]){row(index).querySelector('.remove-stop').focus();row(index).querySelector('.remove-stop').dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:0}));}
  assert.equal($('stop-list').children.length,0);assert.equal(focused(),$('trip-panel'),'An emptied list hands focus to the logbook');
  focused().blur();press('z',w.document.body,{ctrlKey:true});press('z',w.document.body,{ctrlKey:true});press('z',w.document.body,{ctrlKey:true});assert.equal($('stop-list').children.length,3);
  press(' ',w.document.body);assert.equal($('trip-panel').hidden,true,'Space on the page folds the logbook');assert.ok(sailing(),'And then sets sail');
});

test('a touch swipe on a stop\'s name leaves the route alone; its number picks it up',async t=>{
  const {w,$,pointer}=await chart(t,[LONDON,PARIS,ROME]);
  $('trips-button').click();await wait(()=>$('trip-list').querySelector('.trip-card'));const row=i=>$('stop-list').children[i],names=()=>w.RedlineApp.getStops().map(stop=>stop.name);
  w.document.elementFromPoint=()=>row(2);
  const swipe=(target,grip)=>{pointer('pointerdown',100,100,{kind:'touch',target});pointer('pointermove',100,140,{kind:'touch',target:grip});pointer('pointerup',100,140,{kind:'touch',target:grip});};
  let grip=row(0).querySelector('.stop-grip');swipe(grip.lastElementChild,grip);assert.deepEqual(names(),['London','Paris','Rome'],'A swipe scrolls the list');
  grip=row(0).querySelector('.stop-grip');swipe(grip.querySelector('.stop-number'),grip);assert.deepEqual(names(),['Paris','Rome','London'],'The numeral is the handle');
  const css=source('public/style.css');
  assert.match(css.match(/^\.stop-grip \{[^}]*\}/m)[0],/touch-action: pan-y/);assert.match(css.match(/^\.stop-number \{[^}]*\}/m)[0],/touch-action: none/);
});

test('the album\'s pin flies to its city only once the book has shut, with the keys on the map',async t=>{
  const {w,$,tab,mapCalls}=await setup(t);tab(paris.id).click();
  const motion=controlledMotion(w);$('album-pages').querySelector('.gallery-map-button').click();
  await wait(()=>motion.running.size>0);assert.equal(mapCalls.focused,null,'Nothing is painted behind the book yet, so no flight has begun');
  for(let i=0;i<4&&$('photo-panel').open;i++)await motion.finish();await wait(()=>!$('photo-panel').open);
  assert.equal(mapCalls.focused,paris.id);assert.equal(w.document.activeElement,$('map'));
});

test('the map and its stops come after the planner in the tab order, and the focused port stands out',async t=>{
  const {$,w}=await chart(t,[LONDON,PARIS]);
  const after=(node,other)=>Boolean(other.compareDocumentPosition(node)&w.Node.DOCUMENT_POSITION_FOLLOWING);
  for(const id of ['zoom-in','reset-view','trips-button','destination','play','clear'])assert.ok(after($('route-stops'),$(id)),`${id} comes before the stops`);
  assert.equal(w.document.querySelector('.zoom-controls').getAttribute('role'),'group');
  assert.match(source('public/style.css').match(/^\.zoom-controls \{[^}]*\}/m)[0],/z-index/,'The controls paint above the map that now follows them');
  assert.match(source('public/style.css'),/focus-visible \.stop-dot \{ stroke: #2f2418; stroke-width: 3;/,'A dark ring, 3:1 or better against land, sea and the dot');
  assert.equal($('toggle-stops'),null,'And the old fold button is gone');
});

test('a held key hurries the glide home too',async t=>{
  const {w,$,clock,press,until,sailing,map}=await chart(t,[LONDON,PARIS,ROME]);
  const glide=start=>{start();until(3);const began=clock.now;while(sailing()&&clock.now-began<6000)clock.frame();assert.equal(sailing(),false);return clock.now-began;};
  const normal=glide(()=>$('play').click()),held=glide(()=>press('Enter',map));
  w.document.dispatchEvent(new w.KeyboardEvent('keyup',{key:'Enter',bubbles:true}));
  assert.ok(held<normal/2,`Held, ${held}ms against ${normal}ms`);
});

test('iOS pinch events are not counted twice',async t=>{
  const {w,clock,pointer,map}=await chart(t,[LONDON,PARIS]);
  const gesture=(type,scale)=>{const event=new w.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{scale,clientX:720,clientY:450});map.dispatchEvent(event);};
  gesture('gesturestart',1);gesture('gesturechange',2);clock.settle();assert.ok(Math.abs(camera(w).w-720)<1e-6,'Safari\'s trackpad pinch zooms');
  pointer('pointerdown',600,450,{kind:'touch',id:1});pointer('pointerdown',800,450,{kind:'touch',id:2});
  gesture('gesturestart',1);gesture('gesturechange',2);clock.settle();assert.ok(Math.abs(camera(w).w-720)<1e-6,'With touch pointers down the pointers have the pinch');
});

test('names keep their places as a trace moves the camera, rather than flickering',async t=>{
  const {w,$,clock,sailing}=await chart(t,[LONDON,PARIS,ROME,ATHENS,CAIRO,['Madrid',-3.7026,40.4165]]);
  $('play').click();let frames=0;const shows=new Map();let shown=new Set();
  while(sailing()&&frames<3000){clock.frame();frames++;const now=new Set(lettered(w));for(const name of now)if(!shown.has(name))shows.set(name,(shows.get(name)||0)+1);shown=now;}
  const again=[...shows.values()].filter(count=>count>=4).length;
  assert.ok(frames>100,'It really sailed');assert.ok(again<=20,`${again} of ${shows.size} names came and went four times or more`);
});

test('background city names stay selective without removing smaller route stops or search entries',async t=>{
  const places=[['Mumbai',72.88,19.08],['Akola',77,20.7],['Delhi',77.23,28.65],['Makkah',39.82,21.43]],{w,$,clock,sailing}=await chart(t,places);
  const seen=new Set();$('play').click();let frames=0;
  while(sailing()&&frames++<3000){clock.frame();for(const label of w.RedlineApp.atlas.labels)if(['city','capital'].includes(label.kind))seen.add(label.text);}
  for(const name of ['Ahmedabad','Akola','Makkah'])assert.equal(seen.has(name),false,`${name} is not a background label`);
  assert.ok(seen.size>0,'Recognizable background places still appear');
  assert.ok(w.MAP_CITIES.some(city=>city.name==='Ahmedabad'),'The destination search index is complete');
  assert.deepEqual([...$('route-stops').querySelectorAll('.stop-label')].map(node=>node.textContent),places.map(([name])=>name.toUpperCase()),'Smaller destinations keep their route labels');
});

test('the chart title is a piece of its own: it follows the trip, stays on the sheet and moves off the route',async t=>{
  const piece=w=>w.RedlineApp.atlas.labels.find(label=>label.kind==='cartouche');
  const {w,$,press}=await setup(t,{realMap:true,route:[],seed:false}),clock=mapClock(w),atlas=w.RedlineApp.atlas;
  press('Escape');await tick();clock.frame();
  const label=piece(w);assert.equal(label.text,'A summer away');assert.equal(label.kicker,'A chart of');
  const size=atlas.measure('cartouche',label.text,label.kicker),box={x:label.x-size.w/2,y:label.y-size.h/2,w:size.w,h:size.h};
  assert.ok(box.x>=14&&box.x+box.w<=1426&&box.y>=14&&box.y+box.h<=886,'It stays on the sheet');
  for(const other of atlas.labels){
    if(other===label)continue;
    const near=atlas.measure(other.kind,other.text,other.angle,other.curve);
    assert.equal(w.RedlineLabels.overlaps(box,{x:other.x-near.w/2,y:other.y-near.h/2,w:near.w,h:near.h}),false,`${other.text} keeps clear of it`);
  }
  $('trip-title').textContent='Another voyage';await tick();clock.frame();assert.equal(piece(w).text,'Another voyage','It follows the trip\'s name');
  $('trip-title').textContent='';await tick();clock.frame();assert.equal(piece(w).text,'The Known World');
  $('zoom-in').click();clock.settle();assert.equal(piece(w),undefined,'Closer in, it leaves with the great names');
  $('zoom-out').click();clock.settle();assert.ok(piece(w));
  // A meridian through the piece, with both stops and their names well clear of it.
  const route=[[-128,-30],[-128,-70]].map(([longitude,latitude],i)=>({id:`cartouche-stop-${i}`,name:`Stop ${i}`,country:'Test',longitude,latitude}));
  const crossed=await setup(t,{realMap:true,route,seed:false}),other=mapClock(crossed.w);
  crossed.press('Escape');await tick();other.frame();
  const moved=piece(crossed.w),{h}=crossed.w.RedlineApp.atlas.measure('cartouche',moved.text,moved.kicker);
  assert.ok(moved.y+h/2<480*900/720,'It finds open water clear of the red line, rather than leaving the chart');assert.ok(lettered(crossed.w).includes('Europe'));
});

test('the chart title is on the chart in a window short enough for the dock to reach its usual place',async t=>{
  const {w,press}=await setup(t,{realMap:true,route:[],seed:false}),clock=mapClock(w),atlas=w.RedlineApp.atlas,measure=atlas.measure;
  atlas.measure=(kind,...rest)=>kind==='cartouche'?{w:346,h:76}:measure(kind,...rest);
  // 1440 by 820, where the title's corner came within reach of the dock's top left and it silently gave way.
  w.Element.prototype.getBoundingClientRect=function(){
    const [left,top,width,height]=this.id==='route-dock'?[370,686,700,112]:this.matches('.zoom-controls')?[1380,650,36,136]:this.closest?.('#trip-panel')?[24,24,380,600]:[0,0,1440,820];
    return {left,top,width,height,right:left+width,bottom:top+height};
  };
  for(const resized of w.testResizes)resized([]);press('Escape');await tick();clock.frame();
  const label=atlas.labels.find(l=>l.kind==='cartouche');assert.ok(label,'It is there');
  const size=atlas.measure('cartouche',label.text,label.kicker),box={x:label.x-size.w/2,y:label.y-size.h/2,w:size.w,h:size.h};
  assert.ok(box.x>=4&&box.y>=4&&box.x+box.w<=1436&&box.y+box.h<=816,'Whole');
  assert.equal(w.RedlineLabels.overlaps(box,{x:370,y:686,w:700,h:112}),false,'And clear of the dock');
  assert.ok(Math.abs(label.y-574*820/720)<60,'Close to its usual place');
});

test('crossing a route does not make the names change with the ink: the whole route is kept clear from the start',async t=>{
  // The second leg runs through Africa's name, and the first does not.
  const route=[[-60,-60],[0,7.5],[40,7.5]].map(([longitude,latitude],i)=>({id:`ink-stop-${i}`,name:`Port ${i}`,country:'Test',longitude,latitude}));
  const {w,$,press}=await setup(t,{realMap:true,route,seed:false}),clock=mapClock(w);
  press('Escape');await tick();clock.frame();
  const overview=lettered(w).filter(text=>text!=='The Known World').sort();
  $('play').click();clock.frame();
  assert.deepEqual(lettered(w).filter(text=>text!=='The Known World').sort(),overview,'Nothing moves in where the line is about to run');
  for(const i of [1,2])assert.equal($('route-stops').children[i].style.opacity,'0','The ports ahead are unseen');
});

test('names keep their places through a zoom in and out: what leaves does not flicker back, and the route comes first',async t=>{
  const route=[['Lisbon',-9.14,38.72],['Seville',-5.98,37.39],['Cadiz',-6.29,36.53],['Rome',12.5,41.9],['Athens',23.73,37.98],['Istanbul',28.98,41.01],['Cairo',31.25,30.06]].map(([name,longitude,latitude],i)=>({id:`sweep-stop-${i}`,name,country:'Test',longitude,latitude}));
  const {w,$,press}=await setup(t,{realMap:true,route,seed:false}),clock=mapClock(w),map=$('map');w.matchMedia=()=>({matches:true});
  press('Escape');await tick();clock.frame();
  const seen=new Map();let frames=0,lost=0,returned=0;const away=new Map();
  const look=()=>{
    const now=new Set(lettered(w));
    for(const [text,at] of away){if(now.has(text)){away.delete(text);if(frames-at<20)returned++;}}
    for(const text of seen.keys())if(!now.has(text)&&seen.get(text)===frames-1){lost++;away.set(text,frames);}
    for(const text of now)seen.set(text,frames);frames++;
    // The port names, drawn first, are never covered.
    for(const group of $('route-stops').children){
      const text=group._label;if(text.classList.contains('label-hidden'))continue;
      const {x,y,w:vw,h:vh}=camera(w),[px,py]=group._point,width=text._width,anchor=text.getAttribute('text-anchor'),left=(px-x)*1440/vw+Number(text.getAttribute('x'))-(anchor==='end'?width:anchor==='middle'?width/2:0),top=(py-y)*900/vh+Number(text.getAttribute('y'))-11;
      for(const label of w.RedlineApp.atlas.labels){
        if(label.kind==='cartouche')continue;
        const print=w.RedlineApp.atlas.footprint(label.kind,label.text,label.angle,label.curve);
        for(const b of print.boxes)assert.equal(w.RedlineLabels.overlaps({x:left,y:top,w:width,h:15},{x:label.x+b.x,y:label.y+b.y,w:b.w,h:b.h}),false,`${text.textContent} is clear of ${label.text}`);
      }
    }
  };
  const wheel=deltaY=>{map.dispatchEvent(new w.WheelEvent('wheel',{clientX:760,clientY:220,deltaY,bubbles:true,cancelable:true}));look();};
  // Each way on its own: turning round brings back what just left, as it should.
  for(let i=0;i<60;i++)wheel(-16);away.clear();for(let i=0;i<60;i++)wheel(16);
  assert.ok(lost>20,'The sweep really took names away');
  assert.ok(returned<=10,`${returned} of ${lost} names lost came back within a moment, against 63 before names rested`);
});

const pointerOn=(w,target,type,extra={})=>{const event=new w.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{pointerType:'mouse',pointerId:1,clientX:0,clientY:0,...extra});target.dispatchEvent(event);};
const clickOn=(w,target,extra={})=>{pointerOn(w,target,'pointerdown',extra);target.dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1,...extra}));};
const dropFiles=(w,target,names=['dropped.jpg'])=>{const event=new w.Event('drop',{bubbles:true,cancelable:true});event.dataTransfer={types:['Files'],files:names.map(name=>new File([jpeg],name,{type:'image/jpeg'}))};target.dispatchEvent(event);};
const manyCities=count=>Array.from({length:count},(_,i)=>({id:`album-city-${i}`,name:`City ${i}`,country:'Test',latitude:i+1,longitude:i+1}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('photos dropped while the cover opens wait for it and then go to review, at any moment of the opening',async t=>{
  const {w,$,press,storage,api}=await setup(t);press('Escape');
  const motion=controlledMotion(w),panel=$('photo-panel'),book=$('album-book');
  const reviewed=async()=>{
    await wait(()=>$('photo-review').children.length===1&&!$('upload-photos').hidden&&!$('choose-photos').disabled);
    assert.equal(panel.dataset.motion,'');assert.equal(book.inert,false);assert.equal(book.dataset.preparing,undefined);
    assert.equal(book.querySelector('.album-cover-scene'),null,'No cover is left behind');assert.equal($('album-modes').inert,false);
    assert.equal(book.dataset.mode,'review');assert.equal($('photo-review').hidden,false);
    $('cancel-photo-import').click();press('Escape');await wait(()=>motion.running.size===3);await motion.finish();await wait(()=>!panel.open);
  };
  // Mid-cover: the opening carries on untouched, and nothing is read until it ends.
  $('photos-button').click();await wait(()=>motion.running.size===3);
  dropFiles(w,panel);await tick();
  assert.equal(panel.dataset.motion,'opening');assert.equal(motion.running.size,3);assert.equal($('photo-review').children.length,0);
  await motion.finish();await reviewed();
  // Before the trip has even loaded, which would otherwise leave the book invisible.
  let release;storage.api=async(path,options)=>{if(!release)await new Promise(resolve=>release=resolve);return api(path,options);};
  $('photos-button').click();await wait(()=>!!release);
  dropFiles(w,panel);release();await wait(()=>motion.running.size===3);await motion.finish();await reviewed();
  storage.api=api;
  // A trip that fails to load still shows the album, and the photos still arrive.
  let refuse;storage.api=()=>{storage.api=api;return new Promise((resolve,reject)=>refuse=()=>reject(Error('Storage is unavailable.')));};
  $('photos-button').click();await wait(()=>!!refuse);dropFiles(w,panel);refuse();await reviewed();
  // Closed again before it opened: the photos go on to review rather than vanish.
  $('photos-button').click();await wait(()=>motion.running.size===3);
  dropFiles(w,panel);press('Escape');assert.equal(panel.dataset.motion,'closing');
  await motion.finish();await wait(()=>motion.running.size===3);await motion.finish();await reviewed();
  // A drop on a book already shutting does the same.
  $('photos-button').click();await wait(()=>motion.running.size===3);await motion.finish();press('Escape');await wait(()=>motion.running.size===3);
  dropFiles(w,panel);await motion.finish();await wait(()=>motion.running.size===3);await motion.finish();await reviewed();
});

test('the album reopens while an import is still running, and shows its review; a running save stays shut',async t=>{
  const {w,$,press,choose}=await setup(t);
  let open;const gate=new Promise(resolve=>open=resolve),decode=w.createImageBitmap;w.createImageBitmap=async file=>{await gate;return decode(file);};
  choose(['one.jpg','two.jpg']);await tick();press('Escape');assert.equal($('photo-panel').open,false);
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
  assert.equal($('album-book').dataset.mode,'review');assert.equal($('photo-progress').hidden,false,'The progress is there to see');
  open();await wait(()=>$('photo-review').children.length===2&&!$('upload-photos').hidden);assert.equal($('photo-progress').hidden,true);
  // Saving goes on pushing to the photos, so reopening must not replace them underneath it.
  $('bulk-photo-city').value=paris.id;$('bulk-photo-city').dispatchEvent(new w.Event('change',{bubbles:true}));
  $('upload-photos').click();press('Escape');assert.equal($('photo-panel').open,false);
  $('photos-button').click();await tick();assert.equal($('photo-panel').open,false);
  await wait(()=>!$('choose-photos').disabled);
});

test('a finished turn keeps the very pages it turned, in both layouts, and bookmarks where it landed',async t=>{
  const {w,$,press,pages}=await setup(t,{route:[paris,madrid],seedStops:[paris,paris,paris,paris,paris,paris,paris,paris,madrid]}),root=$('album-pages'),motion=controlledMotion(w);
  press('ArrowRight');
  let back=root.querySelector('.leaf-back'),right=root.children[1],image=right.querySelector('img');
  assert.ok(back.classList.contains('left'));await motion.finish();
  assert.deepEqual([...root.children],[back,right],'The leaf’s far side and the page beneath it become the spread');
  assert.equal(right.querySelector('img'),image,'A print already painted is not replaced as the leaf disappears');
  assert.equal(pages(),'left:contents right:city');assert.equal(root.querySelector('.album-leaf,.page-shade'),null);assert.equal(back.classList.contains('leaf-face'),false);assert.equal(back.classList.contains('leaf-back'),false);
  press('ArrowRight');await motion.finish();const after=$('album-position').textContent;
  press('ArrowLeft');back=root.querySelector('.leaf-back');const left=root.children[0];assert.ok(back.classList.contains('right'));await motion.finish();
  assert.deepEqual([...root.children],[left,back]);
  press('ArrowRight');await motion.finish();assert.equal($('album-position').textContent,after);
  // A cover turn carries its pages on boards; they come off again.
  press('Home');await motion.finish();assert.equal(pages(),'left:void right:cover');assert.equal(root.querySelector('.album-bound-page,.cover-turn'),null);
  press('ArrowRight');await motion.finish();assert.equal(pages(),'left:inside right:title');assert.equal(root.querySelector('.album-bound-page,.cover-turn'),null);
  // One page at a time, after a reflow that remembered its place: the turn moves the bookmark on from it.
  w.innerWidth=480;w.innerHeight=800;w.dispatchEvent(new w.Event('resize'));await pause(30);assert.equal(root.classList.contains('single'),true);
  press('ArrowRight');let below=root.children[0];await motion.finish();assert.deepEqual([...root.children],[below],'Forward, the page beneath stays');
  press('ArrowRight');await motion.finish();press('ArrowLeft');const above=root.querySelector('.single-leaf');await motion.finish();
  assert.deepEqual([...root.children],[above],'Back, the page that came down stays');assert.equal(above.classList.contains('single-leaf'),false);
  press('ArrowRight');await motion.finish();const place=$('album-position').textContent;
  press('Escape');await wait(()=>motion.running.size===3);await motion.finish();await wait(()=>!$('photo-panel').open);
  $('photos-button').click();await wait(()=>motion.running.size===3);await motion.finish();assert.equal($('album-position').textContent,place);
});

test('pressing A builds the spread once, and the place holds across a layout changed while shut',async t=>{
  const {w,$,press,tab}=await setup(t,{route:[paris,madrid],seedStops:[...Array.from({length:30},()=>paris),madrid]}),root=$('album-pages'),native=root.replaceChildren;
  const scrub=$('album-scrub');scrub.value='8';scrub.dispatchEvent(new w.Event('input'));const spread=$('album-position').textContent,first=spread.match(/(\d+)–/)[1];
  press('Escape');let builds=0;root.replaceChildren=function(...nodes){if(nodes.length)builds++;return native.apply(this,nodes);};
  const reopen=async()=>{builds=0;$('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);};
  await reopen();assert.equal(builds,1,'Not the six it used to take');assert.equal($('album-position').textContent,spread);
  press('Escape');w.innerWidth=480;w.innerHeight=800;await reopen();assert.equal(builds,1);
  assert.match($('album-position').textContent,new RegExp(`page ${first}$`),'One page at a time, the same place');
  press('Escape');w.innerWidth=1440;w.innerHeight=900;await reopen();assert.equal($('album-position').textContent,spread,'And back to the same spread');
});

test('keyboard and screen-reader focus stays in the album when the cover makes the first control inert',async t=>{
  const {w,$,press}=await setup(t);press('Escape');
  const native=w.HTMLDialogElement.prototype.showModal;w.HTMLDialogElement.prototype.showModal=function(){native.call(this);$('album-view').focus();};
  $('photos-button').click();await wait(()=>$('photo-panel').open&&!$('photo-panel').dataset.motion);
  assert.equal(w.document.activeElement,$('photo-panel'));
});

test('in window view a mouse can turn every page, covers and blanks included; outside it the covers stay bare',async t=>{
  const {w,$,press,pages}=await setup(t,{route:[paris,madrid,rome],seedStops:[paris,madrid,rome]});
  const corner=()=>$('album-pages').querySelector('.page-corner');
  press('Home');assert.equal(corner(),null);press('f');
  assert.ok(corner(),'The front cover');corner().click();assert.equal(pages(),'left:inside right:title');
  press('End');assert.equal(pages(),'left:back right:void');corner().click();assert.equal(pages(),'left:blank right:inside','The back cover’s corner turns backwards');
  $('album-pages').querySelector('.page-blank .page-corner').click();assert.match(pages(),/^left:city right:city$/,'And so does a left-hand blank');
  press('f');press('End');assert.equal(corner(),null,'The arrows do this outside window view');
  w.innerWidth=480;w.innerHeight=800;press('f');assert.ok(corner(),'One page at a time too');const before=$('album-position').textContent;corner().click();assert.notEqual($('album-position').textContent,before);assert.notEqual(pages(),'single:back');
});

test('a click outside closes the book from anywhere that looks outside it; in window view it only folds the tabs',async t=>{
  const {w,$,press,tab}=await setup(t),panel=$('photo-panel'),book=$('album-book'),rail=$('gallery-filter');
  const reopen=async()=>{$('photos-button').click();await wait(()=>panel.open&&!panel.dataset.motion);};
  for(const selector of ['.album-foot','.album-top','.album-title']){clickOn(w,panel.querySelector(selector));assert.equal(panel.open,false,selector);await reopen();}
  tab(paris.id).click();clickOn(w,book);assert.equal(panel.open,true,'An open book is not outside itself');clickOn(w,$('album-pages'));assert.equal(panel.open,true);
  press('End');clickOn(w,book);assert.equal(panel.open,false,'Beside a shut book');await reopen();
  press('Home');clickOn(w,$('album-pages'));assert.equal(panel.open,false,'The empty half of a shut book');await reopen();
  // The rail's own box counts, but a near miss on a tab does not.
  tab(paris.id).click();Object.assign(tab(paris.id),{getBoundingClientRect:()=>({left:100,right:130,top:50,bottom:150})});
  clickOn(w,rail,{clientX:132,clientY:152});assert.equal(panel.open,true);
  clickOn(w,rail,{clientX:170,clientY:100});assert.equal(panel.open,false);await reopen();
  // Window view fills the screen: there is no outside.
  tab(paris.id).click();press('f');$('album-edge').dispatchEvent(new w.Event('pointerenter'));assert.ok(panel.classList.contains('index-open'));
  clickOn(w,panel.querySelector('.album-stage'),{clientX:9999});assert.equal(panel.open,true);assert.ok(panel.classList.contains('expanded'),'Still in window view');assert.equal(panel.classList.contains('index-open'),false,'The tabs fold away');
  clickOn(w,panel.querySelector('.album-stage'));assert.equal(panel.open,true,'With the tabs away too');
  // The cover over the map does have an outside, though its toolbar is no part of it.
  press('Home');clickOn(w,$('album-toolbar'));assert.equal(panel.open,true);clickOn(w,panel.querySelector('.album-stage'));assert.equal(panel.open,false);
});

test('window view: a re-entered rail keeps its scroll, and a skim through the top edge does not strand the toolbar',async t=>{
  const {w,$,press,tab}=await setup(t),rail=$('gallery-filter'),panel=$('photo-panel'),edge=$('album-top-edge');tab(paris.id).click();press('f');
  $('album-edge').dispatchEvent(new w.Event('pointerenter'));rail.scrollTop=500;rail.dispatchEvent(new w.Event('pointerenter'));assert.equal(rail.scrollTop,500,'Drifting off and back');
  clickOn(w,panel.querySelector('.album-stage'),{clientX:9999});$('album-edge').dispatchEvent(new w.Event('pointerenter'));assert.equal(rail.scrollTop,0,'Uncovering it again finds the current tab');
  edge.dispatchEvent(new w.Event('pointerenter'));assert.equal(edge.getAttribute('aria-expanded'),'true');
  pointerOn(w,$('album-pages'),'pointermove',{clientY:10});assert.equal(edge.getAttribute('aria-expanded'),'true','On its way to the toolbar');
  pointerOn(w,$('album-pages'),'pointermove',{clientY:400});assert.equal(edge.getAttribute('aria-expanded'),'false');assert.equal($('album-toolbar').inert,true);
  edge.dispatchEvent(new w.Event('pointerenter'));pointerOn(w,$('album-toolbar'),'pointermove',{clientY:400});assert.equal(edge.getAttribute('aria-expanded'),'true','Over the toolbar itself');
});

test('window view changes size only through motion it owns, and a cover or view change never pins a moving book',async t=>{
  const {w,$,press}=await setup(t),panel=$('photo-panel'),book=$('album-book'),motion=controlledMotion(w);
  const onBook=()=>[...motion.running].find(item=>item.element===book);
  const layout=()=>panel.classList.contains('expanded')?panel.classList.contains('cover-view')?{left:228,top:32,width:984,height:656}:{left:4,top:4,width:1200,height:800}:{left:160,top:90,width:880,height:560};
  // A transform still running on the book shows in its measured rect.
  book.getBoundingClientRect=()=>onBook()?{left:80,top:40,width:1000,height:660}:layout();
  const reopen=async()=>{$('photos-button').click();await wait(()=>motion.running.size===3);await motion.finish();};
  press('f');await motion.finish();
  // Escape twice, the natural way out: the close must not measure the shrink.
  press('Escape');assert.ok(onBook());press('Escape');assert.equal(panel.dataset.motion,'closing');
  assert.equal(onBook(),undefined,'The shrink has stopped');assert.equal(book.style.width,'880px','The cover pinned the real book');
  await wait(()=>motion.running.size===3);await motion.finish();await wait(()=>!panel.open);assert.equal(book.style.width,'');
  // Closing straight from window view folds down through its size rather than snapping first.
  await reopen();press('f');await motion.finish();press('a');
  const fold=onBook();assert.ok(fold);assert.match(fold.frames[0].transform,/scale\(1\.36/);assert.equal(panel.dataset.motion,'closing');assert.equal(book.dataset.windowMotion,'true');assert.equal(panel.classList.contains('expanded'),false);
  await wait(()=>motion.running.size===4);await motion.finish();await wait(()=>!panel.open);assert.equal(book.dataset.windowMotion,undefined);assert.equal(onBook(),undefined);
  // A view turn during the shrink pins the real book too.
  await reopen();press('f');await motion.finish();press('f');assert.ok(onBook());$('sheet-view').click();
  assert.equal(onBook(),undefined);assert.equal(book.style.width,'880px');await motion.finish();await motion.finish();assert.equal(book.style.width,'');
  $('album-view').click();await motion.finish();await motion.finish();
  // The cover over the map is a different book from the full window, so no turn is pinned between them.
  press('Home');await motion.finish();press('f');await motion.finish();assert.ok(panel.classList.contains('cover-view'));
  $('sheet-view').click();assert.equal(book.dataset.viewMotion,undefined);assert.equal(book.style.width,'');assert.equal(panel.classList.contains('cover-view'),false);assert.equal($('album-book').dataset.mode,'sheet');assert.match(onBook().frames[0].transform,/scale\(0\.82/,'The book glides between them');
  await motion.finish();$('album-view').click();assert.equal(book.dataset.viewMotion,undefined);assert.ok(panel.classList.contains('cover-view'));await motion.finish();
});

test('album and All Photos change directly on a short landscape page, whose sizes differ too much for one turn',async t=>{
  const {w,$}=await setup(t),motion=controlledMotion(w);w.innerWidth=568;w.innerHeight=320;w.dispatchEvent(new w.Event('resize'));await pause(30);
  $('sheet-view').click();assert.equal($('album-book').dataset.viewMotion,undefined);assert.equal($('album-book').dataset.mode,'sheet');assert.equal(motion.running.size,0);
  $('album-view').click();assert.equal($('album-book').dataset.mode,'album');
  w.innerWidth=480;w.innerHeight=800;w.dispatchEvent(new w.Event('resize'));await pause(30);
  $('sheet-view').click();assert.equal($('album-book').dataset.viewMotion,'true','A portrait page still turns');await motion.finish();
});

test('toggling window view or resizing keeps the same prints at the top of All Photos',async t=>{
  const {w,$,press,tiles}=await setup(t,{route:[paris],seedStops:Array.from({length:12},()=>paris)}),panel=$('photo-panel'),scroll=$('photo-scroll');
  tiles();let wide=false;const pitch=()=>panel.classList.contains('expanded')||wide?50:100;
  scroll.getBoundingClientRect=()=>({top:100,bottom:700,left:0,right:800,width:800,height:600});
  $('photo-gallery').querySelectorAll('.photo-tile').forEach((tile,i)=>tile.getBoundingClientRect=()=>{const top=100+i*pitch()-scroll.scrollTop;return {top,bottom:top+pitch()-10,left:0,right:90};});
  await pause(200);
  scroll.scrollTop=520;press('f');assert.equal(scroll.scrollTop,270,'Print six stays at the top');press('f');assert.equal(scroll.scrollTop,520);
  // The window has already changed by the time a resize is heard, so the place is read as the sheet scrolls.
  scroll.dispatchEvent(new w.Event('scroll'));await pause(140);
  wide=true;w.dispatchEvent(new w.Event('resize'));await pause(30);assert.equal(scroll.scrollTop,270);
});

test('a city chosen in All Photos is where the album opens next, and the highlight follows the sheet as it scrolls',async t=>{
  const {w,$,tab}=await setup(t,{route:[paris,madrid,rome],seedStops:[paris,paris,paris,paris,paris,madrid,rome]});
  const current=city=>tab(city.id).getAttribute('aria-current')==='true';
  tab(paris.id).click();const start=$('album-position').textContent;
  $('sheet-view').click();$('album-view').click();assert.equal($('album-position').textContent,start,'An untouched round trip keeps its page');
  $('sheet-view').click();tab(rome.id).click();assert.ok(current(rome));
  $('album-view').click();assert.match($('album-position').textContent,/Rome/);assert.ok(current(rome));
  $('sheet-view').click();const scroll=$('photo-scroll');Object.defineProperties(scroll,{scrollHeight:{value:1300},clientHeight:{value:400}});
  $('photo-gallery').querySelectorAll('.gallery-city').forEach((section,i)=>section.getBoundingClientRect=()=>({top:i*500-scroll.scrollTop,bottom:(i+1)*500-scroll.scrollTop}));
  await pause(200);
  scroll.scrollTop=520;scroll.dispatchEvent(new w.Event('scroll'));await wait(()=>current(madrid));
  // A tab's own jump owns the highlight until it has landed.
  tab(paris.id).click();scroll.scrollTop=520;for(const gap of [140,120,160]){scroll.dispatchEvent(new w.Event('scroll'));await pause(gap);}assert.ok(current(paris));
  scroll.scrollTop=30;scroll.dispatchEvent(new w.Event('scroll'));await pause(160);assert.ok(current(paris));
  // A short last city never reaches the top, so the end of the sheet counts.
  scroll.scrollTop=900;scroll.dispatchEvent(new w.Event('scroll'));await wait(()=>current(rome));
});

test('the unread leaves dwindle with every way of turning, including the slider and reduced motion',async t=>{
  const {w,$,press}=await setup(t,{route:[paris],seedStops:Array.from({length:24},()=>paris)}),scrub=$('album-scrub'),depth=()=>$('album-book').style.getPropertyValue('--page-depth');
  const slide=value=>{scrub.value=String(value);scrub.dispatchEvent(new w.Event('input'));};
  slide(Number(scrub.max)-2);assert.equal(depth(),'0px','No leaves left at the last spread');
  slide(0);assert.equal(depth(),'6px');
  press('End');press('ArrowLeft');assert.equal(depth(),'0px','Without animation too');press('ArrowLeft');assert.equal(depth(),'3px');
  const motion=controlledMotion(w);press('ArrowRight');assert.equal(depth(),'0px','An animated turn does not wait to land');await motion.finish();
});

test('window view speaks page turns even with the foot hidden',async t=>{
  const {w,$,press}=await setup(t),live=$('album-live');
  assert.equal($('album-foot').contains(live),false);assert.ok($('photo-panel').contains(live),'Everything else is inert under the modal');assert.equal(live.getAttribute('role'),'status');
  press('ArrowRight');assert.equal(live.textContent,'','The foot says it here');
  press('f');press('ArrowRight');assert.ok(live.textContent);assert.equal(live.textContent,$('album-position').textContent);
  press('f');assert.equal(live.textContent,'');
});

test('warming follows the open page, wherever it is in a long chapter',async t=>{
  const {w,$,press,prints}=await setup(t,{route:[paris],seedStops:Array.from({length:60},()=>paris)}),scrub=$('album-scrub'),native=w.RedlineAlbumMotion.preload;
  let warmed=[];w.RedlineAlbumMotion.preload=urls=>{warmed=urls;return native(urls);};
  const shown=()=>prints().map(print=>print.querySelector('img').src),slide=value=>{scrub.value=String(value);scrub.dispatchEvent(new w.Event('input'));};
  slide(Number(scrub.max)-8);assert.ok(warmed.length>0&&warmed.length<=48);
  for(const src of shown())assert.ok(warmed.includes(src),'What is on screen');
  const list=warmed;press('ArrowRight');assert.ok(shown().length>0);for(const src of shown())assert.ok(list.includes(src),'And the next spread, ready before it is turned to');
  press('f');assert.ok(warmed.length>0&&warmed.length<=24,'Originals are big, so only the nearest are held');for(const src of shown())assert.ok(warmed.includes(src));
});

test('swipes ignore a press the browser took for itself',async t=>{
  const {w,$,pages}=await setup(t),touch=(type,x)=>pointerOn(w,$('album-pages'),type,{pointerType:'touch',clientX:x,clientY:100});
  touch('pointerdown',300);touch('pointercancel',300);touch('pointerup',100);assert.equal(pages(),'left:inside right:title');
  touch('pointerdown',300);touch('pointerup',100);assert.equal(pages(),'left:contents right:city');
});

test('one page at a time the book gives up only the room its tabs use',async t=>{
  const {$,choose}=await setup(t),gutter=()=>$('album-book').style.getPropertyValue('--tab-gutter');
  assert.equal(gutter(),'31px','One column');
  choose(['one.jpg']);await wait(()=>$('photo-review').children.length===1);assert.equal(gutter(),'0px','The tabs are away during review');
  const empty=await setup(t,{seed:false});assert.equal(empty.$('album-book').style.getPropertyValue('--tab-gutter'),'0px','And on an empty album');
  const crowded=await setup(t,{route:manyCities(20),seedStops:manyCities(20)});
  assert.equal(crowded.$('album-book').style.getPropertyValue('--tab-gutter'),`${(Number(crowded.$('album-book').style.getPropertyValue('--tab-width').replace('px',''))-18)+4}px`);
});

test('the cover carries the tab rail at its full height, and hands it back unchanged',async t=>{
  const {w,$,press}=await setup(t);press('Escape');const motion=controlledMotion(w),rail=$('gallery-filter');
  rail.getBoundingClientRect=()=>({left:0,top:0,width:60,height:231,right:60,bottom:231});
  $('photos-button').click();await wait(()=>motion.running.size===3);
  assert.ok(rail.closest('.album-cover-scene'));assert.equal(rail.style.height,'231px');assert.equal(rail.style.maxHeight,'');
  await motion.finish();assert.equal(rail.parentElement,$('album-book'));assert.equal(rail.style.height,'');
});

test('the tab rail lays out to its real height, settles before placing anything and follows every resize',async t=>{
  const cities=manyCities(12),{w,$,press}=await setup(t,{route:cities,seedStops:cities}),rail=$('gallery-filter'),book=$('album-book'),panel=$('photo-panel');
  const tall=()=>parseFloat(rail.style.getPropertyValue('--tab-h')),width=()=>parseFloat(book.style.getPropertyValue('--tab-width')),resize=async()=>{w.dispatchEvent(new w.Event('resize'));await pause(40);};
  const bottom=()=>Math.max(...[...rail.children].map(tab=>(Number(tab.style.getPropertyValue('--tab-row'))+1)*tall()-2));
  let height=()=>panel.classList.contains('expanded')?300:560;
  Object.defineProperty(rail,'clientHeight',{configurable:true,get:()=>height()});
  await resize();assert.ok(bottom()<=560,`${bottom()} of 560`);
  // Window view keeps room below the rail for its exit button, in every mode.
  press('f');assert.ok(bottom()<=300,`${bottom()} of 300 in the album`);press('f');assert.ok(bottom()>300);
  $('sheet-view').click();press('f');assert.ok(bottom()<=300,`${bottom()} of 300 in All Photos`);press('f');$('album-view').click();
  // More columns narrow a two-page book. The first draw must already fit what that leaves.
  height=()=>560-width()*4/3;
  book.style.setProperty('--tab-width','45px');await resize();
  assert.ok(bottom()<=height()+1e-6,`${bottom()} of ${height()} after settling on ${width()}`);
});

test('tabs renumber on a resize that changes the contents pages, in any view',async t=>{
  const cities=manyCities(8),{w,$,tab}=await setup(t,{route:cities,seedStops:cities}),book=$('album-book'),last=cities[7];let tall=600;
  book.style.paddingTop=book.style.paddingBottom='0px';Object.defineProperty(book,'clientHeight',{configurable:true,get:()=>tall});
  const resize=async()=>{w.dispatchEvent(new w.Event('resize'));await pause(40);},chip=()=>tab(last.id).querySelector('.chip-stop').textContent;
  await resize();const roomy=chip();
  tall=246;await resize();const tight=chip();assert.notEqual(tight,roomy,'A shorter page holds seven ports, so the chapters move on');
  tab(last.id).click();assert.match($('album-position').textContent,new RegExp(`\\b${tight}\\b`),'The tab and the page agree');
  $('sheet-view').click();tall=600;await resize();assert.equal(chip(),roomy,'All Photos keeps them right too');
});

test('tabs beyond the rail are cued by a quiet fade and reached by scrolling and keys, with the rail a single Tab stop',async t=>{
  const cities=manyCities(6),{w,$,press,tab}=await setup(t,{route:cities,seedStops:cities}),rail=$('gallery-filter'),list=[...rail.children],stops=()=>list.filter(el=>el.tabIndex===0),position=$('album-position');
  assert.deepEqual(stops(),[list[0]],'The first, with no city chosen');
  tab(cities[2].id).click();assert.deepEqual(stops(),[list[2]],'Then the current tab');
  const at=position.textContent;list[2].focus();
  press('ArrowDown',list[2]);assert.equal(w.document.activeElement,list[3]);assert.deepEqual(stops(),[list[3]],'Tab returns to where the arrows left it');
  press('ArrowUp',list[3]);press('ArrowUp',list[2]);assert.equal(w.document.activeElement,list[1]);
  press('ArrowUp',list[1]);press('ArrowUp',list[0]);assert.equal(w.document.activeElement,list[0],'It stops at the ends');
  assert.equal(position.textContent,at,'Walking the tabs turns nothing');
  const down=new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true});list[0].dispatchEvent(down);assert.equal(down.defaultPrevented,true,'And does not scroll anything else');
  $('album-next').focus();assert.deepEqual(stops(),[rail.querySelector('[aria-current="true"]')],'Leaving the rail puts the stop back on the current tab');
  list[4].focus();tab(cities[4].id).click();assert.equal(w.document.activeElement,list[4],'A rebuild or a jump keeps the keyboard’s place');
  // Fade only the ends that have more.
  const ends=()=>[rail.hasAttribute('data-more-start'),rail.hasAttribute('data-more-end')],scrolled=top=>{rail.scrollTop=top;rail.dispatchEvent(new w.Event('scroll'));};
  assert.deepEqual(ends(),[false,false],'Nothing to cue when all of it fits');
  Object.defineProperties(rail,{clientHeight:{configurable:true,value:200},scrollHeight:{configurable:true,value:620}});
  scrolled(0);assert.deepEqual(ends(),[false,true]);scrolled(200);assert.deepEqual(ends(),[true,true]);scrolled(420);assert.deepEqual(ends(),[true,false]);
  Object.defineProperties(list[5],{offsetTop:{configurable:true,value:500},offsetHeight:{configurable:true,value:90}});
  scrolled(0);tab(cities[5].id).click();assert.equal(rail.scrollTop,418,'The current tab stops clear of the fade');assert.deepEqual(ends(),[true,true]);
  list[1].focus();Object.defineProperties(list[2],{offsetTop:{configurable:true,value:100},offsetHeight:{configurable:true,value:90}});press('ArrowDown',list[1]);assert.equal(rail.scrollTop,72,'A key can reach any of them');
});

test('route maps lie on the baked sheet at once, with land that is never culled only if the picture fails',async t=>{
  const {w,$,press}=await setup(t,{realMap:true});
  const map=$('album-pages').querySelector('.route-map'),images=[...map.querySelectorAll('image')];
  assert.equal(images.length,1);assert.equal(images[0].getAttribute('href'),'atlas/sheet.webp');
  assert.deepEqual(['x','y','width','height'].map(name=>images[0].getAttribute(name)),['0','0','1440','720'],'The whole sheet lies under the view box, which does the cropping');
  assert.equal(map.querySelector('.route-map-land'),null,'Stroking the world under an opaque picture is only a cost');
  images[0].dispatchEvent(new w.Event('error'));
  assert.equal(map.querySelector('.route-map-land').getAttribute('href'),'#land');assert.equal(map.querySelector('image'),null);
  assert.ok(map.children[1].classList.contains('route-map-land'),'It lies under the route');
  press('Escape');$('zoom-in').click();$('zoom-in').click();mapClock(w).settle();
  assert.ok([...$('land').children].every(path=>!path.hasAttribute('style')),'Zooming the map leaves the shared land alone');
  const styles=source('public/style.css');
  assert.match(styles,/\.route-map-land \{[^}]*fill: var\(--land\);[^}]*fill-rule: evenodd;[^}]*stroke: var\(--coast\);/,'A selector cannot reach into a <use> copy, so it inherits these, and is not drawn black');
  assert.doesNotMatch(styles,/\.route-map-land path/);assert.match(styles,/#land path \{[^}]*vector-effect: non-scaling-stroke;/);
});

test('a route near the date line runs on into the world repeated',async t=>{
  const {$,press}=await setup(t,{realMap:true,seed:false,route:[{id:'fiji-stop-a',name:'Suva',country:'Fiji',latitude:-18.1,longitude:178.4},{id:'fiji-stop-b',name:'Labasa',country:'Fiji',latitude:-16.4,longitude:179.4}]});
  const images=[...$('album-pages').querySelectorAll('.route-map image')];
  assert.deepEqual(images.map(image=>image.getAttribute('x')),['0','1440'],'The view box runs past the eastern edge');
  assert.ok(images[1].classList.contains('route-map-under'));
  press('Escape');
});

test('a sharper cut is painted only for a route zoomed past the sheet, and only once the album has settled and is idle',async t=>{
  const painted=[],bitmap={width:720,height:360,close(){}},atlas={supported:true,ready:new Promise(()=>{}),paintRegion:(box,width,height)=>{painted.push([box,width,height]);return Promise.resolve(bitmap);}};
  const {w,$,press}=await setup(t,{atlas});
  // The small route shown wide: this page holds more device pixels than the sheet has there.
  const route=$('album-pages').querySelector('.title-map .route-map');assert.ok(route);
  assert.equal(painted.length,0,'Nothing is painted before it has settled and been idle');
  const idle=[];w.requestIdleCallback=task=>{idle.push(task);return idle.length;};
  const rect=w.Element.prototype.getBoundingClientRect;w.Element.prototype.getBoundingClientRect=function(){return this.classList?.contains('route-map')?{left:0,top:0,width:5000,height:2500,right:5000,bottom:2500}:rect.call(this);};
  w.dispatchEvent(new w.Event('resize'));await wait(()=>idle.length>0);
  assert.equal(painted.length,0,'Waiting for idle');
  while(idle.length)idle.shift()({});
  await wait(()=>painted.length===1);
  await wait(()=>!!$('album-pages').querySelector('.title-map .route-map-sharp'));
  const under=$('album-pages').querySelector('.title-map .route-map-under');assert.equal(under.nextElementSibling,$('album-pages').querySelector('.title-map .route-map-sharp'),'Under the route line, over the sheet');
  // A wide route in a small picture never asks.
  w.Element.prototype.getBoundingClientRect=function(){return this.classList?.contains('route-map')?{left:0,top:0,width:100,height:50,right:100,bottom:50}:rect.call(this);};
  w.dispatchEvent(new w.Event('resize'));await wait(()=>idle.length>0);while(idle.length)idle.shift()({});await tick();
  assert.equal(painted.length,1,'The cut is kept, and this one is not soft');
  w.Element.prototype.getBoundingClientRect=rect;press('Escape');
});

test('after the map settles the album warms its fonts, sheet and first prints, in idle steps and never while it is open',async t=>{
  let settle;const ready=new Promise(resolve=>{settle=resolve;}),loaded=[],decoded=[];
  const atlas={supported:true,ready,paintRegion:()=>Promise.resolve(null)};
  const {w,$,press}=await setup(t,{atlas,seedStops:[madrid,paris]});press('Escape');
  w.document.fonts={load:font=>{loaded.push(font);return Promise.resolve([]);}};
  w.HTMLImageElement.prototype.decode=async function(){decoded.push(this.src);};
  assert.equal(loaded.length,0,'Nothing before the map has its first picture');
  settle();await new Promise(resolve=>setTimeout(resolve,2600));
  await wait(()=>loaded.length>=4,3000);
  assert.ok(loaded.some(font=>font.includes('Redline Album Script')));assert.ok(loaded.some(font=>font.includes('IM Fell English')));
  await wait(()=>decoded.some(url=>url.includes('atlas/sheet.webp')),3000);
});

test('the album rules only a browser can act on stay in place',()=>{
  const css=source('public/gallery.css'),rule=(selector,part)=>assert.ok(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} \\{[^}]*${part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`).test(css),`${selector} needs ${part}`);
  rule('.closed-back .album-pages','pointer-events: none;');rule('.closed-back .album-pages > *','pointer-events: auto;');
  rule('.album-pages','touch-action: pan-y pinch-zoom;');
  rule('.folio','color: var(--album-quiet);');
  assert.match(css,/\.album\.expanded #photo-message\.error \{ position: absolute; bottom: 16px; z-index: 5; \}/,'An error keeps its own red toast and centring');
  rule(':is(#photo-ready-count, .album-copy-photo-ready-count)','flex: 1;');
  rule('.album-tab:focus-visible','z-index: 1001;');
  // The rail meets the page edge at the same place before, during and after a cover's motion.
  rule('.album-book .album-cover-scene .album-tabs','left: calc(100% + 2px - var(--tab-root, 28px)); top: 5px;');
  rule('.album-book .album-cover-scene.closed-book .album-tabs','left: calc(75% + 1px - var(--tab-root, 28px));');
  rule('.album-book[data-mode=album]:is(.closed-front, .closed-back) > .album-tabs, .album-book .album-cover-scene.closed-book .album-tabs','clip-path: inset(0 0 0 calc(var(--tab-root, 28px) - 2px));');
  rule('.album-book[data-mode=album]:is(.closed-front, .closed-back) > .album-tabs, .album-book .album-cover-scene.closed-book .album-tabs','clip-path: inset(0 0 0 calc(var(--tab-root, 28px) - 3px));');
  // Long rails fade, and keep scrolling.
  rule('.album-tabs','overflow: hidden auto;');rule('.album-tabs:is([data-more-start], [data-more-end])','mask-image: linear-gradient(#0000, #000 var(--fade-start, 0px), #000 calc(100% - var(--fade-end, 0px)), #0000);');rule('.album-tabs[data-more-start]','--fade-start: 28px;');rule('.album-tabs[data-more-end]','--fade-end: 28px;');
  // Touch: no invisible corner over the prints, while window view shows both its corners and its edges.
  assert.match(css,/@media \(hover: none\) \{\s*\.page-corner \{ display: none; \}\s*\.album\.expanded \.page-corner \{ display: block;[^}]*opacity: 1; \}/);
  assert.match(css,/@media \(pointer: coarse\) \{[^@]*#album-top-edge::after \{[^}]*height: 4px;[^@]*#album-edge::after \{[^}]*width: 4px;/);
  // Import review stays an even count across the sheet, big enough to use: the later rules win.
  const columns=[...css.matchAll(/--sheet-columns: (\d+);/g)].map(match=>Number(match[1]));assert.deepEqual(columns,[10,6,2,4]);
  assert.match(css,/@media \(max-height: 520px\) and \(orientation: landscape\) \{ \.album \{ --sheet-columns: 4; \} \}/);
  // A short landscape sheet has room for a whole print.
  assert.match(css,/@media \(max-height: 520px\) and \(orientation: landscape\) \{[^@]*\.gallery-city-heading \{ position: static;[^@]*minmax\(84px, 1fr\)/);
  // One page has no spine down its middle, on the sheet or the copy a view turn carries.
  assert.match(css,/\.album-book:is\(\[data-mode=review\], \[data-mode=sheet\]\) \.album-sheet::after, \.album-view-layer\.single \.album-sheet::after \{ left: 0; \}/);
  assert.match(css,/\.album-book \{[^}]*width: calc\(100% - var\(--tab-gutter, var\(--tab-width\)\)\);/);
  for(const gone of ['album-loading-cover','drop-in','transition: transform .32s'])assert.equal(css.includes(gone),false,`${gone} did nothing`);
});

test('dividers grow to the longest name and letter it smaller, and long lists take more columns rather than clipping',async t=>{
  const tabs=$=>[...$('gallery-filter').children],height=$=>parseFloat($('gallery-filter').style.getPropertyValue('--tab-h'));
  const short=await setup(t,{route:[paris,madrid],seedStops:[paris,madrid]});
  assert.equal(height(short.$),92,'Short names keep the shortest divider');
  assert.ok(tabs(short.$).every(tab=>tab.querySelector('.tab-name').style.fontSize==='14px'),'And the full size of lettering');
  const long={...madrid,name:'Santa Cruz de la Sierra del Mar'},named=await setup(t,{route:[paris,long],seedStops:[paris,long]});
  assert.equal(height(named.$),146,'A long name takes the tallest divider, for every tab alike');
  const [first,second]=tabs(named.$).map(tab=>parseFloat(tab.querySelector('.tab-name').style.fontSize));
  assert.equal(first,14);assert.equal(second,10.5,'Beyond that its lettering shrinks, to no less than 10.5px');
  const cities=Array.from({length:20},(_,i)=>({id:`divider-city-${i}`,name:`City number ${i}`,country:'Test',latitude:i*2,longitude:i*3}));
  const crowded=await setup(t,{route:cities,seedStops:cities}),placed=tabs(crowded.$).map(tab=>[Number(tab.style.getPropertyValue('--tab-column')),Number(tab.style.getPropertyValue('--tab-row'))]);
  assert.equal(placed.length,20);assert.equal(new Set(placed.map(String)).size,20,'No two dividers share a place');
  const columns=Math.max(...placed.map(([column])=>column))+1,tall=height(crowded.$),room=crowded.w.innerHeight*.78-24-10;
  assert.ok(columns>1&&columns<=6,`${columns} columns`);
  assert.ok(placed.every(([column,row])=>(row+1)*tall<=room+1e-6),'Every divider fits within the book');
  assert.ok(placed.every(([column,row])=>column%2===(row%1?1:0)),'Odd columns start half a divider lower, so names stay clear of their neighbours');
  assert.equal(crowded.$('album-book').style.getPropertyValue('--tab-width'),`${columns*27+18}px`,'The book leaves room for its columns');
});

test('touch arrows stay after a turn of the card or a focus change, and a mouse still lets them fade',async t=>{
  const {w,$,tiles}=await setup(t),armed=[],realTimeout=w.setTimeout.bind(w);
  w.setTimeout=(fn,delay,...args)=>{if(delay===700){armed.push(fn);return 0;}return realTimeout(fn,delay,...args);};
  w.matchMedia=query=>({matches:query==='(hover: none)'});
  tiles()[0].click();const frame=$('full-photo').parentElement;
  $('flip-postcard').click();$('unflip-postcard').click();$('viewer-next').focus();
  assert.equal(armed.length,0,'README: touch controls stay visible');assert.equal(frame.classList.contains('arrows-idle'),false);
  await w.RedlinePostcards.close();
  w.matchMedia=()=>({matches:false});tiles()[0].click();assert.ok(armed.length>0,'With a mouse the arrows rest as before');
});

test('a drag that selects postcard text neither turns the card nor closes the viewer, wherever it ends',async t=>{
  const {w,$,tiles}=await setup(t);tiles()[0].click();$('flip-postcard').click();
  const viewer=$('photo-viewer'),flipped=()=>viewer.classList.contains('flipped');
  const drag=(from,to,extra={})=>{from.dispatchEvent(new w.Event('pointerdown',{bubbles:true}));to.dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1,...extra}));};
  const paper=$('postcard-back').querySelector('.postcard-columns');
  drag($('postcard-message'),paper);assert.equal(flipped(),true,'Released over the paper between the columns');
  drag($('postcard-recipient'),$('postcard-back'));assert.equal(flipped(),true,'Released over the card’s own padding');
  drag($('postcard-message'),viewer,{clientX:5000,clientY:5000});await tick();assert.equal(viewer.open,true,'Released on the backdrop');assert.equal(flipped(),true);
  drag($('full-photo'),viewer,{clientX:5000,clientY:5000});await tick();assert.equal(viewer.open,true,'Only a press on the backdrop itself closes');
  drag(paper,paper);assert.equal(flipped(),false,'A plain click on the paper still turns the card');
  drag(viewer,viewer,{clientX:5000,clientY:5000});await wait(()=>!viewer.open);
  tiles()[0].click();viewer.dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1,clientX:5000,clientY:5000}));await wait(()=>!viewer.open);
});

test('a share too long to draw keeps saying so after the autosave, until the text fits or the card turns back',async t=>{
  const {w,$,tiles,api,trip}=await setup(t);
  w.RedlinePostcardExport={render:(image,place,value)=>{if(value.message.length>5)throw Error('Shorten the text to fit this postcard.');return {toBlob:callback=>callback(new Blob([jpeg],{type:'image/jpeg'}))};}};
  const type=text=>{$('postcard-message').value=text;$('postcard-message').dispatchEvent(new w.Event('input'));};
  tiles()[0].click();$('flip-postcard').click();type('far too long a message');
  await wait(()=>$('postcard-error').textContent==='Shorten the text to fit this postcard.');
  await wait(()=>$('postcard-saved').textContent==='Saved');await tick();
  assert.ok((await api(`/trips/${trip.id}`)).photos.some(photo=>photo.postcard?.message==='far too long a message'),'The autosave ran');
  assert.equal($('postcard-error').textContent,'Shorten the text to fit this postcard.','The dead button keeps its reason');assert.equal($('share-postcard').disabled,true);
  type('fits');await wait(()=>!$('share-postcard').disabled);assert.equal($('postcard-error').textContent,'');
  type('too long once more');await wait(()=>$('postcard-error').textContent!=='');
  // A caption's autosave runs 600 ms after typing.
  const caption=async text=>{$('caption-input').value=text;$('caption-input').dispatchEvent(new w.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,650));assert.ok((await api(`/trips/${trip.id}`)).photos.some(photo=>photo.caption===text),'The caption saved');};
  await caption('A caption too');
  assert.equal($('postcard-error').textContent,'Shorten the text to fit this postcard.','A caption saved in the meantime leaves it too');
  $('unflip-postcard').click();assert.equal($('postcard-error').textContent,'','The reason goes with the back of the card');
  $('flip-postcard').click();await wait(()=>$('postcard-error').textContent!=='');
  $('viewer-next').click();await wait(()=>$('photo-position').textContent==='2 / 2');assert.equal($('postcard-error').textContent,'');
  await caption('On the next photo');assert.equal($('postcard-error').textContent,'','Another photo does not inherit the reason');
});

test('the All Photos badge follows a postcard written or cleared, without redrawing the sheet',async t=>{
  const {w,$,tiles}=await setup(t);const first=tiles()[0],tile=first.closest('.photo-tile'),badge=()=>tile.querySelectorAll('.postcard-badge').length;
  const save=async text=>{$('postcard-message').value=text;$('postcard-message').dispatchEvent(new w.Event('input'));$('postcard-save-status').textContent='';$('save-postcard').click();await wait(()=>$('postcard-save-status').textContent==='Postcard saved.');};
  assert.equal(badge(),0);first.click();$('flip-postcard').click();
  await save('Wish you were here');assert.equal(badge(),1);assert.equal(tile.isConnected,true,'The same tile');
  await save('Wish you were here too');assert.equal(badge(),1,'One badge, however many saves');
  await save('   ');assert.equal(badge(),0,'Nothing written, no badge');
});

test('the album catches up when the rest of a part-saved import is cancelled or removed',async t=>{
  for(const finish of ['cancel','remove']){
    const {w,$,choose,pages}=await setup(t,{seed:false});
    await wait(()=>pages()==='left:inside right:title');
    choose(['one.jpg','two.jpg']);await wait(()=>$('photo-review').children.length===2&&!$('choose-photos').disabled);
    const select=$('photo-review').querySelector('select');select.value=paris.id;select.dispatchEvent(new w.Event('change'));
    $('upload-photos').click();await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
    if(finish==='cancel')$('cancel-photo-import').click();else $('photo-review').querySelector('.remove-photo').click();
    assert.equal($('album-pages').hidden,false);assert.equal($('album-pages').querySelector('.title-meta').textContent,'2 stops · 1 photo',finish);
  }
});

test('GPS photos around one city make one new stop, under the city’s name and country',async t=>{
  const {w,$,choose,api,trip}=await setup(t,{realMap:true,seed:false,route:[madrid]});
  const index=JSON.parse(source('public/photo-cities.json')),spots={louvre:[48.8606,2.3376],eiffel:[48.8584,2.2945],notre:[48.853,2.3499],lyon:[45.764,4.8357]};
  w.fetch=async()=>({ok:true,json:async()=>index});
  w.exifr.gps=async file=>{const [latitude,longitude]=spots[file.name.split('.')[0]];return {latitude,longitude};};
  choose(['louvre.jpg','eiffel.jpg','notre.jpg','lyon.jpg']);await wait(()=>$('photo-review').children.length===4&&!$('choose-photos').disabled);
  assert.deepEqual([...$('photo-review').querySelectorAll('select')].map(select=>select.selectedOptions[0].text),['Paris (from GPS, new stop)','Paris (from GPS, new stop)','Paris (from GPS, new stop)','Lyon (from GPS, new stop)']);
  $('upload-photos').click();await wait(()=>/4 photos saved/.test($('photo-message').textContent));
  const stops=[...w.RedlineApp.getStops()];assert.deepEqual(stops.map(stop=>[stop.name,stop.country]),[['Madrid','Spain'],['Paris','France'],['Lyon','France']]);
  assert.equal((await api(`/trips/${trip.id}`)).photos.filter(photo=>photo.city?.name==='Paris').length,3);
});

test('a batch reuses a new stop only within a city’s reach, and only a stop it has not already got',async t=>{
  const {w,$,choose}=await setup(t,{realMap:true,seed:false,route:[madrid]});
  const places=[['Near One',50,10,'DE'],['Near Two',50.05,10,'DE'],['Far',50.15,10,'DE'],['On the route',40.4,-3.7,'ES']];
  w.fetch=async()=>({ok:true,json:async()=>places});
  w.exifr.gps=async file=>{const place=places[Number(file.name[0])];return {latitude:place[1],longitude:place[2]};};
  choose(['0.jpg','1.jpg','2.jpg','3.jpg']);await wait(()=>$('photo-review').children.length===4&&!$('choose-photos').disabled);
  assert.deepEqual([...$('photo-review').querySelectorAll('select')].map(select=>select.selectedOptions[0].text),['Near One (from GPS, new stop)','Near One (from GPS, new stop)','Far (from GPS, new stop)','01 · Madrid, Spain'],'5 km away shares the stop, 17 km does not, and a stop on the route still wins');
});

test('the photo index names cities, and its generator leaves out sections of them',async()=>{
  const {fromGeoNames,pruneIndex,coreRadius}=await import('../scripts/build-photo-cities.mjs');
  const index=JSON.parse(source('public/photo-cities.json')),names=new Set(index.map(row=>row[0]));
  for(const section of ['Paris 01 Louvre','Paris 16 Passy','Paris 10e Arrondissement','Lyon 01','Marseille 16','Shadwell','City of Westminster','Financial District','Times Square','Budapest V. kerület','Sector 1','Zürich (Kreis 11) / Oerlikon'])assert.equal(names.has(section),false,section);
  for(const city of ['Paris','London','New York','Lyon','Versailles','Kawasaki','Yokohama'])assert.equal(names.has(city),true,city);
  const row=(id,name,lat,lon,code,country)=>[id,name,name,'',lat,lon,'P',code,country,'','','','','','100000','','','UTC','2024-01-01'].join('\t');
  assert.deepEqual(fromGeoNames([row(1,'Lyon',45.74846,4.84671,'PPLA','FR'),row(2,'Lyon 01',45.77,4.83,'PPLX','FR')].join('\n')+'\n'),[['Lyon',45.7485,4.8467,'FR']]);
  assert.equal(coreRadius(35000000),15,'A megacity does not swallow its neighbours');
  const cities=[{name:'Big  City',country:'Testland',latitude:10,longitude:10,population:4000000},{name:'Next Door',country:'Testland',latitude:10.02,longitude:10.02,population:150000},{name:'Far Hamlet',country:'Testland',latitude:30,longitude:30,population:0}];
  const rows=[['Old Quarter',10.01,10.01,'TL'],['Next Door',10.02,10.02,'TL'],['Suburb',10.2,10.2,'TL'],['Far Hamlet',30,30,'TL'],['Outskirts',10.3,10.3,'TL'],['Paris 12e Arrondissement',48.8,2.4,'FR']];
  const pruned=pruneIndex(rows,cities);
  assert.deepEqual(pruned.map(place=>place[0]),['Big City','Next Door','Suburb','Far Hamlet','Outskirts','Big City'],'Its core answers as the city, a neighbour on the map stays, and the map’s name stands for the core');
  assert.deepEqual(pruned[0],['Big City',10.01,10.01,'TL',10,10],'A core row stays where it is, so the rim still finds the city');
  assert.deepEqual(pruned.at(-1),['Big City',10,10,'TL'],'With the ISO code of the rows around it');
  assert.equal(pruneIndex([['Across the Border',10.01,10.01,'XX'],['Downtown',10,10,'TL']],cities)[0][4],undefined,'A row over the border stays itself');
  assert.deepEqual(pruneIndex(pruned,cities),pruned,'Pruning again changes nothing');
});

test('a tile’s picker names its whole city on hover, once a tile is too narrow to',async t=>{
  const {w,$,choose,change}=await setup(t);
  choose(['one.jpg','two.jpg']);await wait(()=>$('photo-review').children.length===2&&!$('choose-photos').disabled);
  const select=()=>$('photo-review').querySelector('select');assert.equal(select().title,'');
  select().value=madrid.id;select().dispatchEvent(new w.Event('change'));assert.equal(select().title,'02 · Madrid, Spain');
  change('bulk-photo-city',paris.id);assert.equal(select().title,'01 · Paris, France','A bulk choice redraws it too');
  select().value='';select().dispatchEvent(new w.Event('change'));assert.equal(select().title,'');
});

test('a drop on the open viewer changes nothing behind it, and works again once it is closed',async t=>{
  const {w,$,tiles}=await setup(t);tiles()[0].click();
  const dragging=type=>{const event=new w.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],dropEffect:'',files:[new File([jpeg],'drop.jpg',{type:'image/jpeg'})]}});return event;};
  $('full-photo').dispatchEvent(dragging('dragenter'));assert.equal($('photo-drop-hint').hidden,true);
  const over=dragging('dragover');$('full-photo').dispatchEvent(over);assert.equal(over.dataTransfer.dropEffect,'none','The cursor says so');
  $('full-photo').dispatchEvent(dragging('drop'));await tick();await tick();
  assert.equal($('photo-review').children.length,0);assert.equal($('album-book').dataset.mode,'sheet');assert.equal($('photo-viewer').open,true);
  await w.RedlinePostcards.close();
  $('photo-panel').dispatchEvent(dragging('dragenter'));assert.equal($('photo-drop-hint').hidden,false);
  const again=dragging('dragover');$('photo-panel').dispatchEvent(again);assert.equal(again.dataTransfer.dropEffect,'copy');
  $('photo-panel').dispatchEvent(dragging('drop'));await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
});

test('import review keeps keyboard focus through its page turns, and past the last photo in window view',async t=>{
  const {w,$,choose,press}=await setup(t);
  choose(Array.from({length:144},(_,i)=>`page-${i}.jpg`));await wait(()=>$('photo-selection-count').textContent==='144 selected'&&!$('choose-photos').disabled);
  const motion=controlledMotion(w),focused=()=>w.document.activeElement;
  // The book is inert for a turn, which in a browser drops focus; jsdom has no inert, so the test drops it, unless the button has just been disabled.
  const turn=async id=>{$(id).focus();$(id).click();await wait(()=>motion.running.size===4);if(!$(id).disabled){$(id).blur();assert.equal(focused(),w.document.body);}await motion.finish();await wait(()=>!$('album-book').inert);await tick();};
  await turn('review-next');assert.equal(focused(),$('review-next'),'A second Enter turns again');
  await turn('review-next');assert.equal($('review-next').disabled,true);assert.equal(focused(),$('review-prev'),'The last page has no Next, so focus takes the other button');
  await turn('review-prev');assert.equal(focused(),$('review-prev'));
  $('cancel-photo-import').click();assert.equal(focused(),$('choose-photos'),'Outside window view, focus returns to Add photos');
  press('f');assert.equal($('photo-panel').classList.contains('expanded'),true);
  const emptied=[()=>$('cancel-photo-import').click(),()=>$('photo-review').querySelector('.remove-photo').click(),()=>{const select=$('photo-review').querySelector('select');select.value=paris.id;select.dispatchEvent(new w.Event('change'));$('upload-photos').click();}];
  for(const empty of emptied){
    choose(['one.jpg']);await wait(()=>$('photo-review').children.length===1&&!$('choose-photos').disabled);
    empty();await wait(()=>!$('photo-review').children.length&&focused()===$('photo-panel'));
    await wait(()=>!$('photo-message').textContent.startsWith('Saving')&&!$('choose-photos').disabled);
  }
});

test('saving many new GPS stops redraws the review once, and leaves the trip clean',async t=>{
  const {w,$,choose,api,trip}=await setup(t,{realMap:true,seed:false,route:[madrid]});
  const places=Array.from({length:6},(_,i)=>[`Place ${i}`,10+i*3,20+i*3,'FR']);
  w.fetch=async()=>({ok:true,json:async()=>places});
  w.exifr.gps=async file=>{const place=places[Number(file.name[0])];return {latitude:place[1],longitude:place[2]};};
  choose(places.map((place,i)=>`${i}.jpg`));await wait(()=>$('photo-review').children.length===6&&!$('choose-photos').disabled);
  const review=$('photo-review'),rebuild=review.replaceChildren;let rebuilt=0;review.replaceChildren=function(...nodes){rebuilt++;return rebuild.apply(this,nodes);};
  $('upload-photos').click();await wait(()=>/6 photos saved/.test($('photo-message').textContent)&&!$('choose-photos').disabled);
  assert.ok(rebuilt<=2,`${rebuilt} rebuilds for six new stops`);
  assert.equal(w.RedlineApp.getStops().length,7);assert.equal((await api(`/trips/${trip.id}`)).trip.stops.length,7,'The new stops were still saved');
  assert.equal($('save-trip').classList.contains('dirty'),false);
});

test('the caption editor’s pin goes when the editor does',async t=>{
  const {$,tiles}=await setup(t);tiles()[0].click();const viewer=$('photo-viewer'),pinned=()=>[viewer.style.top,viewer.style.bottom,viewer.style.marginBlock];
  $('edit-caption').click();assert.equal(viewer.style.bottom,'auto','Held still while the form opens beneath it');
  $('edit-caption').click();await wait(()=>$('caption-form').hidden);assert.deepEqual(pinned(),['','','']);
  $('edit-caption').click();assert.equal(viewer.style.bottom,'auto');$('flip-postcard').click();assert.deepEqual(pinned(),['','',''],'Turning the card closes it too');
});

test('the viewer and review rules only a browser can act on stay in place',()=>{
  const css=source('public/gallery.css'),postcards=source('public/postcards.js');
  // A faded arrow still takes its click, or it falls through and turns the card.
  assert.match(css,/\.viewer-photo\.arrows-idle \.viewer-edge:not\(:focus-visible\) \{ opacity: 0; \}/);assert.match(css,/#photo-viewer\.flipped \.viewer-edge \{ pointer-events: none; \}/);
  // A tick chooses photos for a bulk city, and an unticked photo still saves, so it does not dim as if it would not.
  assert.equal(css.includes('.review-photo:not(.selected)'),false);
  // A phone's Select toolbar wraps inside the sheet that clips it, so Done is always reachable.
  assert.match(css,/@media \(max-width: 650px\) \{[^@]*\.gallery-actions \{ flex-wrap: wrap; row-gap: 4px; \}\s*\.toolbar-spacer \{ display: none; \}/);
  // Postcard fields do not make iOS zoom, its buttons take a fingertip, and this comes after the rule it overrides.
  const touch=css.indexOf('@media (hover: none), (any-pointer: coarse) {\n  #postcard-back textarea, #postcard-back input { font-size: 16px; }');
  assert.ok(touch>css.indexOf('#postcard-back textarea, #postcard-back input { font-size: 15px; }'));assert.match(css.slice(touch),/\.postcard-actions button:not\(\.viewer-tool\) \{ min-width: 44px; min-height: 44px; \}/);
  // A panorama keeps height for its fields, and a narrow photo keeps a toolbar and buttons that fit, the save note giving way first.
  assert.match(css,/#postcard-back \{[^}]*padding: clamp\(10px, 4%, 24px\);/);
  assert.match(css,/#postcard-card \{[^}]*min-width: min\(240px, calc\(90vw - 40px\)\);/);assert.match(css,/#full-photo \{[^}]*margin-inline: auto;/);assert.match(css,/#postcard-saved \{ min-width: 0;[^}]*overflow: hidden;/);
  // Nothing reads these.
  assert.equal(css.includes('#photo-viewer select'),false);
  for(const gone of ['caption-editing',"toggle('preview'"])assert.equal(postcards.includes(gone),false,gone);
});

const contrast=(a,b)=>{
  const luminance=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=.03928?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0),[x,y]=[luminance(a),luminance(b)];
  return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
};
const markup=()=>new JSDOM(source('map.html')).window.document;
const blockOf=(css,opening)=>{const from=css.indexOf(opening);assert.ok(from>=0,opening);let depth=0;for(let i=css.indexOf('{',from);i<css.length;i++){if(css[i]==='{')depth++;else if(css[i]==='}'&&--depth===0)return css.slice(from,i+1);}};

test('quiet text and glyphs stay readable on the darkest paper behind them',()=>{
  const css=source('public/style.css')+source('public/gallery.css'),rule=selector=>css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} \\{([^}]*)\\}`,'m'))?.[1],token=name=>css.match(new RegExp(`${name}: (#\\w{6})`))[1];
  const logbook='#f1e7d4',page='#efe5d2',strip='#e4d5b9',leather='#594b3a';
  for(const [selector,ground,need] of [['.folio',page,4.5],['#postcard-back textarea::placeholder, #postcard-back input::placeholder',page,4.5],['.trip-state',logbook,4.5],['.trip-state.unsaved',logbook,4.5],[':is(#photo-ready-count, .album-copy-photo-ready-count)',strip,4.5],['.danger-button',strip,4.5],['.cover-kicker',leather,4.5],['.cover-title',leather,4.5],['.cover-meta',leather,4.5],['.back-mark',leather,4.5],['.page-stop',page,4.5],['.contents-no',page,4.5],['.album .eyebrow',page,4.5],['.title-meta',page,4.5],['.page-country',page,4.5],['.gallery-city-count',page,4.5],['.photo-empty-hint',page,4.5],['.sheet-label',page,4.5],[':where(.album) .text-button',strip,4.5],['.remove-stop',logbook,3]]){
    const body=rule(selector);assert.ok(body,`${selector} is still styled`);
    const colour=body.match(/(?:^|;)\s*color: ([^;]+);/)[1].replace(/var\((--[\w-]+)\)/,(_,name)=>token(name));
    assert.ok(contrast(colour,ground)>=need,`${selector} is ${contrast(colour,ground).toFixed(2)}:1, and needs ${need}:1`);
    assert.doesNotMatch(body,/opacity: (?!1;)/,`${selector} would fade below that`);
  }
});

test('the album keeps to its type system: a book face, nothing under 13px, no wide tracking on small type, lining figures, and tabs left alone',()=>{
  const css=source('public/gallery.css').replace(/\/\*[\s\S]*?\*\//g,''),tabs=/\.album-tab/;
  assert.match(css,/--album-text: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;/);
  assert.doesNotMatch(css,/Arial|Helvetica|sans-serif/,'No interface sans inside the book');
  const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([,selector,body])=>({selector:selector.trim(),body}));
  const sizeOf=body=>{const px=[...body.matchAll(/font(?:-size)?:[^;]*?(?:clamp\()?(\d+(?:\.\d+)?)px/g)].map(match=>Number(match[1]));return px.length?Math.min(...px):null;};
  for(const {selector,body} of rules){
    if(tabs.test(selector))continue;
    const size=sizeOf(body);
    if(size!==null)assert.ok(size>=13,`${selector} sets ${size}px`);
    const tracking=body.match(/letter-spacing: ([\d.]+)(em|px)/);
    if(tracking&&size!==null&&size<14){const em=tracking[2]==='em'?Number(tracking[1]):Number(tracking[1])/size;assert.ok(em<=.08,`${selector} tracks ${em.toFixed(2)}em at ${size}px`);}
  }
  // Rough outlines and a script only where they are large enough to read.
  for(const {selector,body} of rules){
    if(tabs.test(selector))continue;
    const size=sizeOf(body);
    if(/var\(--serif\)/.test(body))assert.ok(size>=22,`${selector} letters IM Fell at ${size}px`);
    if(/var\(--hand\)/.test(body))assert.ok(size>=21,`${selector} writes script at ${size}px`);
    if(/var\(--lettering\)/.test(body))assert.ok(size>=20,`${selector} letters Redline Hand at ${size}px`);
  }
  assert.match(css,/#postcard-back #postcard-message \{[^}]*var\(--hand\)/,'The postcard message is the one long piece of handwriting');
  assert.match(css,/@container \(max-width: 300px\) \{\s*\.print figcaption \{[^}]*-webkit-line-clamp: 2;[^}]*white-space: normal;/,'A caption this large cannot be cut short on a narrow print');
  assert.match(css,/#photo-panel :not\(\.album-tab, \.album-tab \*\) \{ font-variant-numeric: lining-nums; \}/);
  assert.ok(css.lastIndexOf('font-variant-numeric')>css.lastIndexOf('font: '),'The font shorthand resets it, so it comes after them all');
  // The user's tabs: their lettering, size and placement.
  assert.match(css,/\.album-tab \.tab-name \{[^}]*font: 14px\/var\(--tab-strip, 27px\) var\(--lettering\); letter-spacing: \.05em;/);
  assert.match(css,/\.album-tab \.chip-stop \{ bottom: 5px; color: #f6e8c4; font: 10px\/1\.2 var\(--serif\); \}/);
  const style=source('public/style.css');assert.match(style,/--serif: "IM Fell English", Georgia, serif;/,'The map chrome and tabs keep it');
});

test('keyboard focus stands out on the album\'s dark chrome, in the trip menu and in search results',()=>{
  const style=source('public/style.css'),gallery=source('public/gallery.css'),paper=style.match(/--paper: (#\w{6})/)[1],logRed=style.match(/\.route-dock, \.route-log \{[^}]*--red: (#\w{6})/)[1];
  assert.match(gallery,/\.album :is\(\.album-top, \.album-foot, #album-drawer\) :focus-visible \{ outline-color: var\(--paper\); \}/);
  for(const ground of ['#302820','#29221c'])assert.ok(contrast(paper,ground)>=3,`The paper ring on ${ground}`);
  for(const edge of ['album-top-edge','album-edge'])assert.match(gallery,new RegExp(`#${edge}:focus-visible \\{ outline: 2px solid var\\(--paper\\);`),'Brass falls under 3:1 on the leather');
  assert.match(style,/\.trip-menu button:focus-visible \{ outline: 2px solid var\(--red\); outline-offset: -2px; \}/);
  assert.doesNotMatch(style,/\.trip-menu button:hover, \.trip-menu button:focus-visible \{[^}]*outline: none/,'A tint alone is 1.17:1');
  assert.match(style,/#suggestions button\[aria-selected=true\] \{ box-shadow: inset 3px 0 var\(--red\); \}/,'Focus stays in the field, so this is the only sign of the chosen row');
  for(const ground of ['#faf5ea','#efe3cc'])assert.ok(contrast(logRed,ground)>=3,`The red mark on ${ground}`);
});

test('the trace button keeps its accessible name on a phone',()=>{
  const phone=blockOf(source('public/style.css'),'@media (max-width: 650px)'),rule=phone.match(/\.travel-controls #play-label \{([^}]*)\}/)[1],play=markup().getElementById('play');
  assert.doesNotMatch(rule,/display: none|visibility: hidden/,'Either would take the only text out of its name');
  assert.match(rule,/position: absolute;/);assert.match(rule,/clip: rect\(0, 0, 0, 0\);/);
  assert.equal(play.textContent.trim(),'Trace route');assert.equal(play.querySelector('svg').getAttribute('aria-hidden'),'true');
});

test('search results stay within a short window, and a trip menu has room with one saved trip',()=>{
  const css=source('public/style.css'),[,inset]=css.match(/\.suggestion-panel \{[^}]*max-height: min\(260px, calc\(100svh - (\d+)px\)\);/);
  // The panel sits 8px above the dock. Its status line adds 21px, and a phone-width dock wraps to 136.5px, 16px up rather than 22px.
  const top=(height,dock,below)=>height-below-dock-8-Math.min(260,height-Number(inset));
  for(const [height,dock,below] of [[375,110.5,22],[375,131.5,22],[320,157.5,16]])assert.ok(top(height,dock,below)>=0,`The first result starts at y=${top(height,dock,below)} in a ${height}px window`);
  assert.equal(Math.min(260,720-Number(inset)),260,'A roomy window keeps the full list');
  assert.match(css,/\.trip-switcher \.trip-grid:has\(\.trip-menu:not\(\[hidden\]\)\) \{ min-height: 240px; \}/);
});

test('with Switch trip open, + New trip and Export trip still come before the list in tab order',()=>{
  const doc=markup(),actions=doc.querySelector('.current-actions'),list=doc.getElementById('trip-switcher');
  assert.ok(actions.compareDocumentPosition(list)&doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(actions.parentElement,list.parentElement,'It is still placed against the navigation row');
  assert.match(source('public/style.css'),/\.current-actions \{ position: absolute; top: 0; right: 0;/);
  for(const id of ['current-trip-map','trips-summary','toggle-stops'])assert.equal(doc.getElementById(id),null,`${id} had no visible use`);
});

test('no field makes iOS zoom the page on focus',()=>{
  const gallery=source('public/gallery.css'),block=blockOf(gallery,'@media (hover: none), (any-pointer: coarse) {\n  #postcard-back textarea');
  const sixteen=[...block.matchAll(/^\s*([^{}\n]+?) \{ font-size: 16px; \}/gm)].map(match=>match[1]).join(', ');
  assert.ok(gallery.indexOf('.album select {')<gallery.indexOf(block),'After the rules it overrides');
  const doc=markup(),fields=[...doc.querySelectorAll('input:not([type=checkbox]):not([type=range]):not([type=file]),textarea,select')];
  // Rename fields and the selects under each print are built later, inside these.
  const rename=doc.createElement('input');rename.type='text';doc.getElementById('trip-list').append(Object.assign(doc.createElement('form'),{className:'trip-rename-form'}));doc.querySelector('.trip-rename-form').append(rename);
  const pick=doc.createElement('select');doc.getElementById('photo-review').append(pick);
  const largeAlready=['trip-name','caption-input'];assert.match(source('public/style.css'),/#trip-name-form input \{[^}]*italic 19px/);assert.match(gallery,/#caption-input \{[^}]*font: 16px/);
  assert.ok(fields.length>8);
  for(const field of [...fields,rename,pick])if(!largeAlready.includes(field.id))assert.ok(field.matches(sixteen),`${field.id||field.tagName} is 16px on a touch screen`);
});

test('every custom property and keyframes in the stylesheets has a reader',()=>{
  const css=(source('public/style.css')+source('public/gallery.css')).replace(/\/\*[\s\S]*?\*\//g,''),scripts=readdirSync(new URL('../public/',import.meta.url)).filter(name=>/\.js$/.test(name)&&!/^(world|atlas-geography|atlas-names)\.js$/.test(name)).map(name=>source(`public/${name}`)).join('');
  for(const name of new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(match=>match[1])))assert.ok(css.includes(`var(${name}`)||scripts.includes(name),`${name} is read`);
  for(const [,name] of css.matchAll(/@keyframes ([\w-]+)/g))assert.ok(new RegExp(`animation[^;}]*\\b${name}\\b`).test(css)||scripts.includes(name),`@keyframes ${name} is used`);
});

test('a click on a city goes to the closest dot, not to whichever neighbour paints last',async t=>{
  const {w,clock,map,stop}=await chart(t,[LONDON,PARIS,ROME]);
  [[100,100],[104,100],[300,300]].forEach(([x,y],i)=>{stop(i).querySelector('.stop-dot').getBoundingClientRect=()=>({left:x-4.5,top:y-4.5,width:9,height:9});});
  const click=(i,clientX,clientY)=>{stop(i).querySelector('circle[r="12"]').dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1,clientX,clientY}));clock.settle();};
  click(1,100,100);assert.equal(map.dataset.tripStep,'1','Paris’ target lies over London’s dot');
  click(1,104,100);assert.equal(map.dataset.tripStep,'2','And its own dot is still its own');
  stop(2).querySelector('circle[r="12"]').dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:0}));clock.settle();assert.equal(map.dataset.tripStep,'3','Assistive technology names the exact stop');
});

test('a flicked map stops coasting when a key or a city takes the camera',async t=>{
  const {w,$,clock,map,press,wheel,stop}=await chart(t,[LONDON,PARIS,ROME,ATHENS]);
  const flick=()=>{const fire=(type,x,at)=>{const event=new w.MouseEvent(type,{button:0,clientX:x,clientY:300,bubbles:true,cancelable:true});Object.defineProperties(event,{pointerId:{value:1},pointerType:{value:'mouse'},timeStamp:{value:at}});map.dispatchEvent(event);};
    const began=clock.now;fire('pointerdown',700,began);for(let i=1;i<=6;i++)fire('pointermove',700+30*i,began+10*i);fire('pointerup',880,began+62);};
  for(let i=0;i<5;i++)wheel(-160,720,200);clock.settle();
  flick();press('ArrowRight',map);press('ArrowRight',map);press('ArrowRight',map);const landed=camera(w);clock.run(90);assert.deepEqual(camera(w),landed,'A key');
  flick();stop(1).dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1}));clock.settle();const city=camera(w);clock.run(90);assert.deepEqual(camera(w),city,'A city');
  assert.equal($('play-label').textContent,'Trace route');
});

test('a Safari pinch over a city zooms the map, not the page',async t=>{
  const {w,clock,stop}=await chart(t,[LONDON,PARIS]);
  const fire=(type,scale)=>{const event=new w.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{scale,clientX:720,clientY:450});stop(0).dispatchEvent(event);return event;};
  assert.equal(fire('gesturestart',1).defaultPrevented,true);assert.equal(fire('gesturechange',2).defaultPrevented,true);clock.settle();
  assert.ok(Math.abs(camera(w).w-720)<1e-6);
});

test('a clean reload leaves the camera and a trace alone while the trip loads',async t=>{
  const first=await setup(t,{realMap:true,seed:false,route:[paris,madrid]}),dump=store=>Object.fromEntries(Array.from({length:store.length},(_,i)=>[store.key(i),store.getItem(store.key(i))]));
  const again=await setup(t,{realMap:true,seed:false,route:[paris,madrid],profile:{idb:first.w.indexedDB,local:dump(first.w.localStorage),session:dump(first.w.sessionStorage)}}),{w,$,press}=again,clock=mapClock(w),map=$('map');
  map.dispatchEvent(new w.WheelEvent('wheel',{clientX:720,clientY:300,deltaY:-160,bubbles:true,cancelable:true}));press('Enter',map);
  assert.equal($('play-label').textContent,'Pause');await tick();await new Promise(resolve=>setTimeout(resolve,120));clock.frame();
  assert.equal($('play-label').textContent,'Pause');assert.ok(camera(w).w<1440,'Still zoomed');
});

test('long names never widen the rail past what the book can spare',async t=>{
  const long=['Saint Petersburg','San Francisco','Rio de Janeiro','Buenos Aires','Philadelphia'].map((name,i)=>({id:`album-city-${i}`,name,country:'Test',latitude:10+i*5,longitude:10+i*5}));
  const {w,$}=await setup(t,{route:long,seedStops:long}),book=$('album-book'),stage=book.parentElement;
  const measure=(width,height,rail)=>{
    for(const [node,field,value] of [[stage,'clientWidth',width],[stage,'clientHeight',height],[$('gallery-filter'),'clientHeight',rail]])Object.defineProperty(node,field,{configurable:true,value});
    w.dispatchEvent(new w.Event('resize'));return Number(book.style.getPropertyValue('--tab-width').replace('px',''));
  };
  // Book height: the smaller of the stage's height and (width - 2 x rail - 28) / 1.5.
  const fits=(width,height,rail)=>Math.min(height-8,(width-48-2*rail-28)/1.5);
  for(const [width,height,railHeight] of [[820,270,120],[643,255,100]]){
    const rail=measure(width,height,railHeight);
    assert.ok(rail<=153,`${width}x${height} gives a ${rail}px rail`);
    assert.ok(fits(width,height,rail)>=Math.min(height-8,(width-48-2*99-28)/1.5)-1,`${width}x${height} keeps its book`);
  }
  assert.equal(new Set([...$('gallery-filter').children].map(tab=>`${tab.style.getPropertyValue('--tab-column')},${tab.style.getPropertyValue('--tab-row')}`)).size,5,'No two tabs share a place');
});

test('a stray click during a turn stays in the album, and a near miss on a control does nothing',async t=>{
  const {w,$,tab}=await setup(t),panel=$('photo-panel');
  tab(paris.id).click();
  const button=$('album-next'),foot=panel.querySelector('.album-foot');
  button.getBoundingClientRect=()=>({left:100,right:142,top:50,bottom:92});
  clickOn(w,foot,{clientX:148,clientY:70});assert.equal(panel.open,true,'Six pixels from the arrow');
  clickOn(w,foot,{clientX:400,clientY:70});assert.equal(panel.open,false,'Clear of everything');
});

test('window view lets go of originals once the reader has moved on',async t=>{
  const {w}=await setup(t),cache=w.RedlineAlbumMotion,urls=['https://redline.test/a.jpg','https://redline.test/b.jpg'];
  cache.clearPreloads();let attempts=0;w.HTMLImageElement.prototype.decode=function(){attempts++;return Promise.resolve();};
  await cache.preload(urls);assert.equal(attempts,2);await cache.preload(urls);assert.equal(attempts,2,'Held');
  cache.release([urls[0],'https://redline.test/never-held.jpg']);await cache.preload(urls);assert.equal(attempts,3,'Only what was let go is fetched again');cache.clearPreloads();
});

test('an airport photo does not rename a city, and the rim of a city still finds it',async t=>{
  const {w,$,choose,api,trip}=await setup(t,{realMap:true,seed:false,route:[madrid]});
  const index=JSON.parse(source('public/photo-cities.json')),spots={cdg:[49.0097,2.5479],louvre:[48.8606,2.3376],eiffel:[48.8584,2.2945],boulogne:[48.8397,2.2399],denis:[48.9362,2.3574]};
  w.fetch=async()=>({ok:true,json:async()=>index});
  w.exifr.gps=async file=>{const [latitude,longitude]=spots[file.name.split('.')[0]];return {latitude,longitude};};
  choose(['cdg.jpg','louvre.jpg','eiffel.jpg','boulogne.jpg','denis.jpg']);await wait(()=>$('photo-review').children.length===5&&!$('choose-photos').disabled);
  const names=[...$('photo-review').querySelectorAll('select')].map(select=>select.selectedOptions[0].text);
  assert.notEqual(names[0],'Paris (from GPS, new stop)');
  assert.deepEqual(names.slice(1),Array(4).fill('Paris (from GPS, new stop)'));
  $('upload-photos').click();await wait(()=>/5 photos saved/.test($('photo-message').textContent));
  const stopNames=(await api(`/trips/${trip.id}`)).trip.stops.map(stop=>stop.name);assert.equal(stopNames.filter(name=>name==='Paris').length,1,stopNames.join());
  const added=w.RedlineApp.getStops().find(stop=>stop.name==='Paris');assert.ok(Math.abs(added.latitude-48.85)<.05&&Math.abs(added.longitude-2.35)<.05,'At the city, not where the first photo stood');
});

test('a press that lands during a turn never shuts the album, whenever it is released',async t=>{
  const {w,$,tab}=await setup(t),panel=$('photo-panel'),stage=panel.querySelector('.album-stage');tab(paris.id).click();
  const motion=controlledMotion(w),fire=type=>stage.dispatchEvent(new w.MouseEvent(type,{bubbles:true}));
  $('sheet-view').click();await wait(()=>motion.running.size);
  fire('pointerdown');fire('pointerup');fire('click');assert.notEqual(panel.dataset.motion,'closing','Released during the turn');
  fire('pointerdown');for(let i=0;i<4&&$('album-book').dataset.viewMotion;i++)await motion.finish();
  assert.equal($('album-book').dataset.viewMotion,undefined,'The turn is over');
  fire('pointerup');fire('click');assert.equal(panel.open,true,'Released after it');assert.notEqual(panel.dataset.motion,'closing');
  fire('pointerdown');fire('pointerup');fire('click');assert.equal(panel.dataset.motion,'closing','At rest, the stage still closes the book');
  for(let i=0;i<4&&panel.open;i++)await motion.finish();
});

test('the photo index has settled: repeating the generator changes nothing, and every row is a place',async()=>{
  const {pruneIndex}=await import('../scripts/build-photo-cities.mjs');
  const context={window:{}};vm.createContext(context);vm.runInContext(source('public/atlas-geography.js'),context);
  const index=JSON.parse(source('public/photo-cities.json'));
  assert.deepEqual(JSON.parse(JSON.stringify(pruneIndex(index,context.window.MAP_CITIES))),index);
  assert.equal(new Set(index.map(row=>JSON.stringify(row))).size,index.length,'No row twice');
  assert.deepEqual(index.filter(row=>!/^[A-Z]{2}$/.test(row[3])),[],'Every code is an ISO code');
  assert.deepEqual(index.filter(row=>/\bhome$/i.test(row[0])),[],'And no one’s home');
  assert.ok(index.some(row=>row[0]==='Macau'&&row.length===4));
});
