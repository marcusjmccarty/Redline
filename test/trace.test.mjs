import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import '../public/trace.js';
const {measure,duration,timeline,camera,cameraView,ease,spring,trackingCamera}=globalThis.RedlineTrace;
import '../public/map-layout.js';
const context={window:{}};vm.createContext(context);
vm.runInContext(readFileSync('public/vendor/geo.js','utf8'),context);
vm.runInContext(readFileSync('public/world.js','utf8'),context);
const {RedlineGeo:geo,window:world}=context;
const {project,route:routePath}=globalThis.RedlineLayout;

function route(from,to){return routePath(geo.geoInterpolate(from,to));}

test('trace has time for a gentle camera move and starts without a delay',()=>{
  assert.equal(duration(10),1600);assert.equal(duration(300),1800);assert.equal(duration(1000),3600);
  const run=timeline({from:0,to:1,duration:2000});
  assert.equal(run.advance(100).position,.05);
  assert.equal(run.advance(900).position,.5);
  assert.equal(run.advance(1000).done,true);
});

test('reverse, resumed progress, and speed boosts retain exact arrival',()=>{
  const reverse=timeline({from:.7,to:0,duration:2000});
  assert.ok(Math.abs(reverse.advance(400).position-.5)<1e-8);assert.equal(reverse.advance(1000).position,0);
  const slow=timeline({from:.25,to:1,duration:2000}),fast=timeline({from:.25,to:1,duration:2000});
  slow.advance(100);assert.equal(slow.advance(100).position,fast.advance(200).position);
  assert.equal(fast.advance(100000).position,1);
});

test('projected line reveal retains the same full arc and excludes date-line jumps',()=>{
  for(const [from,to] of [[[-78.4678,-.1807],[-3.7038,40.4168]],[[-157.86,21.31],[139.69,35.68]],[[179,65],[-179,65]],[[0,80],[180,80]]]){
    const full=route(from,to),leg=measure(full);
    assert.equal(leg.pathAt(1),full);
    for(const fraction of [.1,.3,.5,.8])assert.ok(Math.abs(measure(leg.pathAt(fraction)).length/leg.length-fraction)<1e-8);
  }
  const dateLine=measure(route([179,65],[-179,65]));
  assert.equal((dateLine.path.match(/M/g)||[]).length,2);assert.ok(dateLine.length<20);
  assert.ok(!measure(route([0,0],[0,0])).pathAt(.5).includes('NaN'));
});

test('the restored map matches the original geography and keeps the entire world in frame',()=>{
  assert.equal(createHash('sha256').update(readFileSync('public/world.js')).digest('hex'),'0c173428c68e58e063b2ec2b0706199fe8b71fbae91804bfcc00f3dc0915c9e0');
  assert.equal(world.WORLD_PATHS.length,176);assert.equal(world.REGION_PATHS.length,581);
  assert.equal(world.ANTARCTICA_POLYGONS.length,8);assert.equal(world.MAP_COUNTRIES.length,176);
  for(const place of [[174.76,-36.85],[-157.86,21.31],[151.21,-33.87],[0,-90],[0,90]]){
    const [x,y]=project(place);assert.ok(x>=0&&x<=1440&&y>=0&&y<=720);
  }
  assert.deepEqual(project([0,0]),[720,360]);assert.deepEqual(project([0,90]),[720,0]);assert.deepEqual(project([0,-90]),[720,720]);
});

const worldFrame={x:0,y:0,w:1440,h:720};

test('zoom damping preserves motion through retargets and is independent of frame rate',()=>{
  const initial={value:0,velocity:0},goal=Math.log(4);
  const frames=rate=>{let state=initial;for(let i=0;i<rate;i++)state=spring(state,goal,1/rate,18);return state;};
  assert.ok(Math.abs(frames(30).value-frames(144).value)<1e-12);
  const moving=spring(initial,goal,.1,18),retarget=spring(moving,Math.log(6),0,18);
  assert.equal(retarget.velocity,moving.velocity,'Retargeting does not zero the current velocity');
  assert.ok(Math.abs(retarget.value-moving.value)<1e-12);
  const continued=spring(retarget,Math.log(6),.01,18);assert.ok(continued.value>moving.value);
  let state=continued;
  for(let i=0;i<120;i++)state=spring(state,0,1/120,18);
  assert.ok(Math.abs(state.value)<.0001&&Math.abs(state.velocity)<.001);
});

test('manual tracking retains the chosen zoom and settles exactly on the same arrival composition',()=>{
  for(const [width,height] of [[1440,900],[390,844]]){
    const space={width,height,left:25,right:width-25,top:25,bottom:height-190};
    const tracker=trackingCamera(worldFrame,space,worldFrame,(4/3)**9);let view=worldFrame;
    for(let i=0;i<120;i++){
      const target=[500+i*2,300-i*.5],previous=view;
      view=tracker.step(target,4,1000/120);
      assert.ok(view.x>=0&&view.x+view.w<=1440+.001&&view.y>=0&&view.y+view.h<=720+.001);
      assert.ok(Math.abs(view.w/previous.w-1)<.075,'Zoom changes without frame-sized jumps');
    }
    const destination=[740,240],plan=camera(measure('M500,300L740,240'),space,worldFrame,destination,4);
    for(let i=0;i<180;i++)view=tracker.step(destination,4,1000/120);
    for(const key of ['x','y','w','h'])assert.ok(Math.abs(view[key]-plan.arrival[key])<.001);
  }
});

test('one smooth camera move fits both cities and has no zoom reversals or date-line sweeps',()=>{
  const pairs=[[[ -78.4678,-.1807],[-3.7038,40.4168]],[[-9.14,38.72],[151.21,-33.87]],[[-157.86,21.31],[139.69,35.68]],[[-.13,51.51],[2.35,48.86]]];
  for(const [width,height] of [[1440,900],[1920,1080],[390,844]])for(const pair of pairs)for(const reverse of [false,true]){
    const [from,to]=reverse?[...pair].reverse():pair,geometry=measure(route(from,to));
    const space={width,height,left:Math.min(54,width*.09),right:width-Math.min(54,width*.09),top:54,bottom:height-200};
    const plan=camera(geometry,space,worldFrame,project(to));let previous=worldFrame;
    assert.deepEqual(cameraView(worldFrame,plan,project(from),0),worldFrame);
    for(let i=1;i<=100;i++){
      const amount=i/100,frame=cameraView(worldFrame,plan,geometry.pointAt(ease(amount)),amount);
      assert.ok(frame.w<=previous.w+1e-8,'A leg has only one zoom direction');
      assert.ok(Math.hypot(frame.x-previous.x,frame.y-previous.y)<25,'No sudden pan jumps');previous=frame;
    }
    assert.deepEqual(previous,plan.arrival,'Fast and normal arrivals use the same exact frame');
    for(const city of [from,to]){const [x,y]=project(city),sx=(x-previous.x)*width/previous.w,sy=(y-previous.y)*height/previous.h;assert.ok(sx>=0&&sx<=width&&sy>=0&&sy<space.bottom+1,'Both cities stay in the final frame above controls');}
    if(geometry.crossesSeam)assert.deepEqual(plan.follow(project(from)),plan.follow(project(to)),'Date-line travel avoids a jump across the sheet');
    const nearStart=cameraView(worldFrame,plan,geometry.pointAt(ease(.0001)),.0001),nearEnd=cameraView(worldFrame,plan,geometry.pointAt(ease(.9999)),.9999);
    assert.ok(Math.abs(nearStart.w-worldFrame.w)<.000001&&Math.abs(nearEnd.w-plan.arrival.w)<.000001,'Camera starts and lands with zero velocity');
  }
});
