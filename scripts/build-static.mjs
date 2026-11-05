import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { privateFiles, shipped } from './publish-target.mjs';
import './build-atlas.mjs';
const root=new URL('../',import.meta.url),out=new URL('dist/',root);
const stray=privateFiles(await readdir(new URL('public/',root),{recursive:true}));
if(stray.length)throw Error(`Move these out of public/ first, because everything there is published: ${stray.join(', ')}`);
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
await cp(new URL('public/',root),out,{recursive:true,filter:shipped});
let html=await readFile(new URL('map.html',root),'utf8');
if (/signin-with-chatgpt|src="\//.test(html)) throw Error('The standalone build must use relative assets and independent storage.');
const digest=async path=>createHash('sha256').update(await readFile(new URL(path,out))).digest('hex').slice(0,12);
// Styles and scripts name some files themselves, so their copies in dist/ carry the keys too. This comes first, because their own keys depend on it.
async function stamp(file,names){
  let text=await readFile(new URL(file,out),'utf8');
  for(const name of names){if(!text.includes(name))throw Error(`${file} no longer names ${name}.`);text=text.replaceAll(name,`${name}?v=${await digest(name)}`);}
  await writeFile(new URL(file,out),text);
}
await stamp('style.css',['fonts/redline-hand.woff','fonts/redline-hand-bold.woff','fonts/im-fell-english.woff2','fonts/im-fell-english-italic.woff2']);
await stamp('gallery.css',['fonts/album-script.woff']);
await stamp('trips.js',['vendor/exifr.js','photo-cities.json']);
// Relief tiles are named at run time, so they share one key.
const reliefFiles=(await readdir(new URL('relief/',out))).filter(name=>name.endsWith('.webp')).sort();
const reliefVersion=createHash('sha256').update((await Promise.all(reliefFiles.map(name=>digest(`relief/${name}`)))).join()).digest('hex').slice(0,12);
html=html.replace('<script id="atlas-assets" type="application/json">{',`<script id="atlas-assets" type="application/json">{"reliefVersion":"${reliefVersion}",`);
// Scripts, styles, and baked atlas images get fresh cache keys on publication.
const assets=[...new Set([...html.matchAll(/"([^":\s]+\.(?:js|css|svg|png|webp|jpg|bin|woff2?))"/g)].map(match=>match[1]))];
const versions=await Promise.all(assets.map(async asset=>[asset,createHash('sha256').update(await readFile(new URL(asset,out))).digest('hex').slice(0,12)]));
for(const [asset,version] of versions)html=html.replaceAll(`"${asset}"`,`"${asset}?v=${version}"`);
await writeFile(new URL('index.html',out),html);
await writeFile(new URL('.nojekyll',out),'');
console.log('Built the independent website in dist/.');
