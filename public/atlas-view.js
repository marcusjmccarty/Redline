/* Hands the baked sheet and painted atlas tiles to the compositor as layers, and letters names on a clear canvas above them.
   Moving the camera is one style write a layer, however rich the map is. */
(() => {
  'use strict';
  const TILE=512,GUTTER=2,FADE=120,FADED=FADE+34,NAME_FADE=200,NEW_NAMES=4,WORLD_W=1440,WORLD_H=720,SETTLE=140,REST=260;
  const HAND='"Redline Hand", "IM Fell English", Georgia, serif',FELL='"IM Fell English", Georgia, serif';
  // How each kind of name is lettered. Sizes are CSS pixels at a 1440-wide sheet, eased for smaller windows.
  const STYLES={
    continent:{font:HAND,weight:700,size:24,track:.27,fill:'#8e2c1a',halo:'rgba(246,235,209,.8)',haloWidth:4.4,caps:true,jitter:.6},
    ocean:{font:FELL,italic:true,size:21,track:.16,fill:'#4a3a24',halo:'rgba(240,230,204,.6)',haloWidth:3,jitter:.3},
    sea:{font:FELL,italic:true,size:13,track:.07,fill:'#4a3a24',halo:'rgba(240,230,204,.7)',haloWidth:2.6,jitter:.1},
    range:{font:HAND,weight:700,size:11,track:.2,fill:'#3b2a19',halo:'rgba(243,231,204,.9)',haloWidth:3.2,caps:true,jitter:.25},
    desert:{font:HAND,weight:700,size:11,track:.24,fill:'#6c3d1a',halo:'rgba(243,231,204,.86)',haloWidth:3.2,caps:true,jitter:.25},
    land:{font:FELL,italic:true,size:12,track:.06,fill:'#3f2f1c',halo:'rgba(243,231,204,.92)',haloWidth:3.2,jitter:.1},
    country:{font:HAND,weight:700,size:12,track:.18,fill:'#31220f',halo:'rgba(243,231,204,.88)',haloWidth:3.2,caps:true,jitter:.25},
    city:{font:FELL,size:13,track:.01,fill:'#2b2015',halo:'rgba(243,231,204,.86)',haloWidth:2.8,jitter:0,dot:true},
    capital:{font:FELL,size:14,track:.015,fill:'#2b2015',halo:'rgba(243,231,204,.88)',haloWidth:2.8,jitter:0,dot:true,ring:true}
  };
  const hash=(text,i)=>{let n=i*2654435761;for(let c=0;c<text.length;c++)n=Math.imul(n^text.charCodeAt(c),16777619);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967296;};
  function inert(){
    let view=null,labels=[];
    const measure=(kind,text)=>({w:text.length*(STYLES[kind]?.size||12)*.62,h:(STYLES[kind]?.size||12)*1.4});
    return {supported:false,update(next,nextLabels){view=next;labels=nextLabels;},prefetch(){},release(){},paintRegion:()=>Promise.resolve(null),measure,
      footprint(kind,text){const {w,h}=measure(kind,text),dotted=STYLES[kind]?.dot,x=dotted?-5:-w/2,y=-h/2;return {boxes:[{x,y,w,h}],left:x,top:y,right:x+w,bottom:y+h};},
      era:0,snapshot:()=>null,ready:Promise.resolve(false),get view(){return view;},get labels(){return labels;}};
  }
  function create(canvas,assets,{labelsReady=null}={}){
    if(typeof Worker==='undefined'||typeof OffscreenCanvas==='undefined'||typeof DecompressionStream==='undefined')return inert();
    let context=null;
    try{context=canvas.getContext?.('2d');}catch{}
    if(!context)return inert();
    // Safari replays every drawImage on the CPU in its GPU process, but moves a layer for nothing. So the art lives behind the canvas, which is left only the names.
    const stack=document.createElement('div');stack.className='atlas-layers';canvas.before(stack);
    const tiles=new Map(),levels=new Map(),sheet={el:null,transform:'',shown:false},queue=[],prefetched=[],urgent=[],pending=new Map(),jobs=new Map(),sprites=new Map(),shapes=new Map(),painters=[];
    let started=false,width=0,height=0,dpr=1,epoch=0,era=0,nextId=1,stamp=0,lettering=true,ruler=null,view={x:0,y:0,w:WORLD_W,h:WORLD_H},frame=0,labels=[],lettered=new Map(),resolveReady,sharpening=false,sharpened=false,retrying=false,settleTimer=0,restTimer=0,resizedAt=-Infinity,movedAt=-Infinity,needsPainting=!assets.sheet;
    const small=window.innerWidth<900,maxTiles=small?56:140;
    // Every WebKit browser's canvases share one GPU process with the page, so a worker painting there stalls the page's own frames. On the worker's own thread it does not. Blink and Gecko keep their GPU painting.
    const agent=globalThis.navigator?.userAgent||'',software=/AppleWebKit/.test(agent)&&!/Chrom(?:e|ium)|Android/.test(agent);
    // Software painting truly runs side by side, but every worker decodes its own land plate, so small screens keep fewer.
    const crew=Math.max(1,Math.min(small?2:3,(globalThis.navigator?.hardwareConcurrency||4)-1));
    const ready=new Promise(resolve=>{resolveReady=resolve;});
    const level=zoom=>Math.max(0,Math.min(8,Math.ceil(Math.log2(Math.max(1,zoom))-.12)));
    const paramsFor=(lvl,i,j)=>{
      const scale=2**lvl,sx=width/WORLD_W*scale,sy=height/WORLD_H*scale,worldW=Math.round(width*scale),worldH=Math.round(height*scale),x0=i*TILE,y0=j*TILE;
      return {type:'tile',sx,sy,x0,y0,w:Math.min(TILE+GUTTER,worldW-x0),h:Math.min(TILE+GUTTER,worldH-y0),dpr,level:lvl};
    };
    function nextJob(){
      if(urgent.length)return urgent.shift();
      if(!started)return null;
      for(let job;job=queue.shift()||prefetched.shift();){const have=tiles.get(job.key);if((!have||have.stale)&&!pending.has(job.key))return job;}
      return null;
    }
    // One tile per free worker, the rest still waiting, so a change of camera can reorder or drop them.
    function pump(){
      for(const painter of painters){
        if(!painter.ready||painter.busy)continue;
        const job=nextJob();if(!job)return;
        const id=nextId++;if(job.key)pending.set(job.key,id);
        jobs.set(id,job);painter.busy=true;painter.job=id;painter.worker.postMessage({...job.params,id});
      }
    }
    // A 2D canvas, because WebKit shows its surface as the layer itself. A bitmaprenderer canvas is painted again into a layer of its own, measurably longer frames in Safari, whenever it is attached.
    function picture(bitmap,className){
      const el=document.createElement('canvas');el.className=className;el.width=bitmap.width;el.height=bitmap.height;
      inscribe(el,bitmap);return el;
    }
    function inscribe(el,bitmap){el.getContext('2d',{alpha:false}).drawImage(bitmap,0,0);bitmap.close?.();}
    function received(painter,{id,bitmap}){
      const job=jobs.get(id);jobs.delete(id);painter.busy=false;
      if(job?.resolve){job.resolve(bitmap);pump();return;}
      if(job?.key==='overview'){pending.delete('overview');showSheet(bitmap);pictured(true);pump();return;}
      if(!job||job.epoch!==epoch){bitmap.close?.();pump();return;}
      pending.delete(job.key);
      const now=performance.now(),previous=tiles.get(job.key);
      // A repaint of a tile already on screen swaps in place; only new tiles fade up.
      if(previous){inscribe(previous.el,bitmap);previous.stale=false;previous.used=now;}
      else{
        const {x0,y0,w,h,level:lvl}=job.params,el=picture(bitmap,'atlas-tile');
        // A layer's own pixels are device pixels. Otherwise WebKit would hold each tile enlarged at the screen's scale. Whichever arrived first, the same tile lies on top in a gutter.
        el.style.cssText=`left:${x0/dpr}px;top:${y0/dpr}px;width:${w/dpr}px;height:${h/dpr}px;z-index:${y0/TILE*65536+x0/TILE}`;
        const tile={el,born:now,used:now,lvl,i:x0/TILE,j:y0/TILE,shown:0};tiles.set(job.key,tile);
        // The browser may take back a canvas's surface. The workers can paint this one again.
        el.addEventListener('contextlost',()=>{if(tiles.get(job.key)===tile){drop(job.key,tile);schedule();}});
      }
      evict();schedule();pump();
    }
    const onScreen=tile=>levels.get(tile.lvl)?.tiles.has(tile);
    const needed=(tile,lvl,{i0,i1,j0,j1})=>tile.lvl===lvl&&tile.i>=i0&&tile.i<=i1&&tile.j>=j0&&tile.j<=j1;
    function drop(key,tile){tile.el.remove();levels.get(tile.lvl)?.tiles.delete(tile);tile.el.width=tile.el.height=0;tiles.delete(key);}
    function evict(){
      if(tiles.size<=maxTiles)return;
      // Never what the view is waiting for, however many that is, or it would be painted again and again. Stand-ins go last, having been used just now.
      const target=level(WORLD_W/view.w),visible=plan(target),oldest=[...tiles.entries()].filter(([,tile])=>tile.lvl>0&&!needed(tile,target,visible)).sort((a,b)=>a[1].used-b[1].used);
      for(const [key,tile] of oldest){if(tiles.size<=maxTiles)break;drop(key,tile);}
    }
    function resize(){
      const rect=canvas.getBoundingClientRect(),ratio=Math.min(2,window.devicePixelRatio||1),w=Math.round(rect.width*ratio),h=Math.round(rect.height*ratio);
      if(!w||!h||w===width&&h===height&&ratio===dpr)return false;
      const scaleChanged=ratio!==dpr||Math.abs(w/(width||1)-1)>.001;
      width=w;height=h;dpr=ratio;canvas.width=w;canvas.height=h;epoch++;lettering=true;fitSheet();
      for(const [key,tile] of tiles)drop(key,tile);
      pending.clear();queue.length=0;prefetched.length=0;
      // A region for the logbook or album does not depend on the window, and its caller is still waiting. The whole sheet just stretches.
      for(const [id,job] of jobs)if(!job.resolve&&job.key!=='overview')jobs.delete(id);
      if(scaleChanged){sprites.clear();shapes.clear();era++;}
      return true;
    }
    // Its pixels are device pixels too, so a small window still zooms into all of them.
    function fitSheet(){if(sheet.el){sheet.el.style.width=`${sheet.el.width/dpr}px`;sheet.el.style.height=`${sheet.el.height/dpr}px`;}}
    function showSheet(bitmap){sheet.el?.remove();sheet.el=picture(bitmap,'atlas-sheet');sheet.transform='';sheet.shown=true;fitSheet();stack.append(sheet.el);resize();}
    // Only if the baked sheet could not be had: this is the slowest thing the painter does.
    function paintOverview(){
      needsPainting=false;resize();
      const w=Math.max(1,Math.round(width/2)),h=Math.max(1,Math.round(height/2));
      urgent.unshift({key:'overview',params:{type:'tile',sx:w/WORLD_W,sy:h/WORLD_H,x0:0,y0:0,w,h,dpr:dpr/2,level:-1}});pump();
    }
    // The first picture is up, so the page can show itself and the workers can start painting tiles.
    function pictured(ok){
      started=true;resolveReady(ok);
      while(painters.length<crew)hire();
      schedule();pump();
    }
    function sharpen(){sharpening=true;for(const painter of painters)if(painter.ready&&!painter.sharp)painter.worker.postMessage({type:'sharpen'});}
    function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;draw();});}
    function plan(lvl,frameView=view){
      const scale=2**lvl,worldW=width*scale,worldH=height*scale,left=frameView.x/WORLD_W*worldW,right=(frameView.x+frameView.w)/WORLD_W*worldW,top=frameView.y/WORLD_H*worldH,bottom=(frameView.y+frameView.h)/WORLD_H*worldH;
      return {i0:Math.max(0,Math.floor(left/TILE)),i1:Math.min(Math.ceil(worldW/TILE)-1,Math.floor((right-.001)/TILE)),j0:Math.max(0,Math.floor(top/TILE)),j1:Math.min(Math.ceil(worldH/TILE)-1,Math.floor((bottom-.001)/TILE)),scale,left,top};
    }
    // A layer spanning spanX by spanY of its own pixels, whose CSS pixels are those pixels at the screen's scale, follows the camera with one style write.
    function aim(layer,spanX,spanY){
      const kx=width/view.w,ky=height/view.h,transform=`matrix(${kx*WORLD_W/spanX},0,0,${ky*WORLD_H/spanY},${-view.x*kx/dpr},${-view.y*ky/dpr})`;
      if(transform===layer.transform)return;
      layer.transform=transform;layer.el.style.transform=transform;
    }
    function levelLayer(lvl){
      let layer=levels.get(lvl);if(layer)return layer;
      layer={el:document.createElement('div'),tiles:new Set(),transform:''};layer.el.className='atlas-level';layer.el.style.zIndex=lvl+1;
      stack.append(layer.el);levels.set(lvl,layer);return layer;
    }
    // Exactly the tiles of this level the view can see stay attached. Answers whether they cover it, and whether any is still fading up, which starts a frame or two after it is asked for.
    function showLevel(lvl,now){
      const layer=levelLayer(lvl),{i0,i1,j0,j1,scale}=plan(lvl);let covered=true,fading=false;
      for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
        const tile=tiles.get(`${lvl}/${i}/${j}`);if(!tile){covered=false;continue;}
        tile.used=now;tile.shown=stamp;
        if(!layer.tiles.has(tile)){
          layer.tiles.add(tile);layer.el.append(tile.el);
          if(now-tile.born<FADE){tile.born=now;tile.el.animate?.({opacity:[0,1]},{duration:FADE});}
        }
        if(now-tile.born<FADED)fading=true;
      }
      for(const tile of layer.tiles)if(tile.shown!==stamp){tile.el.remove();layer.tiles.delete(tile);}
      if(layer.tiles.size)aim(layer,width*scale,height*scale);
      return {covered,fading};
    }
    // Coarser tiles stand in until the sharp ones have faded up, and the whole sheet lies under them. Whatever is covered leaves the compositor, so nothing is drawn twice.
    function showLayers(target,now){
      stamp++;
      let lvl=target,{covered,fading}=showLevel(lvl,now),whole=covered&&!fading;
      while(!whole&&lvl>Math.max(0,target-3)){const under=showLevel(--lvl,now);whole=under.covered&&!under.fading;fading||=under.fading;}
      for(const [other,layer] of levels)if(other>target||other<lvl){for(const tile of layer.tiles)tile.el.remove();layer.tiles.clear();}
      if(sheet.el){
        if(sheet.shown===whole){sheet.shown=!whole;sheet.el.style.opacity=whole?0:1;}
        if(!whole)aim(sheet,sheet.el.width,sheet.el.height);
      }
      return fading;
    }
    // ---------- Lettering ----------
    const designScale=()=>Math.max(.72,Math.min(1.12,width/dpr/1440));
    // Measuring is all that choosing names needs: most candidates never show, and painting them all at once cost Safari a tenth of a second as the camera crossed a zoom where many become eligible.
    function shape(kind,text,angle=0,curve=0){
      const key=`${kind}|${text}|${angle}|${curve}`;let entry=shapes.get(key);if(entry)return entry;
      const style=STYLES[kind]||STYLES.land,copy=style.caps?text.toUpperCase():text,size=style.size*designScale(),track=style.track*size;
      const g=(ruler??=new OffscreenCanvas(4,4).getContext('2d')),font=`${style.italic?'italic ':''}${style.weight||''} ${size}px ${style.font}`;g.font=font;
      const chars=[...copy],marks=chars.map(c=>g.measureText(c)),advances=marks.map(m=>m.width),textWidth=advances.reduce((a,b)=>a+b,0)+track*Math.max(0,chars.length-1);
      const inks=marks.map(m=>[m.actualBoundingBoxAscent??size*.74,m.actualBoundingBoxDescent??size*.06]);
      const dotSpace=style.dot?size*.72:0,radians=angle*Math.PI/180,pad=style.haloWidth+3+Math.abs(curve)*textWidth*.12,cos=Math.abs(Math.cos(radians)),sin=Math.abs(Math.sin(radians));
      const boxW=textWidth+dotSpace,boxH=size*1.34;
      entry={key,style,font,size,track,chars,advances,inks,textWidth,dotSpace,radians,curve,boxW,w:Math.ceil((boxW*cos+boxH*sin+pad*2)*dpr),h:Math.ceil((boxW*sin+boxH*cos+pad*2+Math.abs(curve)*textWidth*.22)*dpr),cssW:boxW*cos+boxH*sin,cssH:boxW*sin+boxH*cos};
      if(shapes.size>2000)shapes.delete(shapes.keys().next().value);
      shapes.set(key,entry);return entry;
    }
    // Each letter's place about the name's anchor in CSS pixels, halo included. Dotted names hang from their dot, the rest are centred on their point.
    function letters(entry){
      if(entry.letters)return entry.letters;
      const {style,size,track,advances,inks,textWidth,dotSpace,radians,curve,boxW,cssW}=entry,halo=style.haloWidth/2,cos=Math.cos(radians),sin=Math.sin(radians),ox=style.dot?cssW/2-size*.16:0,oy=style.dot?-size*.04:0,out=[];
      let cursor=-boxW/2+dotSpace;
      advances.forEach((advance,i)=>{
        const mid=cursor+advance/2,t=textWidth?mid/textWidth:0,base=size*.34-curve*textWidth*t*t*.5,[up,down]=inks[i],dx=advance/2+halo,dy=(up+down)/2+halo,ly=base+(down-up)/2,turn=radians+curve*t,c=Math.abs(Math.cos(turn)),s=Math.abs(Math.sin(turn)),w=dx*c+dy*s,h=dx*s+dy*c;
        if(advance>0&&up+down>0)out.push({x:ox+mid*cos-ly*sin-w,y:oy+mid*sin+ly*cos-h,w:w*2,h:h*2});
        cursor+=advance+track;
      });
      if(style.dot){const r=(style.ring?size*.2:size*.15)+1.6;out.unshift({x:-r,y:-r,w:r*2,h:r*2});}
      return entry.letters=out;
    }
    // The coarse form of the same, for choosing places. A level straight name is one box; a slanted or curved one is a box every few letters, so another name may lie in its corners.
    function footprint(entry){
      if(entry.print)return entry.print;
      const all=letters(entry),span=list=>{const x=Math.min(...list.map(b=>b.x)),y=Math.min(...list.map(b=>b.y));return {x,y,w:Math.max(...list.map(b=>b.x+b.w))-x,h:Math.max(...list.map(b=>b.y+b.h))-y};};
      const whole=span(all.length?all:[{x:0,y:0,w:0,h:0}]),sag=Math.abs(Math.sin(entry.radians))*entry.boxW+Math.abs(entry.curve)*entry.textWidth*.25,pieces=Math.max(1,Math.min(all.length,1+Math.ceil(sag/(entry.size*.7)))),boxes=[];
      if(pieces===1)boxes.push(whole);else for(let i=0;i<pieces;i++)boxes.push(span(all.slice(Math.floor(i*all.length/pieces),Math.floor((i+1)*all.length/pieces))));
      return entry.print={boxes,left:whole.x,top:whole.y,right:whole.x+whole.w,bottom:whole.y+whole.h};
    }
    function sprite(kind,text,angle=0,curve=0){
      const {key,style,font,size,track,chars,advances,textWidth,dotSpace,radians,boxW,w,h,cssW,cssH}=shape(kind,text,angle,curve);let entry=sprites.get(key);if(entry)return entry;
      const out=new OffscreenCanvas(w,h),c=out.getContext('2d');
      c.scale(dpr,dpr);c.translate(w/dpr/2,h/dpr/2);c.rotate(radians);c.font=font;c.textBaseline='alphabetic';c.lineJoin='round';
      const startX=-boxW/2+dotSpace,baseline=size*.34,place=[];let cursor=startX;
      chars.forEach((char,i)=>{
        const mid=cursor+advances[i]/2,t=textWidth?mid/textWidth:0,bend=curve*t,lift=-curve*textWidth*t*t*.5;
        place.push({char,x:mid,y:baseline+lift+(hash(text,i)-.5)*style.jitter,a:bend+(hash(text,i+50)-.5)*style.jitter*.03,half:advances[i]/2});
        cursor+=advances[i]+track;
      });
      const inked=(paint)=>{for(const p of place){c.save();c.translate(p.x,p.y);c.rotate(p.a);paint(p.char,-p.half,0);c.restore();}};
      c.strokeStyle=style.halo;c.lineWidth=style.haloWidth;inked((char,x,y)=>c.strokeText(char,x,y));
      c.fillStyle=style.fill;inked((char,x,y)=>c.fillText(char,x,y));
      if(style.dot){
        const cx=-boxW/2+size*.16,cy=baseline-size*.3,r=style.ring?size*.2:size*.15;
        c.beginPath();c.arc(cx,cy,r+1.6,0,Math.PI*2);c.fillStyle=style.halo;c.fill();
        c.beginPath();c.arc(cx,cy,r,0,Math.PI*2);c.fillStyle='#f4e9cf';c.fill();c.strokeStyle='#2b2015';c.lineWidth=.9;c.stroke();
        if(style.ring){c.beginPath();c.arc(cx,cy,r*.42,0,Math.PI*2);c.fillStyle='#2b2015';c.fill();}
      }
      entry={canvas:out,w,h,cssW,cssH};
      if(sprites.size>900)sprites.delete(sprites.keys().next().value);
      sprites.set(key,entry);return entry;
    }
    // The chart's title piece: a ruled plate between two fern sprays, redrawn when the title changes.
    function cartouche(text,kicker){
      const key=`cartouche|${text}|${kicker}`;let entry=sprites.get(key);if(entry)return entry;
      const k=designScale(),small=9.5*k,probe=new OffscreenCanvas(4,4).getContext('2d'),label=text.toUpperCase();
      const widthAt=size=>{probe.font=`700 ${size}px ${HAND}`;return [...label].reduce((sum,c)=>sum+probe.measureText(c).width+size*.14,0)-size*.14;};
      // Long titles letter smaller so the piece keeps its proportions.
      const size=Math.max(11*k,19*k*Math.min(1,250*k/widthAt(19*k))),track=size*.14,textW=widthAt(size);
      const plateW=Math.max(textW+34*k,170*k),plateH=56*k,sprayW=46*k,cssW=plateW+sprayW*2,cssH=plateH+20*k,w=Math.ceil(cssW*dpr),h=Math.ceil(cssH*dpr);
      const out=new OffscreenCanvas(w,h),c=out.getContext('2d');c.scale(dpr,dpr);c.translate(cssW/2,cssH/2);c.lineCap='round';c.lineJoin='round';
      // Plate.
      c.fillStyle='rgba(245,234,208,.94)';c.strokeStyle='#2b2015';c.lineWidth=1;
      const notch=7*k,pw=plateW/2,ph=plateH/2;
      c.beginPath();c.moveTo(-pw+notch,-ph);c.lineTo(pw-notch,-ph);c.quadraticCurveTo(pw-notch,-ph+notch,pw,-ph+notch);c.lineTo(pw,ph-notch);c.quadraticCurveTo(pw-notch,ph-notch,pw-notch,ph);c.lineTo(-pw+notch,ph);c.quadraticCurveTo(-pw+notch,ph-notch,-pw,ph-notch);c.lineTo(-pw,-ph+notch);c.quadraticCurveTo(-pw+notch,-ph+notch,-pw+notch,-ph);c.closePath();c.fill();c.stroke();
      c.lineWidth=.5;c.save();c.scale((pw-3.5*k)/pw,(ph-3.5*k)/ph);c.stroke();c.restore();
      // Fern sprays, one each side, leaning outward.
      const fern=side=>{
        c.save();c.scale(side,1);c.translate(pw-4*k,ph*.55);c.strokeStyle='#3f4d2c';c.fillStyle='#4d5c33';c.lineWidth=1;
        c.beginPath();c.moveTo(0,0);c.quadraticCurveTo(sprayW*.55,-2*k,sprayW*.92,-plateH*.78);c.stroke();
        for(let i=1;i<=9;i++){
          const t=i/10,x=2*(1-t)*t*sprayW*.55+t*t*sprayW*.92,y=2*(1-t)*t*-2*k+t*t*-plateH*.78,len=(11-i*.72)*k,a=-1.1+t*-.2;
          for(const flip of [-1,1]){c.save();c.translate(x,y);c.rotate(a+flip*.95);c.beginPath();c.moveTo(0,0);c.quadraticCurveTo(len*.5,-len*.28,len,0);c.quadraticCurveTo(len*.5,len*.28,0,0);c.fill();c.restore();}
        }
        c.restore();
      };
      fern(-1);fern(1);
      // Lettering.
      c.textBaseline='alphabetic';c.fillStyle='#6b5a3c';c.font=`italic ${small}px ${FELL}`;c.textAlign='center';c.fillText(kicker,0,-ph+15.5*k);
      c.strokeStyle='#2b201566';c.lineWidth=.5;c.beginPath();c.moveTo(-34*k,-ph+20*k);c.lineTo(34*k,-ph+20*k);c.stroke();
      c.textAlign='left';c.font=`700 ${size}px ${HAND}`;c.fillStyle='#8e2c1a';let x=-textW/2;
      [...label].forEach((char,i)=>{c.save();c.translate(x,ph-12*k+(hash(label,i)-.5)*.7);c.rotate((hash(label,i+50)-.5)*.02);c.fillText(char,0,0);c.restore();x+=probe.measureText(char).width+track;});
      entry={canvas:out,w,h,cssW,cssH};
      if(sprites.size>900)sprites.delete(sprites.keys().next().value);
      sprites.set(key,entry);return entry;
    }
    function paintLabels(now){
      // Tiles arriving and the camera resting leave the names as they are.
      if(!lettering)return false;
      context.clearRect(0,0,width,height);let fading=false,made=0;
      for(const label of labels){
        // A few new names a frame. The rest wait their turn and then fade up, because a zoom can make dozens eligible at once.
        if(label.kind!=='cartouche'&&!sprites.has(shape(label.kind,label.text,label.angle,label.curve).key)&&++made>NEW_NAMES){
          if(label.born>0){label.born=now;lettered.set(label.kind+label.text,now);}
          fading=true;continue;
        }
        const alpha=Math.min(1,(now-label.born)/NAME_FADE);if(alpha<1){fading=true;context.globalAlpha=alpha;}
        if(label.kind==='cartouche'){const piece=cartouche(label.text,label.kicker);context.drawImage(piece.canvas,Math.round(label.x*dpr-piece.w/2),Math.round(label.y*dpr-piece.h/2));}
        else{
          const entry=sprite(label.kind,label.text,label.angle,label.curve);
          // Dotted labels hang from their dot; the rest are centred on their point.
          const style=STYLES[label.kind],ax=style?.dot?entry.w/2-(entry.cssW/2-(style.size*designScale()*.16))*dpr:entry.w/2,ay=style?.dot?entry.h/2+(style.size*designScale()*.34-style.size*designScale()*.3)*dpr:entry.h/2;
          context.drawImage(entry.canvas,Math.round(label.x*dpr-ax),Math.round(label.y*dpr-ay));
        }
        if(alpha<1)context.globalAlpha=1;
      }
      lettering=fading;return fading;
    }
    const sameNames=(a,b)=>a.length===b.length&&a.every((label,i)=>{const other=b[i];return label.x===other.x&&label.y===other.y&&label.text===other.text&&label.kind===other.kind&&label.angle===other.angle&&label.curve===other.curve&&label.kicker===other.kicker;});
    function draw(){
      // Repaint once the window has stopped changing; until then the old sheet simply stretches.
      if(resize()){resizedAt=performance.now();clearTimeout(settleTimer);settleTimer=setTimeout(schedule,SETTLE);}
      if(!width)return;
      const target=level(WORLD_W/view.w),now=performance.now();
      // Anything but a small screen can use the sharp plate as soon as the first picture is up; a small one waits until it zooms in.
      if(started&&!sharpening&&(target>=1||!small||width>1700))sharpen();
      const {i0,i1,j0,j1}=plan(target),centerI=(i0+i1)/2,centerJ=(j0+j1)/2,wanted=[];
      // The world's own tiles wait for the camera to rest and the sharp plate to arrive: the baked sheet already stands in, and is nearly as good.
      const moving=target===0&&now-movedAt<REST,waiting=!started||now-resizedAt<SETTLE||moving||target===0&&sharpening&&!sharpened;
      queue.length=0;
      for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
        const key=`${target}/${i}/${j}`,tile=tiles.get(key);
        if(!waiting&&(!tile||tile.stale)&&!pending.has(key))wanted.push({key,params:paramsFor(target,i,j),epoch,distance:Math.hypot(i-centerI,j-centerJ)});
      }
      wanted.sort((a,b)=>a.distance-b.distance);queue.push(...wanted);
      if(started&&moving&&!restTimer)restTimer=setTimeout(()=>{restTimer=0;schedule();},REST);
      const fading=showLayers(target,now),namesFading=paintLabels(now);
      pump();
      if(fading||namesFading)schedule();
    }
    function hire(){
      const first=!painters.length,painter={worker:new Worker(assets.worker),ready:false,busy:false,sharp:false,dead:false,job:0};painters.push(painter);
      painter.worker.onmessage=({data})=>heard(painter,data);
      painter.worker.onerror=event=>{console.error(event.message);lost(painter);};
      painter.worker.postMessage({type:'start',...assets,sheet:first&&assets.sheet?(small?assets.sheetSmall||assets.sheet:assets.sheet):undefined,software});
    }
    function lost(painter){
      painter.dead=true;painter.ready=false;
      const job=jobs.get(painter.job);jobs.delete(painter.job);if(job){pending.delete(job.key);job.resolve?.(null);}
      if(painters.every(other=>other.dead)){resolveReady(false);for(const waiting of urgent.splice(0))waiting.resolve?.(null);}
      pump();
    }
    function heard(painter,data){
      if(data.type==='sheet'){
        if(data.bitmap){showSheet(data.bitmap);pictured(true);}else needsPainting=true;
      }else if(data.type==='ready'){
        painter.ready=true;if(needsPainting)paintOverview();
        if(sharpening&&!painter.sharp)painter.worker.postMessage({type:'sharpen'});
        schedule();pump();
      }else if(data.type==='detail'){
        // The sharp plate and finest coasts have arrived everywhere. Tiles stay until replaced, so the sharpening is seamless.
        painter.sharp=true;
        if(painters.every(other=>other.sharp||other.dead)){sharpened=true;for(const tile of tiles.values())tile.stale=true;schedule();}
      }else if(data.type==='tile')received(painter,data);
      else if(data.type==='tile-error'){
        const job=jobs.get(data.id);jobs.delete(data.id);painter.busy=false;console.error(data.message);
        if(job){pending.delete(job.key);job.resolve?.(null);if(job.key==='overview')pictured(false);}
        pump();
      }else if(data.type==='sharpen-error'){
        // The world's tiles stop waiting for it, and it is asked for again later.
        console.error(data.message);sharpened=true;schedule();
        if(!retrying){retrying=true;setTimeout(()=>{retrying=false;sharpening=false;schedule();},30000);}
      }else if(data.type==='error'){console.error(data.message);lost(painter);}
    }
    hire();
    // Lettering is drawn to canvas, so ask for its fonts rather than waiting for the page to use them.
    Promise.all(['16px "Redline Hand"','700 16px "Redline Hand"','16px "IM Fell English"','italic 16px "IM Fell English"'].map(font=>document.fonts?.load?.(font))).catch(()=>{}).then(()=>{sprites.clear();shapes.clear();era++;lettering=true;labelsReady?.();schedule();});
    return {
      supported:true,
      ready,
      // Called from the app's own animation frame, so map, lettering and route move together.
      update(next,nextLabels){
        // A name fades up as it arrives, so one the camera only passes by never flashes at full strength.
        const now=performance.now(),still=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,arrived=new Map();
        for(const label of nextLabels){const key=label.kind+label.text;label.born=lettered.get(key)??(still?-NAME_FADE:now);arrived.set(key,label.born);}
        if(next.x!==view.x||next.y!==view.y||next.w!==view.w)movedAt=now;
        if(!sameNames(nextLabels,labels))lettering=true;
        lettered=arrived;view=next;labels=nextLabels;if(frame){cancelAnimationFrame(frame);frame=0;}draw();
      },
      // While the album covers the map, only the sheet and what still shows through its backdrop stay in memory.
      release(){for(const [key,tile] of tiles)if(tile.lvl>0&&!onScreen(tile))drop(key,tile);},
      // A crisp painting of any part of the sheet, for the route maps in the logbook and album.
      paintRegion(box,w,h,density=1){
        return new Promise(resolve=>{
          if(painters.every(painter=>painter.dead)){resolve(null);return;}
          const sx=w/box.w,sy=h/box.h;
          urgent.push({resolve,params:{type:'tile',sx,sy,x0:box.x*sx,y0:box.y*sy,w:Math.round(w),h:Math.round(h),dpr:density,level:-2}});pump();
        });
      },
      // Paint the tiles a coming camera move will need before it arrives.
      prefetch(frameView){
        if(!width||!started)return;
        const lvl=level(WORLD_W/frameView.w),{i0,i1,j0,j1}=plan(lvl,frameView);prefetched.length=0;
        for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){const key=`${lvl}/${i}/${j}`;if((!tiles.has(key)||tiles.get(key).stale)&&!pending.has(key))prefetched.push({key,params:paramsFor(lvl,i,j),epoch});}
        pump();
      },
      measure(kind,text,angle=0,curve=0){const entry=kind==='cartouche'?cartouche(text,angle):shape(kind,text,angle,curve);return {w:entry.cssW,h:entry.cssH};},
      // Where a lettered name's ink lies on the map, one box a letter. scripts/check-names.mjs reads this.
      outline(label){return letters(shape(label.kind,label.text,label.angle,label.curve)).map(({x,y,w,h})=>({x:label.x+x,y:label.y+y,w,h}));},
      footprint(kind,text,angle=0,curve=0){return footprint(shape(kind,text,angle,curve));},
      // Changes when lettering's measures do, because the fonts arrived or the window's scale changed.
      get era(){return era;},
      // The whole sheet, for the opening fold. A canvas can be drawn from just as a bitmap can.
      snapshot:()=>sheet.el,
      get view(){return view;},
      get labels(){return labels;}
    };
  }
  window.RedlineAtlasView=Object.freeze({create});
})();
