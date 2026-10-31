/* Static atlas geometry: one fill per country, no full-world clipping mask. */
(() => {
  'use strict';
  const paints=[
    ['atlas-americas',290,190],['atlas-south',470,465],['atlas-europe',770,165],
    ['atlas-africa',805,355],['atlas-asia',1080,190],['atlas-australia',1260,490]
  ];
  function measure(path){
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,x=0,y=0,count=0;
    for(const point of path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)){
      const px=Number(point[1]),py=Number(point[2]);
      left=Math.min(left,px);right=Math.max(right,px);top=Math.min(top,py);bottom=Math.max(bottom,py);x+=px;y+=py;count++;
    }
    return {left,top,right,bottom,x:count?x/count:0,y:count?y/count:0};
  }
  function paintFor(bounds){
    return paints.reduce((best,paint)=>Math.hypot(bounds.x-paint[1],bounds.y-paint[2])<Math.hypot(bounds.x-best[1],bounds.y-best[2])?paint:best)[0];
  }
  const intersects=(bounds,view,pad=3)=>bounds.right>=view.x-pad&&bounds.left<=view.x+view.w+pad&&bounds.bottom>=view.y-pad&&bounds.top<=view.y+view.h+pad;
  function create(land,regions,worldPaths,regionPaths){
    function mount(root,paths,coloured){
      const fragment=document.createDocumentFragment(),entries=[];
      for(const d of paths){
        if(!d)continue;
        const bounds=measure(d),node=document.createElementNS('http://www.w3.org/2000/svg','path');
        node.setAttribute('d',d);
        if(coloured)node.style.fill=`url(#${paintFor(bounds)})`;
        entries.push({node,bounds,visible:true});fragment.append(node);
      }
      root.append(fragment);return entries;
    }
    const countries=mount(land,worldPaths,true),boundaries=mount(regions,regionPaths,false);
    let last='';
    return {paint(view,showRegions){
      const key=[view.x,view.y,view.w,view.h,showRegions].join(',');if(key===last)return;last=key;
      for(const entries of [countries,boundaries])for(const entry of entries){
        const visible=(entries===countries||showRegions)&&intersects(entry.bounds,view);
        if(visible===entry.visible)continue;entry.visible=visible;entry.node.style.display=visible?'':'none';
      }
    }};
  }
  window.RedlineAtlas={measure,paintFor,intersects,create};
})();
