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
  function paintFor(bounds){
    return bounds.x<640?'atlas-americas':bounds.x>1120&&bounds.y>420?'atlas-australia':'atlas-oldworld';
  }
  const intersects=(bounds,view,pad=3)=>bounds.right>=view.x-pad&&bounds.left<=view.x+view.w+pad&&bounds.bottom>=view.y-pad&&bounds.top<=view.y+view.h+pad;
  function create(land,regions,landPaths,regionPaths,countryLayer,countryPaths=[]){
    function mount(root,paths,coloured){
      const fragment=document.createDocumentFragment(),entries=[];
      for(const d of paths){
        if(!d)continue;
        const bounds=measure(d),node=document.createElementNS('http://www.w3.org/2000/svg','path');
        node.setAttribute('d',d);
        if(coloured)node.style.fill=`url(#${paintFor(bounds)})`;
        entries.push({node,bounds,visible:true});fragment.append(node);
      }
      root?.append(fragment);return entries;
    }
    const coasts=mount(land,landPaths,true),countries=mount(countryLayer,countryPaths,false),boundaries=mount(regions,regionPaths,false);
    let last='';
    return {paint(view,showRegions){
      const key=[view.x,view.y,view.w,view.h,showRegions].join(',');if(key===last)return;last=key;
      for(const entries of [coasts,countries,boundaries])for(const entry of entries){
        const visible=(entries!==boundaries||showRegions)&&intersects(entry.bounds,view);
        if(visible===entry.visible)continue;entry.visible=visible;entry.node.style.display=visible?'':'none';
      }
    }};
  }
  window.RedlineAtlas={measure,paintFor,intersects,create};
})();
