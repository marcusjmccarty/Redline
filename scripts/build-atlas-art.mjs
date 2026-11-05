/* Authoring step, not part of `npm run build`: bakes Natural Earth into the atlas assets in public/atlas/.
   node scripts/build-atlas-art.mjs <natural-earth-dir> [geo] [plates]
   The directory holds vector/{land-10m,countries-10m}.json, vector/ne_10m_*.geojson and raster/{SR_50M,HYP_50M_SR}.tif.
   See docs/ATLAS.md for where they come from. Plates are written as PNG, then to JPEG with macOS sips. */
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {deflateSync} from 'node:zlib';
import {encodeLayer} from './atlas-codec.mjs';

const source=process.argv[2];
if(!source){console.error('Usage: node scripts/build-atlas-art.mjs <natural-earth-dir> [geo] [plates]');process.exit(1);}
const wanted=new Set(process.argv.slice(3));const all=!wanted.size;
const out=new URL('../public/atlas/',import.meta.url);fs.mkdirSync(out,{recursive:true});
const json=name=>JSON.parse(fs.readFileSync(`${source}/vector/${name}`,'utf8'));
const clamp=(v,a=0,b=1)=>v<a?a:v>b?b:v;

// ---------- Projection: the map's own equirectangular sheet, with Antarctica at half height ----------
const antarctic=ring=>ring.every(([,lat])=>lat<-55);
function projectRing(ring){
  const squash=antarctic(ring);
  return ring.map(([lon,lat])=>{
    const x=(lon+180)*4,y=(90-(lat<=-84.9?-90:lat))*4;
    return [x,squash?360+y/2:y];
  });
}
const projectLine=line=>line.map(([lon,lat])=>[(lon+180)*4,(90-lat)*4]);
// The source is stitched across the date line; this sheet is not. Pieces of a ring that run off one edge come back on the other.
function clipLongitude(ring,keep,cross){
  const output=[];
  for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length],inA=keep(a[0]),inB=keep(b[0]);
    if(inA)output.push(a);
    if(inA!==inB){const t=(cross-a[0])/(b[0]-a[0]);output.push([cross,a[1]+(b[1]-a[1])*t]);}
  }
  return output;
}
function cutAtDateLine(raw){
  const ring=raw.slice();if(ring.length>1&&ring[0][0]===ring.at(-1)[0]&&ring[0][1]===ring.at(-1)[1])ring.pop();
  let offset=0,previous=ring[0][0],crossings=0,breakAt=-1,lowest=0;const unwrapped=[[ring[0][0],ring[0][1]]];
  for(let i=1;i<ring.length;i++){
    const lon=ring[i][0],delta=lon-previous;
    if(delta>180){offset-=360;crossings++;if(breakAt<0)breakAt=i;}else if(delta<-180){offset+=360;crossings++;if(breakAt<0)breakAt=i;}
    unwrapped.push([lon+offset,ring[i][1]]);previous=lon;lowest=Math.min(lowest,offset);
  }
  const closing=ring[0][0]-previous;if(closing>180)offset-=360;else if(closing<-180)offset+=360;
  if(!crossings&&offset===0)return [ring];
  // A net turn of 360 degrees means the ring encloses the pole: Antarctica. Close it along the bottom of the sheet.
  if(offset!==0){
    const start=breakAt<0?0:breakAt,ordered=[...ring.slice(start),...ring.slice(0,start)];
    let shift=0,last=ordered[0][0];const path=[ordered[0]];
    for(let i=1;i<ordered.length;i++){const delta=ordered[i][0]-last;if(delta>180)shift-=360;else if(delta<-180)shift+=360;last=ordered[i][0];path.push([ordered[i][0]+shift,ordered[i][1]]);}
    const first=path[0],final=path.at(-1),sign=final[0]>first[0]?1:-1,bottom=-90;
    const endLon=first[0]+sign*360,joined=(endLon-final[0])?final[1]+(first[1]-final[1])*0:final[1];
    return [normalizeLongitudes([...path,[endLon,first[1]],[endLon,bottom],[first[0],bottom]])].map(r=>r);
  }
  const low=Math.min(...unwrapped.map(p=>p[0])),high=Math.max(...unwrapped.map(p=>p[0])),pieces=[];
  for(const shift of [-360,0,360]){
    if(high+shift<-180||low+shift>180)continue;
    let piece=unwrapped.map(([lon,lat])=>[lon+shift,lat]);
    piece=clipLongitude(piece,x=>x>=-180,-180);if(piece.length<3)continue;
    piece=clipLongitude(piece,x=>x<=180,180);if(piece.length>=3)pieces.push(piece);
  }
  return pieces;
}
function normalizeLongitudes(path){
  const low=Math.min(...path.map(p=>p[0])),shift=low<-180?360*Math.ceil((-180-low)/360):0;
  return path.map(([lon,lat])=>[Math.max(-180,Math.min(180,lon+shift)),lat]);
}
function splitLine(line){
  const lines=[[line[0]]];
  for(let i=1;i<line.length;i++){if(Math.abs(line[i][0]-line[i-1][0])>180)lines.push([]);lines.at(-1).push(line[i]);}
  return lines.filter(part=>part.length>1);
}

// ---------- TopoJSON ----------
function arcsOf(topology){
  const {scale:[kx,ky],translate:[tx,ty]}=topology.transform;
  return topology.arcs.map(arc=>{let x=0,y=0;return arc.map(([dx,dy])=>{x+=dx;y+=dy;return [x*kx+tx,y*ky+ty];});});
}
function ringFrom(indexes,arcs){
  const ring=[];
  for(const index of indexes){const arc=index<0?[...arcs[~index]].reverse():arcs[index];ring.push(...(ring.length?arc.slice(1):arc));}
  return ring;
}
function polygonsOf(geometry){return geometry.type==='Polygon'?[geometry.arcs]:geometry.type==='MultiPolygon'?geometry.arcs:[];}

// ---------- Simplification (Douglas-Peucker, iterative) ----------
function simplify(points,tolerance,closed=false){
  const n=points.length;if(n<3||tolerance<=0)return points;
  const keep=new Uint8Array(n);keep[0]=1;keep[n-1]=1;
  const t2=tolerance*tolerance,stack=[];
  if(closed&&n>3){let far=0,best=-1;const [ax,ay]=points[0];for(let i=1;i<n-1;i++){const d=(points[i][0]-ax)**2+(points[i][1]-ay)**2;if(d>best){best=d;far=i;}}keep[far]=1;stack.push([0,far],[far,n-1]);}
  else stack.push([0,n-1]);
  while(stack.length){
    const [a,b]=stack.pop();if(b-a<2)continue;
    const [ax,ay]=points[a],[bx,by]=points[b],dx=bx-ax,dy=by-ay,len=dx*dx+dy*dy;let far=-1,best=t2;
    for(let i=a+1;i<b;i++){
      const px=points[i][0]-ax,py=points[i][1]-ay;let d;
      if(len===0)d=px*px+py*py;
      else{const u=clamp((px*dx+py*dy)/len);const qx=px-u*dx,qy=py-u*dy;d=qx*qx+qy*qy;}
      if(d>best){best=d;far=i;}
    }
    if(far>=0){keep[far]=1;stack.push([a,far],[far,b]);}
  }
  return points.filter((_,i)=>keep[i]);
}
function ringArea(ring){let area=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++)area+=(ring[j][0]+ring[i][0])*(ring[j][1]-ring[i][1]);return Math.abs(area/2);}

// ---------- Geography ----------
let cachedLand=null;
function landRings(){
  if(cachedLand)return cachedLand;
  const landTopology=json('land-10m.json'),landArcs=arcsOf(landTopology),rings=[];
  for(const geometry of landTopology.objects.land.geometries)for(const polygon of polygonsOf(geometry))for(const rawRing of polygon)for(const piece of cutAtDateLine(ringFrom(rawRing,landArcs)))rings.push(projectRing(piece));
  return cachedLand=rings;
}
function buildGeography(){
  const rings=landRings();
  const lod=[{tolerance:.2,minArea:.12},{tolerance:.06,minArea:.012},{tolerance:.018,minArea:0}];
  const land=lod.map(({tolerance,minArea})=>rings.filter(ring=>ringArea(ring)>=minArea).map(ring=>({rank:0,points:simplify(ring,tolerance,true)})).filter(f=>f.points.length>=4));
  // Lakes: real water bodies, biggest first. Scale rank doubles as the level they appear at.
  const lakeFeatures=json('ne_10m_lakes.geojson').features.filter(f=>f.properties.featurecla!=='Reservoir'&&f.properties.scalerank<=8);
  const lakes=[];
  for(const feature of lakeFeatures){
    const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;
    for(const polygon of polygons){const points=simplify(polygon[0].map(([lon,lat])=>[(lon+180)*4,(90-lat)*4]),.03,true);if(points.length>=4&&ringArea(points)>.008)lakes.push({rank:feature.properties.scalerank,points});}
  }
  // Rivers run from source to mouth in the source data, so ink can widen downstream.
  const riverFeatures=json('ne_10m_rivers_lake_centerlines.geojson').features.filter(f=>f.properties.featurecla==='River'&&f.properties.scalerank<=9);
  const rivers=[];
  for(const feature of riverFeatures){
    const lines=feature.geometry.type==='LineString'?[feature.geometry.coordinates]:feature.geometry.coordinates;
    for(const line of lines){const points=simplify(projectLine(line),.05);if(points.length>=2)rivers.push({rank:feature.properties.scalerank,points});}
  }
  // A border is an arc that two countries share; arcs used once are coast.
  const countries=json('countries-10m.json'),countryArcs=arcsOf(countries),uses=new Map();
  for(const geometry of countries.objects.countries.geometries)for(const polygon of polygonsOf(geometry))for(const ring of polygon)for(const index of ring){const arc=index<0?~index:index;uses.set(arc,(uses.get(arc)||0)+1);}
  const borderLines=[...uses].filter(([,count])=>count>=2).flatMap(([arc])=>splitLine(countryArcs[arc]).map(projectLine));
  const borders=[.16,.03].map(tolerance=>borderLines.map(line=>({rank:0,points:simplify(line,tolerance)})).filter(f=>f.points.length>=2));

  // First-level administrative lines come from the app's own data, so they match its label set.
  const context={window:{}};vm.runInNewContext(fs.readFileSync(new URL('../public/world.js',import.meta.url),'utf8'),context);
  const regions=context.window.REGION_PATHS.filter(Boolean).flatMap(path=>path.split('M').filter(Boolean).map(line=>({rank:0,points:[...line.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(match=>[Number(match[1]),Number(match[2])])}))).filter(f=>f.points.length>=2);
  const terrain=buildTerrain();
  const near=Buffer.concat(packLayers({land0:land[0],lakes0:lakes.filter(f=>f.rank<=4),rivers0:rivers.filter(f=>f.rank<=4),borders0:borders[0]},{terrain}));
  const far=Buffer.concat(packLayers({land1:land[1],land2:land[2],lakes1:lakes,rivers1:rivers,borders1:borders[1],regions},{}));
  fs.writeFileSync(new URL('geo0.bin',out),deflateSync(near,{level:9}));
  fs.writeFileSync(new URL('geo1.bin',out),deflateSync(far,{level:9}));
  const points=layer=>layer.reduce((a,f)=>a+f.points.length,0);
  console.log('land points',land.map(points),'lakes',lakes.length,points(lakes),'rivers',rivers.length,points(rivers),'borders',borders.map(points));
  console.log('geo0',fs.statSync(new URL('geo0.bin',out)).size,'geo1',fs.statSync(new URL('geo1.bin',out)).size);
  buildNames();
}
function packLayers(layers,{terrain}){
  const bodies=[],index={};let offset=0;
  for(const [name,features] of Object.entries(layers)){const body=encodeLayer(features);index[name]={offset,length:body.length};bodies.push(body);offset+=body.length;}
  if(terrain){index.terrain={offset,length:terrain.bytes.length,width:terrain.width,height:terrain.height};bodies.push(terrain.bytes);}
  const header=Buffer.from(JSON.stringify(index)),size=Buffer.alloc(4);size.writeUInt32LE(header.length);
  return [size,header,...bodies];
}

// ---------- Rasters: raw, uncompressed strip TIFFs ----------
function readTiff(name,channels){
  const buffer=fs.readFileSync(`${source}/raster/${name}`),ifd=buffer.readUInt32LE(4),count=buffer.readUInt16LE(ifd);let width=0,height=0,offsets=0;
  for(let i=0;i<count;i++){const at=ifd+2+i*12,tag=buffer.readUInt16LE(at);if(tag===256)width=buffer.readUInt32LE(at+8)&0xffff;if(tag===257)height=buffer.readUInt32LE(at+8)&0xffff;if(tag===273)offsets=buffer.readUInt32LE(at+8);}
  const first=buffer.readUInt32LE(offsets);
  return {width,height,channels,buffer,first};
}
let cachedRasters=null;
function rasters(){
  if(!cachedRasters)cachedRasters={relief:readTiff('SR_50M.tif',1),colour:readTiff('HYP_50M_SR.tif',3)};
  return cachedRasters;
}
// A fine land mask, used to keep land pigment on land and to pool sea pigment against coasts.
function landMask(width,height,minArea=0){
  const mask=new Uint8Array(width*height),rows=Array.from({length:height},()=>[]),sx=width/1440,sy=height/720;
  for(const source of landRings()){
    if(minArea&&ringArea(source)<minArea)continue;
    const ring=source.map(([x,y])=>[x*sx,y*sy]);
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const [ax,ay]=ring[j],[bx,by]=ring[i];if(ay===by)continue;
      const low=Math.max(0,Math.ceil(Math.min(ay,by)-.5)),high=Math.min(height-1,Math.ceil(Math.max(ay,by)-.5)-1);
      for(let y=low;y<=high;y++)rows[y].push(ax+(y+.5-ay)/(by-ay)*(bx-ax));
    }
  }
  for(let y=0;y<height;y++){
    const row=rows[y].sort((a,b)=>a-b);
    for(let k=0;k+1<row.length;k+=2){const from=Math.max(0,Math.round(row[k])),to=Math.min(width,Math.round(row[k+1]));mask.fill(1,y*width+from,y*width+to);}
  }
  return mask;
}
// Rasters are plain equirectangular; on this sheet the far south is squashed to half height.
const sourceY=sheetY=>sheetY>=660?(sheetY-360)*2:sheetY;
// Terrain cells (quarter degree): 4-bit ruggedness, forest, aridity, ice. The painter draws from these at any zoom.
function buildTerrain(){
  const {relief,colour}=rasters(),width=1440,height=720,bytes=Buffer.alloc(width*height*2),mask=landMask(width,height);
  const step=relief.width/width;let mountains=0,forest=0,arid=0,ice=0;
  for(let y=0;y<height;y++){
    const latitude=90-(sourceY(y)+.5)/4;
    for(let x=0;x<width;x++){
      if(!mask[y*width+x])continue;
      const x0=Math.floor(x*step),y0=Math.floor(sourceY(y)*step),n=Math.ceil(step);let sum=0,sq=0,r=0,g=0,b=0,count=0;
      for(let j=0;j<n;j++)for(let i=0;i<n;i++){
        const row=Math.min(relief.height-1,y0+j),col=Math.min(relief.width-1,x0+i);
        const s=relief.buffer[relief.first+row*relief.width+col],at=colour.first+(row*colour.width+col)*3;
        sum+=s;sq+=s*s;r+=colour.buffer[at];g+=colour.buffer[at+1];b+=colour.buffer[at+2];count++;
      }
      const mean=sum/count,sd=Math.sqrt(Math.max(0,sq/count-mean*mean));r/=count;g/=count;b/=count;
      const rugged=clamp((sd-9)/48),light=(r+g+b)/3;
      let humid=clamp((g-r-6)/30);
      // Trees thin out toward the tundra, and the steppes of the mid-latitudes stay open.
      humid*=clamp((70-Math.abs(latitude))/8);
      const dry=clamp((r-g-3)/14)*clamp((light-150)/30)*(1-rugged);
      const frozen=(b-r>7&&light>205)||Math.abs(latitude)>78&&light>205?1:0;
      // The last nibble is at least 1 on any land, so sea cells are all zero.
      const packed=[Math.round(rugged*15),Math.round((frozen?0:humid)*15),Math.round((frozen?0:dry)*15),frozen?15:1];
      bytes[(y*width+x)*2]=packed[0]<<4|packed[1];bytes[(y*width+x)*2+1]=packed[2]<<4|packed[3];
      if(packed[0]>4)mountains++;if(packed[1]>4)forest++;if(packed[2]>4)arid++;if(frozen)ice++;
    }
  }
  console.log('terrain cells',{mountains,forest,arid,ice});
  return {bytes,width,height};
}

// ---------- Plates ----------
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(type,data){
  const payload=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
  for(const byte of payload)crc=crcTable[(crc^byte)&255]^(crc>>>8);
  const head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([head,payload,tail]);
}
function writeJpeg(name,width,height,rgb,quality){
  const stride=width*3,raw=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++){const row=y*(stride+1);raw[row]=0;rgb.copy(raw,row+1,y*stride,(y+1)*stride);}
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const png=new URL(`${name}.png`,`file://${process.env.TMPDIR||'/tmp/'}`);
  fs.writeFileSync(png,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:1})),chunk('IEND',Buffer.alloc(0))]));
  const target=new URL(`${name}.jpg`,out);
  execFileSync('sips',['-s','format','jpeg','-s','formatOptions',String(quality),png.pathname,'--out',target.pathname],{stdio:'ignore'});
  fs.rmSync(png);console.log(`${name}.jpg`,width,height,fs.statSync(target).size);
}
function random(x,y,seed){let n=Math.imul(x,374761393)^Math.imul(y,668265263)^seed;n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;}
const fade=t=>t*t*(3-2*t);
function noise(x,y,seed){const ix=Math.floor(x),iy=Math.floor(y),u=fade(x-ix),v=fade(y-iy),a=random(ix,iy,seed),b=random(ix+1,iy,seed),c=random(ix,iy+1,seed),d=random(ix+1,iy+1,seed);return (a+(b-a)*u)*(1-v)+(c+(d-c)*u)*v;}
function fbm(x,y,seed,octaves=4){let v=0,a=.5,f=1;for(let i=0;i<octaves;i++){v+=a*noise(x*f,y*f,seed+i*97);a/=2;f*=2.03;}return v/(1-a*2);}
const mix=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
// Distance from water to the nearest land, in cells (two-pass chamfer).
function distanceField(mask,width,height){
  const d=new Float32Array(width*height).fill(1e6);
  for(let i=0;i<d.length;i++)if(mask[i])d[i]=0;
  const a=1,b=Math.SQRT2;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*width+x;let v=d[i];if(x)v=Math.min(v,d[i-1]+a);if(y){v=Math.min(v,d[i-width]+a);if(x)v=Math.min(v,d[i-width-1]+b);if(x<width-1)v=Math.min(v,d[i-width+1]+b);}d[i]=v;}
  for(let y=height-1;y>=0;y--)for(let x=width-1;x>=0;x--){const i=y*width+x;let v=d[i];if(x<width-1)v=Math.min(v,d[i+1]+a);if(y<height-1){v=Math.min(v,d[i+width]+a);if(x<width-1)v=Math.min(v,d[i+width+1]+b);if(x)v=Math.min(v,d[i+width-1]+b);}d[i]=v;}
  return d;
}
function buildPlates(){
  // Sea: pigment pools along the coasts and thins across open water, with slow brush variation.
  {
    const width=1440,height=720,mask=landMask(width,height,3),distance=distanceField(mask,width,height),rgb=Buffer.alloc(width*height*3);
    const deep=[230,216,182],open=[238,227,198],pale=[245,236,212],pool=[198,176,128];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const i=y*width+x,u=x/1440,v=y/720,warp=fbm(u*5+3,v*3-2,41)*.5;
      const blotch=fbm(u*7+warp,v*4-warp,17),fine=fbm(u*38,v*22,29,3);
      let colour=mix(open,deep,clamp((blotch-.34)*2.6));
      colour=mix(colour,pale,clamp((.42-fbm(u*5-warp,v*3+warp,53))*3)*.75);
      const near=Math.exp(-distance[i]/5);
      colour=mix(colour,pool,near*.66);
      const grain=(fine-.5)*9;
      rgb[i*3]=clamp(colour[0]+grain,0,255);rgb[i*3+1]=clamp(colour[1]+grain,0,255);rgb[i*3+2]=clamp(colour[2]+grain,0,255);
    }
    writeJpeg('sea',width,height,rgb,72);
  }
  // Land: gouache washes set from the terrain's climate colours, modelled by real hillshade.
  {
    const {relief,colour}=rasters(),width=5400,height=2700,scale=relief.width/width,rgb=Buffer.alloc(width*height*3);
    const mask=landMask(width,height);
    const paper=[221,197,146],moss=[150,152,96],sage=[180,175,118],ochre=[222,184,112],rust=[203,144,90],umber=[178,150,108],snow=[240,236,222];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      // Domain warp: the boundaries between washes wander like pigment rather than following contours.
      const u=x/width,v=y/height,wx=(fbm(u*24,v*12,5)-.5)*16,wy=(fbm(u*24+9,v*12-4,7)-.5)*16;
      const sheetRow=sourceY((y+wy)/height*720)/720*height;
      const col=Math.max(0,Math.min(relief.width-1,Math.floor((x+wx)*scale))),row=Math.max(0,Math.min(relief.height-1,Math.floor(sheetRow*scale)));
      const at=colour.first+(row*colour.width+col)*3,r=colour.buffer[at],g=colour.buffer[at+1],b=colour.buffer[at+2];
      const shade=relief.buffer[relief.first+Math.min(relief.height-1,Math.floor(sourceY(y/height*720)/720*relief.height))*relief.width+Math.min(relief.width-1,x*2)];
      const light=(r+g+b)/3,humid=clamp((g-r-4)/34),dry=clamp((r-g-3)/16),high=clamp((175-light)/70),latitude=90-sourceY(v*720)/4;
      const wash=fbm(u*16,v*8,61,3);
      let c=paper;
      c=mix(c,sage,clamp(humid*1.3)*.8);
      c=mix(c,moss,clamp(humid-.35)*.95);
      c=mix(c,ochre,clamp(dry*1.1)*.82);
      c=mix(c,rust,clamp(dry-.55)*1.2*clamp((wash-.35)*3));
      c=mix(c,umber,high*.55);
      if(b-r>7&&light>205||Math.abs(latitude)>78&&light>205)c=mix(c,snow,.9);
      const tint=(wash-.5)*14,model=clamp(shade/205,.42,1.14),depth=model<1?1-(1-model)*.92:1+(model-1)*.5;
      let red=(c[0]+tint)*depth,green=(c[1]+tint*.92)*depth,blue=(c[2]+tint*.72)*depth;
      // Shadows warm toward umber instead of going grey.
      if(model<1){const warm=(1-model)*22;red+=warm*.5;green+=warm*.12;blue-=warm*.28;}
      const i=y*width+x;rgb[i*3]=clamp(red,0,255);rgb[i*3+1]=clamp(green,0,255);rgb[i*3+2]=clamp(blue,0,255);
    }
    // Land pigment spreads a little past the coast so the crisp vector edge never reveals the sea colour.
    const nearest=new Int32Array(width*height).fill(-1);
    let frontier=[];for(let i=0;i<mask.length;i++)if(mask[i]){nearest[i]=i;frontier.push(i);}
    for(let pass=0;pass<14;pass++){
      const next=[];
      for(const i of frontier){const x=i%width,y=(i-x)/width;for(const j of [x?i-1:-1,x<width-1?i+1:-1,y?i-width:-1,y<height-1?i+width:-1])if(j>=0&&nearest[j]<0){nearest[j]=nearest[i];next.push(j);}}
      frontier=next;
    }
    for(let i=0;i<mask.length;i++){
      if(mask[i])continue;
      const from=nearest[i]<0?-1:nearest[i];
      if(from>=0){rgb[i*3]=rgb[from*3];rgb[i*3+1]=rgb[from*3+1];rgb[i*3+2]=rgb[from*3+2];}
      else{rgb[i*3]=paper[0];rgb[i*3+1]=paper[1];rgb[i*3+2]=paper[2];}
    }
    writeJpeg('land',width,height,rgb,68);
    // A small first plate lets the map appear long before the full one has downloaded.
    const land=new URL('land.jpg',out).pathname,small=new URL('land-small.jpg',out).pathname;
    execFileSync('sips',['-Z','1440','-s','format','jpeg','-s','formatOptions','62',land,'--out',small],{stdio:'ignore'});
    console.log('land-small.jpg',fs.statSync(small).size);
  }
}

// ---------- Names ----------
function principal(rings){
  // Centroid and long axis of a feature's points, so lettering can run along a range or sea.
  let sx=0,sy=0,n=0;for(const ring of rings)for(const [x,y] of ring){sx+=x;sy+=y;n++;}
  const cx=sx/n,cy=sy/n;let xx=0,yy=0,xy=0;for(const ring of rings)for(const [x,y] of ring){xx+=(x-cx)**2;yy+=(y-cy)**2;xy+=(x-cx)*(y-cy);}
  const angle=.5*Math.atan2(2*xy,xx-yy),spread=Math.sqrt((xx+yy)/n);
  let degrees=angle*180/Math.PI;if(degrees>90)degrees-=180;if(degrees<-90)degrees+=180;
  return {x:+cx.toFixed(1),y:+cy.toFixed(1),angle:Math.round(Math.abs(degrees)>62?0:degrees),spread:+spread.toFixed(1)};
}
const featureRings=feature=>(feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates).map(polygon=>polygon[0].map(([lon,lat])=>[(lon+180)*4,(90-lat)*4]));
// The source shouts; the lettering decides for itself which names are capitals.
const titleCase=name=>name.toLowerCase().replace(/(^|[\s\-(.])(\p{L})/gu,(_,lead,letter)=>lead+letter.toUpperCase()).replace(/\b(Of|The|De|Du|Del|La|Le|And)\b/g,word=>word.toLowerCase());
function buildNames(){
  const names=[];
  const kinds={'Range/mtn':'range',Desert:'desert',Plateau:'land',Basin:'land',Tundra:'land',Wetlands:'land',Plain:'land'};
  for(const feature of json('ne_10m_geography_regions_polys.geojson').features){
    const {FEATURECLA:cla,NAME:name,SCALERANK:rank}=feature.properties,kind=kinds[cla];
    if(!kind||!name||rank>4||/\d/.test(name))continue;
    const info=principal(featureRings(feature));
    if(info.y>655)continue;
    names.push({name:titleCase(name),kind,rank,...info});
  }
  const seas={ocean:0,sea:1,gulf:2,bay:2,strait:3,channel:3,sound:3};
  for(const feature of json('ne_10m_geography_marine_polys.geojson').features){
    const {featurecla:cla,name,scalerank:rank}=feature.properties;
    if(!(cla in seas)||!name||rank>4)continue;
    const info=principal(featureRings(feature));
    if(info.y>650||cla==='ocean')continue;
    names.push({name:name.replace(/\s+/g,' ').trim(),kind:'sea',rank,...info});
  }
  const unique=new Map();for(const item of names){const key=item.name+item.kind;if(!unique.has(key)||unique.get(key).rank>item.rank)unique.set(key,item);}
  const list=[...unique.values()].sort((a,b)=>a.rank-b.rank);
  fs.writeFileSync(new URL('../public/atlas-names.js',import.meta.url),`/* Generated by scripts/build-atlas-art.mjs from Natural Earth geographic regions and marine areas. */\nwindow.ATLAS_NAMES=${JSON.stringify(list)};\n`);
  console.log('names',list.length,list.slice(0,12).map(n=>n.name).join(', '));
}

if(all||wanted.has('geo'))buildGeography();
if(all||wanted.has('plates'))buildPlates();
