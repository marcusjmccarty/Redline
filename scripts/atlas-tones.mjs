import {deflateSync} from 'node:zlib';

const clamp=value=>Math.max(0,Math.min(1,value));
const fade=t=>t*t*t*(t*(t*6-15)+10);
function random(x,y,seed){
  let n=Math.imul(x,374761393)^Math.imul(y,668265263)^seed;
  n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;
}
function noise(x,y,seed){
  const ix=Math.floor(x),iy=Math.floor(y),u=fade(x-ix),v=fade(y-iy);
  const a=random(ix,iy,seed),b=random(ix+1,iy,seed),c=random(ix,iy+1,seed),d=random(ix+1,iy+1,seed);
  return (a+(b-a)*u)*(1-v)+(c+(d-c)*u)*v;
}
function wash(x,y,seed){
  // Broad, irregular washes carry the colour; smaller variations merely soften
  // their transitions. Avoid clipped contrast and conspicuous mottled patches.
  const u=x+(noise(x*2+7,y*2-9,seed+71)-.5)*.34;
  const v=y+(noise(x*2-13,y*2+5,seed+97)-.5)*.34;
  const value=noise(u*3.2,v*3.2,seed)*.6+noise(u*6.2+9,v*6.2-5,seed+11)*.32+noise(u*11.4-7,v*11.4+11,seed+31)*.08;
  return clamp(.5+(value-.5)*1.45);
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(type,data){
  const payload=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
  for(const byte of payload)crc=crcTable[(crc^byte)&255]^(crc>>>8);
  const header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([header,payload,tail]);
}
function png(width,height,pixels){
  const stride=width*4,raw=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++){
    const row=y*(stride+1);raw[row]=1;
    for(let x=0;x<stride;x++)raw[row+x+1]=(pixels[y*stride+x]-(x>=4?pixels[y*stride+x-4]:0))&255;
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
// Scan conversion happens at build time. Country borders never participate in
// the wash; only the original coastlines distinguish warm land from blue water.
function landMask(data,width,height){
  const mask=new Uint8Array(width*height),shapes=data.ATLAS_LAND.map(path=>path.split('M').filter(Boolean).map(ring=>[...ring.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(match=>[Number(match[1]),Number(match[2])])));
  shapes.push(...data.ANTARCTICA_POLYGONS.map(polygon=>polygon.map(ring=>ring.map(([x,y])=>[x,360+y*.5]))));
  for(const rings of shapes){
    const rows=Array.from({length:height},()=>[]);
    for(const ring of rings)for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const [ax,ay]=[ring[j][0]*width/1440,ring[j][1]*height/720], [bx,by]=[ring[i][0]*width/1440,ring[i][1]*height/720];
      if(ay===by)continue;
      const first=Math.max(0,Math.ceil(Math.min(ay,by)-.5)),last=Math.min(height,Math.ceil(Math.max(ay,by)-.5));
      for(let y=first;y<last;y++)rows[y].push(ax+(y+.5-ay)*(bx-ax)/(by-ay));
    }
    rows.forEach((crossings,y)=>{
      crossings.sort((a,b)=>a-b);
      for(let i=0;i+1<crossings.length;i+=2)mask.fill(1,y*width+Math.max(0,Math.ceil(crossings[i]-.5)),y*width+Math.min(width,Math.ceil(crossings[i+1]-.5)));
    });
  }
  return mask;
}
export function atlasTones(data,width=1024,height=512){
  const mask=landMask(data,width,height),distance=new Uint8Array(width*height);distance.fill(255);
  // Leave the precise coastline to the SVG. The colour image is transparent
  // at shorelines, so its finite resolution cannot blur land while zooming.
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;
    if(x&&mask[i]!==mask[i-1]||x+1<width&&mask[i]!==mask[i+1]||y&&mask[i]!==mask[i-width]||y+1<height&&mask[i]!==mask[i+width])distance[i]=0;
  }
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;distance[i]=Math.min(distance[i],x?distance[i-1]+1:255,y?distance[i-width]+1:255);
  }
  for(let y=height-1;y>=0;y--)for(let x=width-1;x>=0;x--){
    const i=y*width+x;distance[i]=Math.min(distance[i],x+1<width?distance[i+1]+1:255,y+1<height?distance[i+width]+1:255);
  }
  const pixels=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x,land=mask[i],tone=wash(x/width*2,y/height,land?0x2d7289:0x629138);
    const dark=land?[227,204,158]:[161,185,198],light=land?[255,244,212]:[234,236,223];
    for(let c=0;c<3;c++)pixels[i*4+c]=Math.round(dark[c]+(light[c]-dark[c])*tone);
    pixels[i*4+3]=Math.round(fade(clamp(distance[i]/3))*148);
  }
  return {png:png(width,height,pixels),pixels,mask,width,height};
}
