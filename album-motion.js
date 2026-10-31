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
    const outside=`translateX(-${Math.ceil(size.right||innerWidth)+Math.ceil(tabs.getBoundingClientRect().width||160)+96}px)`;
    arrival.style.transform=opening?outside:'translateX(0px)';
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
    function run(from,to,duration){
      const timing={duration,easing:'cubic-bezier(.4,0,.2,1)',fill:'both'};
      animations=[leaf.animate([{transform:from.leaf},{transform:to.leaf}],timing),scene.animate([{transform:from.scene},{transform:to.scene}],timing)];
      return done(animations);
    }
    return {
      async open(){
        direction='opening';await ready;if(disposed||direction!=='opening')return;started=true;
        run(closedFrames,openFrames,620);
        animations.push(arrival.animate([{transform:outside},{transform:'translateX(0px)',offset:.6},{transform:'translateX(0px)'}],{duration:620,easing:'cubic-bezier(.22,.7,.18,1)',fill:'both'}));
        return done(animations);
      },
      close(){
        if(direction==='opening'&&started){
          direction='closing';reversed=true;animations.forEach(animation=>animation.reverse());return done(animations);
        }
        const alreadyClosed=opening&&!started||closed==='front';direction='closing';
        return ready.then(()=>{if(disposed||alreadyClosed)return;return run(openFrames,closedFrames,660);});
      },
      async depart(onDepart){
        if(disposed)return;
        if(reversed||opening&&!started){onDepart();return;}
        // Let the complete front cover register before it leaves the map.
        const hold=scene.animate([{opacity:1},{opacity:1}],{duration:40,fill:'both'});animations.push(hold);await done([hold]);
        if(disposed)return;onDepart();
        const slide=arrival.animate([{transform:'translateX(0px)'},{transform:outside}],{duration:240,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'});
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
  window.RedlineAlbumMotion={create};
})();
