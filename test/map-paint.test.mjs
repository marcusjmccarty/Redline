import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {dissolve} from '../scripts/atlas-geometry.mjs';
const source=name=>readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
function atlas(t){
  const dom=new JSDOM('<svg><g id="land"></g><g id="regions"></g><g id="countries"></g></svg>',{runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());w.eval(source('public/world.js'));w.eval(source('public/atlas-geography.js'));w.eval(source('public/map-paint.js'));
  const land=w.document.getElementById('land'),regions=w.document.getElementById('regions'),countries=w.document.getElementById('countries');
  const renderer=w.RedlineAtlas.create(land,regions,w.ATLAS_LAND,w.REGION_PATHS,countries,w.ATLAS_BORDERS);
  return {w,land,regions,countries,renderer};
}
const world={x:0,y:0,w:1440,h:720},europe={x:700,y:110,w:180,h:90};
const visible=layer=>[...layer.children].filter(node=>node.style.display!=='none');

test('atlas culling keeps intersecting land and borders and restores them when panning or zooming out',t=>{
  const {w,land,regions,countries,renderer}=atlas(t),measure=w.RedlineAtlas.measure;
  renderer.paint(world,false);assert.equal(visible(land).length,119);assert.equal(visible(regions).length,0);
  for(const view of [europe,{x:1250,y:400,w:180,h:120},{x:0,y:100,w:160,h:400}]){
    renderer.paint(view,true);
    for(const layer of [land,regions,countries])for(const node of layer.children){
      const b=measure(node.getAttribute('d'));
      const expected=b.right>=view.x-3&&b.left<=view.x+view.w+3&&b.bottom>=view.y-3&&b.top<=view.y+view.h+3;
      assert.equal(node.style.display!=='none',expected,'Every intersecting coastline remains visible, including across the date line');
    }
  }
  renderer.paint(europe,true);
  assert.ok(visible(land).length<50);assert.ok(visible(regions).length<150,'Offscreen state boundaries are not painted');
  renderer.paint(world,true);assert.equal(visible(land).length,119);assert.equal(visible(regions).length,581);
  assert.deepEqual([...land.children].map(node=>node.getAttribute('d')),Array.from(w.ATLAS_LAND),'Culling never edits the original polygons or lake holes');
});

test('a still camera writes no atlas attributes and a moving camera changes only visibility',t=>{
  const {w,land,regions,countries,renderer}=atlas(t);
  const observer=new w.MutationObserver(()=>{});observer.observe(w.document.querySelector('svg'),{subtree:true,attributes:true});
  renderer.paint(europe,true);observer.takeRecords();
  for(let i=0;i<120;i++)renderer.paint({...europe},true);
  assert.equal(observer.takeRecords().length,0,'Steady trace frames do not invalidate country or border paint');
  renderer.paint({...europe,x:1000},true);const mutations=observer.takeRecords();
  assert.ok(mutations.length>0&&mutations.every(m=>m.attributeName==='style'));
  assert.equal(land.children.length+regions.children.length+countries.children.length,726,'No duplicate shared edges or clipping-mask copies');
  observer.disconnect();
});

const rings=path=>path.split('M').filter(Boolean).map(part=>[...part.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(m=>[Number(m[1]),Number(m[2])]));
function inside(rings,[x,y]){
  let hit=false;
  for(const ring of rings)for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])hit=!hit;
  }
  return hit;
}

test('landmass construction dissolves national edges but keeps lakes and islands inside lakes',()=>{
  const input=['M0,0L10,0L10,20L0,20Z','M10,0L20,0L20,20L10,20ZM12,8L16,8L16,12L12,12ZM13,9L15,9L15,11L13,11Z'];
  const result=dissolve(input);assert.equal(result.land.length,1,'Adjacent countries use a single continuous colour field');
  const land=rings(result.land[0]);
  for(const point of [[1,1],[9.99,5],[10.01,5],[14,10]])assert.equal(inside(land,point),true);
  for(const point of [[21,10],[12.5,9],[14,11.5]])assert.equal(inside(land,point),false);
  assert.equal(result.borders.length,1);assert.match(result.borders[0],/M10,(?:0L10,20|20L10,0)/);
});

test('the generated atlas retains the original land coverage and deterministically reproduces its published geometry',t=>{
  const {w}=atlas(t),generated=dissolve(Array.from(w.WORLD_PATHS));
  assert.deepEqual(generated.land,Array.from(w.ATLAS_LAND));assert.deepEqual(generated.borders,Array.from(w.ATLAS_BORDERS));
  const originalData={window:{}},runtimeData={window:{}};
  runInNewContext(source('public/world.js'),originalData);runInNewContext(source('public/atlas-geography.js'),runtimeData);
  assert.equal(runtimeData.window.WORLD_PATHS,undefined,'The runtime does not load the original country polygons as well');
  for(const [key,value] of Object.entries(originalData.window))if(key!=='WORLD_PATHS')assert.equal(JSON.stringify(runtimeData.window[key]),JSON.stringify(value),`${key} is preserved`);
  const original=Array.from(w.WORLD_PATHS,rings),merged=generated.land.map(rings);
  for(let y=7.31;y<720;y+=19.73)for(let x=3.17;x<1440;x+=17.83){
    const point=[x,y];assert.equal(merged.some(shape=>inside(shape,point)),original.some(shape=>inside(shape,point)),`Geography at ${point} is unchanged`);
  }
  const vertices=paths=>paths.reduce((count,path)=>count+(path.match(/,/g)||[]).length,0);
  assert.ok(vertices(generated.land)<vertices(w.WORLD_PATHS)/2,'Less than half as many coordinates need filled-area painting');
});
