/* Route city labels: stable placement around dots, nearby names, and the drawn route. */
(() => {
  'use strict';
  // Text anchor offsets from the dot for 13px Courier capitals; right-above is the original default.
  const slots=Object.freeze([
    ['right-above',10,-12,'start'],['right-below',10,20,'start'],['left-above',-10,-12,'end'],
    ['left-below',-10,20,'end'],['above',0,-12,'middle'],['below',0,20,'middle'],
    ['right',12,4,'start'],['left',-12,4,'end'],['above-far',0,-32,'middle'],['below-far',0,40,'middle'],
    ['right-above-far',24,-24,'start'],['right-below-far',24,24,'start'],['left-above-far',-24,-24,'end'],['left-below-far',-24,24,'end']
  ].map(([name,x,y,anchor])=>Object.freeze({name,x,y,anchor})));
  const HEIGHT=14,DESCENT=3,HALO=3,DOT=4.5;
  // Courier New is monospace: 0.6em advance at 13px plus 0.5px letter-spacing.
  const estimate=text=>String(text).length*8.3;
  const overlaps=(a,b,gap=0)=>a.x<b.x+b.w+gap&&a.x+a.w+gap>b.x&&a.y<b.y+b.h+gap&&a.y+a.h+gap>b.y;
  function box(item,slot){
    const width=item.width??estimate(item.text||''),h=item.height||HEIGHT;
    const left=slot.anchor==='start'?slot.x:slot.anchor==='end'?slot.x-width:slot.x-width/2;
    return {x:item.x+left-HALO,y:item.y+slot.y-(h-DESCENT)-HALO,w:width+HALO*2,h:h+HALO*2};
  }
  const distance=(point,rect)=>Math.hypot(Math.max(rect.x-point.x,0,point.x-rect.x-rect.w),Math.max(rect.y-point.y,0,point.y-rect.y-rect.h));
  // Exact segment/rectangle intersection, including the text's breathing room.
  function crosses(segment,rect,pad=0){
    let low=0,high=1;
    for(let axis=0;axis<2;axis++){
      const start=segment[0][axis],delta=segment[1][axis]-start,min=(axis?rect.y:rect.x)-pad,max=min+(axis?rect.h:rect.w)+pad*2;
      if(Math.abs(delta)<1e-9){if(start<min||start>max)return false;continue;}
      const a=(min-start)/delta,b=(max-start)/delta;low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));
      if(low>high)return false;
    }
    return true;
  }
  // Bucket short route segments once per frame instead of comparing every
  // label against every point in a long, zoomed-in trip.
  function indexLines(segments,{width=Infinity,height=Infinity}={}){
    const size=96,buckets=new Map();
    const range=rect=>[Math.max(0,Math.floor(rect.x/size)),Math.min(Math.floor(width/size),Math.floor((rect.x+rect.w)/size)),Math.max(0,Math.floor(rect.y/size)),Math.min(Math.floor(height/size),Math.floor((rect.y+rect.h)/size))];
    segments.forEach((segment,i)=>{
      const [a,b]=segment,[x0,x1,y0,y1]=range({x:Math.min(a[0],b[0]),y:Math.min(a[1],b[1]),w:Math.abs(b[0]-a[0]),h:Math.abs(b[1]-a[1])});
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const key=`${x},${y}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(i);}
    });
    return {hits(rect,pad=5){
      const [x0,x1,y0,y1]=range({x:rect.x-pad,y:rect.y-pad,w:rect.w+pad*2,h:rect.h+pad*2}),seen=new Set();
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)for(const i of buckets.get(`${x},${y}`)||[]){
        if(seen.has(i))continue;seen.add(i);if(crosses(segments[i],rect,pad))return true;
      }
      return false;
    }};
  }
  function place(items,{width=Infinity,height=Infinity,obstacles=[],previous,edge=4,gap=5,dot=DOT,segments=[],routes=indexLines(segments,{width,height})}={}){
    const dots=items.map(item=>({x:item.x-dot,y:item.y-dot,w:dot*2,h:dot*2})),result=items.map(()=>null);
    const before=key=>typeof previous?.get==='function'?previous.get(key):previous?.[key];
    const order=items.map((_,i)=>i).sort((a,b)=>(items[a].priority??a)-(items[b].priority??b)||a-b);
    const choices=items.map((item,i)=>{
      const kept=before(item.id??i),neighbours=items.filter((other,j)=>j!==i&&Math.hypot(item.x-other.x,item.y-other.y)<100);
      return slots.map((slot,index)=>{
        const rect=box(item,slot),own=distance(item,rect);
        const score=neighbours.reduce((total,other)=>total+Math.max(0,own+10-distance(other,rect))**2,0)+index+(slot.name===kept?-16:0);
        return {...slot,box:rect,score};
      }).filter(({box:b})=>b.x>=edge&&b.y>=edge&&b.x+b.w<=width-edge&&b.y+b.h<=height-edge
        &&!obstacles.some(t=>overlaps(b,t,gap))&&!dots.some((d,j)=>j!==i&&overlaps(b,d,gap))&&!routes.hits(b,5))
        .sort((a,b)=>a.score-b.score);
    });
    const blockers=(candidate,except)=>result.flatMap((placed,i)=>i!==except&&placed&&overlaps(candidate.box,placed.box,gap)?[i]:[]);
    for(const i of order){
      result[i]=choices[i].find(candidate=>!blockers(candidate,i).length)||null;
      if(result[i])continue;
      // One local adjustment can save a crowded neighbour without hiding a
      // higher-priority city or reshuffling an entire cluster every frame.
      for(const candidate of choices[i]){
        const blocked=blockers(candidate,i);if(blocked.length!==1)continue;
        const j=blocked[0],alternate=choices[j].find(other=>!overlaps(other.box,candidate.box,gap)&&!blockers(other,j).length);
        if(alternate){result[j]=alternate;result[i]=candidate;break;}
      }
    }
    return result;
  }
  globalThis.RedlineLabels=Object.freeze({place,estimate,overlaps,slots,crosses,indexLines});
})();
