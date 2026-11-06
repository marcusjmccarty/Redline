import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import '../public/trace.js';
const {measure,duration,zoomDuration,homeDuration,inkShare,inkSpeed,dwell,timeline,journey,camera,cameraView,ease,snap,spring,trackingCamera}=globalThis.RedlineTrace;
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

test('a leg takes 1.2 to 2 seconds however far it goes, and its ink eases out of port, holds steady and eases in',()=>{
  assert.equal(duration(0),150,'A leg to nowhere has nothing to show');assert.equal(duration(.5),660,'Nor one too short to see');assert.equal(duration(1),1170);assert.equal(duration(100),1350);assert.equal(duration(1600),1950);
  for(let length=1;length<1600;length+=7)assert.ok(duration(length)>=1170&&duration(length)<=1950,`${length} units take ${duration(length)}ms`);
  assert.equal(zoomDuration(8),930);assert.equal(zoomDuration(1/8),930,'Zooming costs the same in either direction');
  assert.equal(inkShare(-1),0);assert.equal(inkShare(0),0);assert.equal(inkShare(1),1);assert.equal(inkShare(2),1);
  const rate=(t,step=1e-4)=>(inkShare(t+step)-inkShare(t))/step;
  assert.ok(rate(0)<.01&&rate(1-1e-4)<.01,'It starts and stops at rest');
  for(const t of [.3,.5,.7])assert.ok(Math.abs(rate(t)-rate(.4))<1e-6,'And holds one speed through the middle');
  for(let t=0;t<1;t+=.002)assert.ok(Math.abs(rate(t+.002)-rate(t))<.03,`With no jerk at ${t}`);
  const run=timeline({from:0,to:1,duration:2000}),first=run.advance(16).position,second=run.advance(84).position;
  assert.ok(first>0&&first<.001&&second<.02,`The hand-zoomed ink starts softly too (${first}, ${second})`);
  assert.ok(Math.abs(run.advance(900).position-inkShare(.5))<1e-9);
  assert.equal(run.advance(1000).done,true);
});

test('reverse, resumed progress, and speed boosts retain exact arrival',()=>{
  const reverse=timeline({from:.7,to:0,duration:2000});
  assert.ok(Math.abs(reverse.advance(400).position-.7*(1-inkShare(400/1400)))<1e-8);assert.equal(reverse.advance(1000).position,0);
  const slow=timeline({from:.25,to:1,duration:2000}),fast=timeline({from:.25,to:1,duration:2000});
  slow.advance(100);assert.equal(slow.advance(100).position,fast.advance(200).position);
  assert.equal(fast.advance(100000).position,1);
});

test('projected line reveal retains the same full arc and excludes date-line jumps',()=>{
  const flat={a:1,d:1,e:0,f:0};
  for(const [from,to] of [[[-78.4678,-.1807],[-3.7038,40.4168]],[[-157.86,21.31],[139.69,35.68]],[[179,65],[-179,65]],[[0,80],[180,80]]]){
    const leg=measure(route(from,to));
    for(const fraction of [.1,.3,.5,.8,1])assert.ok(Math.abs(measure(leg.screenPathAt(fraction,flat)).length/leg.length-fraction)<.01,`${fraction} of the arc`);
  }
  const dateLine=measure(route([179,65],[-179,65]));
  assert.equal((dateLine.path.match(/M/g)||[]).length,2);assert.ok(dateLine.length<20);
  assert.ok(!measure(route([0,0],[0,0])).screenPathAt(.5,flat).includes('NaN'));
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
      assert.ok(Math.abs(view.w/previous.w-1)<.11,'Zoom changes without frame-sized jumps, even with the snappier spring');
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
      const widthRatio=plan.arrival.w/start.w,run=journey({geometry,space,start,plan});
      let state;
      do{
        state=run.advance(16);
        const tip=geometry.pointAt(state.position),frame=cameraView(start,plan,tip,state.time);
        assert.ok(Math.abs(Math.log2(frame.w/view.w))/.016<2.2,'At normal speed the zoom changes by about 2.1 doublings per second at most');
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
});

test('long automatic zooms ease into a steady middle speed in either direction',()=>{
  for(const ratio of [1/32,32]){
    const start={x:0,y:0,w:100,h:50},end={x:0,y:0,w:100*ratio,h:50*ratio},geometry=measure('M0,0L.01,0'),space={width:1200,height:800,left:40,right:1160,top:40,bottom:640};
    const plan={follow:()=>end,arrival:end},run=journey({geometry,space,start,plan});
    let last=start,maxSpeed=0;
    for(let i=0;i<400;i++){
      const state=run.advance(16),frame=cameraView(start,plan,[0,0],state.time);
      maxSpeed=Math.max(maxSpeed,Math.abs(Math.log2(frame.w/last.w))/.016);last=frame;
      if(state.done)break;
    }
    assert.deepEqual(last,end);assert.ok(maxSpeed<2.2,`Peak zoom ${maxSpeed} octaves per second`);
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
    // Only the longest legs may lift the ink's pace above its usual speed.
    const limit=inkSpeed(space)*1.45;
    let start=worldFrame;
    for(const pair of routes){
      const geometry=measure(route(...pair)),plan=camera(geometry,space,worldFrame,geometry.pointAt(1));
      const run=journey({geometry,space,start,plan});
      assert.ok(run.duration>=150&&run.duration<4600,`Move duration ${run.duration}ms for ${pair} on ${width}×${height}`);
      let state,previous=start,last=geometry.pointAt(0);
      do{
        state=run.advance(16);const point=geometry.pointAt(state.position),view=cameraView(start,plan,point,state.time);
        const zoom=Math.abs(Math.log2(view.w/previous.w))/.016;
        assert.ok(zoom<2.2,`Zoom stays within about 2.1 octaves per second (${zoom})`);
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

test('a seven-stop trip around the world takes about twelve seconds at normal speed, a moment at each port included',()=>{
  const cities=[[-74.006,40.7128],[-.1257,51.5085],[31.2497,30.0626],[77.2315,28.6519],[139.6917,35.6895],[151.2073,-33.8679],[-43.1729,-22.9068]];
  for(const [width,height] of [[1440,900],[1920,1080],[390,844],[844,390]]){
    const space={width,height,left:30,right:width-30,top:30,bottom:height-130},legs=cities.slice(1).map((to,i)=>measure(route(cities[i],to)));
    let view=worldFrame,total=dwell*(legs.length-1);
    legs.forEach((geometry,i)=>{
      // The same composition the app asks for: each leg knows its neighbours.
      const plan=camera(geometry,space,worldFrame,project(cities[i+1]),null,legs[i-1],legs[i+1]);
      total+=journey({geometry,space,start:view,plan}).duration;view=plan.arrival;
    });
    assert.ok(total>11000&&total<13400,`${total}ms on ${width}×${height}`);
  }
});

test('camera moves answer at once and land softly',()=>{
  assert.equal(snap(0),0);assert.equal(snap(1),1);assert.equal(snap(-1),0);assert.equal(snap(2),1);
  assert.ok(snap(.05)>ease(.05)*50,'The first frames already cover real ground, unlike a symmetric ease');
  assert.ok(snap(.05)>.1&&snap(.25)>.5,`Most of the move happens early (${snap(.25)})`);
  assert.ok(1-snap(.98)<.0001,'The last frames barely move');
  for(let t=0;t<1;t+=.01)assert.ok(snap(t+.01)>=snap(t),'A camera move never doubles back');
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

// Where the app's camera really is when a leg begins: the frame the previous leg settled on, or wherever the map was left.
function sail(names,space,start=worldFrame){
  const legs=names.slice(1).map((to,i)=>measure(route(names[i],to)));let view=start;
  return legs.map((geometry,i)=>{
    const plan=camera(geometry,space,worldFrame,project(names[i+1]),null,legs[i-1],legs[i+1]),from=view,run=journey({geometry,space,start:from,plan});
    let state,farOff=0,time=0;
    do{
      state=run.advance(16);time+=16;const [x,y]=geometry.pointAt(state.position),frame=cameraView(from,plan,[x,y],state.time);
      const sx=(x-frame.x)*space.width/frame.w,sy=(y-frame.y)*space.height/frame.h;
      if(sx<-24||sx>space.width+24||sy<-24||sy>space.height+24)farOff+=16;
    }while(!state.done);
    assert.equal(state.position,1);view=plan.arrival;
    return {duration:run.duration,farOff};
  });
}
const places={rome:[12.5113,41.8919],london:[-.1257,51.5085],paris:[2.3488,48.8534],tokyo:[139.6917,35.6895],sydney:[151.2073,-33.8679],auckland:[174.7635,-36.8485],rio:[-43.1729,-22.9068],prague:[14.4208,50.088],krakow:[19.9366,50.0614],honolulu:[-157.8583,21.3069]};

test('ink out of sight does not crawl: a leg starting far from the camera takes no longer at any zoom',()=>{
  for(const [width,height] of [[1440,900],[3840,2160]]){
    const space={width,height,left:54,right:width-54,top:54,bottom:height-166},[tx,ty]=project(places.tokyo);
    const fromWorld=sail([places.london,places.paris],space)[0].duration;
    for(const zoom of [13,40,240]){
      const w=1440/zoom,h=720/zoom,{duration:took,farOff}=sail([places.london,places.paris],space,{x:tx-w/2,y:ty-h/2,w,h})[0];
      assert.ok(took<fromWorld+2400,`${zoom}× over Tokyo at ${width}×${height}: ${took}ms against ${fromWorld}ms from the world`);
      assert.ok(took-farOff>=1100,`And the ink is drawn where it can be seen (${farOff}ms of ${took}ms out of sight)`);
    }
  }
});

test('a leg leaving a close-up across the date line or the Arctic waits for the camera rather than drawing out of sight',()=>{
  for(const [width,height] of [[1440,900],[2560,1440],[3840,2160]]){
    const space={width,height,left:54,right:width-54,top:54,bottom:height-166};
    for(const trip of [[places.sydney,places.auckland,places.rio],[places.prague,places.krakow,places.honolulu]]){
      const leg=sail(trip,space)[1];
      assert.ok(leg.duration<5000,`The long leg takes ${leg.duration}ms at ${width}×${height}`);
      assert.ok(leg.farOff<=64,`The tip stays in the window (${leg.farOff}ms out of it)`);
    }
  }
});

test('a leg that goes nowhere holds the next leg\'s composition and is over quickly, and its neighbours ignore it',()=>{
  const space={width:1440,height:900,left:54,right:1386,top:54,bottom:734},rome=[12.5113,41.8919];
  const still=measure(route(places.london,places.london)),onward=measure(route(places.london,rome));
  assert.equal(still.length,0);assert.equal((still.path.match(/L/g)||[]).length,8,'Nothing to draw, so hardly any points');
  const alone=camera(onward,space,worldFrame,project(rome)),plan=camera(still,space,worldFrame,project(places.london),null,null,onward);
  assert.equal(plan.arrival.w,alone.arrival.w,'It frames the next real leg, not a 36× dive');
  assert.deepEqual(camera(onward,space,worldFrame,project(rome),null,still,null).arrival,alone.arrival,'The next leg is composed as if it were not there');
  assert.equal(camera(still,space,worldFrame,project(places.london),null,still,onward).arrival.w,alone.arrival.w,'Three stops in one place do not dive at one another either');
  assert.ok(journey({geometry:still,space,start:worldFrame,plan}).duration<3200,'Only the camera takes any time');
  assert.equal(journey({geometry:still,space,start:plan.arrival,plan}).duration,duration(0),'With the camera in place it takes a moment');
  const nowhere=camera(still,space,worldFrame,project(places.london));assert.equal(nowhere.arrival.w,1440,'A route of one place twice stays on the world');
});

test('a leg resumed near its port takes only the time that is left',()=>{
  const space={width:1440,height:900,left:54,right:1386,top:54,bottom:734},geometry=measure(route(places.london,places.paris));
  const plan=camera(geometry,space,worldFrame,project(places.paris)),whole=journey({geometry,space,start:plan.arrival,plan}).duration;
  for(const from of [.9,.97]){
    const left=journey({geometry,space,start:plan.arrival,plan,from}).duration;
    assert.ok(left<=whole*(1-from)*1.05+1,`From ${from}, ${left}ms of a ${whole}ms leg`);
  }
  assert.ok(whole>=1170,'A whole leg keeps its minimum');
});

// Every 16ms of a voyage: the ink's speed on screen, the map's zoom, and where the tip is.
function playback(stops,space){
  const legs=stops.slice(1).map((to,i)=>measure(route(stops[i],to)));let view=worldFrame;
  return legs.map((geometry,i)=>{
    const plan=camera(geometry,space,worldFrame,project(stops[i+1]),null,legs[i-1],legs[i+1]),from=view,run=journey({geometry,space,start:from,plan}),frames=[];
    let state,last=geometry.pointAt(0),previous=from;
    do{
      state=run.advance(16);const tip=geometry.pointAt(state.position),frame=cameraView(from,plan,tip,state.time);
      const sx=space.width*2/(frame.w+previous.w),sy=space.height*2/(frame.h+previous.h);
      frames.push({ink:Math.abs(tip[0]-last[0])>720?null:Math.hypot((tip[0]-last[0])*sx,(tip[1]-last[1])*sy)/.016,zoom:Math.log2(previous.w/frame.w)/.016,x:(tip[0]-frame.x)*space.width/frame.w,y:(tip[1]-frame.y)*space.height/frame.h,position:state.position});
      last=tip;previous=frame;
    }while(!state.done);
    view=plan.arrival;
    return {geometry,duration:run.duration,level:worldFrame.w/plan.arrival.w,frames};
  });
}
const voyages={
  voyage:[[-9.1393,38.7223],[-5.9845,37.3891],[-7.9811,31.6295],[-6.2886,36.5271],[12.5113,41.8919],[23.7278,37.9838],[28.9784,41.0082],[31.2497,30.0626],[58.4059,23.5859],[72.8777,19.076],[85.324,27.7172],[100.5018,13.7563],[103.8198,1.3521],[-43.1729,-22.9068]],
  world:[[-74.006,40.7128],[-.1257,51.5085],[31.2497,30.0626],[77.2315,28.6519],[139.6917,35.6895],[151.2073,-33.8679],[-43.1729,-22.9068]],
  europe:[[-.1257,51.5085],[2.3488,48.8534],[4.9041,52.3676],[13.405,52.52],[14.4208,50.088],[16.3738,48.2082]],
  italy:[[9.19,45.4642],[12.3155,45.4408],[11.2558,43.7696],[11.3308,43.3188],[12.4964,41.9028],[14.2681,40.8518],[16.8719,41.1171]],
};
const viewports=[[1440,900,{left:54,right:1386,top:54,bottom:734}],[390,844,{left:35,right:355,top:35,bottom:659}]].map(([width,height,rest])=>({width,height,...rest}));

test('on every leg the ink eases out of port, keeps one speed through the middle and eases into the next, without a jerk',()=>{
  for(const space of viewports)for(const [name,stops] of Object.entries(voyages))playback(stops,space).forEach(({frames,duration:took},leg)=>{
    const seen=frames.map(f=>f.ink).filter(speed=>speed!==null),moving=seen.findIndex(speed=>speed>0),peak=Math.max(...seen),journeyed=seen.slice(moving);
    const label=`${name} leg ${leg} at ${space.width}: peak ${peak.toFixed(0)}px/s`;
    assert.ok(journeyed[0]<peak*.12,`${label} starts at ${journeyed[0]}`);assert.ok(seen.at(-1)<peak*.12,`${label} ends at ${seen.at(-1)}`);
    const middle=journeyed.slice(Math.ceil(journeyed.length*.3),Math.floor(journeyed.length*.7)),low=Math.min(...middle),high=Math.max(...middle);
    assert.ok(low>high*.9,`${label} holds ${low.toFixed(0)} to ${high.toFixed(0)} through the middle`);
    // One frame's change of speed, as a share of the top speed, is no more than a smooth ramp over about 150ms asks.
    for(let i=1;i<journeyed.length;i++)assert.ok(Math.abs(journeyed[i]-journeyed[i-1])<peak*.14,`${label} jumps ${journeyed[i-1].toFixed(0)} to ${journeyed[i].toFixed(0)} at frame ${i} of ${took/16|0}`);
    assert.ok(peak<inkSpeed(space)*1.45,label);
  });
});

test('a short hop is not a flash, an ocean does not drag, and the ink is never lost off screen',()=>{
  for(const space of viewports)for(const [name,stops] of Object.entries(voyages)){
    const legs=playback(stops,space);
    legs.forEach(({duration:took,frames},leg)=>{
      assert.ok(took>=1170,`${name} leg ${leg} takes ${took}ms`);
      if(leg)assert.ok(took<3000,`${name} leg ${leg} takes ${took}ms`);else assert.ok(took<4600,`${name}'s first leg zooms from the whole world in ${took}ms`);
      // Below the dock is hidden, not off screen, and a whole-world leg can pass there.
      assert.ok(frames.every(f=>f.x>=-1&&f.x<=space.width+1&&f.y>=-1&&f.y<=space.height+1),`${name} leg ${leg}: the tip stays in the window`);
    });
  }
});

test('the camera does not breathe in and out through a local itinerary',()=>{
  for(const space of viewports)for(const stops of [voyages.europe,voyages.italy]){
    const levels=playback(stops,space).map(leg=>leg.level);
    const swings=levels.slice(1).map((level,i)=>Math.log2(level/levels[i]));
    swings.slice(1).forEach((swing,i)=>assert.ok(swing*swings[i]>=0||Math.min(Math.abs(swing),Math.abs(swings[i]))<.4,`In and out by whole octaves: ${levels.map(level=>level.toFixed(1))}`));
    assert.ok(Math.max(...swings.map(Math.abs))<.75,`Levels ${levels.map(level=>level.toFixed(1))}`);
  }
  // Nor does the first leg dive further than the next one wants, only to pull straight out again.
  const [first,second]=playback(voyages.voyage,viewports[0]);
  assert.ok(first.level<second.level*1.61,`${first.level} then ${second.level}`);
});

test('from the overview the camera answers at once and the ink sets out once there is something to see',()=>{
  for(const space of viewports)for(const stops of [voyages.italy,voyages.europe,voyages.voyage]){
    const [{frames,level,duration:took}]=playback(stops,space),begun=frames.findIndex(f=>f.position>1e-4);
    assert.ok(frames[9].zoom>0,'The zoom is under way within 160ms');
    assert.ok(begun*16>took*.3&&begun*16<took*.8,`The ink leaves at ${begun*16}ms of ${took}ms`);
    assert.ok(frames.reduce((sum,f,i)=>i<begun?sum+f.zoom*.016:sum,0)>Math.log2(level)*.5,'With the zoom more than half done');
    assert.ok(Math.max(...frames.map(f=>f.ink??0))>inkSpeed(space)*.3,'And it is drawn at a speed worth watching');
  }
});

test('the way home from a voyage is gentler than a press of the key, and a port is held long enough to read',()=>{
  assert.ok(dwell>=300&&dwell<=450,`${dwell}ms`);
  for(const octaves of [1,3,5])assert.ok(homeDuration(2**octaves)>zoomDuration(2**octaves)*1.4,`${octaves} octaves`);
  assert.ok(homeDuration(32)<3000,'And still not a long wait');
});

test('a leg resumed anywhere, in either direction, sets out softly from where it stopped and never doubles back',()=>{
  for(const space of viewports)for(const [from,to] of [[.25,1],[.5,1],[.8,1],[.8,0],[.3,0]]){
    const geometry=measure(route(places.london,places.rome)),plan=camera(geometry,space,worldFrame,geometry.pointAt(to)),start={...plan.arrival},run=journey({geometry,space,start,plan,from,to}),sign=Math.sign(to-from);
    const whole=journey({geometry,space,start,plan}).duration;
    assert.ok(run.duration<=whole*Math.abs(to-from)*1.25+1,`${run.duration}ms for ${Math.abs(to-from)} of a ${whole}ms leg`);
    let state=run.advance(16),last=state.position;
    assert.ok(Math.abs(state.position-from)<.004,`The first frame moves it little (${state.position} from ${from})`);
    while(!state.done){state=run.advance(16);assert.ok((state.position-last)*sign>=-1e-12,'Onward only');last=state.position;}
    assert.equal(state.position,to);
  }
});

test('the tracking camera cuts to a new point without sweeping the sheet',()=>{
  const space={width:1440,height:900,left:0,right:1440,top:0,bottom:900},start={x:0,y:150,w:360,h:180},tracker=trackingCamera(start,space,worldFrame,240);
  tracker.step([200,240],4,16);tracker.jump([1000,240]);
  const frame=tracker.step([1000,240],4,16);
  assert.ok(Math.abs(frame.x+frame.w/2-1000)<1,`The next frame is already there (${frame.x})`);
});
