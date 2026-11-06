/* Route geometry, playback timing, and a single smooth camera move per leg. */
(() => {
  'use strict';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const maxZoom=240,autoZoomLimit=36;
  // A port is held this long, its dot and name up, before the camera moves on.
  const dwell=400;
  // Grows slowly with distance: a hop is not a flash, and an ocean does not drag. Under a sheet unit there is hardly a line to show.
  const duration=length=>length<1?150+1020*length:1150+20*Math.sqrt(length);
  const ease=value=>{const t=clamp(value,0,1);return t*t*t*(t*(t*6-15)+10);};
  // Leaves at once and settles softly: camera moves answer the moment they are asked for.
  const snap=value=>{const t=clamp(value,0,1),u=1-t;return 1-u*u*u*(1+.6*t);};
  // The share of a leg's ink laid by a share of its time: speed eases up out of the port, holds steady, and eases down into the next.
  const inkUp=.18,inkDown=.24,inkMean=1-(inkUp+inkDown)/2,inkRamp=x=>x*x*x*(1-x/2);
  function inkShare(value){
    const t=clamp(value,0,1);
    return (t<inkUp?inkUp*inkRamp(t/inkUp):t<=1-inkDown?t-inkUp/2:inkMean-inkDown*inkRamp((1-t)/inkDown))/inkMean;
  }
  // Ramp velocity smoothly over the first and last 30% of a move. The
  // constant-speed middle avoids a sudden rush on a multi-octave zoom.
  function cameraPhase(t){
    const ramp=.3,edge=Math.min(t,1-t);
    if(edge>=ramp)return (t-ramp/2)/(1-ramp);
    const u=edge/ramp,shoulder=ramp*u*u*u*(1-u/2)/(1-ramp);
    return t<.5?shoulder:1-shoulder;
  }
  // Analytic critical damping keeps velocity when a wheel gesture retargets mid-move.
  function spring(state,target,seconds,frequency=16){
    const offset=state.value-target,term=(state.velocity+frequency*offset)*seconds,decay=Math.exp(-frequency*seconds);
    return {value:target+(offset+term)*decay,velocity:(state.velocity-frequency*term)*decay};
  }
  function trackingCamera(start,space,world,maxZoom){
    const fx=(space.left+space.right)/2/space.width,fy=(space.top+space.bottom)/2/space.height;
    let zoom={value:Math.log(world.w/start.w),velocity:0},x={value:start.x+fx*start.w,velocity:0},y={value:start.y+fy*start.h,velocity:0};
    return {jump(point){x={value:point[0],velocity:0};y={value:point[1],velocity:0};},step(point,level,milliseconds){
      const seconds=Math.max(0,milliseconds)/1000;
      zoom=spring(zoom,Math.log(level),seconds,26);
      if(zoom.value<0||zoom.value>Math.log(maxZoom))zoom={value:clamp(zoom.value,0,Math.log(maxZoom)),velocity:0};
      const w=world.w/Math.exp(zoom.value),h=w*world.h/world.w;
      x=spring(x,point[0],seconds,24);y=spring(y,point[1],seconds,24);
      const frame={x:clamp(x.value-fx*w,0,world.w-w),y:clamp(y.value-fy*h,0,world.h-h),w,h};
      if(frame.x!==x.value-fx*w)x={value:frame.x+fx*w,velocity:0};
      if(frame.y!==y.value-fy*h)y={value:frame.y+fy*h,velocity:0};
      return frame;
    }};
  }

  function measure(path){
    const points=[],segments=[];let moves=0;
    for(const match of path.matchAll(/([ML])([\d.e+-]+),([\d.e+-]+)/gi)){
      const x=Number(match[2]),y=Number(match[3]),previous=points.at(-1),move=match[1]==='M';
      const distance=previous&&!move?Math.hypot(x-previous.x,y-previous.y):0;
      if(move)moves++;
      points.push({x,y,move,distance:(previous?.distance||0)+distance});
      if(distance)segments.push({a:[previous.x,previous.y],b:[x,y],start:previous.distance,end:previous.distance+distance});
    }
    const length=points.at(-1)?.distance||0;
    const below=(size,at,value)=>{let low=0,high=size-1;while(low<high){const mid=Math.ceil((low+high)/2);if(at(mid)<=value)low=mid;else high=mid-1;}return low;};
    // The sheet stretches its two axes differently, so a share of the leg on screen is not the same share of its length on the sheet.
    function stretched(sx,sy){
      const marks=new Float64Array(points.length);
      for(let i=1;i<points.length;i++)marks[i]=marks[i-1]+(points[i].move?0:Math.hypot((points[i].x-points[i-1].x)*sx,(points[i].y-points[i-1].y)*sy));
      return {lengthAt(amount){
        if(points.length<2)return 0;
        const distance=clamp(amount,0,1)*length,i=Math.min(points.length-2,below(points.length,mid=>points[mid].distance,distance));
        return marks[i]+(marks[i+1]-marks[i])*(distance-points[i].distance)/Math.max(1e-9,points[i+1].distance-points[i].distance);
      },positionAt(mark){
        const i=Math.min(points.length-2,below(points.length,mid=>marks[mid],mark));
        return (points[i].distance+(points[i+1].distance-points[i].distance)*(mark-marks[i])/Math.max(1e-9,marks[i+1]-marks[i]))/length;
      }};
    }
    function locate(amount){
      if(!points.length)return {index:0,point:[0,0]};
      const distance=clamp(amount,0,1)*length,low=below(points.length,mid=>points[mid].distance,distance);
      const from=points[low],to=points[low+1]||from;
      const t=(distance-from.distance)/Math.max(1e-9,to.distance-from.distance);
      return {index:low,point:[from.x+(to.x-from.x)*t,from.y+(to.y-from.y)*t]};
    }
    // Draw the red ink in CSS pixels, alongside the fixed-size city pins.
    // No zoomed SVG stroke or round cap can briefly rasterize at world scale.
    function screenPathAt(amount,matrix){
      if(amount<=0||!points.length)return '';
      const {index,point}=locate(amount);
      const pair=(x,y)=>`${(x*matrix.a+matrix.e).toFixed(2)},${(y*matrix.d+matrix.f).toFixed(2)}`;
      let result='';
      for(let i=0;i<=index;i++){const p=points[i];result+=(p.move?'M':'L')+pair(p.x,p.y);}
      if(amount<1)result+='L'+pair(...point);
      return result;
    }
    const pointAt=amount=>locate(amount).point;
    function segmentsAt(amount){
      const limit=clamp(amount,0,1)*length,result=[];
      for(const segment of segments){
        if(segment.start>=limit)break;
        const t=Math.min(1,(limit-segment.start)/(segment.end-segment.start));
        result.push([segment.a,t===1?segment.b:segment.a.map((value,i)=>value+(segment.b[i]-value)*t)]);
      }
      return result;
    }
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
    const bounds=points.length?{left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)}:{left:0,right:0,top:0,bottom:0};
    return {length,path,screenPathAt,pointAt,segmentsAt,stretched,bounds,crossesSeam:moves>1};
  }

  function pointFrame(point,space,world,zoom){
    const w=world.w/zoom,h=world.h/zoom;
    return {x:clamp(point[0]-(space.left+space.right)/2/space.width*w,0,world.w-w),y:clamp(point[1]-(space.top+space.bottom)/2/space.height*h,0,world.h-h),w,h};
  }
  function fitLevel({left,right,top,bottom},space,world){
    const spanX=Math.max(1e-6,right-left),spanY=Math.max(1e-6,bottom-top);
    // Compose against the actual free viewport, not a fixed fraction of the
    // world. Regional journeys use the same readable scale on narrow screens.
    const fit=Math.min((space.right-space.left)*world.w/(spanX*space.width),
      (space.bottom-space.top)*world.h/(spanY*space.height));
    const desired=fit*.47;
    // A soft ceiling preserves geographic context on tiny hops without a
    // sudden change of behaviour at a particular distance. Manual zoom is free.
    return Math.max(1,desired/(1+(desired/autoZoomLimit)**4)**.25);
  }
  function camera(geometry,space,world,destination,zoom=null,before=null,after=null){
    if(zoom){const follow=point=>pointFrame(point,space,world,zoom);return {follow,arrival:follow(destination)};}
    // A leg that goes nowhere has nothing to frame: it holds its neighbours' composition, and they ignore it.
    if(before?.length<.01)before=null;if(after?.length<.01)after=null;
    const {left,right,top,bottom}=geometry.bounds,center=[(left+right)/2,(top+bottom)/2];
    let level=geometry.length<.01?Math.max(1,...[before,after].filter(Boolean).map(leg=>fitLevel(leg.bounds,space,world))):fitLevel(geometry.bounds,space,world);
    // Limit a solitary close-up beside wider legs, while preserving detail
    // throughout a local itinerary. Work in zoom ratios, in either direction.
    if(before||after){
      const neighbor=Math.max(...[before,after].filter(Boolean).map(leg=>fitLevel(leg.bounds,space,world)));
      level=Math.min(level,Math.max(16,neighbor*1.6));
    }
    // Similar neighboring legs share their wider composition. This removes
    // small in/out breaths as a route works through a region.
    const composedLevel=level;
    for(const adjacent of [before,after])if(adjacent){
      const nearby=fitLevel(adjacent.bounds,space,world);
      const difference=Math.max(0,Math.log(composedLevel/nearby));
      const blend=1-ease(clamp((difference-Math.log(1.25))/Math.log(2/1.25),0,1));
      level=Math.min(level,composedLevel*Math.exp(-difference*blend));
    }
    const w=world.w/level,h=world.h/level,sx=space.width/w,sy=space.height/h;
    const axis=(min,max,first,last,scale,extent,size,focus)=>{
      const desired=focus-(first+last)/2/scale;
      const low=Math.max(0,max-last/scale),high=Math.min(size-extent,min-first/scale);
      return low<=high?clamp(desired,low,high):clamp(desired,0,size-extent);
    };
    // One fixed composition per leg. Moving the target along with the ink
    // made the camera creep after the route already fitted comfortably.
    const arrival={x:axis(left,right,space.left,space.right,sx,w,world.w,center[0]),y:axis(top,bottom,space.top,space.bottom,sy,h,world.h,center[1]),w,h};
    return {follow:()=>arrival,arrival};
  }
  const framingPhase=amount=>cameraPhase(clamp(amount/.8,0,1));
  function cameraView(start,plan,point,amount){
    // Settle the composition before arrival; the last part of the red line
    // lands on a still map instead of racing a camera that is still zooming.
    if(amount>=.8)return {...plan.arrival};
    const target=plan.follow(point),blend=framingPhase(amount);
    // Zoom by equal ratios. Interpolate the corners by that same change in width
    // to keep the departure in frame while pulling out for the next leg.
    const ratio=Math.log(target.w/start.w);
    const share=Math.abs(ratio)<1e-6?blend:Math.expm1(ratio*blend)/Math.expm1(ratio);
    return Object.fromEntries(['x','y','w','h'].map(key=>[key,start[key]+(target[key]-start[key])*share]));
  }

  const zoomDuration=ratio=>310*Math.abs(Math.log2(ratio));
  // The voyage's own way home: slower than a press of Backspace, and it lands gently.
  const homeDuration=ratio=>440+480*Math.abs(Math.log2(ratio));
  // The ink's pace at its steady middle, for a whole window or a phone.
  const inkSpeed=space=>clamp(Math.hypot(space.right-space.left,space.bottom-space.top)*.2675,200,1000);
  // Prepare once per leg. The camera moves at once, on its own curve, and is at
  // rest for the last part of the leg, where the clock can stretch without a kink
  // in anything on screen. The ink is laid so its speed on screen follows inkShare
  // whatever the zoom is doing, and it stays in port until it can set out without
  // drawing out of sight or dawdling through a long zoom. The leg takes as long as
  // its most demanding moment needs, and hold-to-accelerate and pause/resume share one clock.
  function journey({geometry,space,start,plan,from=0,to=1}){
    const count=250,rest=200,positions=new Float64Array(count+1),shares=new Float64Array(count+1),destination=geometry.pointAt(to),{width,height}=space;
    const frames=Array.from({length:count+1},(_,i)=>cameraView(start,plan,destination,i/count));
    const sheet=geometry.stretched(width,height*start.w/start.h),first=sheet.lengthAt(from),last=sheet.lengthAt(to),span=Math.abs(last-first);
    const seen=(p,frame)=>{const x=(p[0]-frame.x)*width/frame.w,y=(p[1]-frame.y)*height/frame.h;return x>=0&&x<=width&&y>=0&&y<=height;};
    const speed=inkSpeed(space),nominal=Math.abs(to-from)*duration(geometry.length);
    let zoomTime=0;
    for(let i=1;i<=count;i++)zoomTime=Math.max(zoomTime,Math.abs(Math.log2(frames[i].w/frames[i-1].w))/2.1*1000*rest);
    // Length on screen, at the ink's speed. Its pace lifts on the longest legs rather than let an ocean drag.
    const inkTime=drawn=>{const reach=drawn/(speed*inkMean)*1000;return Math.max(1,nominal,reach<1600?reach:1600+(reach-1600)*.62);};
    // The share of the leg's time gone by a sample, when the camera's move has all but the tail of it.
    const clock=(i,tail)=>i<=rest?i/rest*(1-tail):1-tail+(i-rest)/(count-rest)*tail;
    // Trying a plan looks at every fifth sample, which a smooth camera allows; only the chosen one is laid in full.
    function lay(leave,tail,stride=5){
      const begin=clock(leave,tail);
      let sum=0,drawn=0,clear=true,peak=0,p=geometry.pointAt(from),gone=0;
      for(let i=stride;i<=count;i+=stride){const share=inkShare((clock(i,tail)-begin)/(1-begin));sum+=(share-gone)*(frames[i-stride].w+frames[i].w)/2;shares[i]=sum;gone=share;}
      positions[0]=from;
      for(let i=stride;i<=count;i+=stride){
        const part=shares[i]/sum,a=frames[i-stride],b=frames[i],wide=(a.w+b.w)/2;
        positions[i]=span?sheet.positionAt(first+(last-first)*part):from+(to-from)*part;
        drawn+=span*(shares[i]-shares[i-stride])/sum/wide;
        if(positions[i]===positions[i-stride])continue;
        const q=geometry.pointAt(positions[i]);if(!seen(q,b))clear=false;
        // Under way nothing on screen may rush, neither the tip nor the map beneath it. A tip out of sight, or jumping the date line, weighs nothing.
        if(Math.abs(q[0]-p[0])<=720&&(seen(p,a)||seen(q,b))){
          const tip=Math.hypot((q[0]-b.x)*width/b.w-(p[0]-a.x)*width/a.w,(q[1]-b.y)*height/b.h-(p[1]-a.y)*height/a.h);
          const map=Math.hypot((b.x+b.w/2-a.x-a.w/2)*width,(b.y+b.h/2-a.y-a.h/2)*height)/wide;
          peak=Math.max(peak,Math.max(tip,map)/(clock(i,tail)-clock(i-stride,tail)));
        }
        p=q;
      }
      return {drawn,clear,peak};
    }
    function plot(leave){
      const guess=inkTime(lay(leave,.2).drawn),camera=Math.max(zoomTime,.8*guess),tail=1-camera/Math.max(camera/.8,leave/rest*camera+guess);
      const {drawn,clear,peak}=lay(leave,tail),ink=inkTime(drawn),free=1-clock(leave,tail),calm=Math.max(ink/free,zoomTime/(1-tail));
      const total=Math.max(calm,peak/(speed*1.9)*1000),dawdling=Math.max(0,free*total-ink*1.2);
      return {leave,tail,total,score:total+dawdling/2,fits:clear&&drawn>=.72*span/plan.arrival.w,ideal:!dawdling&&total===calm};
    }
    let best=null;
    for(let leave=0;leave<=rest&&!best?.ideal;leave+=20){
      const option=plot(leave);if(!option.fits)continue;
      if(best&&option.score>best.score)break;
      if(!best||option.score<best.score)best=option;
    }
    best||=plot(rest);
    const {total,tail}=best;lay(best.leave,tail,1);
    let elapsed=0;
    return {duration:total,advance(delta){
      elapsed=clamp(elapsed+Math.max(0,delta),0,total);
      if(elapsed>=total)return {time:1,position:to,arrived:true,done:true};
      const share=elapsed/total,at=share<1-tail?share/(1-tail)*rest:rest+(share-1+tail)/tail*(count-rest),low=Math.min(count-1,Math.floor(at));
      return {time:at/count,position:positions[low]+(positions[low+1]-positions[low])*(at-low),arrived:false,done:false};
    }};
  }
  // The hand-zoomed camera's clock: the ink eases out, holds a steady rate and eases in, whatever the tracker does.
  function timeline({from,to,duration}){
    let elapsed=0;
    const total=Math.abs(to-from)*duration;
    return {advance(delta){
      elapsed=clamp(elapsed+Math.max(0,delta),0,total);
      const time=total?elapsed/total:1;
      return {time,position:from+(to-from)*inkShare(time),arrived:elapsed>=total,done:elapsed>=total};
    }};
  }
  globalThis.RedlineTrace=Object.freeze({maxZoom,dwell,measure,duration,zoomDuration,homeDuration,inkShare,inkSpeed,timeline,journey,ease,snap,cameraPhase,camera,cameraView,pointFrame,spring,trackingCamera});
})();
