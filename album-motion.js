/* Cover motion owns a frozen spread, independently of page browsing. */
(() => {
  'use strict';
  const make=className=>{const el=document.createElement('div');el.className=className;return el;};
  const done=animations=>Promise.all(animations.map(animation=>animation.finished.catch(()=>{})));
  function snapshot(source){
    const scroll=source.querySelector('.photo-scroll'),viewport=scroll?.getBoundingClientRect(),scrolls=[];
    function copy(node){
      if(node.nodeType!==1)return node.cloneNode();
      const clone=node.cloneNode(false);
      if(clone.id){clone.classList.add(`album-copy-${clone.id}`);clone.removeAttribute('id');}
      clone.removeAttribute('autofocus');
      // Large albums only duplicate the visible prints. Empty spacers preserve
      // scroll position and the grid without decoding offscreen photographs.
      if(viewport?.height&&node.matches('.gallery-city,.photo-tile')){
        const rect=node.getBoundingClientRect();
        if(rect.bottom<viewport.top||rect.top>viewport.bottom){
          clone.style.height=`${rect.height}px`;clone.style.visibility='hidden';return clone;
        }
      }
      for(const child of node.childNodes)clone.append(copy(child));
      if(node.scrollTop||node.scrollLeft)scrolls.push([clone,node.scrollTop,node.scrollLeft]);
      return clone;
    }
    const el=copy(source);el.classList.add('album-snapshot');el.hidden=false;
    return {el,restore:()=>scrolls.forEach(([node,top,left])=>{node.scrollTop=top;node.scrollLeft=left;})};
  }
  function create({book,source,cover,two,closed='',opening=false}){
    const arrival=make('album-arrival'),scene=make('album-cover-scene'),hinge=make('album-cover-hinge'),leaf=make('album-cover-leaf'),front=make('album-cover-front'),back=make('album-cover-back');
    const tabs=document.getElementById('gallery-filter'),tabParent=tabs.parentElement,tabNext=tabs.nextSibling;
    const tabHeight=tabs.getBoundingClientRect().height,tabMaxHeight=tabs.style.maxHeight,tabScroll=[tabs.scrollTop,tabs.scrollLeft];
    book.dataset.coverPreparing='true';
    const width=source.getBoundingClientRect().width||source.clientWidth||book.clientWidth;
    const size=book.getBoundingClientRect(),savedSize=[book.style.width,book.style.height,book.style.flex];
    // An orientation change is applied after the cover settles, never halfway
    // through a frozen spread. Only transforms run during the fold.
    if(size.width&&size.height){book.style.width=`${size.width}px`;book.style.height=`${size.height}px`;book.style.flex='none';}
    const copies=[];
    scene.classList.toggle('single',!two);scene.classList.toggle('closed-book',!!closed);
    scene.setAttribute('aria-hidden','true');scene.inert=true;
    function half(className,right=false){
      const holder=make(className),copy=snapshot(source);copies.push(copy);
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
    const ready=Promise.all([...scene.querySelectorAll('img')].map(img=>{img.loading='eager';return img.decode?.().catch(()=>{});}))
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
      }
    };
  }
  // A view change turns one physical leaf. Both sides keep frozen, decoded
  // prints at their original scroll positions; the binding never moves.
  function changeView({book,source,apply,direction,two}){
    const layer=make('album-view-layer'),hinge=make('album-view-hinge'),leaf=make('album-view-leaf');
    const front=make('album-view-face album-view-front'),back=make('album-view-face album-view-back');
    const tabs=document.getElementById('gallery-filter'),before=tabs.getBoundingClientRect(),tabTranslate=tabs.style.translate;
    const width=source.getBoundingClientRect().width||source.clientWidth||book.clientWidth,copies=[];
    const size=book.getBoundingClientRect(),savedSize=[book.style.width,book.style.height,book.style.flex];
    if(size.width&&size.height){book.style.width=`${size.width}px`;book.style.height=`${size.height}px`;book.style.flex='none';}
    const forward=direction<0;layer.classList.toggle('single',!two);leaf.classList.add(forward?'forward':'backward');
    layer.inert=true;layer.setAttribute('aria-hidden','true');
    function surface(element,right=false){
      const holder=make(`album-view-surface ${right?'right':'left'}`),copy=snapshot(element),style=getComputedStyle(element);
      copy.el.style.width=`${width}px`;copy.el.style.left=right&&two?`${-width/2}px`:'0';
      copy.el.style.translate=style.translate||'none';copy.el.style.boxShadow=style.boxShadow;copy.el.style.visibility='visible';
      holder.style.setProperty('--view-crease',element.classList.contains('album-pages')&&(book.classList.contains('closed-front')||book.classList.contains('closed-back'))?'0':'1');
      holder.append(copy.el);copies.push(copy);return holder;
    }
    const oldLeft=surface(source),oldRight=two?surface(source,true):null;
    layer.append(oldLeft);if(oldRight)layer.append(oldRight);book.append(layer);copies.forEach(copy=>copy.restore());
    book.dataset.viewMotion='true';
    const incoming=apply(),visibility=incoming.style.visibility;incoming.style.visibility='hidden';
    const newLeft=surface(incoming),newRight=two?surface(incoming,true):null;
    // Keep incoming copies in the laid-out scene while decoding, without
    // revealing them or resetting their nested scrolling containers.
    const preparation=make('album-view-preparation');preparation.append(newLeft);if(newRight)preparation.append(newRight);
    layer.append(preparation);copies.forEach(copy=>copy.restore());
    const after=tabs.getBoundingClientRect(),shift=`${before.left-after.left}px ${before.top-after.top}px`;
    const tabsMove=before.left!==after.left||before.top!==after.top;if(tabsMove)tabs.style.translate=shift;
    let disposed=false,animations=[];
    const scroll=incoming.querySelector('.photo-scroll'),viewport=(scroll||incoming).getBoundingClientRect();
    const images=[...incoming.querySelectorAll('img')].filter(img=>{const rect=img.getBoundingClientRect();return !viewport.height||rect.bottom>=viewport.top&&rect.top<=viewport.bottom;});
    const ready=Promise.all([...layer.querySelectorAll('img'),...images].map(async img=>{
      img.loading='eager';try{await img.decode?.();img.closest('.photo-image')?.classList.add('loaded');}catch{}
    }));
    return {
      async play(){
        await ready;if(disposed)return;
        const frontShade=make('album-view-shade'),backShade=make('album-view-shade'),cast=make('album-view-cast');
        const timing={duration:two?820:720,easing:'cubic-bezier(.37,0,.63,1)',fill:'both'};
        for(const shade of [frontShade,backShade,cast])shade.style.opacity='0';
        let channels=[];
        if(two){
          const underLeft=forward?oldLeft:newLeft,underRight=forward?newRight:oldRight;
          front.append(forward?oldRight:oldLeft,frontShade);back.append(forward?newLeft:newRight,backShade);
          (forward?underRight:underLeft).append(cast);leaf.append(front,back);hinge.append(leaf);layer.replaceChildren(underLeft,underRight,hinge);
          channels=[
            [leaf,[{transform:'rotateY(0deg)'},{transform:`rotateY(${forward?-180:180}deg)`}]],
            [frontShade,[{opacity:0},{opacity:.14,offset:.5},{opacity:.14}]],
            [backShade,[{opacity:.14},{opacity:.14,offset:.5},{opacity:0}]],
            [cast,[{opacity:.12},{opacity:0}]]
          ];
        }else{
          const under=forward?newLeft:oldLeft;under.append(cast);front.append(forward?oldLeft:newLeft,frontShade);leaf.append(front);hinge.append(leaf);layer.replaceChildren(under,hinge);
          channels=[
            [leaf,forward?[{transform:'rotateY(0deg)'},{transform:'rotateY(-105deg)'}]:[{transform:'rotateY(-105deg)'},{transform:'rotateY(0deg)'}]],
            [frontShade,[{opacity:0},{opacity:.12,offset:.5},{opacity:0}]],
            [cast,[{opacity:.12},{opacity:0}]]
          ];
        }
        leaf.style.transform=channels[0][1][0].transform;copies.forEach(copy=>copy.restore());
        // Finish all layout and scrolling before the first moving frame. The
        // browser gets a paint to prepare the two faces on its compositor.
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));if(disposed)return;
        if(tabsMove)channels.push([tabs,[{translate:shift},{translate:tabTranslate||'0px 0px'}]]);
        animations=channels.map(([element,frames])=>element.animate(frames,timing));
        const start=document.timeline?.currentTime;if(start!=null)animations.forEach(animation=>animation.startTime=start);
        await done(animations);
      },
      dispose(){disposed=true;incoming.style.visibility=visibility;tabs.style.translate=tabTranslate;layer.remove();animations.forEach(animation=>animation.cancel());delete book.dataset.viewMotion;[book.style.width,book.style.height,book.style.flex]=savedSize;}
    };
  }
  window.RedlineAlbumMotion={create,changeView};
})();
