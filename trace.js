/* Route geometry, playback timing, and a single smooth camera move per leg. */
(() => {
  'use strict';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const maxZoom=240,autoZoomLimit=36;
  const duration=length=>length<1?150:Math.max(560,Math.min(1500,length*2.2));
  const ease=value=>{const t=clamp(value,0,1);return t*t*t*(t*(t*6-15)+10);};
  // Leaves at once and settles softly: camera moves answer the moment they are asked for.
  const snap=value=>{const t=clamp(value,0,1),u=1-t;return 1-u*u*u*(1+.6*t);};
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
    function locate(amount){
      if(!points.length)return {index:0,point:[0,0]};
      const distance=clamp(amount,0,1)*length;
      let low=0,high=points.length-1;
      while(low<high){const mid=Math.ceil((low+high)/2);if(points[mid].distance<=distance)low=mid;else high=mid-1;}
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
    return {length,path,screenPathAt,pointAt,segmentsAt,bounds,crossesSeam:moves>1};
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
    // Limit a solitary close-up between wider legs, while preserving detail
    // throughout a local itinerary. Work in zoom ratios, in either direction.
    if(before&&after){
      const neighbor=Math.max(fitLevel(before.bounds,space,world),fitLevel(after.bounds,space,world));
      level=Math.min(level,Math.max(16,neighbor*1.6));
    }
    // Similar neighboring legs share their wider composition. This removes
    // small in/out breaths as a route works through a region.
    const composedLevel=level;
    for(const adjacent of [before,after])if(adjacent){
      const nearby=fitLevel(adjacent.bounds,space,world);
      const difference=Math.max(0,Math.log(composedLevel/nearby));
      const blend=1-ease(clamp((difference-Math.log(1.2))/Math.log(1.6/1.2),0,1));
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
  // Prepare once per leg. Playback spends time according to the ink's screen
  // distance AND the camera's zoom, rather than speeding up the ink as a zoom
  // finishes. A shared clock keeps hold-to-accelerate and pause/resume in sync.
  function journey({geometry,space,start,plan,from=0,to=1}){
    const count=256,times=new Float64Array(count+1),positions=new Float64Array(count+1);
    const ratio=plan.arrival.w/start.w,logRatio=Math.abs(Math.log(ratio));
    // Scaled by what is left, so a leg resumed near its port does not stall there.
    const nominal=Math.abs(to-from)*(geometry.length<.01?duration(0):Math.max(420,duration(geometry.length)));
    const pixelsPerSecond=clamp(Math.hypot(space.right-space.left,space.bottom-space.top)*.62,420,1000);
    const travel=u=>{
      const ramp=.1;
      const rounded=u<ramp?u*u/(2*ramp*(1-ramp)):u>1-ramp?1-(1-u)**2/(2*ramp*(1-ramp)):(u-ramp/2)/(1-ramp);
      const fit=Math.exp(-logRatio*(1-framingPhase(u)));
      return from+(to-from)*rounded*(ratio>=1?fit:.35+.65*fit);
    };
    const seen=(p,frame)=>{const x=(p[0]-frame.x)*space.width/frame.w,y=(p[1]-frame.y)*space.height/frame.h;return x>=0&&x<=space.width&&y>=0&&y<=space.height;};
    let previous=start,point=geometry.pointAt(from);
    positions[0]=from;
    for(let i=1;i<=count;i++){
      const u=i/count;let position=travel(u),nextPoint=geometry.pointAt(position);
      const frame=cameraView(start,plan,nextPoint,u),over=p=>Math.abs(p[0]-point[0])>720,clear=p=>seen(p,frame)&&!over(p);
      // The ink waits at the window's edge, or at the date line until the far side is in frame too, rather than drawing where nobody can see it. The last sample always lands.
      if(i<count&&!clear(nextPoint)){
        let low=positions[i-1],high=position;
        if(seen(point,frame))for(let step=0;step<20;step++){const mid=(low+high)/2;if(clear(geometry.pointAt(mid)))low=mid;else high=mid;}
        if(!over(nextPoint)||!seen(nextPoint,frame)||!seen(geometry.pointAt(high),frame)){position=low;nextPoint=geometry.pointAt(low);}
      }
      const w=(previous.w+frame.w)/2,h=(previous.h+frame.h)/2;
      const dx=nextPoint[0]-point[0],dy=nextPoint[1]-point[1];
      // Speed limits are for what can be seen: a tip off screen at both ends of a step weighs nothing.
      const hidden=!seen(point,previous)&&!seen(nextPoint,frame);
      const ink=hidden?0:Math.abs(dx)>720?geometry.length*Math.abs(position-positions[i-1])*Math.hypot(space.width/w,space.height/h)/Math.SQRT2:Math.hypot(dx*space.width/w,dy*space.height/h);
      const before=[(point[0]-previous.x)*space.width/previous.w,(point[1]-previous.y)*space.height/previous.h];
      const after=[(nextPoint[0]-frame.x)*space.width/frame.w,(nextPoint[1]-frame.y)*space.height/frame.h];
      const movement=hidden||Math.abs(dx)>720?0:Math.hypot(after[0]-before[0],after[1]-before[1]);
      const zoom=Math.abs(Math.log2(frame.w/previous.w));
      times[i]=times[i-1]+Math.max(nominal/count,ink/pixelsPerSecond*1000,zoom/3.2*1000,movement/(pixelsPerSecond*1.4)*1000);
      positions[i]=position;previous=frame;point=nextPoint;
    }
    const total=times[count];let elapsed=0;
    return {duration:total,advance(delta){
      elapsed=clamp(elapsed+Math.max(0,delta),0,total);
      if(elapsed>=total)return {time:1,position:to,arrived:true,done:true};
      let low=0,high=count;
      while(low+1<high){const mid=(low+high)>>1;if(times[mid]<=elapsed)low=mid;else high=mid;}
      const share=(elapsed-times[low])/(times[high]-times[low]);
      return {time:(low+share)/count,position:positions[low]+(positions[high]-positions[low])*share,arrived:false,done:false};
    }};
  }
  // The hand-zoomed camera's clock: the ink at a steady rate, whatever the tracker does.
  function timeline({from,to,duration}){
    let elapsed=0;
    const total=Math.abs(to-from)*duration;
    return {advance(delta){
      elapsed=clamp(elapsed+Math.max(0,delta),0,total);
      const time=total?elapsed/total:1;
      return {time,position:from+(to-from)*time,arrived:elapsed>=total,done:elapsed>=total};
    }};
  }
  globalThis.RedlineTrace=Object.freeze({maxZoom,measure,duration,zoomDuration,timeline,journey,ease,snap,camera,cameraView,pointFrame,spring,trackingCamera});
})();
