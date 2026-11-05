/* Authoring step, not part of `npm run build`: writes public/photo-cities.json, which names the city a photo's GPS position lies in.
   node scripts/build-photo-cities.mjs [cities15000.txt]
   The optional file is a GeoNames dump (https://download.geonames.org/export/dump/), whose sections of cities are left out by their PPLX feature code.
   Without one, the present index is pruned again, which is safe to repeat. Either way a photo should find a city, not a neighbourhood. */
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const radians=degrees=>degrees*Math.PI/180;
function distance(a,b){
  const s=Math.sin(radians(b.latitude-a.latitude)/2)**2+Math.cos(radians(a.latitude))*Math.cos(radians(b.latitude))*Math.sin(radians(b.longitude-a.longitude)/2)**2;
  return 2*6371*Math.asin(Math.sqrt(s));
}
const place=([name,latitude,longitude])=>({name,latitude,longitude});
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();

const coordinate=text=>Number(Number(text).toFixed(4));
export const fromGeoNames=text=>text.split('\n').filter(Boolean).map(line=>line.split('\t')).filter(field=>field[7]!=='PPLX').map(field=>[field[1],coordinate(field[4]),coordinate(field[5]),field[8]]);

// How far a large city's core reaches, in km. Capped so a megacity does not swallow its neighbours: Kawasaki is not Tokyo.
export const coreRadius=population=>Math.min(15,.004*Math.sqrt(population));
// The numbered districts that reach beyond a core, under names no city would have.
const numbered=/\b(Arrondissement|kerület)\b|\(Kreis \d+\)|^Sector \d$|^(Paris|Lyon|Marseille) \d/;

// A row inside the core of a city on the map is part of that city, unless it is that city, or another on the map. The map's name then stands for the whole core.
// Such a row keeps its position, because the nearest row to a photo decides, and gains the city's: [city, latitude, longitude, code, city's latitude, city's longitude].
// Without it a photo at the rim would find a suburb beyond. Rows across a border stay themselves.
export function pruneIndex(rows,cities){
  // Pruning can change which row is nearest a city, and with it a code, so carry on until nothing moves. Repeating is then safe.
  let text=JSON.stringify(rows);
  for(let pass=0;pass<6;pass++){const next=JSON.stringify(pruneOnce(JSON.parse(text),cities));if(next===text)break;text=next;}
  return JSON.parse(text);
}
function pruneOnce(rows,cities){
  const regions=new Intl.DisplayNames(['en'],{type:'region'}),codeOf=new Map();
  for(const row of rows)try{codeOf.set(regions.of(row[3]),row[3]);}catch{}
  const named=cities.map(city=>({...city,name:city.name.replace(/\s+/g,' ').trim()})),major=named.filter(city=>city.population>=100000);
  const own=(row,city)=>same(city.name,row.name)&&distance(row,city)<20;
  const nearby=(row,city)=>Math.abs(city.latitude-row.latitude)<.5;
  const plain=rows.filter(row=>row.length===4);
  const nearest=(city,limit=50)=>{
    let row=null,best=limit;
    for(const candidate of plain){const at=place(candidate);if(!nearby(at,city))continue;const d=distance(at,city);if(d<best){best=d;row=candidate;}}
    return row;
  };
  const codes=new Map();
  const code=city=>{if(!codes.has(city))codes.set(city,nearest(city)?.[3]||codeOf.get(city.country)||city.country);return codes.get(city);};
  // The closest major city whose reach takes in this row, or any city within reach for a numbered district.
  const owner=(row,reach)=>{
    const at=place(row);let found=null,best=Infinity;
    for(const city of major){if(!nearby(at,city))continue;const d=distance(at,city);if(d<=reach(city)&&d<best&&code(city)===row[3]){best=d;found=city;}}
    return found;
  };
  const kept=rows.flatMap(row=>{
    if(row.length>4)return [row];
    if(/\bhome$/i.test(row[0]))return [];
    const at=place(row),district=numbered.test(at.name);
    if(!district&&named.some(city=>nearby(at,city)&&own(at,city)))return [row];
    const city=owner(row,district?()=>25:city=>coreRadius(city.population));
    if(city)return [[city.name,row[1],row[2],row[3],city.latitude,city.longitude]];
    return district?[]:[row];
  });
  const missing=major.filter(city=>!kept.some(row=>row.length===4&&nearby(place(row),city)&&own(place(row),city)));
  const added=missing.map(city=>[city.name,city.latitude,city.longitude,code(city)]);
  return [...new Map([...kept,...added].map(row=>[JSON.stringify(row),row])).values()];
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const root=new URL('../public/',import.meta.url),index=new URL('photo-cities.json',root),context={window:{}};
  vm.createContext(context);vm.runInContext(readFileSync(new URL('atlas-geography.js',root),'utf8'),context);
  const rows=process.argv[2]?fromGeoNames(readFileSync(process.argv[2],'utf8')):JSON.parse(readFileSync(index,'utf8'));
  const pruned=pruneIndex(rows,context.window.MAP_CITIES);
  writeFileSync(index,JSON.stringify(pruned));
  console.log(`Wrote ${pruned.length} places, from ${rows.length}.`);
}
