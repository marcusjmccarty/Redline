import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {paper,paperSVG} from '../scripts/atlas-paper.mjs';

test('baked atlas colour images decode to the deterministic field and remain bounded in size',()=>{
  for(const [kind,file] of [['land','atlas-paper'],['water','atlas-water']]){
    const result=paper(kind),{png,width,height,pixels}=result;
    assert.ok(png.length<90000,'Colour shading should not become a large map download');
    const blocks=new Map();
    for(let i=8;i<png.length;){const length=png.readUInt32BE(i),name=png.toString('ascii',i+4,i+8);blocks.set(name,png.subarray(i+8,i+8+length));i+=length+12;}
    assert.equal(blocks.get('IHDR').readUInt32BE(0),width);assert.equal(blocks.get('IHDR').readUInt32BE(4),height);assert.equal(blocks.get('PLTE').length,128*3);
    const raw=inflateSync(blocks.get('IDAT'));assert.equal(raw.length,(width+1)*height);
    for(let y=0;y<height;y++){
      assert.equal(raw[y*(width+1)],1);let previous=0;
      for(let x=0;x<width;x++){previous=(previous+raw[y*(width+1)+x+1])&255;assert.equal(previous,pixels[y*width+x]);}
    }
    const published=readFileSync(new URL(`../public/${file}.svg`,import.meta.url),'utf8');
    assert.equal(published,paperSVG(kind));assert.doesNotMatch(published,/<filter|<radialGradient|<linearGradient|<script/);
    assert.deepEqual(Buffer.from(published.match(/base64,([^\"]+)/)[1],'base64'),png,'The shipped SVG carries its complete image without a network dependency');
  }
});
