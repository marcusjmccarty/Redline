import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {atlasTones,paperGrain} from '../scripts/atlas-tones.mjs';

function unpack(png){
  const chunks=new Map();
  for(let i=8;i<png.length;){const size=png.readUInt32BE(i),type=png.toString('ascii',i+4,i+8);chunks.set(type,png.subarray(i+8,i+8+size));i+=size+12;}
  const header=chunks.get('IHDR');assert.equal(header[9],3,'The atlas uses compact indexed colour');
  return {width:header.readUInt32BE(0),height:header.readUInt32BE(4),rows:inflateSync(chunks.get('IDAT')),palette:chunks.get('PLTE'),alpha:chunks.get('tRNS')};
}

test('the compact atlas preserves its baked pixels and transparent coast edges',()=>{
  const data={ATLAS_LAND:['M200,100L1200,100L1200,600L200,600Z'],ANTARCTICA_POLYGONS:[]};
  const image=atlasTones(data,144,72),decoded=unpack(image.png);
  assert.equal(decoded.width,144);assert.equal(decoded.height,72);assert.ok(decoded.palette.length<=256*3);
  for(let y=0;y<72;y++)for(let x=0;x<144;x++){
    const i=y*144+x,index=decoded.rows[y*145+x+1];
    assert.equal(decoded.rows[y*145],0);
    for(let channel=0;channel<3;channel++)assert.equal(decoded.palette[index*3+channel],image.pixels[i*4+channel]);
    assert.equal(decoded.alpha[index],image.pixels[i*4+3]);
    if(x&&image.mask[i]!==image.mask[i-1])assert.equal(decoded.alpha[index],0,'Exact SVG coastlines stay clear of the raster wash');
  }
});

test('map texture assets stay within small download and decoded-memory budgets',()=>{
  const colour=readFileSync(new URL('../public/atlas-tones.png',import.meta.url));
  const grain=paperGrain(),decoded=unpack(grain),overview=readFileSync(new URL('../public/relief/overview.webp',import.meta.url));
  assert.ok(colour.length<80*1024,'World colour remains below 80 KB');
  assert.ok(grain.length<26*1024,'Reusable paper remains below 26 KB');
  assert.ok(overview.length<16*1024,'World terrain remains below 16 KB');
  assert.equal(decoded.width*decoded.height,192*192);
  assert.ok(decoded.rows.every((value,i)=>i%193===0?value===0:value<26));
  const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
  assert.match(css,/--map-grain: url\("map-paper\.png\?v=[a-f0-9]{12}"\)/,'Paper is independently cacheable rather than embedded in blocking CSS');
});
