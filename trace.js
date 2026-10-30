/* Route geometry, playback timing, and a single smooth camera move per leg. */
(() => {
  'use strict';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const duration=length=>Math.max(1600,Math.min(3600,length*6));
  const ease=value=>{const t=clamp(value,0,1);return t*t*t*(t*(t*6-15)+10);};
  // Analytic critical damping keeps velocity when a wheel gesture retargets mid-move.
  function spring(state,target,seconds,frequency=16){
    const offset=state.value-target,term=(state.velocity+frequency*offset)*seconds,decay=Math.exp(-frequency*seconds);
    return {value:target+(offset+term)*decay,velocity:(state.velocity-frequency*term)*decay};
  }
  function trackingCamera(start,space,world,maxZoom){
    const fx=(space.left+space.right)/2/space.width,fy=(space.top+space.bottom)/2/space.height;
    let zoom={value:Math.log(world.w/start.w),velocity:0},x={value:start.x+fx*start.w,velocity:0},y={value:start.y+fy*start.h,velocity:0};
    return {step(point,level,milliseconds){
      const seconds=Math.max(0,milliseconds)/1000;
      zoom=spring(zoom,Math.log(level),seconds,18);
      if(zoom.value<0||zoom.value>Math.log(maxZoom))zoom={value:clamp(zoom.value,0,Math.log(maxZoom)),velocity:0};
      const w=world.w/Math.exp(zoom.value),h=w*world.h/world.w;
      x=spring(x,point[0],seconds,15);y=spring(y,point[1],seconds,15);
      const frame={x:clamp(x.value-fx*w,0,world.w-w),y:clamp(y.value-fy*h,0,world.h-h),w,h};
      if(frame.x!==x.value-fx*w)x={value:frame.x+fx*w,velocity:0};
      if(frame.y!==y.value-fy*h)y={value:frame.y+fy*h,velocity:0};
      return frame;
    }};
  }

  function measure(path){
    const points=[],commands=[];
    for(const match of path.matchAll(/([ML])([\d.e+-]+),([\d.e+-]+)/gi)){
      const x=Number(match[2]),y=Number(match[3]),previous=points.at(-1),move=match[1]==='M';
      const distance=previous&&!move?Math.hypot(x-previous.x,y-previous.y):0;
      points.push({x,y,distance:(previous?.distance||0)+distance});commands.push(match[0]);
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
    function pathAt(amount){
      if(amount>=1||!points.length)return path;
      const {index,point}=locate(amount);
      return commands.slice(0,index+1).join('')+'L'+point.join(',');
    }
    const pointAt=amount=>locate(amount).point;
    return {length,path,pathAt,pointAt,points:points.map(p=>[p.x,p.y]),crossesSeam:commands.filter(c=>c[0]==='M').length>1};
  }

  function pointFrame(point,space,world,zoom){
    const w=world.w/zoom,h=world.h/zoom;
    return {x:clamp(point[0]-(space.left+space.right)/2/space.width*w,0,world.w-w),y:clamp(point[1]-(space.top+space.bottom)/2/space.height*h,0,world.h-h),w,h};
  }
  function camera(geometry,space,world,destination,zoom=null){
    if(zoom){const follow=point=>pointFrame(point,space,world,zoom);return {follow,arrival:follow(destination)};}
    const xs=geometry.points.map(p=>p[0]),ys=geometry.points.map(p=>p[1]);
    const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
    const center=[(left+right)/2,(top+bottom)/2];
    const level=Math.max(1,Math.min(2.35,
      (space.right-space.left)*world.w/(Math.max(1,right-left)*space.width*1.16),
      (space.bottom-space.top)*world.h/(Math.max(1,bottom-top)*space.height*1.16)));
    const w=world.w/level,h=world.h/level,sx=space.width/w,sy=space.height/h;
    const axis=(min,max,first,last,scale,extent,size,focus)=>{
      const desired=focus-(first+last)/2/scale;
      const low=Math.max(0,max-last/scale),high=Math.min(size-extent,min-first/scale);
      return low<=high?clamp(desired,low,high):clamp(desired,0,size-extent);
    };
    function follow(point){
      // Keep the entire arc composed; the moving line adds only a small pan bias.
      const focus=geometry.crossesSeam?center:center.map((n,i)=>n*.84+point[i]*.16);
      return {x:axis(left,right,space.left,space.right,sx,w,world.w,focus[0]),y:axis(top,bottom,space.top,space.bottom,sy,h,world.h,focus[1]),w,h};
    }
    return {follow,arrival:follow(destination)};
  }
  function cameraView(start,plan,point,amount){
    if(amount>=1)return {...plan.arrival};
    const target=plan.follow(point),blend=ease(amount);
    return Object.fromEntries(['x','y','w','h'].map(key=>[key,start[key]+(target[key]-start[key])*blend]));
  }

  function timeline({from,to,duration}){
    let elapsed=0;
    const total=Math.abs(to-from)*duration;
    return {advance(delta){
      elapsed=clamp(elapsed+Math.max(0,delta),0,total);
      const t=total?elapsed/total:1;
      return {position:from+(to-from)*t,arrived:elapsed>=total,done:elapsed>=total};
    }};
  }
  globalThis.RedlineTrace=Object.freeze({measure,duration,timeline,ease,camera,cameraView,pointFrame,spring,trackingCamera});
})();
