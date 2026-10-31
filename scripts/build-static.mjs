import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import './build-atlas.mjs';
await import('./build-atlas-tones.mjs');
const root=new URL('../',import.meta.url),out=new URL('dist/',root);
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
await cp(new URL('public/',root),out,{recursive:true});
let html=await readFile(new URL('map.html',root),'utf8');
if (/signin-with-chatgpt|src="\//.test(html)) throw Error('The standalone build must use relative assets and independent storage.');
// Scripts, styles, and baked atlas images get fresh cache keys on publication.
const assets=[...new Set([...html.matchAll(/(?:src|href)="([^":]+\.(?:js|css|svg|png))"/g)].map(match=>match[1]))];
const versions=await Promise.all(assets.map(async asset=>[asset,createHash('sha256').update(await readFile(new URL(asset,out))).digest('hex').slice(0,12)]));
for(const [asset,version] of versions)html=html.replaceAll(`"${asset}"`,`"${asset}?v=${version}"`);
await writeFile(new URL('index.html',out),html);
await writeFile(new URL('.nojekyll',out),'');
console.log('Built the independent website in dist/.');
