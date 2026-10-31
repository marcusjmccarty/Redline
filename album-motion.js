/* Cover motion owns a frozen spread, independently of page browsing. */
(() => {
  'use strict';
  const make=className=>{const el=document.createElement('div');el.className=className;return el;};
  const done=animations=>Promise.all(animations.map(animation=>animation.finished.catch(()=>{})));
  // Retain decoded thumbnails while the album is open. Throwaway Image
  // objects did not keep the next view ready and only warmed a dozen photos.
  const previews=new Map(),previewQueue=[],idleWaiters=new Set();
  let decoding=0,previewHolds=0;
  function pumpPreviews(){
    while(!previewHolds&&decoding<3&&previewQueue.length){
      const entry=previewQueue.shift();if(previews.get(entry.url)!==entry||entry.settled)continue;
      entry.running=true;decoding++;
      entry.timer=setTimeout(()=>entry.finish(false),1500);
      entry.image.src=entry.url;
      Promise.resolve().then(()=>entry.image.decode()).then(()=>entry.finish(true),()=>entry.finish(false));
    }
  }
  function preload(urls){
    const work=[];
    for(const url of [...new Set(urls.filter(Boolean))].slice(0,48)){
      let entry=previews.get(url);
      if(entry){previews.delete(url);previews.set(url,entry);work.push(entry.promise);continue;}
      const image=new Image();image.decoding='async';image.loading='eager';
      entry={url,image,running:false,settled:false};
      entry.promise=new Promise(resolve=>{entry.finish=ready=>{
        if(entry.settled)return;entry.settled=true;clearTimeout(entry.timer);
        if(entry.running)decoding--;
        if(!ready&&previews.get(url)===entry)previews.delete(url);
        resolve(ready);pumpPreviews();
      };});
      previews.set(url,entry);previewQueue.push(entry);work.push(entry.promise);
      while(previews.size>48){const [oldUrl,old]=previews.entries().next().value;previews.delete(oldUrl);old.finish(false);old.image.removeAttribute('src');}
    }
    pumpPreviews();return Promise.all(work);
  }
  function clearPreloads(){
    const entries=[...previews.values()];previews.clear();previewQueue.length=0;
    for(const entry of entries){entry.finish(false);entry.image.removeAttribute('src');}
  }
  function holdPreviews(){
    previewHolds++;let released=false;
    return ()=>{
      if(released)return;released=true;previewHolds--;
      // A view turn may hand directly to a closing cover in this same task.
      // Let that next owner acquire its hold before starting queued work.
      queueMicrotask(()=>{if(previewHolds)return;for(const resolve of idleWaiters)resolve();idleWaiters.clear();pumpPreviews();});
    };
  }
  const idle=()=>previewHolds?new Promise(resolve=>idleWaiters.add(resolve)):Promise.resolve();
  function snapshots(source){
    const scroll=source.querySelector('.photo-scroll'),viewport=scroll?.getBoundingClientRect();
    const positions=[...source.querySelectorAll('.photo-scroll')].map(node=>[node.scrollTop,node.scrollLeft]);
    // Measure the live sheet once, then create both halves from a detached
    // template. Reading scroll/layout on every copied descendant was costly.
    const omitted=new WeakMap();
    function measure(node){
      if(node.nodeType!==1)return;
      if(viewport?.height&&node.matches('.gallery-city,.photo-tile')){
        const rect=node.getBoundingClientRect();
        if(rect.bottom<viewport.top||rect.top>viewport.bottom){omitted.set(node,rect.height);return;}
      }
      for(const child of node.children)measure(child);
    }
    measure(source);
    function copy(node){
      if(node.nodeType!==1)return node.cloneNode();
      const clone=node.cloneNode(false);
      if(clone.id){clone.classList.add(`album-copy-${clone.id}`);clone.removeAttribute('id');}
      clone.removeAttribute('autofocus');
      if(omitted.has(node)){clone.style.height=`${omitted.get(node)}px`;clone.style.visibility='hidden';return clone;}
      for(const child of node.childNodes)clone.append(copy(child));
      return clone;
    }
    const template=copy(source);template.classList.add('album-snapshot');template.hidden=false;
    return ()=>{
      const el=template.cloneNode(true),scrolls=[...el.querySelectorAll('.photo-scroll')];
      return {el,restore:()=>scrolls.forEach((node,i)=>{[node.scrollTop,node.scrollLeft]=positions[i];})};
    };
  }
  async function decodeImages(images,{reveal=()=>true}={}){
    await Promise.all([...new Set(images)].map(async image=>{
      image.loading='eager';
      try{
        // complete means bytes loaded, not that the bitmap is ready to paint.
        // Decode each actual face before moving it, including cached images.
        await image.decode?.();
        if(reveal())image.closest('.photo-image')?.classList.add('loaded');
      }catch{}
    }));
  }
  function inertCopy(node,deep=true){
    const copy=node.cloneNode(false);
    if(node.nodeType!==1)return copy;
    if(copy.id){copy.classList.add(`album-copy-${copy.id}`);copy.removeAttribute('id');}
    copy.removeAttribute('autofocus');
    if(deep)for(const child of node.childNodes)copy.append(inertCopy(child));
    return copy;
  }
  // Freeze only the visible contact sheet. A moving page must not carry a
  // scrollable grid, sticky layers, or thousands of hidden photo placeholders.
  function flatSheet(source){
    const scroll=source.querySelector('.photo-scroll'),bounds=source.getBoundingClientRect(),viewport=scroll?.getBoundingClientRect();
    if(!viewport?.height||!bounds.width)return null;
    const images=[],template=inertCopy(source,false);
    template.hidden=false;template.classList.add('album-snapshot','album-frozen-sheet');
    const place=(copy,rect,parent)=>{
      Object.assign(copy.style,{position:'absolute',inset:'auto',left:`${rect.left-parent.left}px`,top:`${rect.top-parent.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,margin:'0',flex:'none'});
      return copy;
    };
    const capture=(node,rect,parent)=>{
      images.push(...node.querySelectorAll('img'));
      return place(inertCopy(node),rect,parent);
    };
    // Read live geometry before attaching any of the new nodes. Detached
    // writes below cannot invalidate the live book's layout.
    for(const child of source.children){
      const rect=child===scroll?viewport:child.getBoundingClientRect();
      if(!rect.height||child.hidden)continue;
      if(child!==scroll){template.append(capture(child,rect,bounds));continue;}
      const viewportCopy=place(inertCopy(scroll,false),viewport,bounds);
      viewportCopy.classList.add('album-frozen-scroll');
      const gallery=scroll.querySelector('#photo-gallery'),copy=inertCopy(gallery,false);
      copy.classList.add('album-frozen-gallery');viewportCopy.append(copy);template.append(viewportCopy);
      for(const section of gallery.children){
        const sectionRect=section.getBoundingClientRect();
        if(sectionRect.bottom<viewport.top||sectionRect.top>viewport.bottom)continue;
        if(!section.matches('.gallery-city')){copy.append(capture(section,sectionRect,viewport));continue;}
        const group=inertCopy(section,false);group.classList.add('album-frozen-group');copy.append(group);
        const heading=section.querySelector('.gallery-city-heading'),headingRect=heading.getBoundingClientRect();
        if(headingRect.bottom>viewport.top&&headingRect.top<viewport.bottom)group.append(capture(heading,headingRect,viewport));
        const grid=section.querySelector('.photo-grid'),tiles=grid.children,gridCopy=inertCopy(grid,false);
        gridCopy.classList.add('album-frozen-grid');group.append(gridCopy);
        const columns=Math.max(1,(getComputedStyle(grid).gridTemplateColumns.match(/[\d.]+px/g)||[]).length);
        const rows=Math.ceil(tiles.length/columns),measured=new Map();
        const tileRect=index=>{if(!measured.has(index))measured.set(index,tiles[index].getBoundingClientRect());return measured.get(index);};
        // All Photos uses equal square tiles. Locate the first visible row in
        // logarithmic time instead of measuring every photo in a large city.
        let low=0,high=rows;
        while(low<high){const mid=(low+high)>>1;if(tileRect(mid*columns).bottom<viewport.top-24)low=mid+1;else high=mid;}
        for(let row=low;row<rows;row++){
          if(tileRect(row*columns).top>viewport.bottom+24)break;
          for(let index=row*columns;index<Math.min((row+1)*columns,tiles.length);index++)gridCopy.append(capture(tiles[index],tileRect(index),viewport));
        }
      }
    }
    return {template,images};
  }
  function viewCapture(source,{two,width,closed}){
    // Ordinary album pages keep their native half-page geometry and container
    // sizes, exactly as in a chapter turn; don't clone two entire spreads.
    if(source.classList.contains('album-pages')&&!closed){
      const pages=[...source.children],templates=pages.map(page=>{const copy=inertCopy(page);copy.classList.add('album-snapshot');return copy;});
      return {images:[...source.querySelectorAll('img')],take:right=>({el:templates[two&&right?1:0].cloneNode(true),restore(){}})};
    }
    const frozen=source.classList.contains('album-sheet')?flatSheet(source):null;
    const capture=frozen?()=>({el:frozen.template.cloneNode(true),restore(){}}):snapshots(source),style=getComputedStyle(source);
    return {images:frozen?.images||[...source.querySelectorAll('img')],take:right=>{
      const copy=capture();
      if(frozen&&two){
        // Each face only carries prints that can appear on its half. Keep
        // gutter-crossing prints on both, including their soft shadow, so the
        // hinge stays seamless without decoding/rasterizing two whole sheets.
        const start=right?width/2:0,end=right?width:width/2;
        for(const tile of copy.el.querySelectorAll('.photo-tile')){
          const left=parseFloat(tile.closest('.album-frozen-scroll').style.left)+parseFloat(tile.style.left),edge=left+parseFloat(tile.style.width);
          if(edge<start-24||left>end+24)tile.remove();
        }
      }
      copy.el.style.width=`${width}px`;copy.el.style.left=right&&two?`${-width/2}px`:'0';
      copy.el.style.translate=style.translate||'none';copy.el.style.boxShadow=style.boxShadow;copy.el.style.visibility='visible';return copy;
    }};
  }
  // Chapter turns and Album / All Photos share this exact motion.
  function turnLeaf({leaf,frontShade,backShade,cast,forward,two=true,duration=two?744:560}){
    const timing={duration,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'};
    let animations;
    if(two)animations=[
      leaf.animate([{transform:'rotateY(0deg)'},{transform:`rotateY(${forward?-180:180}deg)`}],timing),
      frontShade.animate([{opacity:0},{opacity:.42,offset:.5},{opacity:.42}],timing),
      backShade.animate([{opacity:.42},{opacity:.42,offset:.5},{opacity:0}],timing),
      cast.animate([{opacity:.55},{opacity:0}],timing)
    ];
    else{
      const frames=[{transform:'perspective(1600px) rotateY(0deg)',opacity:1},{transform:'perspective(1600px) rotateY(-82deg)',opacity:.2}];
      animations=[leaf.animate(forward?frames:[...frames].reverse(),timing)];
    }
    const start=document.timeline?.currentTime;if(start!=null)animations.forEach(animation=>animation.startTime=start);
    return animations;
  }
  function create({book,source,cover,two,closed='',opening=false}){
    const resumePreviews=holdPreviews();
    const arrival=make('album-arrival'),scene=make('album-cover-scene'),hinge=make('album-cover-hinge'),leaf=make('album-cover-leaf'),front=make('album-cover-front'),back=make('album-cover-back');
    const tabs=document.getElementById('gallery-filter'),tabParent=tabs.parentElement,tabNext=tabs.nextSibling;
    const tabHeight=tabs.getBoundingClientRect().height,tabMaxHeight=tabs.style.maxHeight,tabScroll=[tabs.scrollTop,tabs.scrollLeft];
    book.dataset.coverPreparing='true';
    const width=source.getBoundingClientRect().width||source.clientWidth||book.clientWidth;
    const size=book.getBoundingClientRect(),savedSize=[book.style.width,book.style.height,book.style.flex];
    // An orientation change is applied after the cover settles, never halfway
    // through a frozen spread. Only transforms run during the fold.
    if(size.width&&size.height){book.style.width=`${size.width}px`;book.style.height=`${size.height}px`;book.style.flex='none';}
    const copies=[],capture=snapshots(source);
    scene.classList.toggle('single',!two);scene.classList.toggle('closed-book',!!closed);
    scene.setAttribute('aria-hidden','true');scene.inert=true;
    function half(className,right=false){
      const holder=make(className),copy=capture();copies.push(copy);
      copy.el.style.width=`${width}px`;copy.el.style.left=right?`${-width/2}px`:'0';
      holder.append(copy.el);return holder;
    }
    front.append(cover);leaf.append(front,back);
    if(closed==='back')back.append(half('album-cover-crop'));
    else if(!closed){
      scene.append(half('album-cover-still',two));
      if(two)back.append(half('album-cover-crop'));
    }
    // The scene is a flat stacking context. Only the hinge is 3D, so a sticky
    // header or tab can never intersect a turning face at the same depth.
    hinge.append(leaf);scene.append(hinge);scene.style.visibility='hidden';arrival.append(scene);book.append(arrival);
    copies.forEach(copy=>copy.restore());
    const angle=closed==='front'?0:two||closed?-180:-105;
    const shift=two&&!closed?'-25%':'0%';
    const closedFrames={leaf:'rotateY(0deg)',scene:`translateX(${shift})`};
    const openFrames={leaf:`rotateY(${angle}deg)`,scene:'translateX(0%)'};
    const outside=`translateY(${Math.ceil(innerHeight-size.top)+96}px)`;
    arrival.style.transform=opening?outside:'translateY(0px)';
    let animations=[],direction=opening?'opening':'closing',disposed=false,started=false;
    const pose=state=>{leaf.style.transform=state.leaf;scene.style.transform=state.scene;};
    pose(opening?closedFrames:openFrames);
    const ready=decodeImages([...scene.querySelectorAll('img')])
      .then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      .then(()=>{
        if(disposed)return;
        if(tabHeight)tabs.style.maxHeight=`${tabHeight}px`;
        scene.append(tabs);[tabs.scrollTop,tabs.scrollLeft]=tabScroll;book.dataset.coverMotion='true';
        book.querySelector('.album-loading-cover')?.remove();delete book.dataset.preparing;
        scene.style.visibility='';
      });
    // Every channel shares one clock. Reversing this exact timeline also
    // reverses its holds, overlap, and easing, with no separate exit phase.
    function run(reverse=false){
      const total=1400,curve='cubic-bezier(.4,0,.2,1)';
      const frames=key=>[{transform:closedFrames[key],offset:0},{transform:closedFrames[key],offset:.25,easing:curve},{transform:openFrames[key],offset:1}];
      const timing={duration:total,easing:'linear',direction:reverse?'reverse':'normal',fill:'both'};
      animations=[leaf.animate(frames('leaf'),timing),scene.animate(frames('scene'),timing),arrival.animate([
        {transform:outside,offset:0,easing:'cubic-bezier(.42,0,.3,1)'},
        {transform:'translateY(0px)',offset:1000/total},{transform:'translateY(0px)',offset:1}
      ],timing)];
      const start=document.timeline?.currentTime;if(start!=null)animations.forEach(animation=>animation.startTime=start);
      return done(animations);
    }
    return {
      async open(){
        direction='opening';await ready;if(disposed||direction!=='opening')return;started=true;return run();
      },
      close(onDepart=()=>{}){
        const wasOpening=direction==='opening';direction='closing';
        if(wasOpening&&!started){onDepart(0);return Promise.resolve();}
        if(wasOpening){
          const remaining=Math.max(0,Number(animations[0]?.currentTime)||0);
          animations.forEach(animation=>animation.reverse());onDepart(remaining);return done(animations);
        }
        return ready.then(()=>{if(disposed)return;const finished=run(true);onDepart(1400);return finished;});
      },
      dispose(){
        disposed=true;
        tabParent.insertBefore(tabs,tabNext?.parentElement===tabParent?tabNext:null);
        tabs.style.maxHeight=tabMaxHeight;[tabs.scrollTop,tabs.scrollLeft]=tabScroll;
        arrival.remove();animations.forEach(animation=>animation.cancel());delete book.dataset.coverMotion;delete book.dataset.coverPreparing;
        [book.style.width,book.style.height,book.style.flex]=savedSize;
        resumePreviews();
      }
    };
  }
  // Keep the old spread in place while the next page's bitmaps prepare. Warm
  // thumbnails normally finish immediately; corrupt images cannot block it.
  function changeView({book,source,apply,direction,two}){
    // The visible leaf gets first use of the decoder and compositor. Queue
    // background thumbnails until the turn settles, including interrupted turns.
    const resumePreviews=holdPreviews();
    const layer=make('album-view-layer'),hinge=make('album-view-hinge'),leaf=make('album-view-leaf');
    const front=make('album-view-face album-view-front'),back=make('album-view-face album-view-back');
    const tabs=document.getElementById('gallery-filter'),before=tabs.getBoundingClientRect(),tabTranslate=tabs.style.translate;
    const width=source.getBoundingClientRect().width||source.clientWidth||book.clientWidth,copies=[];
    const size=book.getBoundingClientRect(),savedSize=[book.style.width,book.style.height,book.style.flex];
    if(size.width&&size.height){book.style.width=`${size.width}px`;book.style.height=`${size.height}px`;book.style.flex='none';}
    const forward=direction<0;layer.classList.toggle('single',!two);leaf.classList.add(forward?'forward':'backward');
    layer.inert=true;layer.setAttribute('aria-hidden','true');
    const captures=new Map();
    function surface(element,right=false){
      if(!captures.has(element))captures.set(element,viewCapture(element,{two,width,closed:book.classList.contains('closed-front')||book.classList.contains('closed-back')}));
      const holder=make(`album-view-surface ${right?'right':'left'}`),copy=captures.get(element).take(right);
      holder.classList.toggle('native-page',copy.el.classList.contains('album-page'));
      holder.style.setProperty('--view-crease',element.classList.contains('album-pages')&&(book.classList.contains('closed-front')||book.classList.contains('closed-back'))?'0':'1');
      holder.append(copy.el);copies.push(copy);return holder;
    }
    const oldLeft=surface(source),oldRight=two?surface(source,true):null;
    layer.append(oldLeft);if(oldRight)layer.append(oldRight);book.append(layer);copies.forEach(copy=>copy.restore());
    book.dataset.viewMotion='true';
    // The real destination is the stationary paper underneath the turn. Keep
    // it painted throughout; visibility:hidden can discard its scroll/image
    // layers and force a fresh rasterization exactly as the leaf disappears.
    const incoming=apply();
    const arriving=two?surface(incoming,!forward):forward?null:surface(incoming);
    const frontShade=make('page-shade album-view-shade'),backShade=make('page-shade album-view-shade'),cast=make('page-shade cast');
    front.classList.add(forward?'right':'left');back.classList.add(forward?'left':'right');
    // Build the final 3D stack before decoding. At zero degrees the outgoing
    // face covers the next spread. No moving images are reparented at takeoff;
    // the browser has the entire preparation window to rasterize these layers.
    if(two){
      const stationary=forward?oldLeft:oldRight,shadow=make(`album-view-surface ${forward?'right':'left'}`);
      front.append(forward?oldRight:oldLeft,frontShade);back.append(arriving,backShade);
      shadow.append(cast);leaf.append(front,back);hinge.append(leaf);layer.replaceChildren(stationary,shadow,hinge);
    }else{
      front.append(forward?oldLeft:arriving);leaf.append(front);hinge.append(leaf);layer.replaceChildren(...(forward?[]:[oldLeft]),hinge);
      leaf.classList.add('single-leaf');
      // A backward single-page turn starts partly folded. Keep the old page
      // above it during preparation, then remove only this stationary guard.
      if(!forward){const guard=oldLeft.cloneNode(true);guard.classList.add('album-view-guard');layer.append(guard);}
    }
    copies.forEach(copy=>copy.restore());
    const after=tabs.getBoundingClientRect(),shift=`${before.left-after.left}px ${before.top-after.top}px`;
    const tabsMove=before.left!==after.left||before.top!==after.top;if(tabsMove)tabs.style.translate=shift;
    let disposed=false,started=false,animations=[],readyTimer,cancelReady;
    const cancelled=new Promise(resolve=>{cancelReady=resolve;});
    // Even a single-page forward turn needs to warm its live destination,
    // although that view no longer needs any duplicate stationary snapshot.
    if(!captures.has(incoming))captures.set(incoming,viewCapture(incoming,{two,width,closed:false}));
    const ready=decodeImages([...captures.values()].flatMap(capture=>capture.images).concat([...layer.querySelectorAll('img')]),{reveal:()=>!disposed&&!started});
    return {
      async play(){
        if(disposed)return;
        await Promise.race([ready,cancelled,new Promise(resolve=>{readyTimer=setTimeout(resolve,240);})]);
        clearTimeout(readyTimer);if(disposed)return;
        // Give the browser a paint opportunity with the finished leaf in its
        // final stacking order. Uploads and scroll restoration precede motion.
        await Promise.race([cancelled,new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))]);
        if(disposed)return;started=true;
        layer.querySelector('.album-view-guard')?.remove();
        animations=turnLeaf({leaf,frontShade,backShade,cast,forward,two});
        if(tabsMove)animations.push(tabs.animate([{translate:shift},{translate:tabTranslate||'0px 0px'}],{duration:two?744:560,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'}));
        await done(animations);
        if(disposed)return;
        // Retire the outgoing stationary half first, while the finished leaf
        // still covers its side. The live destination has never been hidden.
        for(const page of [oldLeft,oldRight])if(page?.parentNode===layer)page.remove();
        layer.dataset.handoff='true';
        await Promise.race([cancelled,new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))]);
      },
      dispose(){disposed=true;clearTimeout(readyTimer);cancelReady();tabs.style.translate=tabTranslate;layer.remove();animations.forEach(animation=>animation.cancel());delete book.dataset.viewMotion;[book.style.width,book.style.height,book.style.flex]=savedSize;resumePreviews();}
    };
  }
  window.RedlineAlbumMotion={create,changeView,turnLeaf,preload,clearPreloads,idle};
})();
