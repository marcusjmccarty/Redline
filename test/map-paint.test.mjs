import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=name=>readFileSync(new URL(`../${name}`,import.meta.url),'utf8');
function atlas(t){
  const dom=new JSDOM('<svg><g id="land"></g><g id="regions"></g></svg>',{runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());w.eval(source('public/world.js'));w.eval(source('public/map-paint.js'));
  const land=w.document.getElementById('land'),regions=w.document.getElementById('regions');
  const renderer=w.RedlineAtlas.create(land,regions,w.WORLD_PATHS,w.REGION_PATHS);
  return {w,land,regions,renderer};
}
const world={x:0,y:0,w:1440,h:720},europe={x:700,y:110,w:180,h:90};
const visible=layer=>[...layer.children].filter(node=>node.style.display!=='none');

test('atlas culling keeps intersecting land and borders and restores them when panning or zooming out',t=>{
  const {w,land,regions,renderer}=atlas(t),measure=w.RedlineAtlas.measure;
  renderer.paint(world,false);assert.equal(visible(land).length,176);assert.equal(visible(regions).length,0);
  for(const view of [europe,{x:1250,y:400,w:180,h:120},{x:0,y:100,w:160,h:400}]){
    renderer.paint(view,true);
    for(const layer of [land,regions])for(const node of layer.children){
      const b=measure(node.getAttribute('d'));
      const expected=b.right>=view.x-3&&b.left<=view.x+view.w+3&&b.bottom>=view.y-3&&b.top<=view.y+view.h+3;
      assert.equal(node.style.display!=='none',expected,'Every intersecting coastline remains visible, including across the date line');
    }
  }
  renderer.paint(europe,true);
  assert.ok(visible(land).length<50);assert.ok(visible(regions).length<150,'Offscreen state boundaries are not painted');
  renderer.paint(world,true);assert.equal(visible(land).length,176);assert.equal(visible(regions).length,581);
  assert.deepEqual([...land.children].map(node=>node.getAttribute('d')),Array.from(w.WORLD_PATHS),'Culling never edits the original polygons or lake holes');
});

test('a still camera writes no atlas attributes and a moving camera changes only visibility',t=>{
  const {w,land,regions,renderer}=atlas(t);
  const observer=new w.MutationObserver(()=>{});observer.observe(w.document.querySelector('svg'),{subtree:true,attributes:true});
  renderer.paint(europe,true);observer.takeRecords();
  for(let i=0;i<120;i++)renderer.paint({...europe},true);
  assert.equal(observer.takeRecords().length,0,'Steady trace frames do not invalidate country or border paint');
  renderer.paint({...europe,x:1000},true);const mutations=observer.takeRecords();
  assert.ok(mutations.length>0&&mutations.every(m=>m.attributeName==='style'));
  assert.equal(land.children.length+regions.children.length,757,'No duplicate geometry or clipping-mask copies');
  observer.disconnect();
});
