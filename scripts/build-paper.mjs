import {writeFile} from 'node:fs/promises';
import {paperSVG} from './atlas-paper.mjs';
for(const [kind,name] of [['land','atlas-paper'],['water','atlas-water']])await writeFile(new URL(`../public/${name}.svg`,import.meta.url),paperSVG(kind));
console.log('Baked the two small atlas colour textures.');
