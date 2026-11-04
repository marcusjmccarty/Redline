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
  // Tiles share the atlas projection. Only intersecting land tiles have an
  // SVG image (and a decoded bitmap); the overview requests no relief.
  function relief(layer,coverage){
    const levels=[4,16].map((cols,i)=>({cols,rows:coverage?.[i]||[],tiles:new Map(),key:''}));
    return function paint(view,zoom){
      for(const level of levels){
        const {cols,rows,tiles}=level,span=1440/cols;
        const strength=cols===4?Math.min(.74,(zoom-2.2)*.36,Math.max(.12,(13-zoom)*.2)):Math.min(.88,(zoom-10)*.3);
        const opacity=Math.max(0,Math.round(strength*40)/40);
        const x0=Math.max(0,Math.floor(view.x/span)),x1=Math.min(cols-1,Math.ceil((view.x+view.w)/span)-1);
        const y0=Math.max(0,Math.floor(view.y/span)),y1=Math.min(rows.length-1,Math.ceil((view.y+view.h)/span)-1);
        const key=opacity?[x0,x1,y0,y1,opacity].join('/'):'';
        if(key===level.key)continue;level.key=key;
        for(const [id,node] of tiles){
          const x=id%cols,y=Math.floor(id/cols);
          if(!opacity||x<x0||x>x1||y<y0||y>y1){node.remove();tiles.delete(id);}
        }
        if(!opacity)continue;
        for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
          if(!(rows[y]&(1<<x)))continue;
          const id=y*cols+x;let tile=tiles.get(id);
          if(!tile){
            tile=document.createElementNS('http://www.w3.org/2000/svg','image');
            for(const [name,value] of Object.entries({x:x*span,y:y*span,width:span,height:span,preserveAspectRatio:'none',href:`relief/${cols}-${x}-${y}.webp`}))tile.setAttribute(name,value);
            layer.append(tile);tiles.set(id,tile);
          }
          tile.style.opacity=String(opacity);
        }
      }
    };
  }
  window.RedlineAtlas={measure,intersects,create,relief};
})();
