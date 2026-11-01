/* One opening fold per page load. The live map stays authoritative throughout. */
(() => {
  'use strict';
  const root=document.documentElement,media=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let active=!media?.matches&&!document.hidden&&typeof Element.prototype.animate==='function';
  let started=false,stage=null,frame=0,timer=0,motions=[];
  const events=['pointerdown','keydown','wheel','resize','pagehide'];
  function finish(){
    if(!active)return;active=false;
    clearTimeout(timer);cancelAnimationFrame(frame);
    root.classList.remove('map-arriving');
    stage?.remove();stage=null;
    for(const motion of motions)motion.cancel();motions=[];
    for(const name of events)window.removeEventListener(name,finish,true);
    document.removeEventListener('visibilitychange',visibility);
    media?.removeEventListener?.('change',preference);
  }
  function visibility(){if(document.hidden)finish();}
  function preference(){if(media.matches)finish();}
  function guard(ms){clearTimeout(timer);timer=setTimeout(finish,ms);}
  function element(className,parent){const node=document.createElement('div');node.className=className;parent.append(node);return node;}
  function quarter(parent,x,y,bottom){
    const panel=element(`unfold-quarter${bottom?' unfold-bottom':''}`,parent),face=element('unfold-face',panel);
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS(svg.namespaceURI,'use');
    svg.setAttribute('viewBox',`${x} ${y} 720 360`);svg.setAttribute('preserveAspectRatio','none');
    // Reference, rather than clone, the actual map: colours, labels and saved
    // routes remain identical when the temporary panels are removed.
    use.setAttribute('href','#map-artwork');svg.append(use);face.append(svg);
    element('unfold-back',panel);const shade=element('unfold-shade',face);
    return {panel,shade};
  }
  function animate(node,keys,options){
    const motion=node.animate(keys,{fill:'both',easing:'cubic-bezier(.22,.68,.26,1)',...options});
    // Attach rejection handling immediately, including partially built sequences.
    motion.finished.catch(()=>{});motions.push(motion);return motion;
  }
  function unfold(){
    if(!active)return;
    const map=document.getElementById('map'),bounds=map?.getBoundingClientRect();
    if(!bounds?.width||!bounds?.height||!document.getElementById('map-artwork')){finish();return;}
    try{
      stage=element('map-unfold',document.querySelector('main'));stage.setAttribute('aria-hidden','true');
      const paper=element('unfold-paper',stage),leftTop=quarter(paper,0,0,false),leftBottom=quarter(paper,0,360,true);
      const right=element('unfold-right',paper),rightTop=quarter(right,720,0,false),rightBottom=quarter(right,720,360,true);
      animate(stage,[{opacity:0},{opacity:1}],{duration:100});
      animate(paper,[
        {transform:'translate(26%, 26%) scale(.92)',offset:0},
        {transform:'translate(0, 24%) scale(.985)',offset:.55},
        {transform:'translate(0, 0) scale(1)',offset:1}
      ],{duration:920});
      animate(right,[{transform:'rotateY(-165deg)'},{transform:'rotateY(0deg)'}],{duration:560});
      for(const {panel} of [leftBottom,rightBottom])animate(panel,[{transform:'rotateX(165deg)'},{transform:'rotateX(0deg)'}],{duration:540,delay:340});
      for(const {shade} of [leftTop,leftBottom,rightTop,rightBottom])animate(shade,[{opacity:1},{opacity:0}],{duration:800,delay:80});
      guard(1250);
      Promise.all(motions.map(motion=>motion.finished)).then(finish,finish);
    }catch{finish();}
  }
  async function start(){
    if(!active||started)return;started=true;guard(650);
    try{
      const href=document.getElementById('atlas-tones')?.getAttribute('href');
      if(!href){finish();return;}
      const image=new Image();image.src=href;
      if(typeof image.decode!=='function'){finish();return;}
      await image.decode();
      if(!active)return;
      if(!image.naturalWidth){finish();return;}
      frame=requestAnimationFrame(unfold);
    }catch{finish();}
  }
  window.RedlineMapIntro={start};
  if(!active)return;
  root.classList.add('map-arriving');
  // A delayed/failed app script must never leave a blank or unusable page.
  guard(2400);
  for(const name of events)window.addEventListener(name,finish,{capture:true,passive:true});
  document.addEventListener('visibilitychange',visibility);
  media?.addEventListener?.('change',preference);
})();
