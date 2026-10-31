import {deflateSync} from 'node:zlib';

const clamp=n=>Math.max(0,Math.min(1,n));
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
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(type,data){
  const name=Buffer.from(type),payload=Buffer.concat([name,data]);let crc=0xffffffff;
  for(const byte of payload)crc=crcTable[(crc^byte)&255]^(crc>>>8);
  const header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([header,payload,tail]);
}
// One faint transparent wash over the whole map. Never use an image-backed
// SVG pattern per landmass: those tiles can be rasterized at world size on zoom.
export function paper(width=512,height=256){
  const seed=0x518c17;
  const palette=Buffer.alloc(128*3),alpha=Buffer.alloc(128);
  for(let i=0;i<128;i++){
    const dark=i<64,colours=dark?[143,114,74]:[255,247,225];
    for(let c=0;c<3;c++)palette[i*3+c]=colours[c];
    alpha[i]=Math.round(dark?(1-i/63)*32:(i-64)/63*38);
  }
  const pixels=new Uint8Array(width*height),raw=Buffer.alloc((width+1)*height);
  for(let y=0;y<height;y++){
    raw[y*(width+1)]=1;let previous=0;
    for(let x=0;x<width;x++){
      let u=x/width*2,v=y/height;
      const dx=noise(u*3+11,v*3-7,seed)-.5,dy=noise(u*3-8,v*3+13,seed+3)-.5;
      u+=dx*.3;v+=dy*.3;
      const wash=noise(u*3,v*3,seed)*.28+noise(u*8+19,v*8-5,seed+11)*.43+noise(u*19-5,v*19+21,seed+23)*.22+noise(u*47,v*47,seed+37)*.07;
      const p=clamp((wash-.24)/.52),value=Math.round(p*127);
      pixels[y*width+x]=value;raw[y*(width+1)+1+x]=(value-previous)&255;previous=value;
    }
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=3;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('PLTE',palette),chunk('tRNS',alpha),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
  return {png,pixels,palette,alpha,width,height};
}
