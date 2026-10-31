import {readFile,writeFile} from 'node:fs/promises';
import vm from 'node:vm';
import {atlasTones} from './atlas-tones.mjs';
const root=new URL('../',import.meta.url),context={window:{}};
vm.runInNewContext(await readFile(new URL('public/atlas-geography.js',root),'utf8'),context);
const image=atlasTones(context.window);
await writeFile(new URL('public/atlas-tones.png',root),image.png);
console.log(`Atlas colour: ${image.width} × ${image.height}, ${Math.round(image.png.length/1024)} KB; no runtime filters.`);
