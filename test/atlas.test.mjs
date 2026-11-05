import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {createContext,runInContext,runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {encodeLayer} from '../scripts/atlas-codec.mjs';
import {dissolve} from '../scripts/atlas-geometry.mjs';

const file=name=>new URL(`../public/${name}`,import.meta.url);
function recorder(log=[]){
  const target={width:512,height:512,canvas:{width:512,height:512},createPattern:()=>({}),createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)})};
  return new Proxy(target,{get(object,key){if(key in object)return object[key];return (...args)=>{if(typeof key==='string'&&!/^(set|save|restore)/.test(key))log.push(key);return undefined;};},set(object,key,value){object[key]=value;return true;}});
}
function loadPainter(log=[]){
  class Path{moveTo(){}lineTo(){}closePath(){}quadraticCurveTo(){}bezierCurveTo(){}arc(){}}
  class Offscreen{constructor(w,h){this.width=w;this.height=h;}getContext(){return recorder(log);}}
  const context={Path2D:Path,OffscreenCanvas:Offscreen,TextDecoder,Float32Array,Uint8Array,DataView,JSON,Math,Object};
  context.globalThis=context;
  runInNewContext(readFileSync(file('atlas-painter.js'),'utf8'),context);
  return context.RedlineAtlasPainter;
}
const bundle=(painter,name)=>{const raw=inflateSync(readFileSync(file(`atlas/${name}`)));return painter.decodeBundle(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.length));};

test('atlas geography decodes, stays on the sheet, and gets finer at each level',()=>{
  const painter=loadPainter(),near=bundle(painter,'geo0.bin'),far=bundle(painter,'geo1.bin');
  const points=layer=>layer.reduce((sum,feature)=>sum+feature.n,0);
  assert.ok(points(near.land0)>20000&&points(far.land1)>points(near.land0)&&points(far.land2)>points(far.land1));
  for(const layer of [near.land0,far.land2,far.rivers1,far.borders1,far.lakes1])for(const feature of layer){
    assert.ok(feature.left>=-.01&&feature.right<=1440.01&&feature.top>=-.01&&feature.bottom<=720.01,'Every feature lies on the sheet');
  }
  assert.ok(far.rivers1.length>500&&far.lakes1.length>200&&far.regions.length>100,'Rivers, lakes and regional lines are present');
  assert.equal(near.terrain.width,1440);assert.equal(near.terrain.height,720);assert.equal(near.terrain.bytes.length,1440*720*2);
});

test('land rings are cut at the date line, so nothing streaks across the sheet',()=>{
  const painter=loadPainter(),{land0}=bundle(painter,'geo0.bin');
  for(const ring of land0)for(let i=0;i<ring.n;i++){
    const j=(i+1)%ring.n,ax=ring.xy[i*2],ay=ring.xy[i*2+1],bx=ring.xy[j*2],by=ring.xy[j*2+1];
    // Antarctica legitimately closes along the bottom edge of the sheet.
    if(ay>719&&by>719)continue;
    assert.ok(Math.abs(ax-bx)<420,`A coast segment spans ${Math.abs(ax-bx)} units at ${ax},${ay}`);
  }
});

test('terrain cells describe the real world',()=>{
  const painter=loadPainter(),{terrain}=bundle(painter,'geo0.bin'),at=(lon,lat)=>painter.terrainAt(terrain,(lon+180)*4,(90-lat)*4,{});
  assert.ok(at(86,28).rugged>.5,'The Himalaya are rugged');
  assert.ok(at(-62,-3).forest>.5,'The Amazon is forested');
  assert.ok(at(5,23).arid>.4,'The Sahara is arid');
  assert.ok(at(-40,75).ice>.8,'Greenland is ice');
  assert.equal(at(-30,0).land,0,'The mid-Atlantic is open water');
});

test('every ornament on the chart floats on open water',()=>{
  const painter=loadPainter(),{terrain}=bundle(painter,'geo0.bin');
  for(const item of painter.ORNAMENTS){
    const here=painter.terrainAt(terrain,item.x,item.y,{});
    assert.equal(here.land,0,`${item.kind} at ${item.x},${item.y} is on land`);
  }
});

test('a tile paints the same way every time and scales its work with zoom',()=>{
  const paint=(tile)=>{
    const log=[],painter=loadPainter(log),scene=painter.createScene();
    painter.addLayers(scene,bundle(painter,'geo0.bin'));
    painter.paintTile(recorder(log),scene,{sx:2,sy:2.5,x0:1024,y0:256,w:514,h:514,dpr:2,...tile});
    return log;
  };
  const first=paint({}),second=paint({});
  assert.ok(first.length>100,'A land tile draws real work');
  assert.deepEqual(first,second,'Tiles are deterministic, so neighbours always line up');
  const sea=paint({sx:2,sy:2.5,x0:0,y0:900,w:514,h:514});
  assert.ok(sea.length<first.length,'Open water costs less than land');
});

test('the view is inert, not broken, where workers or canvas are unavailable',async()=>{
  const dom=new JSDOM('<canvas id="c"></canvas>',{runScripts:'outside-only',pretendToBeVisual:true});
  dom.window.eval(readFileSync(file('atlas-view.js'),'utf8'));
  const view=dom.window.RedlineAtlasView.create(dom.window.document.getElementById('c'),{});
  assert.equal(view.supported,false);
  const frame={x:12,y:34,w:720,h:360},labels=[{kind:'city',text:'Paris',x:40,y:50,angle:0,curve:0}];
  view.update(frame,labels);view.prefetch({x:0,y:0,w:100,h:50});view.release();
  assert.equal(view.view,frame,'The camera it was given can still be read back');assert.equal(view.labels,labels);
  const city=view.measure('city','Paris');
  assert.ok(city.w>0&&city.h>0&&view.measure('city','Paris and beyond').w>city.w,'Label collision still has a size to work with');
  assert.equal(await view.ready,false,'Nothing waits on a sheet that will never be painted');
  assert.equal(view.snapshot(),null);assert.equal(await view.paintRegion({x:0,y:0,w:100,h:50},100,50),null);
  dom.window.close();
});

test('geometry survives the codec exactly at its resolution',()=>{
  const encoded=encodeLayer([{rank:3,points:[[0,0],[1439.98,719.98],[12.34,56.78]]},{rank:0,points:[[720,360],[720.02,360.02]]}]);
  const bytes=Buffer.concat([Buffer.alloc(4),Buffer.from(JSON.stringify({a:{offset:0,length:encoded.length}})),encoded]);
  const header=JSON.stringify({a:{offset:0,length:encoded.length}});bytes.writeUInt32LE(Buffer.byteLength(header));
  const painter=loadPainter(),layer=painter.decodeBundle(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)).a;
  assert.equal(layer.length,2);assert.equal(layer[0].rank,3);assert.equal(layer[0].n,3);
  assert.ok(Math.abs(layer[0].xy[2]-1439.98)<.001&&Math.abs(layer[0].xy[5]-56.78)<.001);
  assert.ok(Math.abs(layer[1].xy[3]-360.02)<.001);
});

test('every font the stylesheets name ships, and none ships unnamed',()=>{
  const named=['style.css','gallery.css'].flatMap(name=>[...readFileSync(file(name),'utf8').matchAll(/url\("fonts\/([^"]+)"\)/g)].map(match=>match[1]));
  assert.deepEqual([...new Set(named)].sort(),readdirSync(file('fonts/')).filter(name=>/\.woff2?$/.test(name)).sort());
});

for(const name of ['redline-hand','redline-hand-bold'])test(`the ${name} lettering is a valid font that covers the names on the map`,()=>{
  const font=readFileSync(file(`fonts/${name}.woff`));
  assert.equal(font.toString('latin1',0,4),'wOFF');assert.equal(font.readUInt32BE(8),font.length);
  const count=font.readUInt16BE(12),tables={};
  for(let i=0;i<count;i++){
    const at=44+i*20,tag=font.toString('latin1',at,at+4),offset=font.readUInt32BE(at+4),compressed=font.readUInt32BE(at+8),original=font.readUInt32BE(at+12),data=font.subarray(offset,offset+compressed);
    tables[tag.trim()]=compressed<original?inflateSync(data):data;
  }
  for(const tag of ['OS/2','cmap','glyf','head','hhea','hmtx','loca','maxp','name','post'])assert.ok(tables[tag],`${tag} is present`);
  assert.equal(tables.head.readUInt32BE(12),0x5F0F3CF5,'The head table carries the TrueType magic number');
  const glyphs=tables.maxp.readUInt16BE(4);assert.ok(glyphs>300);
  assert.equal(tables.loca.length,(glyphs+1)*4);assert.equal(tables.hhea.readUInt16BE(34),glyphs);
  // Format 4 cmap: every letter a label can reasonably use maps to a real glyph.
  const cmap=tables.cmap,sub=cmap.readUInt32BE(8),segments=cmap.readUInt16BE(sub+6)/2,ends=sub+14,starts=ends+segments*2+2,deltas=starts+segments*2;
  const lookup=code=>{for(let s=0;s<segments;s++)if(code<=cmap.readUInt16BE(ends+s*2))return code>=cmap.readUInt16BE(starts+s*2)?(code+cmap.readUInt16BE(deltas+s*2))&0xffff:0;return 0;};
  for(const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,-\'’éñóüçãßøŁ→'){
    assert.ok(lookup(char.codePointAt(0))>0,`${char} has a glyph`);
  }
});

const rings=path=>path.split('M').filter(Boolean).map(part=>[...part.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(m=>[Number(m[1]),Number(m[2])]));
function inside(rings,[x,y]){
  let hit=false;
  for(const ring of rings)for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])hit=!hit;
  }
  return hit;
}

test('landmass construction dissolves national edges but keeps lakes and islands inside lakes',()=>{
  const input=['M0,0L10,0L10,20L0,20Z','M10,0L20,0L20,20L10,20ZM12,8L16,8L16,12L12,12ZM13,9L15,9L15,11L13,11Z'];
  const result=dissolve(input);assert.equal(result.land.length,1,'Adjacent countries use a single continuous colour field');
  const land=rings(result.land[0]);
  for(const point of [[1,1],[9.99,5],[10.01,5],[14,10]])assert.equal(inside(land,point),true);
  for(const point of [[21,10],[12.5,9],[14,11.5]])assert.equal(inside(land,point),false);
  assert.equal(result.borders.length,1);assert.match(result.borders[0],/M10,(?:0L10,20|20L10,0)/);
});

test('the shipped landmasses keep the original coasts and every other piece of world data',()=>{
  const originalData={window:{}},runtimeData={window:{}};
  runInNewContext(readFileSync(file('world.js'),'utf8'),originalData);runInNewContext(readFileSync(file('atlas-geography.js'),'utf8'),runtimeData);
  const source=Array.from(originalData.window.WORLD_PATHS),shipped=Array.from(runtimeData.window.ATLAS_LAND),generated=dissolve(source);
  assert.deepEqual(generated.land,shipped,'The published land is exactly what the source countries dissolve into');
  assert.ok(generated.borders.length>0,'The source countries still have shared borders to give up');
  for(const key of ['WORLD_PATHS','REGION_PATHS','ATLAS_BORDERS'])assert.equal(runtimeData.window[key],undefined,`${key} is not downloaded a second time; the worker has its own compact copy`);
  const unread=['ANTARCTICA_POLYGONS','MAP_META'];
  for(const key of unread)assert.equal(runtimeData.window[key],undefined,`Nothing at runtime reads ${key}, so it stays out of the download`);
  for(const [key,value] of Object.entries(originalData.window))if(!['WORLD_PATHS','REGION_PATHS',...unread].includes(key))assert.equal(JSON.stringify(runtimeData.window[key]),JSON.stringify(value),`${key} is preserved`);
  const original=source.map(rings),merged=shipped.map(rings);
  for(let y=7.31;y<720;y+=19.73)for(let x=3.17;x<1440;x+=17.83){
    const point=[x,y];assert.equal(merged.some(shape=>inside(shape,point)),original.some(shape=>inside(shape,point)),`Geography at ${point} is unchanged`);
  }
  const vertices=paths=>paths.reduce((count,path)=>count+(path.match(/,/g)||[]).length,0);
  assert.ok(vertices(shipped)<vertices(source)/2,'Less than half as many coordinates need filled-area painting');
});

test('relief is local to the close-up being painted, and every tile it can ask for ships',()=>{
  const painter=loadPainter(),context={};context.self=context;
  runInNewContext(readFileSync(file('relief/index.js'),'utf8'),context);
  const coverage=context.self.REDLINE_RELIEF;let tiles=0;
  coverage.forEach((mask,y)=>{for(let x=0;x<16;x++)if(mask&(1<<x)){
    tiles++;assert.equal(readFileSync(file(`relief/16-${x}-${y}.webp`)).toString('ascii',8,12),'WEBP');
  }});
  assert.ok(tiles>90,'The land is covered');
  const tile=(sx,x0,y0)=>({sx,sy:sx,x0,y0,w:514,h:514,dpr:1});
  assert.equal(painter.reliefTiles(tile(1,0,0),coverage).length,0,'The world overview never loads relief');
  assert.equal(painter.reliefTiles(tile(4,1024,512),coverage).length,0,'Nor does a regional view');
  for(const [sx,x,y] of [[6,750,180],[16,1200,120],[64,800,160],[240,1000,300]]){
    const keys=painter.reliefTiles(tile(sx,x*sx,y*sx),coverage);
    assert.ok(keys.length<=4,`A tile of the sheet touches at most its neighbours (${keys.length})`);
    for(const {x:i,y:j,key} of keys){
      assert.equal(key,`16-${i}-${j}`);assert.ok(coverage[j]&(1<<i),'Open water has no tile to ask for');
      assert.ok(i*90<x+514/sx&&(i+1)*90>x&&j*90<y+514/sx&&(j+1)*90>y,'Only tiles under the painted area load');
    }
  }
});

const atlasAssets=()=>JSON.parse(readFileSync(new URL('../map.html',import.meta.url),'utf8').match(/<script id="atlas-assets"[^>]*>([^<]*)</)[1]);

test('the worker starts on the light files, and fetches the rest only when asked to sharpen',async()=>{
  const assets=atlasAssets(),fetched=[],posted=[],bitmaps=[];
  const context=createContext({Response,DecompressionStream,TextDecoder,console,onmessage:null,Path2D:class{moveTo(){}lineTo(){}closePath(){}},
    postMessage:message=>posted.push(message),
    fetch:async url=>{fetched.push(url);return new Response(readFileSync(file(url)));},
    createImageBitmap:async()=>{const bitmap={closed:false,close(){this.closed=true;}};bitmaps.push(bitmap);return bitmap;},
    importScripts:(...urls)=>{for(const url of urls)runInContext(readFileSync(file(url),'utf8'),context);}});
  context.self=context;
  runInContext(readFileSync(file('atlas-worker.js'),'utf8'),context);
  const posts=async type=>{
    for(let i=0;i<400&&!posted.some(message=>message.type===type||message.type==='error');i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.deepEqual(posted.map(message=>message.type).at(-1),type,JSON.stringify(posted.at(-1)));
  };
  context.onmessage({data:{type:'start',...assets}});await posts('ready');
  assert.deepEqual([...fetched].sort(),[assets.near,assets.sea,assets.landSmall].sort(),'A first paint needs only these');
  assert.equal(posted.some(message=>message.type==='detail'),false);
  context.onmessage({data:{type:'sharpen'}});await posts('detail');
  assert.deepEqual(fetched.slice(3).sort(),[assets.far,assets.land].sort(),'The finest coasts and full plate follow on request');
  assert.equal(bitmaps.filter(bitmap=>bitmap.closed).length,1,'The small land plate is let go once the full one arrives');
});

test('the first paint stays light, and everything the worker is told to fetch ships',()=>{
  const assets=atlasAssets();
  const size=key=>readFileSync(file(assets[key])).length;
  for(const key of ['worker','painter','reliefIndex','near','far','land','landSmall','sea'])assert.ok(size(key)>0,`${key} ships`);
  const first=['near','landSmall','sea'].reduce((sum,key)=>sum+size(key),0),all=first+size('far')+size('land');
  assert.ok(first<640*1024,`The sheet needs ${first} bytes before its first paint`);
  assert.ok(all<3.2*1024*1024,`The whole atlas is ${all} bytes`);
});

test('a name fades up as it arrives, and one already lettered does not fade again',async()=>{
  const dom=new JSDOM('<canvas id="c"></canvas>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,alphas=[];let now=1000,pending=null;
  class Context{constructor(){this.globalAlpha=1;this.canvas={width:64,height:64};}measureText(text){return {width:text.length*6};}drawImage(image){if(image.sprite)alphas.push(this.globalAlpha);}fillRect(){}strokeRect(){}beginPath(){}arc(){}fill(){}stroke(){}save(){}restore(){}scale(){}translate(){}rotate(){}fillText(){}strokeText(){}moveTo(){}lineTo(){}quadraticCurveTo(){}closePath(){}}
  class Offscreen{constructor(width,height){this.width=width;this.height=height;this.sprite=width>4;}getContext(){return new Context();}}
  Object.assign(w,{OffscreenCanvas:Offscreen,DecompressionStream:class{},Worker:class{postMessage(){}},requestAnimationFrame:callback=>{pending=callback;return 1;},cancelAnimationFrame:()=>{pending=null;}});
  Object.defineProperty(w.performance,'now',{configurable:true,value:()=>now});
  w.eval(readFileSync(file('atlas-view.js'),'utf8'));
  const canvas=w.document.getElementById('c');canvas.getContext=()=>new Context();canvas.getBoundingClientRect=()=>({left:0,top:0,width:1440,height:900});
  const view=w.RedlineAtlasView.create(canvas,{worker:'none'}),frame={x:0,y:0,w:1440,h:720},name=text=>({kind:'city',text,x:40,y:50,angle:0,curve:0});
  const painted=labels=>{alphas.length=0;view.update(frame,labels);return [...alphas];};
  const run=ms=>{now+=ms;const callback=pending;pending=null;alphas.length=0;callback?.(now);return [...alphas];};
  assert.deepEqual(painted([name('Paris')]),[0],'It arrives unseen');assert.ok(pending,'And a frame is asked for, with the camera at rest');
  assert.deepEqual(run(100),[.5]);assert.deepEqual(run(100),[1]);assert.equal(pending,null,'Once there, the map rests again');
  assert.deepEqual(painted([name('Paris'),name('Madrid')]),[1,0],'Only the newcomer fades');
  w.matchMedia=()=>({matches:true});pending=null;
  assert.deepEqual(painted([name('Rome')]),[1],'Without motion a new name is simply there');assert.equal(pending,null);
  dom.window.close();
});

test('a relief tile that fails to load is asked for again rather than remembered as missing',async()=>{
  const log=[];let online=false;
  const context=createContext({onmessage:null,importScripts(){},postMessage(){},Response,AbortSignal,createImageBitmap:async blob=>({blob,close(){}}),RedlineAtlasPainter:{reliefTiles:()=>[{key:'16-3-2'}]},
    fetch:async url=>{log.push(url);if(!online)throw Error('Offline');return {ok:true,blob:async()=>'pixels'};}});
  runInContext(readFileSync(file('atlas-worker.js'),'utf8'),context);runInContext('scene={relief:new Map(),reliefCoverage:[]};',context);
  const prepare=()=>runInContext('prepareRelief({})',context),held=()=>runInContext('scene.relief.size',context);
  await prepare();assert.equal(held(),0);
  await prepare();assert.deepEqual(log,['relief/16-3-2.webp','relief/16-3-2.webp'],'The next tile asks again');
  online=true;await prepare();assert.equal(held(),1,'And has it once the network is back');
  await prepare();assert.equal(log.length,3,'A tile in hand is not fetched twice');
});

test('every file the docs name exists, and the README describes the map as it is',()=>{
  for(const name of ['README.md','docs/ATLAS.md','docs/HOSTING.md']){
    const text=readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
    for(const [,path] of text.matchAll(/`((?:public|scripts|docs|test)\/[\w./-]+\.\w+)`/g))assert.ok(existsSync(new URL(`../${path}`,import.meta.url)),`${name}: ${path} is in the repository`);
    assert.doesNotMatch(text,/map-paint|atlas-paper|build-paper|atlas-tones|map-paper|overview\.webp|`server\//,`${name} does not describe the map before the atlas`);
  }
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
  for(const fact of [/2\.5×/,/Scroll, pinch/,/Shift \+ double-click zooms out/,/Redline Hand/,/\[IM Fell English\]\(/,/`public\/fonts\/OFL\.txt`/,/SIL Open Font License/,/Natural Earth.*rasters/,/window view/,/map-intro\.js/])assert.match(readme,fact);
  assert.doesNotMatch(readme,/single raster image|no map-tile requests|1\.8 seconds|book stays centered, with/,'What is no longer true has gone');
  assert.match(readFileSync(file('../docs/HOSTING.md'),'utf8'),/without close-up relief/,'Hosting notes what a trace misses while offline');
});

test('a slow relief tile does not hold up the map',async()=>{
  const log=[];
  const context=createContext({onmessage:null,importScripts(){},postMessage(){},Response,AbortSignal,createImageBitmap:async blob=>({blob,close(){}}),RedlineAtlasPainter:{reliefTiles:()=>[{key:'stalled'},{key:'quick'}]},
    fetch:(url,options)=>{log.push(url);if(url.includes('quick'))return Promise.resolve({ok:true,blob:async()=>'pixels'});return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason)));}});
  runInContext(readFileSync(file('atlas-worker.js'),'utf8'),context);runInContext('scene={relief:new Map(),reliefCoverage:[]};reliefQuery="?v=abc";',context);
  const began=Date.now();await runInContext('prepareRelief({})',context);
  assert.deepEqual(log,['relief/stalled.webp?v=abc','relief/quick.webp?v=abc'],'Asked for together, under the build’s key');
  assert.ok(Date.now()-began<4000,'Given up on within the time limit');assert.deepEqual([...runInContext('[...scene.relief.keys()]',context)],['quick']);
});

test('a sharpen that fails is asked for again, not forgotten',()=>{
  const sent=[],timers=[];let worker;
  class FakeWorker{constructor(){worker=this;}postMessage(message){sent.push(message);}}
  const context=createContext({window:{innerWidth:1440,devicePixelRatio:1,matchMedia:()=>({matches:false}),addEventListener(){},removeEventListener(){}},Worker:FakeWorker,OffscreenCanvas:class{getContext(){return new Proxy({},{get:()=>()=>({width:1})});}},DecompressionStream:class{},
    document:{fonts:{load:async()=>{}},createElement:()=>({getContext:()=>new Proxy({},{get:()=>()=>({width:1})})})},requestAnimationFrame:()=>1,cancelAnimationFrame(){},performance,ResizeObserver:class{observe(){}disconnect(){}},
    setTimeout:(run,delay)=>{timers.push({run,delay});return timers.length;},clearTimeout(){},console:{error(){},log(){}}});
  context.self=context.window;context.addEventListener=()=>{};
  runInContext(readFileSync(file('atlas-view.js'),'utf8'),context);
  const paint=new Proxy({},{get:(_,key)=>key==='canvas'?{}:()=>({width:1}),set:()=>true});
  const canvas={getContext:()=>paint,getBoundingClientRect:()=>({width:1440,height:900}),width:0,height:0,addEventListener(){}};
  const atlas=context.window.RedlineAtlasView.create(canvas,{worker:'w.js'},{});
  worker.onmessage({data:{type:'ready'}});
  const count=()=>sent.filter(message=>message.type==='sharpen').length;
  const drive=()=>{for(const timer of timers.filter(timer=>timer.delay<30000)){timers.splice(timers.indexOf(timer),1);timer.run();}};
  atlas.update({x:0,y:0,w:360,h:180},[]);drive();assert.equal(count(),1);
  worker.onmessage({data:{type:'sharpen-error',message:'Failed to fetch'}});
  atlas.update({x:0,y:0,w:300,h:150},[]);drive();assert.equal(count(),1,'Not at once');
  const later=timers.find(timer=>timer.delay===30000);assert.ok(later,'Half a minute later');later.run();
  atlas.update({x:0,y:0,w:280,h:140},[]);drive();assert.equal(count(),2);
});

test('relief eviction spares what the tile about to paint needs, however many that is',async()=>{
  const closed=[],keys=Array.from({length:12},(_,i)=>`k${i}`);
  const context=createContext({onmessage:null,importScripts(){},postMessage(){},Response,AbortSignal,createImageBitmap:async({name})=>({name,close(){closed.push(name);}}),RedlineAtlasPainter:{reliefTiles:()=>keys.map(key=>({key}))},
    fetch:async url=>({ok:true,blob:async()=>({name:url})})});
  runInContext(readFileSync(file('atlas-worker.js'),'utf8'),context);runInContext('scene={relief:new Map(),reliefCoverage:[]};',context);
  runInContext('for(const key of ["old1","old2"])scene.relief.set(key,{close(){closedOld.push(key);}});var closedOld=[];',context);
  await runInContext('prepareRelief({})',context);
  assert.deepEqual([...runInContext('closedOld',context)],['old1','old2'],'Older tiles go first');
  assert.equal(closed.length,0,'None of the twelve it needs');assert.equal(runInContext('scene.relief.size',context),12);
});

test('a region survives a resize, and a failed paint answers its caller',async()=>{
  const sent=[];let worker;
  class FakeWorker{constructor(){worker=this;}postMessage(message){sent.push(message);}}
  const context=createContext({window:{innerWidth:1440,devicePixelRatio:1,matchMedia:()=>({matches:false}),addEventListener(){},removeEventListener(){}},Worker:FakeWorker,OffscreenCanvas:class{getContext(){return new Proxy({},{get:()=>()=>({width:1})});}},DecompressionStream:class{},
    document:{fonts:{load:async()=>{}},createElement:()=>({getContext:()=>new Proxy({},{get:()=>()=>({width:1})})})},requestAnimationFrame:()=>1,cancelAnimationFrame(){},performance,ResizeObserver:class{observe(){}disconnect(){}},
    setTimeout:()=>1,clearTimeout(){},console:{error(){},log(){}}});
  context.self=context.window;context.addEventListener=()=>{};
  runInContext(readFileSync(file('atlas-view.js'),'utf8'),context);
  const paint=new Proxy({},{get:(_,key)=>key==='canvas'?{}:()=>({width:1}),set:()=>true});
  let width=1440;const canvas={getContext:()=>paint,getBoundingClientRect:()=>({width,height:900}),width:0,height:0,addEventListener(){}};
  const atlas=context.window.RedlineAtlasView.create(canvas,{worker:'w.js'},{});
  worker.onmessage({data:{type:'ready'}});
  // Answer the tiles ahead of a region until the region goes out.
  const region=()=>sent.findLast(message=>message.level===-2),drain=(until=()=>false)=>{for(let i=0;i<50&&!until();i++){const message=sent.find(message=>message.type==='tile'&&message.level!==-2&&!message.answered);if(!message)break;message.answered=true;worker.onmessage({data:{type:'tile',id:message.id,bitmap:{close(){}}}});}};
  drain();
  const first=atlas.paintRegion({x:0,y:0,w:100,h:100},64,64);drain(region);const firstId=region().id;
  width=1200;atlas.update({x:0,y:0,w:1440,h:720},[]);
  const bitmap={close(){}};worker.onmessage({data:{type:'tile',id:firstId,bitmap}});
  assert.equal(await first,bitmap,'The caller still gets its painting');
  drain();
  const second=atlas.paintRegion({x:0,y:0,w:100,h:100},64,64);drain(()=>region().id!==firstId);assert.notEqual(region().id,firstId);
  worker.onmessage({data:{type:'tile-error',id:region().id,message:'Boom'}});
  assert.equal(await second,null,'A failed region answers null');
});
