import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {createContext,runInContext,runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {encodeLayer} from '../scripts/atlas-codec.mjs';
import {dissolve} from '../scripts/atlas-geometry.mjs';
import {sheetHash,sheets} from '../scripts/atlas-sheet.mjs';

const file=name=>new URL(`../public/${name}`,import.meta.url);
function recorder(log=[]){
  const target={width:512,height:512,canvas:{width:512,height:512},createPattern:()=>({}),createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),getImageData:(x,y,w,h)=>{log.push('getImageData');return {data:new Uint8ClampedArray(w*h*4).fill(255)};}};
  return new Proxy(target,{get(object,key){if(key in object)return object[key];return (...args)=>{if(typeof key==='string'&&!/^(set|save|restore)/.test(key))log.push(key);return undefined;};},set(object,key,value){if(value==='destination-in')log.push('cut');object[key]=value;return true;}});
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

test('lake water is painted after terrain stamps so forests cannot cover inland water',()=>{
  const log=[],painter=loadPainter(log),scene=painter.createScene();
  painter.addLayers(scene,bundle(painter,'geo0.bin'));painter.addLayers(scene,bundle(painter,'geo1.bin'));
  painter.prepare(scene);log.length=0;
  painter.paintTile(recorder(log),scene,{sx:16,sy:16,x0:360*16,y0:176*16,w:514,h:514,dpr:1,level:4});
  assert.ok(log.includes('putImageData'),'The wooded Great Lakes region contains painted terrain');
  assert.ok(log.lastIndexOf('clip')>log.lastIndexOf('putImageData'),'The lake fill covers the finished terrain layer, including overhanging tree crowns');
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
  const context=createContext({Response,DecompressionStream,TextDecoder,console,onmessage:null,AbortSignal,Path2D:class{moveTo(){}lineTo(){}closePath(){}},OffscreenCanvas:class{getContext(){return recorder();}},
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
  assert.equal(fetched[0],assets.sheet,'The baked sheet is fetched first and alone');assert.equal(posted[0].type,'sheet');assert.ok(posted[0].bitmap,'and goes to the page before anything else is ready');
  assert.deepEqual(fetched.slice(1).sort(),[assets.near,assets.sea,assets.landSmall].sort(),'A first paint needs only these');
  assert.equal(posted.some(message=>message.type==='detail'),false);
  context.onmessage({data:{type:'sharpen'}});await posts('detail');
  assert.deepEqual(fetched.slice(4).sort(),[assets.far,assets.land].sort(),'The finest coasts and full plate follow on request');
  assert.equal(bitmaps.filter(bitmap=>bitmap.closed).length,1,'The small land plate is let go once the full one arrives');
});

test('in Safari the worker paints its tiles and scratch canvases in software',async()=>{
  const assets=atlasAssets();
  for(const software of [true,false]){
    const posted=[],asked=[];
    class Canvas{constructor(w,h){this.width=w;this.height=h;}getContext(_,options){asked.push(options);return recorder();}transferToImageBitmap(){return {close(){}};}}
    const context=createContext({Response,DecompressionStream,TextDecoder,console,onmessage:null,AbortSignal,Path2D:class{moveTo(){}lineTo(){}closePath(){}quadraticCurveTo(){}arc(){}},OffscreenCanvas:Canvas,postMessage:message=>posted.push(message),
      fetch:async url=>new Response(readFileSync(file(url))),createImageBitmap:async()=>({width:1440,height:720,close(){}}),importScripts:(...urls)=>{for(const url of urls)runInContext(readFileSync(file(url),'utf8'),context);}});
    context.self=context;runInContext(readFileSync(file('atlas-worker.js'),'utf8'),context);
    context.onmessage({data:{type:'start',...assets,sheet:undefined,software}});
    for(let i=0;i<400&&!posted.some(message=>message.type==='ready'||message.type==='error');i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(posted.at(-1).type,'ready');assert.equal(posted.some(message=>message.type==='sheet'),false,'No sheet asked for, none sent');
    asked.length=0;context.onmessage({data:{type:'tile',id:1,sx:4,sy:4,x0:2880,y0:600,w:514,h:514,dpr:1,level:2}});
    for(let i=0;i<400&&!posted.some(message=>message.type==='tile'||message.type==='tile-error');i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(posted.at(-1).type,'tile',JSON.stringify(posted.at(-1)));
    assert.equal(asked[0].alpha,false);assert.equal(!!asked[0].willReadFrequently,software,'The tile canvas');
    assert.equal(asked.filter(options=>options?.willReadFrequently).length>1,true,'Layers read and write pixels, so they are always in software');
    assert.equal(asked.slice(1).some(options=>options===undefined),!software,'Scratch canvases follow the tile canvas');
  }
});

test('a sheet that cannot be fetched is reported, not waited for',async()=>{
  const assets=atlasAssets(),posted=[];
  const context=createContext({Response,DecompressionStream,TextDecoder,console,onmessage:null,AbortSignal,Path2D:class{moveTo(){}lineTo(){}closePath(){}},OffscreenCanvas:class{getContext(){return recorder();}},postMessage:message=>posted.push(message),
    fetch:async url=>{if(url===assets.sheet)throw Error('Offline');return new Response(readFileSync(file(url)));},createImageBitmap:async()=>({close(){}}),importScripts:(...urls)=>{for(const url of urls)runInContext(readFileSync(file(url),'utf8'),context);}});
  context.self=context;runInContext(readFileSync(file('atlas-worker.js'),'utf8'),context);
  context.onmessage({data:{type:'start',...assets}});
  for(let i=0;i<400&&!posted.some(message=>message.type==='ready'||message.type==='error');i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(posted.map(message=>message.type),['sheet','ready']);assert.equal(posted[0].bitmap,null,'The page then asks for a painted one');
});

test('the first paint stays light, and everything the worker is told to fetch ships',()=>{
  const assets=atlasAssets();
  const size=key=>readFileSync(file(assets[key])).length;
  for(const key of ['worker','painter','reliefIndex','near','far','land','landSmall','sea'])assert.ok(size(key)>0,`${key} ships`);
  const first=['near','landSmall','sea'].reduce((sum,key)=>sum+size(key),0),all=first+size('far')+size('land');
  assert.ok(first<640*1024,`The sheet needs ${first} bytes before its first paint`);
  assert.ok(all<3.2*1024*1024,`The whole atlas is ${all} bytes`);
});

test('a name\'s outline lies a box a letter where it is drawn, and its footprint for choosing places follows it',async()=>{
  const dom=new JSDOM('<canvas id="c"></canvas>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
  class Context{constructor(){this.canvas={width:64,height:64};}measureText(text){return {width:text===' '?5:text.length*10,actualBoundingBoxAscent:text===' '?0:9,actualBoundingBoxDescent:0};}drawImage(){}fillRect(){}clearRect(){}strokeRect(){}beginPath(){}arc(){}fill(){}stroke(){}save(){}restore(){}scale(){}translate(){}rotate(){}fillText(){}strokeText(){}moveTo(){}lineTo(){}quadraticCurveTo(){}closePath(){}}
  class Offscreen{constructor(width,height){this.width=width;this.height=height;}getContext(){return new Context();}}
  Object.assign(w,{OffscreenCanvas:Offscreen,DecompressionStream:class{},Worker:class{postMessage(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){}});
  w.eval(readFileSync(file('atlas-view.js'),'utf8'));
  const canvas=w.document.getElementById('c');canvas.getContext=()=>new Context();canvas.getBoundingClientRect=()=>({left:0,top:0,width:1440,height:900});
  const view=w.RedlineAtlasView.create(canvas,{worker:'none'});view.update({x:0,y:0,w:1440,h:720},[]);
  const span=boxes=>({left:Math.min(...boxes.map(b=>b.x)),right:Math.max(...boxes.map(b=>b.x+b.w)),top:Math.min(...boxes.map(b=>b.y)),bottom:Math.max(...boxes.map(b=>b.y+b.h))});
  // A level name is centred on its point, one box in its footprint, and has no box for a space.
  const level=view.outline({kind:'country',text:'Ab Cd',x:500,y:300,angle:0,curve:0});
  assert.equal(level.length,4,'One a letter, none for the word space');
  const flat=span(level),print=view.footprint('country','Ab Cd');
  assert.ok(Math.abs((flat.left+flat.right)/2-500)<1,'Centred on its point');
  assert.equal(print.boxes.length,1);assert.ok(Math.abs(print.left+500-flat.left)<.01&&Math.abs(print.right+500-flat.right)<.01);
  // A slanted name's letters climb along it, and its footprint comes in pieces that leave its corners open.
  const slanted=view.outline({kind:'continent',text:'South America',x:400,y:400,angle:60,curve:0});
  assert.ok(slanted.at(-1).y>slanted[0].y+100,'Turned clockwise, it runs downhill');
  const tall=view.footprint('continent','South America',60);assert.ok(tall.boxes.length>3,`${tall.boxes.length} pieces`);
  const corner={x:tall.right-30,y:tall.top,w:30,h:30};
  assert.ok(!tall.boxes.some(b=>b.x<corner.x+corner.w&&b.x+b.w>corner.x&&b.y<corner.y+corner.h&&b.y+b.h>corner.y),'One big rectangle would have swallowed this corner');
  for(const box of slanted)assert.ok(tall.boxes.some(b=>b.x+400<=box.x+box.w&&b.x+b.w+400>=box.x&&b.y+400<=box.y+box.h&&b.y+b.h+400>=box.y),'Every letter is within a piece');
  // A curved one bends off the straight line between its ends.
  const curved=view.outline({kind:'ocean',text:'Pacific Ocean',x:400,y:400,angle:0,curve:.2}),middle=curved[Math.floor(curved.length/2)],ends=(curved[0].y+curved.at(-1).y)/2;
  assert.ok(Math.abs(middle.y-ends)>3,'The curve is measured');
  // A dotted name hangs from its dot, which is the first box.
  const [dot,...text]=view.outline({kind:'capital',text:'Paris',x:200,y:100,angle:0,curve:0});
  assert.ok(Math.abs(dot.x+dot.w/2-200)<.01&&Math.abs(dot.y+dot.h/2-100)<.01,'The dot is on the point');
  assert.ok(text[0].x>dot.x+dot.w-2,'The text runs to its right');
  const era=view.era;assert.equal(typeof era,'number');
});

test('a name fades up as it arrives, and one already lettered does not fade again',async()=>{
  const dom=new JSDOM('<canvas id="c"></canvas>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,alphas=[];let now=1000,pending=null;
  class Context{constructor(){this.globalAlpha=1;this.canvas={width:64,height:64};}measureText(text){return {width:text.length*6};}drawImage(image){if(image.sprite)alphas.push(this.globalAlpha);}fillRect(){}clearRect(){}strokeRect(){}beginPath(){}arc(){}fill(){}stroke(){}save(){}restore(){}scale(){}translate(){}rotate(){}fillText(){}strokeText(){}moveTo(){}lineTo(){}quadraticCurveTo(){}closePath(){}}
  class Offscreen{constructor(width,height){this.width=width;this.height=height;this.sprite=width>4;}getContext(){return new Context();}}
  Object.assign(w,{OffscreenCanvas:Offscreen,DecompressionStream:class{},Worker:class{postMessage(){}},requestAnimationFrame:callback=>{pending=callback;return 1;},cancelAnimationFrame:()=>{pending=null;}});
  Object.defineProperty(w.performance,'now',{configurable:true,value:()=>now});
  w.eval(readFileSync(file('atlas-view.js'),'utf8'));
  const canvas=w.document.getElementById('c');canvas.getContext=()=>new Context();canvas.getBoundingClientRect=()=>({left:0,top:0,width:1440,height:900});
  const view=w.RedlineAtlasView.create(canvas,{worker:'none'}),frame={x:0,y:0,w:1440,h:720},name=text=>({kind:'city',text,x:40,y:50,angle:0,curve:0});
  const painted=labels=>{alphas.length=0;view.update(frame,labels);return [...alphas];};
  const run=ms=>{now+=ms;const callback=pending;pending=null;alphas.length=0;callback?.(now);return [...alphas];};
  assert.deepEqual(painted([name('Paris')]),[0],'It arrives unseen');assert.ok(pending,'And a frame is asked for, with the camera at rest');
  assert.deepEqual(run(60),[.5]);assert.deepEqual(run(60),[1]);assert.equal(pending,null,'Once there, the map rests again');
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
  await prepare();assert.deepEqual(log,['relief/16-3-2.webp'],'Neighbors reuse the short failure cooldown');
  online=true;runInContext('reliefFailures.clear()',context);await prepare();assert.equal(held(),1,'And has it once the network is back');
  await prepare();assert.equal(log.length,2,'A tile in hand is not fetched twice');
});

test('every file the docs name exists, and the README describes the map as it is',()=>{
  for(const name of ['README.md','docs/ATLAS.md','docs/HOSTING.md']){
    const text=readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
    for(const [,path] of text.matchAll(/`((?:public|scripts|docs|test)\/[\w./-]+\.\w+)`/g))assert.ok(existsSync(new URL(`../${path}`,import.meta.url)),`${name}: ${path} is in the repository`);
    assert.doesNotMatch(text,/map-paint|atlas-paper|build-paper|atlas-tones|map-paper|overview\.webp|`server\//,`${name} does not describe the map before the atlas`);
  }
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
  for(const fact of [/2×/,/Scroll, pinch/,/Shift \+ double-click zooms out/,/Redline Hand/,/\[IM Fell English\]\(/,/`public\/fonts\/OFL\.txt`/,/SIL Open Font License/,/Natural Earth.*rasters/,/window view/,/map-intro\.js/])assert.match(readme,fact);
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

// A view with fake workers. Each message remembers its worker, because a tile must be answered by the worker that was given it.
function fakeView({native=false,innerWidth=1440,agent,cores,width=1440,height=900,dpr=1,assets={worker:'w.js',sheet:'sheet.webp',sheetSmall:'small.webp'}}={}){
  const sent=[],workers=[],timers=[],frames=[],clears=[],draws=[],offscreens=[],canvasEvents={},fontEvents={};let box={width,height},now=1000,stack=null;
  class FakeWorker{constructor(){workers.push(this);}postMessage(message){sent.push({...message,from:this});}}
  const paint=new Proxy({},{get:(_,key)=>key==='canvas'?{}:(...args)=>{if(key==='clearRect')clears.push(args);if(key==='drawImage')draws.push(args[0]);return {width:1};},set:()=>true});
  // Just enough DOM for the layers: who holds whom, and the style writes.
  const element=tag=>{
    const node={tag,className:'',children:[],parent:null,width:0,height:0,animations:[],writes:[],held:null,
      style:new Proxy({},{set(style,key,value){style[key]=value;node.writes.push(key);return true;}}),
      append(child){child.remove();child.parent=node;node.children.push(child);},
      prepend(child){child.remove();child.parent=node;node.children.unshift(child);},
      remove(){if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1);node.parent=null;},
      animate(frames,options){node.animations.push({frames,options});},
      listeners:{},addEventListener(type,listener){node.listeners[type]=listener;},
      getContext(kind,options){if(tag!=='canvas')return null;node.kind=kind;node.options=options;return {drawImage(bitmap){node.held=bitmap;}};}};
    if(tag==='img')for(const dimension of ['width','height']){
      let attribute=0;
      Object.defineProperty(node,dimension,{get:()=>parseFloat(node.style[dimension])||attribute,set:value=>{attribute=value;}});
    }
    return node;
  };
  const preview=native?Object.assign(element('img'),{complete:true,naturalWidth:1440,naturalHeight:800}):null;
  const context=createContext({Image:class{constructor(){return element('img');}},window:{innerWidth,devicePixelRatio:dpr,matchMedia:()=>({matches:false}),addEventListener(){},removeEventListener(){}},navigator:{userAgent:agent,hardwareConcurrency:cores},Worker:FakeWorker,OffscreenCanvas:class{constructor(){offscreens.push(this);}getContext(){return new Proxy({},{get:()=>()=>({width:1})});}},DecompressionStream:class{},
    document:{fonts:{load:async()=>{},addEventListener:(name,fn)=>{fontEvents[name]=fn;}},createElement:element,getElementById:()=>preview},requestAnimationFrame:callback=>{frames.push(callback);return frames.length;},cancelAnimationFrame(){frames.length=0;},performance:{now:()=>now},ResizeObserver:class{observe(){}disconnect(){}},
    setTimeout:(run,delay)=>{timers.push({run,delay});return timers.length;},clearTimeout(){},console:{error(){},log(){}}});
  context.self=context.window;context.addEventListener=()=>{};
  runInContext(readFileSync(file('atlas-view.js'),'utf8'),context);
  const canvas={getContext:()=>paint,getBoundingClientRect:()=>box,width:0,height:0,addEventListener(name,fn){canvasEvents[name]=fn;},before(node){stack=node;}};
  const atlas=context.window.RedlineAtlasView.create(canvas,assets,{});
  const bitmap=()=>({width:64,height:64,closed:false,close(){this.closed=true;}}),world={x:0,y:0,w:1440,h:720};
  const up=()=>{workers[0].onmessage({data:{type:'sheet',bitmap:bitmap()}});for(const worker of workers)worker.onmessage({data:{type:'ready'}});};
  const pendingTiles=()=>sent.filter(message=>message.type==='tile'&&!message.answered);
  const answer=message=>{message.answered=true;message.from.onmessage({data:{type:'tile',id:message.id,bitmap:bitmap()}});};
  const run=(ms=0)=>{now+=ms;for(const timer of timers.splice(0)){if(timer.delay<30000)timer.run();else timers.push(timer);}for(const callback of frames.splice(0))callback(now);};
  const levelOf=lvl=>stack.children.find(node=>node.className==='atlas-level'&&node.style.zIndex===lvl+1),sheet=()=>stack.children.find(node=>node.className==='atlas-sheet');
  const finish=()=>{for(let i=0;i<400&&pendingTiles().length;i++)answer(pendingTiles()[0]);};
  return {sent,workers,timers,frames,clears,draws,offscreens,canvasEvents,fontEvents,atlas,bitmap,world,up,pendingTiles,answer,finish,run,resize(next){box=next;},stack:()=>stack,levelOf,sheet,shownOf:lvl=>levelOf(lvl)?.children.length||0};
}

test('the art lies in layers behind the canvas: one per tile, moved together by one transform per level',()=>{
  const {atlas,up,pendingTiles,answer,run,stack,levelOf,sheet}=fakeView();up();
  assert.equal(stack().className,'atlas-layers','Placed before the canvas, which stays the pointer target');
  assert.equal(sheet().parent,stack());assert.equal(sheet().tag,'canvas');
  const zoomed={x:300,y:100,w:360,h:180};atlas.update(zoomed,[]);run(1000);
  const first=pendingTiles()[0],delivered={width:514,height:514,close(){this.closed=true;}};first.answered=true;first.from.onmessage({data:{type:'tile',id:first.id,bitmap:delivered}});run();
  const level=levelOf(2),[tile]=level.children;
  assert.equal(tile.tag,'canvas');assert.equal(tile.className,'atlas-tile');assert.equal(tile.kind,'2d','WebKit shows a 2D canvas’s surface as the layer itself');assert.equal(tile.options.alpha,false);
  assert.equal(tile.held,delivered);assert.equal(delivered.closed,true,'Its pixels now live in the canvas');assert.deepEqual([tile.width,tile.height],[514,514],'Device pixels, overlapping the next tile by the gutter');
  assert.match(tile.style.cssText,new RegExp(`^left:${first.x0}px;top:${first.y0}px;width:${first.w}px;height:${first.h}px;z-index:${first.y0/512*65536+first.x0/512}$`),'Its own place in the level, and the same order in a gutter whichever arrived first');
  assert.equal(level.style.transform,'matrix(1,0,0,1,-1200,-500)','Four times the world at this zoom, seen from 300,100');
  assert.equal(level.style.zIndex,3,'Above the coarser levels');
  const writes=()=>[level.writes.length,tile.writes.length];let [camera,own]=writes();
  atlas.update(zoomed,[]);assert.deepEqual(writes(),[camera,own],'Nothing moved, nothing written');
  atlas.update({...zoomed,x:301},[]);assert.deepEqual(writes(),[camera+1,own],'Moving is one style write, and the tile is not touched');
  assert.equal(level.style.transform,'matrix(1,0,0,1,-1204,-500)');
  atlas.update({x:300,y:100,w:300,h:150},[]);assert.match(level.style.transform,/^matrix\(1\.2,0,0,1\.2,/,'Zooming scales the level');
});

test('layer pixels are device pixels at any scale, so a tile is never held enlarged',()=>{
  const {atlas,up,pendingTiles,answer,run,levelOf,sheet}=fakeView({dpr:2});up();
  atlas.update({x:300,y:100,w:360,h:180},[]);run(1000);const asked=pendingTiles()[0];answer(asked);run();
  assert.deepEqual([asked.x0%512,asked.w,asked.h,asked.dpr],[0,514,514,2]);
  assert.match(levelOf(2).children[0].style.cssText,new RegExp(`^left:${asked.x0/2}px;top:${asked.y0/2}px;width:257px;height:257px;`),'A 514 pixel tile is 257 CSS pixels at twice the density');
  assert.equal(levelOf(2).style.transform,'matrix(1,0,0,1,-1200,-500)','One to one with the screen, and the camera in CSS pixels');
  assert.equal(sheet().style.width,'32px','The sheet likewise, whatever its own size');
});

test('only tiles the view can see stay attached, and one seen again needs no painting',()=>{
  const {atlas,sent,up,finish,run,levelOf}=fakeView();up();
  const here={x:300,y:100,w:360,h:180},away={x:1000,y:500,w:360,h:180},painted=()=>sent.filter(message=>message.type==='tile').length;
  atlas.update(here,[]);run(1000);finish();run(0);run(1000);
  const attached=[...levelOf(2).children];assert.equal(attached.length,12);assert.ok(attached.every(tile=>tile.parent===levelOf(2)));
  atlas.update(away,[]);assert.ok(levelOf(2).children.every(tile=>!attached.includes(tile)),'Out of view is out of the document');assert.ok(attached.every(tile=>tile.parent===null));
  assert.ok(attached.every(tile=>tile.width>0),'But kept');
  run(1000);finish();run(1000);
  const before=painted();atlas.update(here,[]);run(1000);
  assert.ok(attached.every(tile=>tile.parent===levelOf(2)),'Back at once');assert.equal(painted(),before,'Without asking a worker');
  assert.equal(attached.reduce((sum,tile)=>sum+tile.animations.length,0),attached.length,'And without fading up a second time');
});

test('zooming past regional detail reuses the same artwork and prefetch never exceeds it',()=>{
  const {atlas,sent,up,finish,run}=fakeView();up();
  const frame=zoom=>({x:360-720/zoom,y:220-360/zoom,w:1440/zoom,h:720/zoom});
  atlas.update(frame(16),[]);run(1000);finish();run(1000);
  const painted=sent.filter(message=>message.type==='tile').length;
  for(const zoom of [32,64,128]){atlas.update(frame(zoom),[]);run(1000);finish();run(1000);}
  assert.equal(sent.filter(message=>message.type==='tile').length,painted,'Deeper zooms do not repaint the same region');
  atlas.prefetch({x:900,y:200,w:1440/128,h:720/128});finish();
  assert.ok(sent.filter(message=>message.type==='tile').every(message=>message.level<=4),'Even destination prefetch stays at the detail ceiling');
});

test('a prefetched tile waits out of the document, and is simply there when the camera arrives',()=>{
  const {atlas,sent,up,finish,run,levelOf,shownOf}=fakeView();up();
  atlas.update({x:300,y:100,w:360,h:180},[]);run(1000);finish();run(1000);
  const coming={x:1000,y:500,w:360,h:180},painted=()=>sent.filter(message=>message.type==='tile').length;
  atlas.prefetch(coming);finish();run(1000);assert.equal(shownOf(2),12,'Still only what the view can see');
  const count=painted();atlas.update(coming,[]);
  assert.ok(shownOf(2)>0);assert.equal(painted(),count,'Nothing left to paint');
  assert.ok(levelOf(2).children.every(tile=>tile.animations.length===0),'And no fade for what has long been ready');
});

test('coarser tiles and the sheet lie underneath only until the view is covered and settled',()=>{
  const {atlas,workers,up,pendingTiles,answer,finish,run,levelOf,sheet,shownOf}=fakeView();up();
  for(const worker of workers)worker.onmessage({data:{type:'detail'}});
  const wide={x:0,y:0,w:720,h:360},near={x:100,y:50,w:360,h:180},far={x:1000,y:500,w:360,h:180},hidden=()=>sheet().style.opacity===0;
  atlas.update(wide,[]);run(1000);assert.equal(hidden(),false,'Nothing else covers it yet');assert.match(sheet().style.transform,/^matrix\(/,'And it follows the camera');
  finish();assert.equal(hidden(),false,'While the last tiles fade up the sheet stays');
  run(1000);assert.equal(hidden(),true,'Then it leaves the compositor, keeping its pixels: visibility would make WebKit paint it again');
  const writes=sheet().writes.length;atlas.update({...wide,x:1},[]);assert.equal(sheet().writes.length,writes,'Hidden, it is not moved either');
  atlas.update(wide,[]);run(1000);
  atlas.update(near,[]);run(0);assert.ok(shownOf(1)>0,'The coarser level stands in');assert.equal(hidden(),true,'And covers the view, so the sheet need not come back');
  run(200);answer(pendingTiles()[0]);run(0);assert.ok(shownOf(2)>0&&shownOf(1)>0,'One sharp tile does not retire the stand-ins');
  finish();run(0);assert.ok(shownOf(1)>0,'Nor do all of them until they have faded up');
  run(1000);assert.equal(shownOf(1),0,'Then nothing is drawn twice');assert.equal(hidden(),true);
  atlas.update(far,[]);run(200);assert.equal(hidden(),false,'Where no stand-in reaches, the sheet returns');
  finish();run(1000);assert.equal(hidden(),true);
  atlas.update(wide,[]);run(0);assert.equal(shownOf(2),0,'A finer level is not shown under a coarser target');assert.ok(shownOf(1)>0);
});

test('a new tile fades up on the compositor, and a repaint swaps in place without a fade',()=>{
  const {atlas,workers,up,pendingTiles,answer,finish,run,levelOf}=fakeView();up();
  atlas.update({x:300,y:100,w:360,h:180},[]);run(1000);answer(pendingTiles()[0]);run(0);
  const [tile]=levelOf(2).children,[fade]=tile.animations,painting=tile.held;
  assert.deepEqual([...fade.frames.opacity],[0,1]);assert.equal(fade.options.duration,120);
  finish();run(1000);
  for(const worker of workers)worker.onmessage({data:{type:'detail'}});run(1000);assert.ok(pendingTiles().length>0,'The sharp plate asks for them again');finish();run(0);
  assert.ok(levelOf(2).children.includes(tile),'The same layer');assert.notEqual(tile.held,painting);assert.equal(tile.held.closed,true);assert.equal(tile.animations.length,1,'With no second fade');
});

test('a full cache never drops what the view is waiting for, however many that is',()=>{
  const {atlas,sent,workers,up,finish,run,levelOf,shownOf}=fakeView({width:3360,height:1728,innerWidth:1680});up();
  for(const worker of workers)worker.onmessage({data:{type:'detail'}});
  atlas.update({x:0,y:0,w:1321,h:660},[]);run(1000);finish();run(1000);
  const first=[...levelOf(1).children];assert.ok(first.length>=78,`${first.length} tiles, a window's worth at the steepest minification`);
  atlas.update({x:0,y:0,w:660,h:330},[]);run(1000);finish();
  const painted=()=>sent.filter(message=>message.type==='tile').length,count=painted();
  for(let i=0;i<8;i++){run(100);finish();}
  assert.equal(painted(),count,'Nothing is painted again and again');
  assert.ok(shownOf(2)>=78,'The level is whole');run(1000);assert.equal(shownOf(1),0,'And has retired its stand-ins');
  const gone=first.filter(tile=>tile.width===0);assert.ok(gone.length>0,'The coarser ones made room');assert.ok(gone.every(tile=>tile.parent===null),'Eviction removes the layer too');
  assert.ok(levelOf(2).children.every(tile=>tile.width>0),'And the sharp ones are all still there');
});

test('with the album over the map only what shows through its backdrop stays',()=>{
  const {atlas,sent,up,finish,run,levelOf}=fakeView();up();
  const here={x:300,y:100,w:360,h:180},away={x:1000,y:500,w:360,h:180};
  atlas.update(away,[]);run(1000);finish();run(1000);const elsewhere=[...levelOf(2).children];
  atlas.update(here,[]);run(1000);finish();run(1000);const showing=[...levelOf(2).children];
  atlas.release();
  assert.ok(elsewhere.every(tile=>tile.width===0&&tile.parent===null),'Tiles out of view are freed');
  assert.ok(showing.every(tile=>tile.parent===levelOf(2)&&tile.width>0),'The picture under the book stays sharp');
  const painted=sent.filter(message=>message.type==='tile').length;atlas.update(here,[]);run(1000);
  assert.equal(sent.filter(message=>message.type==='tile').length,painted,'And closing the album paints nothing');
});

test('a resize removes every tile layer, the sheet stretches, and tiles come back to the new size',()=>{
  const {atlas,up,finish,run,resize,levelOf,sheet}=fakeView();up();
  const here={x:300,y:100,w:360,h:180};atlas.update(here,[]);run(1000);finish();run(1000);
  const old=[...levelOf(2).children];assert.equal(sheet().style.opacity,0);
  resize({width:1200,height:900});atlas.update(here,[]);
  assert.equal(levelOf(2).children.length,0);assert.ok(old.every(tile=>tile.parent===null&&tile.width===0));
  assert.equal(sheet().style.opacity,1,'The sheet stands in');assert.equal(sheet().parent.className,'atlas-layers');assert.equal(sheet().style.width,'64px','Its own pixels, at the screen’s scale');
  assert.match(sheet().style.transform,/^matrix\(/);
  assert.equal(atlas.snapshot(),sheet(),'And is still there for whoever asks');
  run(1000);finish();run(1000);assert.equal(levelOf(2).children.length,12);assert.equal(sheet().style.opacity,0);
  assert.equal(levelOf(2).style.transform,'matrix(1,0,0,1,-1000,-500)','Its span narrowed with the window, so the same zoom still lands exactly');
});

test('a canvas the browser takes back is painted again',()=>{
  const {atlas,up,finish,run,levelOf,pendingTiles}=fakeView();up();
  atlas.update({x:300,y:100,w:360,h:180},[]);run(1000);finish();run(1000);
  const [tile]=levelOf(2).children;tile.listeners.contextlost();
  assert.equal(tile.parent,null);assert.equal(tile.width,0);run(1000);
  assert.equal(pendingTiles().length,1,'Its place is asked for again');finish();run(1000);assert.equal(levelOf(2).children.length,12);
});

test('names are measured without being painted, a few new ones letter per frame, and an unchanged scene leaves the canvas alone',()=>{
  const {atlas,up,offscreens,clears,draws,finish,run,world,frames}=fakeView();up();
  offscreens.length=0;
  for(let i=0;i<200;i++)assert.ok(atlas.measure('city',`Town ${i}`).w>0);
  assert.ok(offscreens.length<=1,`${offscreens.length} canvases made to measure 200 names, where painting each cost Safari a tenth of a second at a zoom where many come into reach`);
  const names=Array.from({length:10},(_,i)=>({kind:'city',text:`Town ${i}`,x:40+i*50,y:50,angle:0,curve:0})),painted=()=>{const count=draws.length;draws.length=0;return count;};
  atlas.update(world,names);assert.equal(painted(),4,'Four new names in a frame');
  run(16);assert.equal(painted(),8,'Four more, alongside those already lettered');
  run(16);assert.equal(painted(),10);
  for(let i=0;i<20;i++)run(16);assert.equal(frames.length,0,'And once all have faded up the map rests');
  clears.length=0;draws.length=0;
  atlas.update(world,names.map(name=>({...name})));assert.equal(clears.length,0,'The same names in the same place need no painting');assert.equal(draws.length,0);
  finish();run(1000);assert.equal(clears.length,0,'Nor does a tile arriving');
  atlas.update(world,names.map(name=>({...name,x:name.x+1})));assert.deepEqual(clears,[[0,0,1440,900]],'A moved name clears and letters the canvas');assert.equal(draws.length,10);
});

test('the baked sheet is the first picture, and nothing is painted before it is up',async()=>{
  const {atlas,sent,workers,bitmap,world,pendingTiles,run}=fakeView();
  assert.equal(workers.length,1,'One worker fetches the sheet');assert.equal(sent[0].sheet,'sheet.webp');
  let resolved=false;atlas.ready.then(()=>{resolved=true;});
  atlas.update(world,[]);run();await new Promise(setImmediate);
  assert.equal(resolved,false);assert.equal(pendingTiles().length,0,'No tile is asked for before the first picture');
  const sheet=bitmap();workers[0].onmessage({data:{type:'sheet',bitmap:sheet}});
  assert.equal(await atlas.ready,true,'Ready means decoded, not painted');assert.equal(atlas.snapshot().held,sheet,'The opening fold unfolds the same sheet');
  assert.equal(workers.length,2,'The other workers join once it is up');assert.equal(sent.slice(1).filter(message=>message.type==='start'&&message.sheet).length,0,'Only one of them is given the sheet');
  for(const worker of workers)worker.onmessage({data:{type:'ready'}});
  atlas.update(world,[]);run(1000);atlas.update(world,[]);run(1000);
  assert.equal(sent.some(message=>message.level===-1),false,'The world is never painted whole at run time');
});

test('without the sheet the map paints one, and only then is ready',async()=>{
  for(const fail of [view=>view.workers[0].onmessage({data:{type:'sheet',bitmap:null}}),()=>{}]){
    const view=fail.length&&fakeView()||fakeView({assets:{worker:'w.js'}}),{atlas,workers,sent,pendingTiles,answer,bitmap}=view;fail(view);
    let resolved=false;atlas.ready.then(()=>{resolved=true;});
    workers[0].onmessage({data:{type:'ready'}});await new Promise(setImmediate);
    assert.equal(resolved,false);const whole=pendingTiles();assert.equal(whole.length,1);assert.equal(whole[0].level,-1);assert.equal(sent.filter(message=>message.level===-1).length,1);
    answer(whole[0]);assert.equal(await atlas.ready,true);assert.ok(atlas.snapshot());assert.equal(workers.length,2,'The map carries on as usual');
  }
});

test('Safari and iOS paint in software, and every other engine keeps the GPU',()=>{
  const safari='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',iphone='Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1';
  const chrome='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',edge=`${chrome} Edg/142.0.0.0`,firefox='Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0',android='Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
  for(const [agent,software] of [[safari,true],[iphone,true],[chrome,false],[edge,false],[firefox,false],[android,false]])assert.equal(fakeView({agent}).sent[0].software,software,agent);
});

test('the crew and the sheet suit the screen',()=>{
  const counted=options=>{const view=fakeView(options);view.up();return {workers:view.workers.length,sheet:view.sent[0].sheet};};
  assert.deepEqual(counted({innerWidth:1440,cores:8}),{workers:2,sheet:'sheet.webp'});
  assert.deepEqual(counted({innerWidth:390,cores:6}),{workers:2,sheet:'small.webp'});
  assert.deepEqual(counted({innerWidth:1440,cores:2}),{workers:1,sheet:'sheet.webp'},'One core is left for the page');
});

test('each tile goes to a free worker, regions first, and a change of camera drops what still waits',async()=>{
  const {atlas,workers,sent,up,pendingTiles,answer,run}=fakeView();up();
  const zoomed={x:300,y:100,w:360,h:180},rest=()=>{atlas.update(zoomed,[]);run(1000);};
  for(const worker of workers)worker.onmessage({data:{type:'detail'}});
  rest();
  let out=pendingTiles();assert.equal(out.length,2,'One each');assert.equal(new Set(out.map(message=>message.from)).size,2);assert.ok(out.every(message=>message.level===2));
  let region=null;atlas.paintRegion({x:0,y:0,w:100,h:100},64,64).then(value=>{region=value;});
  assert.equal(pendingTiles().length,2,'All are busy, so it waits');
  answer(out[0]);out=pendingTiles();assert.equal(out.at(-1).level,-2,'The next free worker takes the region ahead of every tile');
  // A new camera forgets the old tile queue: only tiles of the new view go out from here.
  const far={x:1000,y:500,w:180,h:90},before=sent.length;atlas.update(far,[]);run(200);for(let i=0;i<40&&pendingTiles().length;i++)answer(pendingTiles()[0]);
  const later=sent.slice(before).filter(message=>message.type==='tile');assert.ok(later.length>0&&later.every(message=>message.level===3),'Nothing from the old view is painted');
  await new Promise(setImmediate);assert.ok(region,'The region was answered');
});

test('the baked world view never repaints tiles or loads detailed terrain, even at rest',()=>{
  const {atlas,sent,world,up,pendingTiles,run}=fakeView();up();
  for(let i=0;i<6;i++){atlas.update({...world,x:i%2},[]);run(1000);}
  assert.equal(pendingTiles().length,0);
  assert.equal(sent.filter(message=>message.type==='sharpen').length,0);
});

test('a sharpen that fails is asked for again, not forgotten',()=>{
  const {atlas,sent,workers,timers,up,run}=fakeView({innerWidth:600,width:600,height:900});up();assert.equal(workers.length,2);
  const count=()=>sent.filter(message=>message.type==='sharpen').length;
  atlas.update({x:0,y:0,w:1440,h:720},[]);run(1000);assert.equal(count(),0,'A small screen waits until it zooms in');
  atlas.update({x:0,y:0,w:360,h:180},[]);run(200);assert.equal(count(),2);
  workers[0].onmessage({data:{type:'detail'}});workers[1].onmessage({data:{type:'sharpen-error',message:'Failed to fetch'}});
  atlas.update({x:0,y:0,w:300,h:150},[]);run();assert.equal(count(),2,'Not at once');
  const later=timers.find(timer=>timer.delay===30000);assert.ok(later,'Half a minute later');later.run();
  atlas.update({x:0,y:0,w:280,h:140},[]);run(200);assert.equal(count(),3,'Only the worker that failed asks again');
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
  const {atlas,sent,up,pendingTiles,answer,bitmap,resize,run}=fakeView();up();
  const region=()=>sent.findLast(message=>message.level===-2);
  const first=atlas.paintRegion({x:0,y:0,w:100,h:100},64,64),firstMessage=region();
  resize({width:1200,height:900});atlas.update({x:0,y:0,w:1440,h:720},[]);
  const painting=bitmap();firstMessage.answered=true;firstMessage.from.onmessage({data:{type:'tile',id:firstMessage.id,bitmap:painting}});
  assert.equal(await first,painting,'The caller still gets its painting');
  for(let i=0;i<40&&pendingTiles().length;i++)answer(pendingTiles()[0]);
  const second=atlas.paintRegion({x:0,y:0,w:100,h:100},64,64),secondMessage=region();assert.notEqual(secondMessage.id,firstMessage.id);
  secondMessage.answered=true;secondMessage.from.onmessage({data:{type:'tile-error',id:secondMessage.id,message:'Boom'}});
  assert.equal(await second,null,'A failed region answers null');
});

test('the baked sheet was painted from this painter, geometry and plates, and stays small',()=>{
  const stamp=JSON.parse(readFileSync(new URL('../scripts/atlas-sheet.json',import.meta.url),'utf8')),assets=atlasAssets();
  assert.equal(stamp.hash,sheetHash(),'The baked sheet is stale: rebake it with `node scripts/build-atlas-sheet.mjs`, which paints it with the current painter in one headless Chrome');
  assert.deepEqual([assets.sheet,assets.sheetSmall],sheets.map(({name})=>`atlas/${name}`),'The page names what is baked');
  for(const {name,width,height,limit} of sheets){
    const bytes=readFileSync(file(`atlas/${name}`));
    // Chrome writes the extended form, for the colour profile: the canvas size is stored less one, in three bytes each.
    assert.equal(bytes.toString('latin1',8,16),'WEBPVP8X','A WebP');assert.equal(bytes[20]&16,0,'With no alpha');assert.equal(bytes.readUIntLE(24,3)+1,width);assert.equal(bytes.readUIntLE(27,3)+1,height);
    assert.ok(bytes.length<=limit,`${name} is ${bytes.length} bytes`);assert.ok(Math.abs(width/height-1.8)<.05);
  }
});

test('marks are drawn once, then copied by hand from a bounded cache',()=>{
  const log=[],painter=loadPainter(log),scene=painter.createScene();painter.addLayers(scene,bundle(painter,'geo0.bin'));painter.prepare(scene);
  const tile={sx:8,sy:8,x0:6000,y0:1200,w:514,h:514,dpr:2,level:2},count=name=>log.filter(entry=>entry===name).length;
  painter.paintTile(recorder(log),scene,tile);
  const made=scene.stamps.size;assert.ok(made>10,'Over the Alps');assert.ok(count('getImageData')<=3,'All read back together, not one at a time');
  // The stand-in canvas reads back solid white, so whatever was copied shows.
  assert.ok(scene.terrainLayer.pixels.some(value=>value>>>24===255),'The copies reach the layer');
  log.length=0;painter.paintTile(recorder(log),scene,tile);assert.equal(scene.stamps.size,made,'A second paint makes none');assert.equal(count('getImageData'),0);
  assert.ok(scene.stampBytes<8*1024*1024);
  // Under pressure the oldest go, so a long flight cannot grow without limit.
  for(let i=0;i<60;i++)painter.paintTile(recorder(log),scene,{...tile,dpr:1+i/8,sx:8+i,sy:8+i,x0:6000+i*320});
  assert.ok(scene.stampBytes<=33*1024*1024,`${scene.stampBytes} bytes held`);
});

test('land and everything on it is cut at the coast once, and not at all where no coast comes near',()=>{
  const paint=tile=>{const log=[],painter=loadPainter(log),scene=painter.createScene();painter.addLayers(scene,{...bundle(painter,'geo0.bin'),lakes0:[]});painter.paintTile(recorder(log),scene,{w:514,h:514,dpr:1,level:3,sx:8,sy:8,...tile});return log;};
  const inland=paint({x0:6200,y0:2240}),coastal=paint({x0:6000,y0:1200}),cuts=log=>log.filter(entry=>entry==='cut').length;
  for(const log of [inland,coastal])assert.equal(log.includes('clip'),false,'No clip: Safari cuts again for every mark under one');
  assert.equal(cuts(coastal),1);assert.equal(cuts(inland),0);
});

test('waterlines lie at their distance from the coast, and meet across tiles',()=>{
  const painter=loadPainter(),scene=painter.createScene();
  // A square island in a sheet of its own: x and y run 100 to 200, at two device pixels a unit.
  const square=[[100,100],[200,100],[200,200],[100,200]],xy=new Float32Array(square.flat());
  painter.addLayers(scene,{land0:[{rank:0,n:4,xy,left:100,top:100,right:200,bottom:200}]});
  const alphaAt=(x,y)=>scene.shoreSea.pixels[y*scene.shoreSea.canvas.width+x]>>>24,tile=x0=>({sx:2,sy:2,x0,y0:0,w:514,h:514,dpr:1,level:1}),paint=x0=>painter.paintTile(recorder(),scene,tile(x0));
  paint(0);
  // The coast's east side is at x=400. At 2× the offsets are 1.9, 3.9 and 6.3 device pixels.
  const row=300,line=[];for(let x=400;x<412;x++)line.push(alphaAt(x,row));
  const peaks=line.map((value,i)=>value>(line[i-1]||0)&&value>=(line[i+1]||0)?i:-1).filter(i=>i>=0);
  for(const offset of [1.9,3.9,6.3])assert.ok(peaks.some(i=>Math.abs(i+.5-offset)<=1),`A line near ${offset} pixels out: ${line}`);
  assert.equal(alphaAt(420,row),0,'Nothing further out');assert.equal(alphaAt(350,row),0,'And nothing deep inland');
  assert.ok(scene.shoreLand.pixels[row*514+398]>>>24>0,'Pigment gathers just inside the coast');assert.equal(scene.shoreLand.pixels[row*514+350]>>>24,0,'But not far in');
  // The west side of a neighbouring tile sees the same lines where the two overlap.
  const before=[];for(let y=180;y<420;y++)before.push(alphaAt(512,y),alphaAt(513,y));
  paint(512);const after=[];for(let y=180;y<420;y++)after.push(alphaAt(0,y),alphaAt(1,y));
  assert.deepEqual(after,before,'Shared pixels agree exactly');
});

test('coasts lose only what the scale cannot show, and neighbouring tiles keep the same vertices',()=>{
  const points=[];class Path{moveTo(x,y){points.push([x,y]);}lineTo(x,y){points.push([x,y]);}closePath(){}quadraticCurveTo(){}arc(){}}
  class Offscreen{constructor(w,h){this.width=w;this.height=h;}getContext(){return recorder();}transferToImageBitmap(){return {close(){}};}}
  const context={Path2D:Path,OffscreenCanvas:Offscreen,TextDecoder,Float32Array,Uint8Array,DataView,JSON,Math,Object};context.globalThis=context;runInNewContext(readFileSync(file('atlas-painter.js'),'utf8'),context);
  const painter=context.RedlineAtlasPainter,layers=bundle(painter,'geo1.bin'),scene=painter.createScene();painter.addLayers(scene,layers);
  const tile=x0=>({sx:2,sy:2,x0,y0:0,w:514,h:514,dpr:2,level:0}),raw=layers.land1.reduce((sum,f)=>sum+f.n,0);
  const paint=x0=>{points.length=0;painter.paintTile(recorder(),scene,tile(x0));return points.map(([x,y])=>`${(x+x0).toFixed(3)},${y.toFixed(3)}`);};
  // At 1× the finest coasts would crowd many vertices into each device pixel.
  scene.layers.land0=layers.land1;
  const left=new Set(paint(512)),right=new Set(paint(1024));
  assert.ok(left.size<raw/3,`${left.size} of ${raw} vertices`);
  const shared=[...left].filter(point=>{const [x,y]=point.split(',').map(Number);return x>1030&&x<1036&&y>0&&y<512;}),missing=shared.filter(point=>!right.has(point));
  assert.ok(shared.length>4,'The tiles share a stretch of coast');assert.deepEqual(missing,[],'Where they overlap they kept the same vertices, so the ink meets');
});

test('snow lies where the cold is',()=>{
  const painter=loadPainter(),{terrain}=bundle(painter,'geo0.bin');
  const cover=(lon,lat)=>painter.snowCover(terrain,(lon+180)*4,(90-lat)*4,{}),cold=(lon,lat)=>{const x=(lon+180)*4,y=(90-lat)*4;return painter.coldness(x,y,painter.terrainAt(terrain,x,y,{}).rugged);};
  assert.equal(cover(-40,75),1,'Greenland is white');assert.equal(painter.snowCover(terrain,720,700,{}),1,'And Antarctica, along the whole foot of the sheet');
  for(const [lon,lat,name] of [[5,23,'The Sahara'],[-62,-3,'The Amazon'],[20,0,'The Congo'],[135,-25,'Australia'],[2,47,'France']])assert.equal(cover(lon,lat),0,`${name} is bare`);
  assert.ok(cover(-85,75)>.5,'The high Arctic is dusted');assert.ok(cover(100,74)>.5,'And northern Siberia');
  // Stable, and no straight southern edge: along one parallel some ground is snowy and some is not.
  const line=[];for(let lon=-120;lon<140;lon+=2)line.push(cover(lon,64));assert.deepEqual(line,line.map((_,i)=>cover(-120+i*2,64)));
  assert.ok(line.filter(value=>value>.3).length>6&&line.filter(value=>value>0&&value<.1||value===0).length>6,'The edge wanders');
  for(const [lon,lat,name] of [[86,28,'The Himalaya'],[76,35.5,'The Karakoram'],[80,42,'The Tien Shan'],[10,46.5,'The Alps'],[44,43,'The Caucasus'],[-110,44,'The Rockies'],[-146,62,'Alaska'],[-73,-48,'Patagonia'],[-69,-20,'The high Andes']])assert.ok(cold(lon,lat)>=.8,`${name} hold snow (${cold(lon,lat).toFixed(2)})`);
  for(const [lon,lat,name] of [[-3,32,'The Atlas foothills'],[38,10,'The Ethiopian edge'],[110,-1,'Borneo'],[105,-3,'Sumatra']])assert.ok(cold(lon,lat)<.72,`${name} mostly do not (${cold(lon,lat).toFixed(2)})`);
});

test('the map runs to the window edge, with no frame',()=>{
  const view=readFileSync(file('atlas-view.js'),'utf8'),app=readFileSync(file('app.js'),'utf8');
  assert.doesNotMatch(view,/paintBorder|inset|strokeRect/,'The view draws no border');assert.doesNotMatch(app,/inset:/,'And nothing asks for one');
  const css=readFileSync(file('style.css'),'utf8');assert.match(css,/\.map-shell \{ position: absolute; inset: 0;/);
  assert.doesNotMatch(css,/body::after/,'The soft inset vignette read as a border');
  // The layers lie behind the canvas, and every layer must be in its own right or WebKit paints them into one.
  assert.match(css,/\.atlas-layers \{ position: absolute; inset: 0; z-index: 0; overflow: hidden;[^}]*pointer-events: none;/);
  assert.match(css,/#map \{ position: relative;/,'The canvas stays above them, and the pointer’s target');
  assert.match(css,/\.atlas-sheet, \.atlas-level \{[^}]*transform-origin: 0 0; will-change: transform;/);assert.match(css,/\.atlas-tile \{[^}]*will-change: transform;/);
  // The opening fold covers the layers just as it covers the canvas.
  assert.match(css,/\.map-arriving :is\(\.atlas-layers, #map, #place-labels, \.route-dock, \.zoom-controls\) \{ opacity: 0; \}/);
  assert.match(css,/\.map-arriving\.map-revealing :is\(\.atlas-layers, #map, #place-labels\) \{ opacity: 1; \}/);
  assert.match(css,/@media \(prefers-reduced-motion: reduce\) \{[^}]*\}\s*\.map-arriving :is\(\.atlas-layers, #map/);
  assert.match(css,/\.map-unfold \{ position: absolute; z-index: 4;/);
});


test('the HTML preview shows the map before any worker exists, and zoom starts detail on demand',async()=>{
  const {atlas,workers,sent,world,run,sheet}=fakeView({native:true});
  assert.equal(await atlas.ready,true);assert.equal(sheet().tag,'img');
  atlas.update(world,[]);run(1000);assert.equal(workers.length,0,'No procedural painting or terrain downloads at world view');
  assert.equal(sent.length,0);assert.equal(sheet().width,1440);assert.equal(sheet().height,800);
  atlas.update({x:300,y:100,w:360,h:180},[]);run(200);
  assert.equal(workers.length,2,'Detail starts only when zoomed in');
  assert.ok(sent.filter(message=>message.type==='start').every(message=>!message.sheet),'Workers do not download another copy of the visible map');
});

test('native image sheets align with the world on Retina screens and after resizing',()=>{
  const {atlas,world,run,sheet,resize}=fakeView({native:true,dpr:2,width:1280,height:720});
  const assertBounds=(expectedWidth,expectedHeight)=>{
    const node=sheet(),matrix=node.style.transform.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number);
    assert.ok(Math.abs(node.width*matrix[0]-expectedWidth)<.001,'The artwork spans exactly the map width');
    assert.ok(Math.abs(node.height*matrix[3]-expectedHeight)<.001,'The artwork spans exactly the map height');
  };
  atlas.update(world,[]);run(1000);assertBounds(1280,720);
  resize({width:1000,height:600});atlas.update(world,[]);run(1000);assertBounds(1000,600);
  assert.equal(sheet().style.width,'720px','Repeated fitting never shrinks the source again');
});

test('stacked great names retain accurate collision bounds without slanting across coasts',()=>{
  const {atlas}=fakeView();
  const flat=atlas.measure('continent','South America'),stacked=atlas.measure('continent','South\nAmerica');
  assert.ok(stacked.w<flat.w*.65);assert.ok(stacked.h>flat.h*1.7);
  for(const text of ['South\nAmerica','Atlantic\nOcean']){
    const kind=text.startsWith('South')?'continent':'ocean',print=atlas.footprint(kind,text),outline=atlas.outline({kind,text,x:0,y:0,angle:0,curve:0});
    assert.ok(outline.every(box=>box.x>=print.left&&box.y>=print.top&&box.x+box.w<=print.right+.001&&box.y+box.h<=print.bottom+.001));
  }
});

test('continuous camera motion reuses the sheet without painting intermediate views',()=>{
  const {atlas,workers,sent,world,run}=fakeView({native:true});
  atlas.update(world,[]);run(1000);
  for(let i=0;i<20;i++){atlas.update({x:300+i,y:100,w:360,h:180},[]);run(40);}
  assert.equal(workers.length,0,'A moving camera never starts background terrain work');
  run(160);assert.equal(workers.length,2,'The final view starts detail after the camera rests');
  for(const worker of workers)worker.onmessage({data:{type:'ready'}});
  assert.ok(sent.some(message=>message.type==='tile'),'The final view still sharpens');
});

test('small windows retain readable city and country letter heights',()=>{
  const {atlas,world}=fakeView({width:390,height:700,innerWidth:390});atlas.update(world,[]);
  for(const [kind,min] of [['city',13],['capital',14],['country',12],['land',12]]){
    const measured=atlas.measure(kind,'Paris');
    assert.ok(measured.h>=min*1.34-.01,`${kind} stays readable on a phone`);
  }
});


test('a coarse tile still in flight when detail arrives is repainted instead of leaving a mismatched patch',()=>{
  const {atlas,up,workers,run,pendingTiles,answer,finish,sent}=fakeView();up();
  atlas.update({x:300,y:100,w:360,h:180},[]);run(1000);
  const old=pendingTiles()[0];
  for(const worker of workers)worker.onmessage({data:{type:'detail'}});
  answer(old);run(1000);finish();run(1000);finish();
  assert.ok(sent.filter(m=>m.type==='tile'&&m.x0===old.x0&&m.y0===old.y0&&m.level===old.level).length>=2);
});

test('a failed texture retries after a delay and keeps the underlying sheet visible',()=>{
  const {atlas,up,run,pendingTiles,finish,sent,sheet}=fakeView();up();
  atlas.update({x:300,y:100,w:360,h:180},[]);run(1000);
  const first=pendingTiles()[0];first.answered=true;
  first.from.onmessage({data:{type:'tile-error',id:first.id,message:'Temporary failure'}});
  finish();run();assert.notEqual(sheet().style.opacity,0);
  const attempts=()=>sent.filter(m=>m.type==='tile'&&m.x0===first.x0&&m.y0===first.y0&&m.level===first.level).length;
  assert.equal(attempts(),1,'No tight retry loop');run(1000);assert.equal(attempts(),2);finish();run(1000);assert.equal(sheet().style.opacity,0);
});

test('canvas restoration and late fonts redraw names even when the camera is unchanged',async()=>{
  const {atlas,up,run,world,draws,canvasEvents,fontEvents}=fakeView();up();await new Promise(setImmediate);
  const names=[{kind:'city',text:'Paris',x:100,y:100,angle:0,curve:0}];
  atlas.update(world,names);run(1000);draws.length=0;
  canvasEvents.contextlost({preventDefault(){}});canvasEvents.contextrestored();run(1000);
  assert.ok(draws.length>0,'Names return after the GPU surface is restored');
  draws.length=0;const era=atlas.era;fontEvents.loadingdone();run(1000);
  assert.ok(atlas.era>era&&draws.length>0,'Late fonts invalidate both collision measurements and painted names');
});

test('repeated unavailable relief is skipped briefly so every neighboring tile does not wait again',async()=>{
  let calls=0;
  const context=createContext({onmessage:null,importScripts(){},postMessage(){},Response,AbortSignal,createImageBitmap:async()=>({}),RedlineAtlasPainter:{reliefTiles:()=>[{key:'missing'}]},fetch:async()=>{calls++;throw Error('offline');}});
  runInContext(readFileSync(file('atlas-worker.js'),'utf8'),context);runInContext('scene={relief:new Map(),reliefCoverage:[]};',context);
  await runInContext('prepareRelief({})',context);await runInContext('prepareRelief({})',context);
  assert.equal(calls,1);
});


test('failed texture retries are bounded instead of repainting forever',()=>{
  const {atlas,up,run,pendingTiles,sent,finish}=fakeView();up();
  atlas.update({x:300,y:100,w:360,h:180},[]);run(1000);
  const first=pendingTiles()[0],matches=m=>m.type==='tile'&&m.x0===first.x0&&m.y0===first.y0&&m.level===first.level;
  for(let i=0;i<4;i++){
    const next=pendingTiles().find(matches);assert.ok(next);next.answered=true;
    next.from.onmessage({data:{type:'tile-error',id:next.id,message:'offline'}});finish();run(30000);
  }
  assert.equal(sent.filter(matches).length,4,'One attempt and at most three retries');
});

test('a worker lost during a paint is replaced without stranding the visible tile',()=>{
  const {atlas,up,run,pendingTiles,workers,sent,finish}=fakeView();up();
  atlas.update({x:300,y:100,w:360,h:180},[]);run(1000);
  const first=pendingTiles()[0];first.answered=true;first.from.onerror({message:'Worker stopped'});run(1000);
  const replacement=workers.at(-1);assert.notEqual(replacement,first.from);
  replacement.onmessage({data:{type:'ready'}});run(1000);finish();run(1000);
  assert.ok(sent.filter(m=>m.type==='tile'&&m.x0===first.x0&&m.y0===first.y0&&m.level===first.level).length>=2);
});
