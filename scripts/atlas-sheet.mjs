// What the baked sheet is painted from. Any change to these makes it stale, and test/atlas.test.mjs says so.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const inputs=['public/atlas-painter.js','public/atlas/geo0.bin','public/atlas/geo1.bin','public/atlas/land.jpg','public/atlas/sea.jpg'];
export const sheetHash=()=>{
  const hash=createHash('sha256');
  for(const input of inputs)hash.update(input).update(readFileSync(new URL(`../${input}`,import.meta.url)));
  return hash.digest('hex').slice(0,20);
};
export const sheets=[
  {name:'sheet.webp',width:2880,height:1600,dpr:2,limit:1024*1024},
  {name:'sheet-small.webp',width:1440,height:800,dpr:1,limit:300*1024}
];
