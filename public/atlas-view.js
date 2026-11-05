/* Composites painted atlas tiles, lettered names, and the chart's graduated border onto one canvas.
   Moving the camera only moves bitmaps, so it costs almost nothing however rich the map is. */
(() => {
  'use strict';
  const TILE=512,GUTTER=2,FADE=120,NAME_FADE=200,WORLD_W=1440,WORLD_H=720;
  const HAND='"Redline Hand", "IM Fell English", Georgia, serif',FELL='"IM Fell English", Georgia, serif';
  // How each kind of name is lettered. Sizes are CSS pixels at a 1440-wide sheet, eased for smaller windows.
  const STYLES={
    continent:{font:HAND,weight:700,size:24,track:.27,fill:'#8e2c1a',halo:'rgba(246,235,209,.8)',haloWidth:4.4,caps:true,jitter:.6},
    ocean:{font:FELL,italic:true,size:21,track:.16,fill:'#4a3a24',halo:'rgba(240,230,204,.6)',haloWidth:3,jitter:.3},
    sea:{font:FELL,italic:true,size:13,track:.07,fill:'#4a3a24',halo:'rgba(240,230,204,.7)',haloWidth:2.6,jitter:.1},
    range:{font:HAND,weight:700,size:11,track:.2,fill:'#3b2a19',halo:'rgba(243,231,204,.9)',haloWidth:3.2,caps:true,jitter:.25},
    desert:{font:HAND,weight:700,size:11,track:.24,fill:'#6c3d1a',halo:'rgba(243,231,204,.86)',haloWidth:3.2,caps:true,jitter:.25},
    land:{font:FELL,italic:true,size:12,track:.06,fill:'#55422c',halo:'rgba(240,227,198,.78)',haloWidth:2.6,jitter:.1},
    country:{font:HAND,weight:700,size:12,track:.18,fill:'#31220f',halo:'rgba(243,231,204,.88)',haloWidth:3.2,caps:true,jitter:.25},
    city:{font:FELL,size:13,track:.01,fill:'#2b2015',halo:'rgba(243,231,204,.86)',haloWidth:2.8,jitter:0,dot:true},
    capital:{font:FELL,size:14,track:.015,fill:'#2b2015',halo:'rgba(243,231,204,.88)',haloWidth:2.8,jitter:0,dot:true,ring:true}
  };
  const hash=(text,i)=>{let n=i*2654435761;for(let c=0;c<text.length;c++)n=Math.imul(n^text.charCodeAt(c),16777619);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967296;};
  function inert(){
    let view=null,labels=[];
    return {supported:false,update(next,nextLabels){view=next;labels=nextLabels;},prefetch(){},release(){},paintRegion:()=>Promise.resolve(null),measure:(kind,text)=>({w:text.length*(STYLES[kind]?.size||12)*.62,h:(STYLES[kind]?.size||12)*1.4}),snapshot:()=>null,ready:Promise.resolve(false),get view(){return view;},get labels(){return labels;}};
  }
  function create(canvas,assets,{inset=0,labelsReady=null}={}){
    if(typeof Worker==='undefined'||typeof OffscreenCanvas==='undefined'||typeof DecompressionStream==='undefined')return inert();
    let context=null;
    try{context=canvas.getContext?.('2d',{alpha:false});}catch{}
    if(!context)return inert();
    const tiles=new Map(),queue=[],prefetched=[],urgent=[],pending=new Map(),jobs=new Map(),sprites=new Map();
    let worker=null,started=false,busy=false,width=0,height=0,dpr=1,epoch=0,nextId=1,overview=null,view={x:0,y:0,w:WORLD_W,h:WORLD_H},frame=0,levelChanged=0,lastLevel=-1,labels=[],lettered=new Map(),resolveReady,sharpening=false,settleTimer=0,resizedAt=0;
    const maxTiles=window.innerWidth<900?56:140;
    const ready=new Promise(resolve=>{resolveReady=resolve;});
    const level=zoom=>Math.max(0,Math.min(8,Math.ceil(Math.log2(Math.max(1,zoom))-.12)));
    const paramsFor=(lvl,i,j)=>{
      const scale=2**lvl,sx=width/WORLD_W*scale,sy=height/WORLD_H*scale,worldW=Math.round(width*scale),worldH=Math.round(height*scale),x0=i*TILE,y0=j*TILE;
      return {type:'tile',sx,sy,x0,y0,w:Math.min(TILE+GUTTER,worldW-x0),h:Math.min(TILE+GUTTER,worldH-y0),dpr,level:lvl};
    };
    // One tile at a time, so a change of camera can reorder everything still waiting.
    function pump(){
      if(!started||busy)return;
      if(urgent.length){const job=urgent.shift(),id=nextId++;jobs.set(id,job);busy=true;worker.postMessage({...job.params,id});return;}
      if(performance.now()-Math.max(levelChanged,resizedAt)<45){setTimeout(pump,50);return;}
      const job=queue.shift()||prefetched.shift();if(!job)return;
      const have=tiles.get(job.key);if(have&&!have.stale){pump();return;}
      const id=nextId++;pending.set(job.key,id);jobs.set(id,job);busy=true;
      worker.postMessage({...job.params,id});
    }
    function received({id,bitmap}){
      const job=jobs.get(id);jobs.delete(id);busy=false;
      if(job?.resolve){job.resolve(bitmap);pump();return;}
      if(!job||job.epoch!==epoch){bitmap.close?.();pump();return;}
      pending.delete(job.key);
      if(job.key==='overview'){overview?.close?.();overview=bitmap;resolveReady(true);}
      else{
        const previous=tiles.get(job.key);previous?.bitmap.close?.();
        // A repaint of a tile already on screen swaps in place; only new tiles fade up.
        tiles.set(job.key,{bitmap,born:previous?0:performance.now(),used:performance.now(),lvl:job.params.level});evict();
      }
      schedule();pump();
    }
    function evict(){
      if(tiles.size<=maxTiles)return;
      const oldest=[...tiles.entries()].filter(([,tile])=>tile.lvl>0).sort((a,b)=>a[1].used-b[1].used);
      for(const [key,tile] of oldest){if(tiles.size<=maxTiles)break;tile.bitmap.close?.();tiles.delete(key);}
    }
    function resize(){
      const rect=canvas.getBoundingClientRect(),ratio=Math.min(2,window.devicePixelRatio||1),w=Math.round(rect.width*ratio),h=Math.round(rect.height*ratio);
      if(!w||!h||w===width&&h===height&&ratio===dpr)return false;
      const scaleChanged=ratio!==dpr||Math.abs(w/(width||1)-1)>.001;
      width=w;height=h;dpr=ratio;canvas.width=w;canvas.height=h;epoch++;
      for(const tile of tiles.values())tile.bitmap.close?.();
      tiles.clear();pending.clear();queue.length=0;prefetched.length=0;busy=false;
      // A region for the logbook or album does not depend on the window, and its caller is still waiting.
      for(const [id,job] of jobs)if(!job.resolve)jobs.delete(id);
      if(scaleChanged)sprites.clear();
      return true;
    }
    function requestOverview(){
      const w=Math.max(1,Math.round(width/2)),h=Math.max(1,Math.round(height/2)),id=nextId++;
      jobs.set(id,{key:'overview',epoch,params:{}});busy=true;
      worker.postMessage({type:'tile',sx:w/WORLD_W,sy:h/WORLD_H,x0:0,y0:0,w,h,dpr:dpr/2,level:-1,id});
    }
    function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;draw();});}
    function plan(lvl,frameView=view){
      const scale=2**lvl,worldW=width*scale,worldH=height*scale,left=frameView.x/WORLD_W*worldW,right=(frameView.x+frameView.w)/WORLD_W*worldW,top=frameView.y/WORLD_H*worldH,bottom=(frameView.y+frameView.h)/WORLD_H*worldH;
      return {i0:Math.max(0,Math.floor(left/TILE)),i1:Math.min(Math.ceil(worldW/TILE)-1,Math.floor((right-.001)/TILE)),j0:Math.max(0,Math.floor(top/TILE)),j1:Math.min(Math.ceil(worldH/TILE)-1,Math.floor((bottom-.001)/TILE)),scale,left,top};
    }
    function paintLevel(lvl,now,animate){
      const {i0,i1,j0,j1,left,top,scale}=plan(lvl),px=WORLD_W/view.w/scale,py=WORLD_H/view.h/scale;let fading=false;
      for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
        const tile=tiles.get(`${lvl}/${i}/${j}`);if(!tile)continue;
        tile.used=now;
        const alpha=animate?Math.min(1,(now-tile.born)/FADE):1;if(alpha<1){fading=true;context.globalAlpha=alpha;}
        context.drawImage(tile.bitmap,(i*TILE-left)*px,(j*TILE-top)*py,tile.bitmap.width*px,tile.bitmap.height*py);
        if(alpha<1)context.globalAlpha=1;
      }
      return fading;
    }
    // ---------- Lettering ----------
    const designScale=()=>Math.max(.72,Math.min(1.12,width/dpr/1440));
    function sprite(kind,text,angle=0,curve=0){
      const key=`${kind}|${text}|${angle}|${curve}`;let entry=sprites.get(key);if(entry)return entry;
      const style=STYLES[kind]||STYLES.land,copy=style.caps?text.toUpperCase():text,size=style.size*designScale(),track=style.track*size;
      const scratch=new OffscreenCanvas(4,4),g=scratch.getContext('2d'),font=`${style.italic?'italic ':''}${style.weight||''} ${size}px ${style.font}`;g.font=font;
      const chars=[...copy],advances=chars.map(c=>g.measureText(c).width),textWidth=advances.reduce((a,b)=>a+b,0)+track*Math.max(0,chars.length-1);
      const dotSpace=style.dot?size*.72:0,radians=angle*Math.PI/180,pad=style.haloWidth+3+Math.abs(curve)*textWidth*.12,cos=Math.abs(Math.cos(radians)),sin=Math.abs(Math.sin(radians));
      const boxW=textWidth+dotSpace,boxH=size*1.34,w=Math.ceil((boxW*cos+boxH*sin+pad*2)*dpr),h=Math.ceil((boxW*sin+boxH*cos+pad*2+Math.abs(curve)*textWidth*.22)*dpr);
      const out=new OffscreenCanvas(w,h),c=out.getContext('2d');
      c.scale(dpr,dpr);c.translate(w/dpr/2,h/dpr/2);c.rotate(radians);c.font=font;c.textBaseline='alphabetic';c.lineJoin='round';
      const startX=-boxW/2+dotSpace,baseline=size*.34,place=[];let cursor=startX;
      chars.forEach((char,i)=>{
        const mid=cursor+advances[i]/2,t=textWidth?mid/textWidth:0,bend=curve*t,lift=-curve*textWidth*t*t*.5;
        place.push({char,x:mid,y:baseline+lift+(hash(text,i)-.5)*style.jitter,a:bend+(hash(text,i+50)-.5)*style.jitter*.03});
        cursor+=advances[i]+track;
      });
      const inked=(paint)=>{for(const p of place){c.save();c.translate(p.x,p.y);c.rotate(p.a);paint(p.char,-g.measureText(p.char).width/2,0);c.restore();}};
      c.strokeStyle=style.halo;c.lineWidth=style.haloWidth;inked((char,x,y)=>c.strokeText(char,x,y));
      c.fillStyle=style.fill;inked((char,x,y)=>c.fillText(char,x,y));
      if(style.dot){
        const cx=-boxW/2+size*.16,cy=baseline-size*.3,r=style.ring?size*.2:size*.15;
        c.beginPath();c.arc(cx,cy,r+1.6,0,Math.PI*2);c.fillStyle=style.halo;c.fill();
        c.beginPath();c.arc(cx,cy,r,0,Math.PI*2);c.fillStyle='#f4e9cf';c.fill();c.strokeStyle='#2b2015';c.lineWidth=.9;c.stroke();
        if(style.ring){c.beginPath();c.arc(cx,cy,r*.42,0,Math.PI*2);c.fillStyle='#2b2015';c.fill();}
      }
      entry={canvas:out,w,h,cssW:boxW*cos+boxH*sin,cssH:boxW*sin+boxH*cos};
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
      let fading=false;
      for(const label of labels){
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
      return fading;
    }
    // ---------- The graduated border ----------
    function paintBorder(){
      const u=dpr,margin=inset*u;if(!margin)return;
      const bar=4.5*u,inner=margin+bar,right=width-margin,bottom=height-margin;
      context.fillStyle='#ece0c4';
      context.fillRect(0,0,width,margin);context.fillRect(0,bottom,width,height-bottom);context.fillRect(0,margin,margin,height-margin*2);context.fillRect(right,margin,width-right,height-margin*2);
      context.fillStyle='#f4ead2';context.fillRect(margin,margin,right-margin,bar);context.fillRect(margin,bottom-bar,right-margin,bar);context.fillRect(margin,margin+bar,bar,bottom-margin-bar*2);context.fillRect(right-bar,margin+bar,bar,bottom-margin-bar*2);
      // Alternating degree cells that follow the camera, as on the edge of a real chart.
      // Finer divisions appear as the camera closes in: whole tens of degrees down to fractions of one.
      const perUnit=(right-margin)/view.w/u,unitsX=[160,80,40,20,8,4,2,1,.4,.2,.1,.04,.02].findLast(units=>units*perUnit>=30)??160,unitsY=unitsX;
      context.fillStyle='#2b2015';
      const cellX=(from,to,y)=>{const a=Math.max(inner,margin+(from-view.x)/view.w*(right-margin)),b=Math.min(right-bar,margin+(to-view.x)/view.w*(right-margin));if(b>a)context.fillRect(a,y,b-a,bar);};
      const cellY=(from,to,x)=>{const a=Math.max(inner,margin+(from-view.y)/view.h*(bottom-margin)),b=Math.min(bottom-bar,margin+(to-view.y)/view.h*(bottom-margin));if(b>a)context.fillRect(x,a,bar,b-a);};
      for(let n=Math.floor(view.x/unitsX);n*unitsX<view.x+view.w;n++)if(n&1){cellX(n*unitsX,(n+1)*unitsX,margin);cellX(n*unitsX,(n+1)*unitsX,bottom-bar);}
      for(let n=Math.floor(view.y/unitsY);n*unitsY<view.y+view.h;n++)if(n&1){cellY(n*unitsY,(n+1)*unitsY,margin);cellY(n*unitsY,(n+1)*unitsY,right-bar);}
      context.strokeStyle='#2b2015';context.lineWidth=.9*u;context.strokeRect(margin,margin,right-margin,bottom-margin);
      context.lineWidth=.55*u;context.strokeRect(inner,inner,right-margin-bar*2,bottom-margin-bar*2);
    }
    function draw(){
      if(resize()&&started){
        // Repaint once the window has stopped changing; until then the old sheet simply stretches.
        resizedAt=performance.now();clearTimeout(settleTimer);
        settleTimer=setTimeout(()=>{if(!jobs.size)busy=false;requestOverview();schedule();},overview?140:0);
      }
      if(!width)return;
      const zoom=WORLD_W/view.w,target=level(zoom),now=performance.now();
      if(target!==lastLevel){lastLevel=target;levelChanged=now;}
      // Big screens want the sharp plate at once; small ones wait until they zoom in.
      if(started&&!sharpening&&(target>=1||width>1700)){sharpening=true;worker.postMessage({type:'sharpen'});}
      context.imageSmoothingEnabled=true;context.imageSmoothingQuality='medium';
      // The whole sheet at half size lies underneath, so nothing is ever blank.
      if(overview){
        const sw=overview.width,sh=overview.height;
        context.drawImage(overview,view.x/WORLD_W*sw,view.y/WORLD_H*sh,view.w/WORLD_W*sw,view.h/WORLD_H*sh,0,0,width,height);
      }else{context.fillStyle='#d9d3bd';context.fillRect(0,0,width,height);}
      const {i0,i1,j0,j1}=plan(target);
      let missing=false,fading=false;queue.length=0;
      const centerI=(i0+i1)/2,centerJ=(j0+j1)/2,needed=[];
      for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
        const key=`${target}/${i}/${j}`;
        const tile=tiles.get(key);
        if(!tile)missing=true;
        if((!tile||tile.stale)&&!pending.has(key))needed.push({key,params:paramsFor(target,i,j),epoch,distance:Math.hypot(i-centerI,j-centerJ)});
      }
      needed.sort((a,b)=>a.distance-b.distance);queue.push(...needed);
      // Coarser tiles stand in until the sharp ones arrive.
      if(missing)for(let lvl=Math.max(0,target-3);lvl<target;lvl++)paintLevel(lvl,now,false);
      fading=paintLevel(target,now,true);
      const namesFading=paintLabels(now);paintBorder();
      pump();
      if(fading||namesFading)schedule();
    }
    worker=new Worker(assets.worker);
    worker.onmessage=({data})=>{
      if(data.type==='ready'){started=true;resize();requestOverview();schedule();}
      else if(data.type==='detail'){
        // The sharp plate and finest coasts have arrived. Tiles stay until replaced, so the sharpening is seamless.
        for(const tile of tiles.values())tile.stale=true;
        schedule();
      }
      else if(data.type==='tile')received(data);
      else if(data.type==='tile-error'){const job=jobs.get(data.id);jobs.delete(data.id);if(job){pending.delete(job.key);job.resolve?.(null);}busy=false;console.error(data.message);pump();}
      else if(data.type==='sharpen-error'){console.error(data.message);setTimeout(()=>{sharpening=false;if(worker)schedule();},30000);}
      else if(data.type==='error'){console.error(data.message);resolveReady(false);}
    };
    worker.onerror=event=>{console.error(event.message);resolveReady(false);};
    worker.postMessage({type:'start',...assets});
    // Lettering is drawn to canvas, so ask for its fonts rather than waiting for the page to use them.
    Promise.all(['16px "Redline Hand"','700 16px "Redline Hand"','16px "IM Fell English"','italic 16px "IM Fell English"'].map(font=>document.fonts?.load?.(font))).catch(()=>{}).then(()=>{sprites.clear();labelsReady?.();schedule();});
    return {
      supported:true,
      ready,
      // Called from the app's own animation frame, so map, lettering and route move together.
      update(next,nextLabels){
        // A name fades up as it arrives, so one the camera only passes by never flashes at full strength.
        const now=performance.now(),still=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,arrived=new Map();
        for(const label of nextLabels){const key=label.kind+label.text;label.born=lettered.get(key)??(still?-NAME_FADE:now);arrived.set(key,label.born);}
        lettered=arrived;view=next;labels=nextLabels;if(frame){cancelAnimationFrame(frame);frame=0;}draw();
      },
      // While the album covers the map, only the sheet itself stays in memory.
      release(){for(const [key,tile] of tiles)if(tile.lvl>0){tile.bitmap.close?.();tiles.delete(key);}},
      // A crisp painting of any part of the sheet, for the route maps in the logbook and album.
      paintRegion(box,w,h,density=1){
        return new Promise(resolve=>{
          if(!started){ready.then(ok=>ok?this.paintRegion(box,w,h,density).then(resolve):resolve(null));return;}
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
      measure(kind,text,angle=0,curve=0){const entry=kind==='cartouche'?cartouche(text,angle):sprite(kind,text,angle,curve);return {w:entry.cssW,h:entry.cssH};},
      // The sheet at half size, for the opening fold.
      snapshot:()=>overview,
      get view(){return view;},
      get labels(){return labels;}
    };
  }
  window.RedlineAtlasView=Object.freeze({create});
})();
