/* Route city labels: a greedy, priority-ordered choice among six slots around each dot. */
(() => {
  'use strict';
  // Text anchor offsets from the dot for 13px Courier capitals; right-above is the original default.
  const slots=Object.freeze([
    ['right-above',10,-12,'start'],['right-below',10,20,'start'],['left-above',-10,-12,'end'],
    ['left-below',-10,20,'end'],['above',0,-12,'middle'],['below',0,20,'middle']
  ].map(([name,x,y,anchor])=>Object.freeze({name,x,y,anchor})));
  const HEIGHT=14,DESCENT=3,HALO=2,DOT=4.5;
  // Courier New is monospace: 0.6em advance at 13px plus 0.5px letter-spacing.
  const estimate=text=>String(text).length*8.3;
  const overlaps=(a,b,gap=0)=>a.x<b.x+b.w+gap&&a.x+a.w+gap>b.x&&a.y<b.y+b.h+gap&&a.y+a.h+gap>b.y;
  function box(item,slot){
    const width=item.width??estimate(item.text||''),h=item.height||HEIGHT;
    const left=slot.anchor==='start'?slot.x:slot.anchor==='end'?slot.x-width:slot.x-width/2;
    return {x:item.x+left-HALO,y:item.y+slot.y-(h-DESCENT),w:width+HALO*2,h};
  }
  // Items carry screen x/y of the dot, label width/height, and priority (lower first, then input order).
  function place(items,{width=Infinity,height=Infinity,obstacles=[],previous,edge=4,gap=1,dot=DOT}={}){
    const dots=items.map(item=>({x:item.x-dot,y:item.y-dot,w:dot*2,h:dot*2})),taken=[...obstacles],result=items.map(()=>null);
    const before=key=>typeof previous?.get==='function'?previous.get(key):previous?.[key];
    const order=items.map((_,i)=>i).sort((a,b)=>(items[a].priority??a)-(items[b].priority??b)||a-b);
    for(const i of order){
      const item=items[i],kept=slots.find(slot=>slot.name===before(item.id??i));
      for(const slot of kept?[kept,...slots.filter(s=>s!==kept)]:slots){
        const b=box(item,slot);
        if(b.x<edge||b.y<edge||b.x+b.w>width-edge||b.y+b.h>height-edge)continue;
        if(taken.some(t=>overlaps(b,t,gap))||dots.some((d,j)=>j!==i&&overlaps(b,d,gap)))continue;
        taken.push(b);result[i]={...slot,box:b};break;
      }
    }
    return result;
  }
  globalThis.RedlineLabels=Object.freeze({place,estimate,overlaps,slots});
})();
