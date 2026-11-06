/* Route city labels: stable placement around dots, nearby names, and the drawn route. Everything lettered on the map shares one occupancy grid. */
(() => {
  'use strict';
  // Text anchor offsets from the dot for 13 px lettered capitals; right-above is the original default. Near places come first, then rings that need a short leader.
  const NEAR=8,RING=16;
  const slots=Object.freeze([
    ['right-above',10,-12,'start'],['right-below',10,20,'start'],['left-above',-10,-12,'end'],
    ['left-below',-10,20,'end'],['above',0,-12,'middle'],['below',0,20,'middle'],
    ['right',12,4,'start'],['left',-12,4,'end'],
    ['above-near',0,-26,'middle'],['below-near',0,34,'middle'],['right-near',24,4,'start'],['left-near',-24,4,'end'],
    ['right-above-near',18,-18,'start'],['right-below-near',18,27,'start'],['left-above-near',-18,-18,'end'],['left-below-near',-18,27,'end'],
    ['above-far',0,-40,'middle'],['below-far',0,48,'middle'],
    ['right-above-far',24,-30,'start'],['right-below-far',24,39,'start'],['left-above-far',-24,-30,'end'],['left-below-far',-24,39,'end'],
    ['right-far',38,4,'start'],['left-far',-38,4,'end'],
    ['upper-left',-16,-48,'end'],['upper-right',16,-48,'start'],
    ['lower-left',-16,57,'end'],['lower-right',16,57,'start'],
    ['upper',0,-56,'middle'],['lower',0,64,'middle'],['right-out',52,4,'start'],['left-out',-52,4,'end'],
    ['right-above-out',38,-42,'start'],['left-above-out',-38,-42,'end'],['right-below-out',38,51,'start'],['left-below-out',-38,51,'end'],
    ['right-wide-high',64,-30,'start'],['right-wide-up',64,-12,'start'],['right-wide',64,4,'start'],['right-wide-down',64,22,'start'],['right-wide-low',64,40,'start'],
    ['left-wide-high',-64,-30,'end'],['left-wide-up',-64,-12,'end'],['left-wide',-64,4,'end'],['left-wide-down',-64,22,'end'],['left-wide-low',-64,40,'end']
  ].map(([name,x,y,anchor])=>Object.freeze({name,x,y,anchor})));
  const slotNamed=new Map(slots.map((slot,i)=>[slot.name,i]));
  const HEIGHT=14,DESCENT=2,HALO=2,DOT=4.5,CLEARANCE=5;
  // The fallback and floor for 13 px lettered capitals, before a name can be measured.
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
  // What is already lettered this frame, in cells, so a question costs the few cells a box touches however many names there are.
  function occupancy(width,height){
    const size=64,cols=Math.ceil((Number.isFinite(width)?width:4096)/size)+2,rows=Math.ceil((Number.isFinite(height)?height:4096)/size)+2,cells=Array.from({length:cols*rows},()=>[]),used=[];
    const col=x=>Math.max(0,Math.min(cols-1,Math.floor(x/size)+1)),row=y=>Math.max(0,Math.min(rows-1,Math.floor(y/size)+1));
    return {
      // A name's own marks carry its owner, so it does not collide with them. Those held can be released again, to let a neighbour move; a dot stays.
      add(rect,owner=-1,held=false){
        const entry={x:rect.x,y:rect.y,w:rect.w,h:rect.h,owner,held};
        for(let r=row(rect.y),last=row(rect.y+rect.h);r<=last;r++)for(let c=col(rect.x),end=col(rect.x+rect.w);c<=end;c++){const i=r*cols+c;if(!cells[i].length)used.push(i);cells[i].push(entry);}
      },
      hits(x,y,w,h,gap=0,owner=-2){
        const right=x+w+gap,bottom=y+h+gap;x-=gap;y-=gap;
        for(let r=row(y),last=row(bottom);r<=last;r++)for(let c=col(x),end=col(right);c<=end;c++){
          const cell=cells[r*cols+c];
          for(let i=0;i<cell.length;i++){const b=cell[i];if(x<b.x+b.w&&right>b.x&&y<b.y+b.h&&bottom>b.y&&b.owner!==owner)return true;}
        }
        return false;
      },
      release(owner){for(const i of used){const cell=cells[i];for(let j=cell.length-1;j>=0;j--)if(cell[j].owner===owner&&cell[j].held){cell[j]=cell[cell.length-1];cell.pop();}}},
      clear(){for(const i of used)cells[i].length=0;used.length=0;},
      fits:(w,h)=>w===width&&h===height
    };
  }
  // Bucket short route segments once instead of comparing every
  // label against every point in a long, zoomed-in trip.
  function indexLines(segments,{width=Infinity,height=Infinity}={}){
    const size=96,buckets=new Map(),seen=new Int32Array(segments.length),maxX=Math.floor(width/size),maxY=Math.floor(height/size);let stamp=0;
    segments.forEach((segment,i)=>{
      const [a,b]=segment,x0=Math.max(0,Math.floor(Math.min(a[0],b[0])/size)),x1=Math.min(maxX,Math.floor(Math.max(a[0],b[0])/size)),y0=Math.max(0,Math.floor(Math.min(a[1],b[1])/size)),y1=Math.min(maxY,Math.floor(Math.max(a[1],b[1])/size));
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const key=x*65536+y;let bucket=buckets.get(key);if(!bucket)buckets.set(key,bucket=[]);bucket.push(i);}
    });
    return {hits(rect,pad=5){
      const x0=Math.max(0,Math.floor((rect.x-pad)/size)),x1=Math.min(maxX,Math.floor((rect.x+rect.w+pad)/size)),y0=Math.max(0,Math.floor((rect.y-pad)/size)),y1=Math.min(maxY,Math.floor((rect.y+rect.h+pad)/size));stamp++;
      for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
        const bucket=buckets.get(x*65536+y);if(!bucket)continue;
        for(const i of bucket){if(seen[i]===stamp)continue;seen[i]=stamp;if(crosses(segments[i],rect,pad))return true;}
      }
      return false;
    }};
  }
  function projectIndex(index,matrix,bounds){
    const rect={x:0,y:0,w:0,h:0};
    return {hits(box,pad=5){rect.x=(box.x-pad+bounds.left-matrix.e)/matrix.a;rect.y=(box.y-pad+bounds.top-matrix.f)/matrix.d;rect.w=(box.w+pad*2)/matrix.a;rect.h=(box.h+pad*2)/matrix.d;return index.hits(rect,0);}};
  }
  // A leader is a line of small marks, so what comes later can keep off it through the same grid.
  const marksOf=([[x0,y0],[x1,y1]])=>{const steps=Math.max(1,Math.ceil(Math.hypot(x1-x0,y1-y0)/7)),out=[];for(let i=1;i<=steps;i++)out.push({x:x0+(x1-x0)*i/steps-1.5,y:y0+(y1-y0)*i/steps-1.5,w:3,h:3});return out;};
  function place(items,{width=Infinity,height=Infinity,obstacles=[],previous,edge=4,gap=CLEARANCE,dot=DOT,clusterDistance=0,segments=[],routes=indexLines(segments,{width,height}),grid=occupancy(width,height)}={}){
    const result=items.map(()=>null),before=key=>typeof previous?.get==='function'?previous.get(key):previous?.[key];
    for(const obstacle of obstacles)grid.add(obstacle);
    items.forEach((item,i)=>grid.add({x:item.x-dot,y:item.y-dot,w:dot*2,h:dot*2},i));
    const order=items.map((_,i)=>i).sort((a,b)=>(items[a].priority??a)-(items[b].priority??b)||a-b);
    // A world-view dot can cover several towns. Show the highest-priority
    // name there until the pins separate at the current screen scale.
    const representatives=[];
    for(const i of order){
      if(!clusterDistance||!representatives.some(j=>Math.hypot(items[i].x-items[j].x,items[i].y-items[j].y)<clusterDistance))representatives.push(i);
    }
    const inside=(rect,margin)=>rect.x>=margin&&rect.y>=margin&&rect.x+rect.w<=width-margin&&rect.y+rect.h<=height-margin;
    const candidate=(i,index)=>{
      const slot=slots[index],item=items[i],rect=box(item,slot),own=distance(item,rect);
      return {...slot,box:rect,own,index,leader:own>21?[[item.x,item.y],[Math.max(rect.x,Math.min(rect.x+rect.w,item.x)),Math.max(rect.y,Math.min(rect.y+rect.h,item.y))]]:null};
    };
    // A leader that crosses the line or another dot ties its name to the wrong place, past its first few pixels, where its own legs leave the dot.
    const clear=(c,i,clearOfRoutes,space=gap)=>!grid.hits(c.box.x,c.box.y,c.box.w,c.box.h,space,i)&&!(clearOfRoutes&&routes.hits(c.box,space===gap?CLEARANCE:CLEARANCE-2))&&!(c.leader&&marksOf(c.leader).some((m,k)=>grid.hits(m.x,m.y,m.w,m.h,0,i)||clearOfRoutes&&k>0&&routes.hits(m,0)));
    const take=(c,i)=>{grid.add(c.box,i,true);if(c.leader)for(const mark of marksOf(c.leader))grid.add(mark,i,true);result[i]=c;};
    // Of these places, whichever lies best: near its own dot and not nearer another's.
    function best(i,from,to,clearOfRoutes,keep=-1){
      const item=items[i];let neighbours=null,top=null,score=Infinity;
      for(let index=from;index<to;index++){
        const c=candidate(i,index);
        if(!inside(c.box,edge)||!clear(c,i,clearOfRoutes))continue;
        neighbours??=items.filter((other,j)=>j!==i&&Math.abs(item.x-other.x)<100&&Math.abs(item.y-other.y)<100);
        const own=c.own,mine=(index>=NEAR?Math.max(0,own-14)*1.5:0)+neighbours.reduce((total,other)=>total+Math.max(0,own+10-distance(other,c.box))**2,0)+index+(index===keep?-16:0);
        if(mine<score){score=mine;top=c;}
      }
      return top;
    }
    const seek=(i,clearOfRoutes,keep)=>best(i,0,NEAR,clearOfRoutes,keep)||best(i,NEAR,RING,clearOfRoutes,keep)||best(i,RING,slots.length,clearOfRoutes,keep);
    const keptIndex=i=>slotNamed.get(before(items[i].id??i))??-1;
    // A name once placed stays while it can, on a slightly slacker rule than a new arrival's, so nearly touching never turns into flickering.
    function hold(i){
      const keep=keptIndex(i);if(keep<0)return false;
      const c=candidate(i,keep);if(!inside(c.box,edge/2)||!clear(c,i,true,Math.max(0,gap-2)))return false;
      take(c,i);return true;
    }
    function arrive(i){
      const chosen=seek(i,true);
      if(chosen){take(chosen,i);return;}
      // One local adjustment can save a crowded neighbour without hiding a
      // higher-priority city or reshuffling an entire cluster every frame.
      for(let index=0;index<NEAR;index++){
        const c=candidate(i,index);
        if(!inside(c.box,edge)||routes.hits(c.box,CLEARANCE))continue;
        const blocked=representatives.filter(j=>j!==i&&result[j]&&overlaps(c.box,result[j].box,gap));
        if(blocked.length!==1)continue;
        const j=blocked[0],placed=result[j];grid.release(j);result[j]=null;
        if(clear(c,i,true)){
          take(c,i);const alternate=best(j,0,NEAR,true)||best(j,NEAR,RING,true);
          if(alternate){take(alternate,j);return;}
          grid.release(i);result[i]=null;
        }
        take(placed,j);
      }
    }
    // Whoever is placed in a group claims their place before anyone new in it looks for one. A name left far out by a crowd then comes back to its dot, once there is room to spare,
    // and last, because a hub's spokes can cover every slot: better a name across the red line, where its halo keeps it readable, than no name at all.
    function settle(group){
      const waiting=group.filter(i=>!hold(i)),resting=i=>items[i].rest&&!(items[i].priority<0);
      for(const i of waiting)if(!resting(i))arrive(i);
      for(const i of group){
        const c=result[i];if(!c||c.index<NEAR)continue;
        const closer=best(i,0,NEAR,true);
        if(closer&&!grid.hits(closer.box.x,closer.box.y,closer.box.w,closer.box.h,gap+3,i)){grid.release(i);take(closer,i);}
      }
      for(const i of group)if(!result[i]&&!resting(i)){const keep=keptIndex(i),c=best(i,0,NEAR,false,keep)||best(i,NEAR,RING,false,keep);if(c)take(c,i);}
    }
    // The active port is seen whatever else has to give. Stops a trace has yet to reach hold what places are left over, unseen, so a name on show never yields to one that is not.
    const ranked=[i=>items[i].priority<0,i=>!(items[i].priority<0)&&!items[i].unseen,i=>!(items[i].priority<0)&&items[i].unseen];
    for(const rank of ranked)settle(representatives.filter(rank));
    return result;
  }
  globalThis.RedlineLabels=Object.freeze({place,estimate,overlaps,slots,crosses,indexLines,projectIndex,occupancy});
})();
