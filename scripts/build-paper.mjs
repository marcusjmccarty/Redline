import {writeFile} from 'node:fs/promises';
import {paper} from './atlas-paper.mjs';
const {png}=paper();
await writeFile(new URL('../public/atlas-wash.png',import.meta.url),png);
console.log(`Baked one ${Math.round(png.length/1024)} KB atlas wash.`);
