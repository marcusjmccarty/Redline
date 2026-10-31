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
    let animations=[],direction=opening?'opening':'closing',disposed=false,started=false,reversed=false;
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
    function run(from,to,duration,hold=0){
      const timing={duration,easing:'linear',fill:'both'};
      const frames=key=>[{transform:from[key],offset:0},...(hold?[{transform:from[key],offset:hold}]:[]),{transform:to[key],offset:1}].map((frame,i,all)=>({...frame,easing:i===all.length-2?'cubic-bezier(.4,0,.2,1)':'linear'}));
      animations=[leaf.animate(frames('leaf'),timing),scene.animate(frames('scene'),timing)];
      return done(animations);
    }
    return {
      async open(){
        direction='opening';await ready;if(disposed||direction!=='opening')return;started=true;
        run(closedFrames,openFrames,1400,.25);
        animations.push(arrival.animate([{transform:outside},{transform:'translateY(0px)'}],{duration:1000,easing:'cubic-bezier(.42,0,.3,1)',fill:'both'}));
        return done(animations);
      },
      close(){
        if(direction==='opening'&&started){
          direction='closing';reversed=true;animations.forEach(animation=>{animation.reverse();animation.updatePlaybackRate?.(-3.5);});return done(animations);
        }
        const alreadyClosed=opening&&!started||closed==='front';direction='closing';
        return ready.then(()=>{if(disposed||alreadyClosed)return;return run(openFrames,closedFrames,280);});
      },
      async depart(onDepart){
        if(disposed)return;
        if(reversed||opening&&!started){onDepart();return;}
        // Let the complete front cover register before it leaves the map.
        const hold=scene.animate([{opacity:1},{opacity:1}],{duration:20,fill:'both'});animations.push(hold);await done([hold]);
        if(disposed)return;onDepart();
        const slide=arrival.animate([{transform:'translateY(0px)'},{transform:outside}],{duration:100,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'});
        animations.push(slide);await done([slide]);
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
        const timing={duration:two?720:620,easing:'cubic-bezier(.35,0,.25,1)',fill:'both'};
        if(two){
          const underLeft=forward?oldLeft:newLeft,underRight=forward?newRight:oldRight;
          front.append(forward?oldRight:oldLeft,frontShade);back.append(forward?newLeft:newRight,backShade);
          (forward?underRight:underLeft).append(cast);leaf.append(front,back);hinge.append(leaf);layer.replaceChildren(underLeft,underRight,hinge);
          animations=[
            leaf.animate([{transform:'rotateY(0deg)'},{transform:`rotateY(${forward?-180:180}deg)`}],timing),
            frontShade.animate([{opacity:0},{opacity:.22,offset:.5},{opacity:.22}],timing),
            backShade.animate([{opacity:.22},{opacity:.22,offset:.5},{opacity:0}],timing),
            cast.animate([{opacity:.2},{opacity:0}],timing)
          ];
        }else{
          const under=forward?newLeft:oldLeft;under.append(cast);front.append(forward?oldLeft:newLeft,frontShade);leaf.append(front);hinge.append(leaf);layer.replaceChildren(under,hinge);
          animations=[
            leaf.animate(forward?[{transform:'rotateY(0deg)'},{transform:'rotateY(-105deg)'}]:[{transform:'rotateY(-105deg)'},{transform:'rotateY(0deg)'}],timing),
            frontShade.animate([{opacity:0},{opacity:.15,offset:.5},{opacity:0}],timing),
            cast.animate([{opacity:.18},{opacity:0}],timing)
          ];
        }
        copies.forEach(copy=>copy.restore());
        if(tabsMove)animations.push(tabs.animate([{translate:shift},{translate:tabTranslate||'0px 0px'}],timing));
        await done(animations);
      },
      dispose(){disposed=true;incoming.style.visibility=visibility;tabs.style.translate=tabTranslate;layer.remove();animations.forEach(animation=>animation.cancel());delete book.dataset.viewMotion;}
    };
  }
  window.RedlineAlbumMotion={create,changeView};
})();
