/* One opening fold per page load. The live map stays authoritative throughout. */
(() => {
  'use strict';
  const root=document.documentElement,media=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const foldEase='cubic-bezier(.45,0,.25,1)';
  let active=!media?.matches&&!document.hidden&&typeof Element.prototype.animate==='function';
  let started=false,stage=null,frame=0,timer=0,motions=[];
  const events=['pointerdown','keydown','wheel','pagehide'];
  function finish(){
    if(!active)return;active=false;
    clearTimeout(timer);cancelAnimationFrame(frame);
    root.classList.remove('map-arriving','map-revealing');
    stage?.remove();stage=null;
    for(const motion of motions)motion.cancel();motions=[];
    for(const name of events)window.removeEventListener(name,finish,true);
    window.removeEventListener('resize',resize);
    document.removeEventListener('visibilitychange',visibility);
    media?.removeEventListener?.('change',preference);
  }
  function visibility(){if(document.hidden)finish();}
  function preference(){if(media.matches)finish();}
  function resize(){if(stage)finish();}
  function guard(ms){clearTimeout(timer);timer=setTimeout(finish,ms);}
  function handoff(){
    if(!active)return;
    // Paint the real map underneath the opaque, flattened sheet before retiring
    // its temporary compositor layers. Never cross-fade two copies of the ink.
    root.classList.add('map-revealing');
    frame=requestAnimationFrame(()=>{if(active)frame=requestAnimationFrame(finish);});
  }
  function element(className,parent){const node=document.createElement('div');node.className=className;parent.append(node);return node;}
  function quarter(parent,x,y,bottom,bounds,sheet){
    const panel=element(`unfold-quarter${bottom?' unfold-bottom':''}`,parent),face=element('unfold-face',panel);
    // Each panel shows its quarter of the live painted sheet, so nothing changes when the panels leave.
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(sheet.width/2);canvas.height=Math.ceil(sheet.height/2);
    canvas.getContext('2d')?.drawImage(sheet,x/1440*sheet.width,y/720*sheet.height,sheet.width/2,sheet.height/2,0,0,canvas.width,canvas.height);
    face.append(canvas);
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox',`${x} ${y} 720 360`);svg.setAttribute('preserveAspectRatio','none');
    // Ink and pins share the same screen-space transform from the first fold.
    for(const id of ['route-lines','route-stops']){
      const ink=document.createElementNS(svg.namespaceURI,'use');
      ink.setAttribute('href',`#${id}`);
      ink.setAttribute('transform',`scale(${1440/bounds.width} ${720/bounds.height})`);
      svg.append(ink);
    }
    face.append(svg);
    element('unfold-back',panel);const shade=element('unfold-shade',face);
    return {panel,shade};
  }
  function animate(node,keys,options){
    const motion=node.animate(keys,{fill:'both',easing:foldEase,...options});
    // Attach rejection handling immediately, including partially built sequences.
    motion.finished.catch(()=>{});motions.push(motion);return motion;
  }
  function unfold(sheet){
    if(!active)return;
    const map=document.getElementById('map'),bounds=map?.getBoundingClientRect();
    if(!bounds?.width||!bounds?.height||!sheet){finish();return;}
    try{
      stage=element('map-unfold',document.querySelector('main'));stage.setAttribute('aria-hidden','true');
      const paper=element('unfold-paper',stage),leftTop=quarter(paper,0,0,false,bounds,sheet),leftBottom=quarter(paper,0,360,true,bounds,sheet);
      const right=element('unfold-right',paper),rightTop=quarter(right,720,0,false,bounds,sheet),rightBottom=quarter(right,720,360,true,bounds,sheet);
      // Let the folded sheet register, open one hinge, pause, then open the
      // other. Translation follows each hinge instead of racing ahead of it.
      const arrival=100,acrossDuration=640,pause=70,downDuration=740,settle=150;
      const acrossEnd=arrival+acrossDuration,downStart=acrossEnd+pause,flat=downStart+downDuration,total=flat+settle;
      const folded='translate(30%, 30%) scale(.8)',half='translate(7%, 28.5%) scale(.86)',flatSheet='translate(3%, 3%) scale(.94)',open='translate(0, 0) scale(1)';
      animate(stage,[{opacity:0},{opacity:1}],{duration:140});
      animate(paper,[
        {transform:folded,offset:0},
        {transform:folded,offset:arrival/total,easing:foldEase},
        {transform:half,offset:acrossEnd/total},
        {transform:half,offset:downStart/total,easing:foldEase},
        {transform:flatSheet,offset:flat/total,easing:'cubic-bezier(.25,.1,.25,1)'},
        {transform:open,offset:1}
      ],{duration:total,easing:'linear'});
      // A paper-thin separation keeps folded faces out of the same depth plane.
      animate(right,[{transform:'translateZ(1.2px) rotateY(-179.6deg)'},{transform:'translateZ(0) rotateY(0deg)'}],{duration:acrossDuration,delay:arrival});
      for(const {panel} of [leftBottom,rightBottom])animate(panel,[{transform:'translateZ(1.2px) rotateX(179.6deg)'},{transform:'translateZ(0) rotateX(0deg)'}],{duration:downDuration,delay:downStart});
      for(const {shade} of [leftTop,rightTop])animate(shade,[{opacity:1},{opacity:0}],{duration:acrossDuration,delay:arrival});
      for(const {shade} of [leftBottom,rightBottom])animate(shade,[{opacity:1},{opacity:0}],{duration:downDuration,delay:downStart});
      guard(total+350);
      Promise.all(motions.map(motion=>motion.finished)).then(handoff,finish);
    }catch{finish();}
  }
  async function start(atlas){
    if(!active||started)return;started=true;guard(1500);
    try{
      if(!await atlas?.ready||!active){finish();return;}
      const sheet=atlas.snapshot();
      if(!sheet){finish();return;}
      frame=requestAnimationFrame(()=>unfold(sheet));
    }catch{finish();}
  }
  window.RedlineMapIntro={start};
  if(!active)return;
  root.classList.add('map-arriving');
  // A delayed/failed app script must never leave a blank or unusable page.
  guard(2400);
  for(const name of events)window.addEventListener(name,finish,{capture:true,passive:true});
  window.addEventListener('resize',resize,{passive:true});
  document.addEventListener('visibilitychange',visibility);
  media?.addEventListener?.('change',preference);
})();
