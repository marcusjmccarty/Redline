import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('../map.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../public/map-intro.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function setup(t,{reduced=false,hidden=false,supported=true,decode=()=>Promise.resolve(),throwAt=0}={}){
  const dom=new JSDOM(html,{url:'https://redline.test/Redline/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,root=w.document.documentElement,timers=new Map(),frames=new Map(),motions=[],images=[];
  let id=0;const media=new w.EventTarget();media.matches=reduced;
  Object.defineProperty(w.document,'hidden',{configurable:true,get:()=>hidden});
  w.matchMedia=()=>media;
  w.setTimeout=callback=>{timers.set(++id,callback);return id;};w.clearTimeout=id=>timers.delete(id);
  w.requestAnimationFrame=callback=>{frames.set(++id,callback);return id;};w.cancelAnimationFrame=id=>frames.delete(id);
  w.Element.prototype.getBoundingClientRect=()=>({width:1440,height:900});
  if(supported)w.Element.prototype.animate=function(keys,options){
    if(throwAt&&motions.length+1===throwAt)throw Error('Animation unavailable');
    let resolve,reject;
    const motion={target:this,keys,options,cancelled:false,finished:new Promise((yes,no)=>{resolve=yes;reject=no;}),complete:()=>resolve(),cancel(){this.cancelled=true;reject(Error('Cancelled'));}};
    motions.push(motion);return motion;
  };
  w.Image=class {constructor(){this.naturalWidth=1024;images.push(this);}decode(){return decode(this.src);}};
  w.eval(script);
  const flushFrames=()=>{const batch=[...frames.values()];frames.clear();for(const callback of batch)callback();};
  const ready=async()=>{w.RedlineMapIntro.start();await tick();flushFrames();};
  const expire=()=>{const batch=[...timers.values()];timers.clear();for(const callback of batch)callback();};
  const assertClean=()=>{
    assert.equal(root.classList.contains('map-arriving'),false,'The real map and controls are visible');
    assert.equal(root.classList.contains('map-revealing'),false,'The prepaint state is fully cleared');
    assert.equal(w.document.querySelector('.map-unfold'),null,'No temporary rendering layers remain');
    assert.equal(timers.size,0);assert.equal(frames.size,0);
  };
  t.after(()=>{w.dispatchEvent(new w.Event('pagehide'));dom.window.close();});
  return {w,root,media,motions,images,timers,frames,ready,expire,flushFrames,assertClean,setHidden:value=>{hidden=value;w.document.dispatchEvent(new w.Event('visibilitychange'));}};
}

test('the opening sheet shares the live artwork and hands off without replacing the map',async t=>{
  const env=setup(t),{w,motions}=env,map=w.document.getElementById('map'),art=w.document.getElementById('map-artwork');
  await env.ready();
  const faces=[...w.document.querySelectorAll('.unfold-face svg')];
  assert.deepEqual(faces.map(face=>face.getAttribute('viewBox')),['0 0 720 360','0 360 720 360','720 0 720 360','720 360 720 360']);
  for(const face of faces){
    const uses=[...face.querySelectorAll('use')];
    assert.deepEqual(uses.map(node=>node.getAttribute('href')),['#map-artwork','#route-lines','#route-stops'],'The unfolding sheet includes the connecting ink before the city pins');
    assert.equal(uses[1].getAttribute('transform'),uses[2].getAttribute('transform'));
  }
  assert.equal(w.document.querySelectorAll('#map-artwork').length,1,'The atlas is referenced, not copied into four expensive DOM trees');
  w.RedlineMapIntro.start();assert.equal(w.document.querySelectorAll('.map-unfold').length,1);
  for(const motion of motions)motion.complete();await tick();
  assert.ok(env.root.classList.contains('map-revealing'),'The real map is exposed beneath the finished paper');
  assert.ok(w.document.querySelector('.map-unfold'),'The cover stays until the live map has painted');
  env.flushFrames();assert.ok(w.document.querySelector('.map-unfold'));
  env.flushFrames();env.assertClean();
  assert.equal(w.document.getElementById('map'),map);assert.equal(w.document.getElementById('map-artwork'),art);
  w.RedlineMapIntro.start();await tick();assert.equal(w.document.querySelector('.map-unfold'),null,'The intro runs once per page load');
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
    const env=setup(t,options);await env.ready();env.assertClean();assert.equal(env.images.length,0);assert.equal(env.motions.length,0);
  }
});

test('interaction skips an active fold without swallowing the user action',async t=>{
  const env=setup(t);await env.ready();let received=0;
  const button=env.w.document.getElementById('play');button.addEventListener('keydown',()=>received++);
  const event=new env.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});button.dispatchEvent(event);
  env.assertClean();assert.equal(received,1);assert.equal(event.defaultPrevented,false);
  assert.ok(env.motions.every(motion=>motion.cancelled));await tick();
});

test('a late image decode cannot restart an intro dismissed by the user',async t=>{
  let release;const decoded=new Promise(resolve=>{release=resolve;}),env=setup(t,{decode:()=>decoded});
  env.w.RedlineMapIntro.start();env.w.dispatchEvent(new env.w.Event('pointerdown'));env.assertClean();
  release();await tick();env.flushFrames();env.assertClean();assert.equal(env.motions.length,0);
});

test('initial viewport sizing does not dismiss a fold that has not begun',async t=>{
  let release;const decoded=new Promise(resolve=>{release=resolve;}),env=setup(t,{decode:()=>decoded});
  env.w.RedlineMapIntro.start();env.w.dispatchEvent(new env.w.Event('resize'));
  assert.ok(env.root.classList.contains('map-arriving'));
  release();await tick();env.flushFrames();
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

test('missing app readiness and stalled image decoding have bounded fallbacks',async t=>{
  const missing=setup(t);missing.expire();missing.assertClean();await missing.ready();assert.equal(missing.motions.length,0);
  let release;const decoded=new Promise(resolve=>{release=resolve;}),stalled=setup(t,{decode:()=>decoded});
  stalled.w.RedlineMapIntro.start();stalled.expire();stalled.assertClean();
  release();await tick();stalled.flushFrames();stalled.assertClean();assert.equal(stalled.motions.length,0);
});

test('failed image and partial animation construction leave the map usable',async t=>{
  const image=setup(t,{decode:()=>Promise.reject(Error('Image failed'))});await image.ready();image.assertClean();
  const animation=setup(t,{throwAt:3});await animation.ready();animation.assertClean();
  assert.ok(animation.motions.every(motion=>motion.cancelled));await tick();
});


test('the first fold waits for both colour and terrain before exposing either',async t=>{
  const pending=new Map(),env=setup(t,{decode:src=>new Promise(resolve=>pending.set(src,resolve))});
  env.w.RedlineMapIntro.start();assert.equal(pending.size,2);
  pending.get('atlas-tones.png')();await tick();env.flushFrames();assert.equal(env.motions.length,0);
  pending.get('relief/overview.webp')();await tick();env.flushFrames();
  assert.ok(env.motions.length>0);env.w.dispatchEvent(new env.w.Event('pointerdown'));env.assertClean();
});
