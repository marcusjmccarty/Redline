import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('../map.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../public/map-intro.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function setup(t,{reduced=false,hidden=false,supported=true,throwAt=0}={}){
  const dom=new JSDOM(html,{url:'https://redline.test/Redline/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,root=w.document.documentElement,timers=new Map(),delays=new Map(),frames=new Map(),motions=[],painted=[];
  let id=0;const media=new w.EventTarget();media.matches=reduced;
  Object.defineProperty(w.document,'hidden',{configurable:true,get:()=>hidden});
  w.matchMedia=()=>media;
  w.setTimeout=(callback,delay)=>{timers.set(++id,callback);delays.set(id,delay);return id;};w.clearTimeout=id=>timers.delete(id);
  w.requestAnimationFrame=callback=>{frames.set(++id,callback);return id;};w.cancelAnimationFrame=id=>frames.delete(id);
  w.Element.prototype.getBoundingClientRect=()=>({width:1440,height:900});
  if(supported)w.Element.prototype.animate=function(keys,options){
    if(throwAt&&motions.length+1===throwAt)throw Error('Animation unavailable');
    let resolve,reject;
    const motion={target:this,keys,options,cancelled:false,finished:new Promise((yes,no)=>{resolve=yes;reject=no;}),complete:()=>resolve(),cancel(){this.cancelled=true;reject(Error('Cancelled'));}};
    motions.push(motion);return motion;
  };
  // Canvas drawing is a browser service; the fold only has to ask for the right quarter of the sheet.
  w.HTMLCanvasElement.prototype.getContext=function(){return {drawImage:(...args)=>painted.push({canvas:this,args})};};
  w.eval(script);
  const flushFrames=()=>{const batch=[...frames.values()];frames.clear();for(const callback of batch)callback();};
  // The atlas view's half of the bargain: a promise that the sheet is painted, then the sheet itself.
  const atlasWith=(ready=Promise.resolve(true),sheet={width:1440,height:900})=>{const stub={ready,snapshots:0,snapshot(){stub.snapshots++;return sheet;}};return stub;};
  const atlas=atlasWith(),guards=()=>[...timers.keys()].map(key=>delays.get(key));
  const ready=async(stub=atlas)=>{w.RedlineMapIntro.start(stub);await tick();flushFrames();};
  const expire=()=>{const batch=[...timers.values()];timers.clear();for(const callback of batch)callback();};
  const assertClean=()=>{
    assert.equal(root.classList.contains('map-arriving'),false,'The real map and controls are visible');
    assert.equal(root.classList.contains('map-revealing'),false,'The prepaint state is fully cleared');
    assert.equal(w.document.querySelector('.map-unfold'),null,'No temporary rendering layers remain');
    assert.equal(timers.size,0);assert.equal(frames.size,0);
  };
  t.after(()=>{w.dispatchEvent(new w.Event('pagehide'));dom.window.close();});
  return {w,root,media,motions,painted,atlas,atlasWith,guards,timers,frames,ready,expire,flushFrames,assertClean,setHidden:value=>{hidden=value;w.document.dispatchEvent(new w.Event('visibilitychange'));}};
}

test('the opening sheet shows quarters of the painted map and hands off without replacing it',async t=>{
  const env=setup(t),{w,motions,painted,atlas}=env,map=w.document.getElementById('map');
  assert.deepEqual(env.guards(),[2400],'A delayed app script gets 2.4s before the map is simply revealed');
  await env.ready();
  const faces=[...w.document.querySelectorAll('.unfold-face svg')];
  assert.deepEqual(faces.map(face=>face.getAttribute('viewBox')),['0 0 720 360','0 360 720 360','720 0 720 360','720 360 720 360']);
  for(const face of faces){
    const uses=[...face.querySelectorAll('use')];
    assert.deepEqual(uses.map(node=>node.getAttribute('href')),['#route-halos','#route-lines','#route-stops'],'The unfolding sheet includes the connecting ink before the city pins');
    assert.equal(uses[0].getAttribute('transform'),'scale(1 0.8)','Ink and pins share the live overlay\'s screen-space scale');
    assert.equal(uses[0].getAttribute('transform'),uses[1].getAttribute('transform'));
    assert.equal(face.previousElementSibling.tagName,'CANVAS','Each panel paints its quarter beneath the ink');
  }
  assert.equal(atlas.snapshots,1,'One snapshot of the sheet serves all four panels');
  assert.deepEqual(painted.map(({canvas,args})=>[canvas.width,canvas.height,...args.slice(1)]),[[0,0],[0,450],[720,0],[720,450]].map(([x,y])=>[720,450,x,y,720,450,0,0,720,450]),'Together the panels are exactly the sheet, quarter by quarter');
  assert.ok(painted.every(({canvas})=>canvas.closest('.unfold-face')),'Quarters live only on the temporary sheet');
  assert.equal(w.document.querySelector('.map-unfold image, #map-artwork'),null,'No image decoding or copied artwork remains');
  assert.deepEqual(env.guards(),[2050],'The fold\'s 1700ms choreography has a guard just beyond it');
  assert.deepEqual(motions.map(motion=>motion.options.duration+(motion.options.delay||0)),[140,1700,740,1550,1550,740,740,1550,1550],'Fold timing is unchanged: arrive, open across, pause, open down, settle');
  w.RedlineMapIntro.start(atlas);assert.equal(w.document.querySelectorAll('.map-unfold').length,1);
  for(const motion of motions)motion.complete();await tick();
  assert.ok(env.root.classList.contains('map-revealing'),'The real map is exposed beneath the finished paper');
  assert.ok(w.document.querySelector('.map-unfold'),'The cover stays until the live map has painted');
  env.flushFrames();assert.ok(w.document.querySelector('.map-unfold'));
  env.flushFrames();env.assertClean();
  assert.equal(w.document.getElementById('map'),map);
  w.RedlineMapIntro.start(atlas);await tick();assert.equal(w.document.querySelector('.map-unfold'),null,'The intro runs once per page load');
  assert.equal(atlas.snapshots,1);
});

test('interaction during the final paint handoff cancels pending frames without restoring the cover',async t=>{
  const env=setup(t);await env.ready();
  for(const motion of env.motions)motion.complete();await tick();
  assert.ok(env.root.classList.contains('map-revealing'));
  env.w.dispatchEvent(new env.w.Event('pointerdown'));env.assertClean();
  env.flushFrames();await tick();env.assertClean();
});

test('reduced motion, background tabs and missing animation support reveal the map immediately',async t=>{
  for(const options of [{reduced:true},{hidden:true},{supported:false}]){
    const env=setup(t,options);await env.ready();env.assertClean();assert.equal(env.atlas.snapshots,0);assert.equal(env.painted.length,0);assert.equal(env.motions.length,0);
  }
});

test('interaction skips an active fold without swallowing the user action',async t=>{
  const env=setup(t);await env.ready();let received=0;
  const button=env.w.document.getElementById('play');button.addEventListener('keydown',()=>received++);
  const event=new env.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});button.dispatchEvent(event);
  env.assertClean();assert.equal(received,1);assert.equal(event.defaultPrevented,false);
  assert.ok(env.motions.every(motion=>motion.cancelled));await tick();
});

test('a late atlas cannot restart an intro dismissed by the user',async t=>{
  let release;const env=setup(t),atlas=env.atlasWith(new Promise(resolve=>{release=resolve;}));
  env.w.RedlineMapIntro.start(atlas);env.w.dispatchEvent(new env.w.Event('pointerdown'));env.assertClean();
  release(true);await tick();env.flushFrames();env.assertClean();assert.equal(env.motions.length,0);assert.equal(atlas.snapshots,0);
  // Dismissed in the frame between the snapshot and the first fold.
  const waiting=setup(t);waiting.w.RedlineMapIntro.start(waiting.atlas);await tick();assert.equal(waiting.atlas.snapshots,1);
  waiting.w.dispatchEvent(new waiting.w.Event('pointerdown'));waiting.assertClean();waiting.flushFrames();waiting.assertClean();assert.equal(waiting.motions.length,0);
});

test('initial viewport sizing does not dismiss a fold that has not begun',async t=>{
  let release;const env=setup(t);
  env.w.RedlineMapIntro.start(env.atlasWith(new Promise(resolve=>{release=resolve;})));env.w.dispatchEvent(new env.w.Event('resize'));
  assert.equal(env.root.classList.contains('map-arriving'),false,'The preview stays visible while the sheet loads');
  release(true);await tick();env.flushFrames();
  assert.ok(env.w.document.querySelector('.map-unfold'),'The fold uses the settled viewport');
});

test('resizing, hiding the page or enabling reduced motion safely settles the opening sheet',async t=>{
  for(const event of ['resize','hidden','reduced']){
    const env=setup(t);await env.ready();
    if(event==='resize')env.w.dispatchEvent(new env.w.Event('resize'));
    else if(event==='hidden')env.setHidden(true);
    else{env.media.matches=true;env.media.dispatchEvent(new env.w.Event('change'));}
    env.assertClean();assert.ok(env.motions.every(motion=>motion.cancelled));await tick();
  }
});

test('missing app readiness and a stalled atlas have bounded fallbacks',async t=>{
  const missing=setup(t);missing.expire();missing.assertClean();await missing.ready();assert.equal(missing.motions.length,0);
  let release;const stalled=setup(t),atlas=stalled.atlasWith(new Promise(resolve=>{release=resolve;}));
  stalled.w.RedlineMapIntro.start(atlas);assert.deepEqual(stalled.guards(),[1500],'The first frame gets 1.5s, then the live map simply shows');
  stalled.expire();stalled.assertClean();
  release(true);await tick();stalled.flushFrames();stalled.assertClean();assert.equal(stalled.motions.length,0);assert.equal(atlas.snapshots,0);
});

test('a failed or inert atlas and partial animation construction leave the map usable',async t=>{
  const broken=[
    env=>env.atlasWith(Promise.reject(Error('Worker failed'))),
    env=>env.atlasWith(Promise.resolve(false)), // What the inert view promises where workers are unavailable.
    env=>env.atlasWith(Promise.resolve(true),null),
    ()=>({ready:Promise.resolve(true),snapshot(){throw Error('Snapshot failed');}}),
    ()=>null
  ];
  for(const atlas of broken){const env=setup(t);await env.ready(atlas(env));env.assertClean();assert.equal(env.motions.length,0);}
  const animation=setup(t,{throwAt:3});await animation.ready();animation.assertClean();
  assert.ok(animation.motions.every(motion=>motion.cancelled));await tick();
});


test('the first fold waits for its sheet while the preview remains visible',async t=>{
  let release;const env=setup(t),atlas=env.atlasWith(new Promise(resolve=>{release=resolve;}));
  env.w.RedlineMapIntro.start(atlas);await tick();env.flushFrames();
  assert.equal(env.motions.length,0);assert.equal(atlas.snapshots,0);assert.equal(env.w.document.querySelector('.map-unfold'),null);assert.equal(env.root.classList.contains('map-arriving'),false,'The preview stays visible while the sheet loads');
  release(true);await tick();env.flushFrames();assert.equal(atlas.snapshots,1);
  assert.ok(env.motions.length>0);env.w.dispatchEvent(new env.w.Event('pointerdown'));env.assertClean();
});
