import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {paper} from '../scripts/atlas-paper.mjs';

test('the single atlas wash decodes to a small deterministic bitmap with restrained opacity',()=>{
    const result=paper(),{png,width,height,pixels}=result;
    assert.ok(png.length<56000,'The wash has a small download budget');assert.ok(width*height*4<=512*1024,'Decoded pixels are bounded regardless of camera zoom');
    const blocks=new Map();
    for(let i=8;i<png.length;){const length=png.readUInt32BE(i),name=png.toString('ascii',i+4,i+8);blocks.set(name,png.subarray(i+8,i+8+length));i+=length+12;}
    assert.equal(blocks.get('IHDR').readUInt32BE(0),width);assert.equal(blocks.get('IHDR').readUInt32BE(4),height);assert.equal(blocks.get('PLTE').length,128*3);
    assert.equal(blocks.get('tRNS').length,128);assert.ok(blocks.get('tRNS').every(alpha=>alpha<=38),'Weathering is faint, with no opaque cloud patches');
    const raw=inflateSync(blocks.get('IDAT'));assert.equal(raw.length,(width+1)*height);
    for(let y=0;y<height;y++){
      assert.equal(raw[y*(width+1)],1);let previous=0;
      for(let x=0;x<width;x++){previous=(previous+raw[y*(width+1)+x+1])&255;assert.equal(previous,pixels[y*width+x]);}
    }
    const published=readFileSync(new URL('../public/atlas-wash.png',import.meta.url));
    assert.deepEqual(published,png,'Ship the PNG directly, without an enclosing SVG image document');
});
