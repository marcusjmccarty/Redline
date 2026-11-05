/* Static atlas geometry: continuous landmass fills, no runtime clipping. */
(() => {
  'use strict';
  function measure(path){
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,x=0,y=0,count=0;
    for(const point of path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)){
      const px=Number(point[1]),py=Number(point[2]);
      left=Math.min(left,px);right=Math.max(right,px);top=Math.min(top,py);bottom=Math.max(bottom,py);x+=px;y+=py;count++;
    }
    return {left,top,right,bottom,x:count?x/count:0,y:count?y/count:0};
  }
  const intersects=(bounds,view,pad=3)=>bounds.right>=view.x-pad&&bounds.left<=view.x+view.w+pad&&bounds.bottom>=view.y-pad&&bounds.top<=view.y+view.h+pad;
  function create(land,regions,landPaths,regionPaths,countryLayer,countryPaths=[]){
    function mount(root,paths){
      const fragment=document.createDocumentFragment(),entries=[];
      for(const d of paths){
        if(!d)continue;
        const bounds=measure(d),node=document.createElementNS('http://www.w3.org/2000/svg','path');
        node.setAttribute('d',d);
        entries.push({node,bounds,visible:true});fragment.append(node);
      }
      root?.append(fragment);return entries;
    }
    const coasts=mount(land,landPaths),countries=mount(countryLayer,countryPaths),boundaries=mount(regions,regionPaths);
    let last='';
    return {paint(view,showRegions){
      const key=[view.x,view.y,view.w,view.h,showRegions].join(',');if(key===last)return;last=key;
      for(const entries of [coasts,countries,boundaries])for(const entry of entries){
        const visible=(entries!==boundaries||showRegions)&&intersects(entry.bounds,view);
        if(visible===entry.visible)continue;entry.visible=visible;entry.node.style.display=visible?'':'none';
      }
    }};
  }
  // Keep a small decoded tile cache and prepare just beyond the viewport.
  // Each level is one opacity group; adjacent opaque tiles overlap by half a
  // source pixel so Chrome cannot expose hairline seams while resampling.
  function relief(layer,coverage){
    const svg=name=>document.createElementNS('http://www.w3.org/2000/svg',name);
    const levels=[4,16].map((cols,i)=>({cols,rows:coverage?.[i]||[],tiles:new Map(),group:svg('g'),key:''}));
    const smoothStep=(start,end,value)=>{const t=Math.max(0,Math.min(1,(value-start)/(end-start)));return t*t*(3-2*t);};
    let clock=0,generation=0;
    function clear(){
      generation++;
      for(const level of levels){
        for(const entry of level.tiles.values())if(entry.image)entry.image.src='';
        level.tiles.clear();level.group.replaceChildren();level.group.remove();level.key='';
      }
    }
    return function paint(view,zoom){
      if(zoom<=2.2){if(levels.some(level=>level.tiles.size))clear();return;}
      clock++;
      for(const level of levels){
        const {cols,rows,tiles,group}=level,span=1440/cols,size=cols===4?384:1024;
        const strength=cols===4?.76*smoothStep(2.2,4.6,zoom)*(1-.82*smoothStep(9,20,zoom)):.78*smoothStep(10,18,zoom);
        const opacity=Math.round(strength*1000)/1000;
        const pad=Math.min(span*.2,view.w*.08);
        const x0=Math.max(0,Math.floor((view.x-pad)/span)),x1=Math.min(cols-1,Math.ceil((view.x+view.w+pad)/span)-1);
        const y0=Math.max(0,Math.floor((view.y-pad)/span)),y1=Math.min(rows.length-1,Math.ceil((view.y+view.h+pad)/span)-1);
        const key=opacity?[x0,x1,y0,y1,opacity].join('/'):'';
        if(key===level.key)continue;level.key=key;
        if(group.parentNode!==layer&&opacity)layer.append(group);
        group.style.opacity=String(opacity);
        for(const [id,entry] of tiles){
          const x=id%cols,y=Math.floor(id/cols);
          entry.active=!!opacity&&x>=x0&&x<=x1&&y>=y0&&y<=y1;
          if(!entry.active)entry.node.remove();
        }
        if(opacity)for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
          if(!(rows[y]&(1<<x)))continue;
          const id=y*cols+x;let entry=tiles.get(id);
          if(!entry){
            const node=svg('image'),bleed=span/size*.5,href=`relief/${cols}-${x}-${y}.webp${cols===4?'?v=2':''}`;
            for(const [name,value] of Object.entries({x:x*span-bleed,y:y*span-bleed,width:span+bleed*2,height:span+bleed*2,preserveAspectRatio:'none',href}))node.setAttribute(name,value);
            entry={node,ready:false,active:true,used:clock,image:null};tiles.set(id,entry);
            const image=new Image();
            if(typeof image.decode==='function'){
              const token=generation;entry.image=image;image.decoding='async';image.src=href;
              const pending=entry;
              image.decode().then(()=>{
                if(token!==generation||tiles.get(id)!==pending)return;
                pending.image=null;pending.ready=true;
                if(pending.active)group.append(node);
              }).catch(()=>{if(tiles.get(id)===pending){pending.image=null;pending.failed=true;}});
            }else entry.ready=true;
          }
          entry.active=true;entry.used=clock;
          if(entry.ready&&entry.node.parentNode!==group)group.append(entry.node);
        }
        // Detached tiles survive small back-and-forth camera moves without a
        // new decode. Eviction only touches tiles outside the prepared area.
        const budget=cols===4?8:12;
        for(const [id,entry] of [...tiles].sort((a,b)=>a[1].used-b[1].used)){
          if(tiles.size<=budget)break;if(entry.active)continue;
          if(entry.image)entry.image.src='';entry.node.remove();tiles.delete(id);
        }
      }
    };
  }
  window.RedlineAtlas={measure,intersects,create,relief};
})();
