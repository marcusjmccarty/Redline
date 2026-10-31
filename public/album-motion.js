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
    const scene=make('album-cover-scene'),leaf=make('album-cover-leaf'),front=make('album-cover-front'),back=make('album-cover-back');
    const tabs=document.getElementById('gallery-filter'),tabParent=tabs.parentElement,tabNext=tabs.nextSibling;
    const width=source.clientWidth||source.getBoundingClientRect().width||book.clientWidth;
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
    scene.append(leaf,tabs);book.append(scene);book.dataset.coverMotion='true';
    copies.forEach(copy=>copy.restore());
    const angle=closed==='front'?0:two||closed?-180:-105;
    const shift=two&&!closed?'-25%':'0%';
    const closedFrames={leaf:'rotateY(0deg)',scene:`translateX(${shift})`};
    const openFrames={leaf:`rotateY(${angle}deg)`,scene:'translateX(0%)'};
    let animations=[],direction=opening?'opening':'closing',disposed=false;
    const pose=state=>{leaf.style.transform=state.leaf;scene.style.transform=state.scene;};
    pose(opening?closedFrames:openFrames);
    function run(from,to,duration){
      const timing={duration,easing:'cubic-bezier(.4,0,.2,1)',fill:'both'};
      animations=[leaf.animate([{transform:from.leaf},{transform:to.leaf}],timing),scene.animate([{transform:from.scene},{transform:to.scene}],timing)];
      return done(animations);
    }
    return {
      open(){direction='opening';return run(closedFrames,openFrames,860);},
      close(){
        if(direction==='opening'&&animations.length){
          direction='closing';animations.forEach(animation=>animation.reverse());return done(animations);
        }
        direction='closing';return closed==='front'?Promise.resolve():run(openFrames,closedFrames,660);
      },
      async depart(onDepart){
        // Let the complete front cover register before it leaves the map.
        const hold=scene.animate([{opacity:1},{opacity:1}],{duration:130,fill:'both'});animations.push(hold);await done([hold]);
        if(disposed)return;onDepart();
        const fade=scene.animate([{opacity:1,translate:'0 0'},{opacity:0,translate:'0 9px'}],{duration:190,easing:'ease-in',fill:'forwards'});
        animations.push(fade);await done([fade]);
      },
      dispose(){
        disposed=true;animations.forEach(animation=>animation.cancel());
        tabParent.insertBefore(tabs,tabNext?.parentElement===tabParent?tabNext:null);
        scene.remove();delete book.dataset.coverMotion;
        [book.style.width,book.style.height,book.style.flex]=savedSize;
      }
    };
  }
  window.RedlineAlbumMotion={create};
})();
