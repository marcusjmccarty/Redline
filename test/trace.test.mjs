import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import '../public/trace.js';
const {measure,duration,timeline,journey,camera,cameraView,ease,spring,trackingCamera}=globalThis.RedlineTrace;
import '../public/map-layout.js';
const context={window:{}};vm.createContext(context);
vm.runInContext(readFileSync('public/vendor/geo.js','utf8'),context);
vm.runInContext(readFileSync('public/world.js','utf8'),context);
const {RedlineGeo:geo,window:world}=context;
const {project,route:routePath}=globalThis.RedlineLayout;

function route(from,to){return routePath(geo.geoInterpolate(from,to));}

test('screen-space ink retains its exact arc, arrival and date-line breaks at every zoom',()=>{
  for(const pair of [[[2,48],[2.02,48.01]],[[-74,41],[31,30]],[[175,20],[-175,20]]]){
    const leg=measure(route(...pair));
    for(const zoom of [1,8,72,240]){
      const matrix={a:zoom,d:zoom*1.4,e:-710*zoom,f:-300*zoom};
      assert.equal(leg.screenPathAt(0,matrix),'');
      for(const amount of [.01,.5,1]){
        const screen=measure(leg.screenPathAt(amount,matrix)),end=screen.pointAt(1),point=leg.pointAt(amount);
        assert.ok(Math.abs(end[0]-(point[0]*matrix.a+matrix.e))<.011);
        assert.ok(Math.abs(end[1]-(point[1]*matrix.d+matrix.f))<.011);
        if(amount===1)assert.equal(screen.crossesSeam,leg.crossesSeam);
      }
    }
  }
});

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

test('label obstacles use only revealed route segments and never bridge the date line',()=>{
  const geometry=measure('M0,0L10,0M100,100L110,100');
  assert.deepEqual(geometry.segmentsAt(0),[]);
  assert.deepEqual(geometry.segmentsAt(.25),[[[0,0],[5,0]]]);
  assert.deepEqual(geometry.segmentsAt(.75),[[[0,0],[10,0]],[[100,100],[105,100]]]);
  assert.deepEqual(geometry.segmentsAt(1),[[[0,0],[10,0]],[[100,100],[110,100]]]);
  const crossing=measure(route([179,65],[-179,65]));
  assert.ok(crossing.segmentsAt(1).every(([a,b])=>Math.hypot(b[0]-a[0],b[1]-a[1])<20));
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
    const plan=camera(geometry,space,worldFrame,project(to)),playback=journey({geometry,space,start:worldFrame,plan});let previous=worldFrame;
    assert.deepEqual(cameraView(worldFrame,plan,project(from),0),worldFrame);
    for(let i=0;i<Math.ceil(playback.duration/16);i++){
      const state=playback.advance(16),frame=cameraView(worldFrame,plan,geometry.pointAt(state.position),state.time);
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

test('nearby legs retain context and regional routes fill a useful part of the viewport',()=>{
  const space={width:1200,height:800,left:40,right:1160,top:40,bottom:640};
  function frame(from,to){
    const geometry=measure(route(from,to)),dest=project(to),start=project(from);
    const view=camera(geometry,space,worldFrame,dest).arrival;
    for(const [x,y] of [start,dest]){
      const sx=(x-view.x)*space.width/view.w,sy=(y-view.y)*space.height/view.h;
      assert.ok(sx>=space.left-1&&sx<=space.right+1&&sy>=space.top-1&&sy<=space.bottom+1);
    }
    return {level:worldFrame.w/view.w,separation:Math.hypot((dest[0]-start[0])*space.width/view.w,(dest[1]-start[1])*space.height/view.h)};
  }
  const short=frame([-78.424,-1.396],[-78.062,-1.505]),regional=frame([-78.062,-1.505],[-78.145,.04]);
  assert.ok(short.level>regional.level&&regional.level>10);
  assert.ok(short.separation>40&&short.level<=36,'A small hop stays legible without an extreme close-up');
  assert.ok(regional.separation>180,'Regional journeys are not lost in empty space');
  assert.ok(frame([-80.19,25.76],[-78.47,-.18]).separation>240,'Longer legs still occupy at least 40% of the available height');
});

test('the ink stays on screen and zoom changes at a bounded rate across long and short legs',()=>{
  const places=[[-80.19,25.76],[-78.47,-.18],[-78.424,-1.396],[-78.062,-1.505],[-78.145,.04],[-3.7038,40.4168]];
  const space={width:1200,height:800,left:40,right:1160,top:40,bottom:640};
  for(const stops of [places,[...places].reverse()]){
    let view=worldFrame;
    for(let i=1;i<stops.length;i++){
      const geometry=measure(route(stops[i-1],stops[i])),start=view,plan=camera(geometry,space,worldFrame,geometry.pointAt(1));
      const widthRatio=plan.arrival.w/start.w,run=timeline({from:0,to:1,duration:duration(geometry.length),widthRatio,easeStops:true});
      let state;
      do{
        state=run.advance(16);
        const tip=geometry.pointAt(state.position),frame=cameraView(start,plan,tip,state.time);
        assert.ok(Math.abs(Math.log2(frame.w/view.w))/.016<1.8,'At normal speed the zoom changes by less than 1.8 doublings per second');
        const x=(tip[0]-frame.x)*space.width/frame.w,y=(tip[1]-frame.y)*space.height/frame.h;
        assert.ok(x>=0&&x<=space.width&&y>=0&&y<=space.bottom,'The ink stays in the available map area');
        if(widthRatio>4&&state.time<.5)assert.ok(state.position<state.time/2,'A long leg waits for the map to pull back');
        view=frame;
      }while(!state.done);
      assert.equal(state.position,1);assert.deepEqual(view,plan.arrival);
    }
  }
});

test('an isolated local leg eases the zoom peak while successive nearby legs retain their detail',()=>{
  const wide=measure('M480,360L720,360'),local=measure('M720,360L722,360');
  const space={width:1200,height:800,left:40,right:1160,top:40,bottom:640};
  const frame=(before,after)=>camera(local,space,worldFrame,local.pointAt(1),null,before,after).arrival;
  const natural=frame(null,null),isolated=frame(wide,wide);
  assert.ok(isolated.w>=natural.w*1.2&&isolated.w<=worldFrame.w/16+.001,'An isolated tiny hop limits the zoom peak while preserving at least 16× local detail');
  assert.deepEqual(frame(local,wide),natural);assert.deepEqual(frame(wide,local),natural);
  for(const [from,to] of [[0,1],[1,0]]){
    const run=timeline({from,to,duration:2000,easeStops:true}),start=run.advance(50).position;
    assert.ok(Math.abs(start-from)>0&&Math.abs(start-from)<.01);
    assert.equal(run.advance(950).position,.5);
    assert.ok(Math.abs(to-run.advance(950).position)<.01);assert.equal(run.advance(50).position,to);
  }
});

test('long automatic zooms ease into a steady middle speed in either direction',()=>{
  for(const ratio of [1/32,32]){
    const start={x:0,y:0,w:100,h:50},end={x:0,y:0,w:100*ratio,h:50*ratio};
    const plan={follow:()=>end,arrival:end},run=timeline({from:0,to:1,duration:1600,widthRatio:ratio,easeStops:true});
    let last=start,maxSpeed=0;
    for(let i=0;i<400;i++){
      const state=run.advance(16),frame=cameraView(start,plan,[0,0],state.time);
      maxSpeed=Math.max(maxSpeed,Math.abs(Math.log2(frame.w/last.w))/.016);last=frame;
      if(state.done)break;
    }
    assert.deepEqual(last,end);assert.ok(maxSpeed<1.38);
  }
});

test('automatic framing adapts to portrait space, keeps regional detail, and stops chasing the ink',()=>{
  for(const [width,height] of [[1440,900],[390,844],[844,390]]){
    const space={width,height,left:30,right:width-30,top:30,bottom:height-130};
    for(const pair of [[[0,0],[3,1]],[[0,0],[1,3]],[[10,10],[10.0001,10.0001]],[[0,0],[0,0]]]){
      const geometry=measure(route(...pair)),plan=camera(geometry,space,worldFrame,project(pair[1]));
      assert.ok(Object.values(plan.arrival).every(Number.isFinite));
      assert.ok(worldFrame.w/plan.arrival.w<=36,'Automatic close-ups retain context');
      for(const amount of [0,.25,.5,.75,1])assert.deepEqual(plan.follow(geometry.pointAt(amount)),plan.arrival,'The settled composition is fixed');
      if(geometry.length>1){
        const {left,right,top,bottom}=geometry.bounds;
        const fill=Math.max((right-left)*width/plan.arrival.w/(space.right-space.left),(bottom-top)*height/plan.arrival.h/(space.bottom-space.top));
        assert.ok(fill>.28&&fill<.5,`A regional arc stays readable with more surrounding geography (${fill})`);
      }
    }
  }
});

test('comparable neighboring legs avoid a zoom breath without losing their endpoints',()=>{
  const space={width:1200,height:800,left:40,right:1160,top:40,bottom:640};
  const a=measure('M700,300L720,300'),b=measure('M720,300L743,300');
  const first=camera(a,space,worldFrame,[720,300],null,null,b);
  const second=camera(b,space,worldFrame,[743,300],null,a,null);
  assert.equal(first.arrival.w,second.arrival.w);
});

test('the camera settles before arrival and a tiny stopover does not cause an isolated deep zoom',()=>{
  const space={width:1200,height:800,left:40,right:1160,top:40,bottom:640};
  const before=measure('M650,300L700,300'),hop=measure('M700,300L701,300'),after=measure('M701,300L760,300');
  const plan=camera(hop,space,worldFrame,[701,300],null,before,after);
  const regional=camera(before,space,worldFrame,[700,300]);
  assert.ok(worldFrame.w/plan.arrival.w<=worldFrame.w/regional.arrival.w*1.6+1e-8);
  for(const time of [.8,.9,.99,1])assert.deepEqual(cameraView(worldFrame,plan,hop.pointAt(time),time),plan.arrival);
  const run=journey({geometry:hop,space,start:worldFrame,plan});let state;
  do{state=run.advance(16);}while(state.time<.8);
  assert.ok(state.position<.99,'Some ink remains after the camera settles');
});

test('automatic playback bounds visible ink speed and zoom together in every viewport',()=>{
  const routes=[[[0,0],[2,1]],[[2,1],[2.01,1.01]],[[2.01,1.01],[100,30]],[[100,30],[101,30]],[[101,30],[175,20]],[[175,20],[-175,20]]];
  for(const [width,height] of [[1440,900],[390,844],[844,390]]){
    const space={width,height,left:30,right:width-30,top:30,bottom:height-130};
    const limit=Math.max(150,Math.min(300,Math.hypot(space.right-space.left,space.bottom-space.top)*.24));
    let start=worldFrame;
    for(const pair of routes){
      const geometry=measure(route(...pair)),plan=camera(geometry,space,worldFrame,geometry.pointAt(1));
      const run=journey({geometry,space,start,plan});
      assert.ok(run.duration<11000,`Move duration ${run.duration}ms for ${pair} on ${width}×${height}`);
      let state,previous=start,last=geometry.pointAt(0);
      do{
        state=run.advance(16);const point=geometry.pointAt(state.position),view=cameraView(start,plan,point,state.time);
        const zoom=Math.abs(Math.log2(view.w/previous.w))/.016;
        assert.ok(zoom<1.08,`Zoom advances without a rush (${zoom})`);
        if(Math.abs(point[0]-last[0])<720){
          const ink=Math.hypot((point[0]-last[0])*width/((view.w+previous.w)/2),(point[1]-last[1])*height/((view.h+previous.h)/2))/.016;
          assert.ok(ink<limit*1.04,`The ink does not surge at the end of a zoom (${ink})`);
        }
        previous=view;last=point;
      }while(!state.done);
      assert.equal(state.position,1);assert.deepEqual(previous,plan.arrival);start=previous;
    }
  }
});

test('camera and ink share the same boosted, paused and resumed clock in either direction',()=>{
  const space={width:1200,height:800,left:40,right:1160,top:40,bottom:640};
  const geometry=measure('M700,300L710,310'),start=worldFrame;
  for(const [from,to] of [[0,1],[.37,1],[.82,0],[1,0]]){
    const plan=camera(geometry,space,worldFrame,geometry.pointAt(to));
    const create=()=>journey({geometry,space,start,plan,from,to});
    const normal=create(),boost=create();let slow,fast;
    for(let i=0;i<20;i++){normal.advance(16);slow=normal.advance(16);fast=boost.advance(32);}
    assert.deepEqual(slow,fast);assert.deepEqual(normal.advance(0),slow);
    assert.deepEqual(cameraView(start,plan,geometry.pointAt(slow.position),slow.time),cameraView(start,plan,geometry.pointAt(fast.position),fast.time));
    assert.equal(normal.advance(100000).position,to);
    assert.equal(boost.advance(100000).done,true);
  }
});
