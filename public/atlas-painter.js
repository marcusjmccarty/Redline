/* The atlas painter: inks one tile of the map onto a 2D canvas. It runs in a worker, so it touches no DOM. */
(() => {
  'use strict';
  const INK='#2b2015',SEPIA='#5a4530',WATER_INK='#4c5f5a',RIVER='#4c7d8c',PAPER='#f1e4c6';
  const clamp=(value,low=0,high=1)=>value<low?low:value>high?high:value;
  const smooth=(low,high,value)=>{const t=clamp((value-low)/(high-low));return t*t*(3-2*t);};
  // One stable pseudo-random stream per map cell, so every tile and zoom level draws the same world.
  const hash=(x,y,seed)=>{let n=Math.imul(x,374761393)^Math.imul(y,668265263)^Math.imul(seed,1442695041);n=Math.imul(n^(n>>>13),1274126177);n^=n>>>16;return (n>>>0)/4294967296;};
  const stream=(x,y,seed)=>{let i=0;return ()=>hash(x,y,seed+(++i)*7919);};
  function drift(x,y,seed){const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy),a=hash(ix,iy,seed),b=hash(ix+1,iy,seed),c=hash(ix,iy+1,seed),d=hash(ix+1,iy+1,seed);return (a+(b-a)*u)*(1-v)+(c+(d-c)*u)*v;}
  // Woods come in groves and clearings, at every scale, rather than an even carpet.
  const grove=(x,y)=>drift(x/19,y/19,301)*.55+drift(x/6.5,y/6.5,302)*.3+drift(x/2.1,y/2.1,303)*.15;

  // ---------- Geometry bundles (see scripts/atlas-codec.mjs) ----------
  function decodeLayer(bytes,start,length){
    let at=start;const end=start+length;
    const read=()=>{let value=0,scale=1,byte;do{byte=bytes[at++];value+=(byte&127)*scale;scale*=128;}while(byte>127);return value;};
    const unzig=value=>value%2?-(value+1)/2:value/2,count=read(),features=new Array(count);
    for(let f=0;f<count;f++){
      const rank=read(),n=read(),xy=new Float32Array(n*2);let x=0,y=0,left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
      for(let i=0;i<n;i++){
        x+=unzig(read());y+=unzig(read());const px=x/50,py=y/50;xy[i*2]=px;xy[i*2+1]=py;
        if(px<left)left=px;if(px>right)right=px;if(py<top)top=py;if(py>bottom)bottom=py;
      }
      features[f]={rank,n,xy,left,top,right,bottom};
    }
    if(at>end)throw Error('The atlas geography is damaged.');
    return features;
  }
  function decodeBundle(buffer){
    const bytes=new Uint8Array(buffer),headerSize=new DataView(buffer).getUint32(0,true),index=JSON.parse(new TextDecoder().decode(bytes.subarray(4,4+headerSize))),base=4+headerSize,layers={};
    for(const [name,entry] of Object.entries(index)){
      if(name==='terrain')layers.terrain={bytes:bytes.subarray(base+entry.offset,base+entry.offset+entry.length),width:entry.width,height:entry.height};
      else layers[name]=decodeLayer(bytes,base+entry.offset,entry.length);
    }
    return layers;
  }

  // ---------- Paths, culled to the tile ----------
  const overlaps=(f,left,top,right,bottom)=>f.right>=left&&f.left<=right&&f.bottom>=top&&f.top<=bottom;
  // Sutherland-Hodgman against the tile: land fills stay cheap however large the continent is.
  function clipRing(xy,n,left,top,right,bottom){
    let input=xy,count=n;
    const pass=(inside,cross)=>{
      const output=new Float32Array((count+4)*2);let m=0,px=input[count*2-2],py=input[count*2-1],pIn=inside(px,py);
      for(let i=0;i<count;i++){
        const x=input[i*2],y=input[i*2+1],cIn=inside(x,y);
        if(cIn!==pIn){const t=cross(px,py,x,y);output[m*2]=px+(x-px)*t;output[m*2+1]=py+(y-py)*t;m++;}
        if(cIn){output[m*2]=x;output[m*2+1]=y;m++;}
        px=x;py=y;pIn=cIn;
      }
      input=output;count=m;
    };
    pass((x)=>x>=left,(ax,_,bx)=>(left-ax)/(bx-ax));if(!count)return null;
    pass((x)=>x<=right,(ax,_,bx)=>(right-ax)/(bx-ax));if(!count)return null;
    pass((_,y)=>y>=top,(_,ay,__,by)=>(top-ay)/(by-ay));if(!count)return null;
    pass((_,y)=>y<=bottom,(_,ay,__,by)=>(bottom-ay)/(by-ay));if(!count)return null;
    return {xy:input,n:count};
  }
  function fillPath(path,features,t,pad){
    const left=t.left-pad,top=t.top-pad,right=t.right+pad,bottom=t.bottom+pad;
    for(const f of features){
      if(!overlaps(f,left,top,right,bottom))continue;
      const inside=f.left>=left&&f.right<=right&&f.top>=top&&f.bottom<=bottom,ring=inside?f:clipRing(f.xy,f.n,left,top,right,bottom);
      if(!ring||ring.n<3)continue;
      const {xy,n}=ring;path.moveTo(xy[0]*t.sx-t.x0,xy[1]*t.sy-t.y0);
      for(let i=1;i<n;i++)path.lineTo(xy[i*2]*t.sx-t.x0,xy[i*2+1]*t.sy-t.y0);
      path.closePath();
    }
  }
  // Coast and river strokes: only segments near the tile, and never the sheet's own edges.
  function strokePath(path,features,t,pad,closed=true){
    const left=t.left-pad,top=t.top-pad,right=t.right+pad,bottom=t.bottom+pad;
    const edge=(ax,ay,bx,by)=>ax<.01&&bx<.01||ax>1439.99&&bx>1439.99||ay>719.99&&by>719.99||ay<.01&&by<.01;
    for(const f of features){
      if(!overlaps(f,left,top,right,bottom))continue;
      const {xy,n}=f;let pen=false;
      for(let i=0,last=closed?n:n-1;i<last;i++){
        const j=(i+1)%n,ax=xy[i*2],ay=xy[i*2+1],bx=xy[j*2],by=xy[j*2+1];
        if(Math.max(ax,bx)<left||Math.min(ax,bx)>right||Math.max(ay,by)<top||Math.min(ay,by)>bottom||closed&&edge(ax,ay,bx,by)){pen=false;continue;}
        if(!pen){path.moveTo(ax*t.sx-t.x0,ay*t.sy-t.y0);pen=true;}
        path.lineTo(bx*t.sx-t.x0,by*t.sy-t.y0);
      }
    }
  }

  // ---------- Terrain, sampled from the quarter-degree cells ----------
  function terrainAt(layer,x,y,out){
    const {bytes,width,height}=layer,fx=clamp(x,0,width-1.001),fy=clamp(y,0,height-1.001),ix=fx|0,iy=fy|0,u=fx-ix,v=fy-iy;
    let rugged=0,forest=0,arid=0,ice=0;
    for(let k=0;k<4;k++){
      const a=(iy+(k>>1))*width+ix+(k&1),weight=(k&1?u:1-u)*(k>>1?v:1-v),b0=bytes[a*2],b1=bytes[a*2+1];
      rugged+=(b0>>4)*weight;forest+=(b0&15)*weight;arid+=(b1>>4)*weight;ice+=(b1&15)*weight;
    }
    out.rugged=rugged/15;out.forest=forest/15;out.arid=arid/15;out.ice=ice/15;out.land=ice;return out;
  }
  // Every zoom step doubles the grid: old features stay exactly where they were and new ones fill in between.
  function eachCell(spacing,tier,t,pad,visit){
    const s=spacing/2**tier,x0=Math.floor((t.left-pad)/s),x1=Math.ceil((t.right+pad)/s),y0=Math.floor((t.top-pad)/s),y1=Math.ceil((t.bottom+pad)/s);
    for(let iy=y0;iy<=y1;iy++)for(let ix=x0;ix<=x1;ix++){
      if(tier&&!(ix&1)&&!(iy&1))continue;
      visit(ix,iy,s);
    }
  }

  // ---------- Inked terrain ----------
  function drawPeak(ctx,x,y,h,w,seed,u,detail){
    const r=stream(seed,Math.round(h*7),11),lean=(r()-.5)*w*.22,ax=x+lean,ay=y-h,lx=x-w/2,rx=x+w/2;
    const lm=[lx+w*(.2+r()*.1),y-h*(.42+r()*.12)],rm=[rx-w*(.18+r()*.1),y-h*(.44+r()*.12)];
    ctx.beginPath();ctx.moveTo(lx,y);ctx.quadraticCurveTo(lm[0],lm[1],ax,ay);ctx.quadraticCurveTo(rm[0],rm[1],rx,y);ctx.closePath();
    ctx.fillStyle='#efe2c3';ctx.fill();
    // The shadowed flank, in the old engravers' convention of light from the upper left.
    ctx.beginPath();ctx.moveTo(ax,ay);ctx.quadraticCurveTo(rm[0],rm[1],rx,y);ctx.lineTo(x+w*.1,y);
    const midx=ax+w*.05+(r()-.5)*w*.08,midy=y-h*.5;ctx.lineTo(midx,midy);ctx.closePath();
    ctx.fillStyle='rgba(112,84,52,.34)';ctx.fill();
    ctx.beginPath();ctx.moveTo(lx,y);ctx.quadraticCurveTo(lm[0],lm[1],ax,ay);ctx.quadraticCurveTo(rm[0],rm[1],rx,y);
    if(detail>0){
      ctx.moveTo(ax,ay);ctx.lineTo(midx,midy);ctx.lineTo(x+w*.1+(r()-.5)*w*.1,y-h*.12);
      const strokes=Math.min(7,Math.round(h/(2.3*u)));
      for(let i=1;i<=strokes;i++){
        const k=i/(strokes+1),sx=ax+(rx-ax)*k*.92+(r()-.5)*u*.4,sy=ay+(y-ay)*k*.98,len=h*(.1+.16*k)*(.8+r()*.5);
        ctx.moveTo(sx,sy);ctx.lineTo(sx-len*.42,sy+len*.8);
      }
    }
    ctx.strokeStyle=INK;ctx.lineWidth=.72*u;ctx.stroke();
  }
  function drawHill(ctx,x,y,h,w,seed,u){
    const r=stream(seed,3,19);
    ctx.beginPath();ctx.moveTo(x-w/2,y);ctx.bezierCurveTo(x-w*.3,y-h*(.9+r()*.3),x+w*.28,y-h*(.9+r()*.3),x+w/2,y);
    ctx.fillStyle='rgba(239,226,195,.75)';ctx.fill();
    ctx.moveTo(x+w*.16,y-h*.5);ctx.lineTo(x+w*.08,y-h*.08);ctx.moveTo(x+w*.3,y-h*.3);ctx.lineTo(x+w*.25,y-h*.04);
    ctx.strokeStyle=SEPIA;ctx.lineWidth=.6*u;ctx.stroke();
  }
  function drawConifer(ctx,x,y,h,seed,u,big){
    const r=stream(seed,5,23),w=h*(.5+r()*.12);
    ctx.beginPath();ctx.moveTo(x,y-h);
    if(big){const tiers=3;for(let i=1;i<=tiers;i++){const k=i/tiers;ctx.lineTo(x+w/2*k+u*.2,y-h*(1-k*.82));if(i<tiers)ctx.lineTo(x+w/2*k*.55,y-h*(1-k*.82));}for(let i=tiers;i>=1;i--){const k=i/tiers;if(i<tiers)ctx.lineTo(x-w/2*k*.55,y-h*(1-k*.82));ctx.lineTo(x-w/2*k-u*.2,y-h*(1-k*.82));}}
    else{ctx.lineTo(x+w/2,y-h*.16);ctx.lineTo(x-w/2,y-h*.16);}
    ctx.closePath();ctx.fillStyle=r()<.5?'#47553a':'#3f4d36';ctx.fill();
    if(big){ctx.strokeStyle=INK;ctx.lineWidth=.45*u;ctx.stroke();}
    ctx.beginPath();ctx.moveTo(x,y-h*.2);ctx.lineTo(x,y);ctx.strokeStyle=INK;ctx.lineWidth=.55*u;ctx.stroke();
  }
  function drawBroadleaf(ctx,x,y,h,seed,u,big,tropical){
    const r=stream(seed,9,29),radius=h*(.36+r()*.08),cy=y-h+radius;
    ctx.beginPath();ctx.moveTo(x,cy+radius*.6);ctx.lineTo(x,y);ctx.strokeStyle=INK;ctx.lineWidth=.55*u;ctx.stroke();
    ctx.beginPath();
    if(big){const lobes=7;for(let i=0;i<=lobes;i++){const a=i/lobes*Math.PI*2,rr=radius*(.92+r()*.2),px=x+Math.cos(a)*rr,py=cy+Math.sin(a)*rr*.92;if(i)ctx.quadraticCurveTo(x+Math.cos(a-.45)*rr*1.22,cy+Math.sin(a-.45)*rr*1.12,px,py);else ctx.moveTo(px,py);}}
    else ctx.arc(x,cy,radius,0,Math.PI*2);
    ctx.closePath();ctx.fillStyle=tropical?(r()<.5?'#5d7f4a':'#4f7344'):(r()<.5?'#737f47':'#65733f');ctx.fill();
    if(big){
      ctx.strokeStyle=INK;ctx.lineWidth=.45*u;ctx.stroke();
      ctx.beginPath();ctx.arc(x+radius*.1,cy+radius*.05,radius*.62,.1,1.5);ctx.stroke();
    }
  }
  function paintTerrain(ctx,scene,t){
    const terrain=scene.terrain;if(!terrain)return;
    // New peaks stop arriving past a point: up close they spread apart and the real ground shows between them.
    const p=t.sx/t.dpr,u=t.dpr,top=Math.max(0,Math.min(4,Math.round(Math.log2(p)))),items=[],at={},fit=Math.max(.62,Math.min(1,Math.sqrt(p)))*u;
    const pad=Math.min(26,40/p+1.2);
    // Mountains and foothills.
    for(let tier=0;tier<=top;tier++)eachCell(5.4,tier,t,pad,(ix,iy,s)=>{
      const roll=hash(ix,iy,31+tier);
      const x=(ix+hash(ix,iy,41+tier))*s,y=(iy+hash(ix,iy,51+tier))*s;
      terrainAt(terrain,x,y,at);
      const r=at.rugged;if(r<.16)return;
      if(r>=.3){
        // The deeper the zoom, the more room each new peak leaves around it.
        if(roll>(smooth(.26,.56,r)*.96+.04)*(tier>=3?.62:tier===2?.82:1))return;
        const size=(6.2+9*smooth(.3,.95,r))*(1+.2*(top-tier))*(.82+hash(ix,iy,61)*.36)*(1+Math.min(1.4,Math.log2(Math.max(1,p/16))*.35));
        items.push({y:y*t.sy,x:x*t.sx,kind:0,size:size*fit,seed:ix*31+iy*17+tier});
      }else if(roll<(p>6?.3:.55)){
        items.push({y:y*t.sy,x:x*t.sx,kind:1,size:(3.6+3*hash(ix,iy,62))*(1+.16*(top-tier))*fit,seed:ix*31+iy*17+tier});
      }
    });
    // Forests.
    for(let tier=0;tier<=Math.min(5,top+1);tier++)eachCell(3.9,tier,t,pad,(ix,iy,s)=>{
      const x=(ix+hash(ix,iy,71+tier))*s,y=(iy+hash(ix,iy,81+tier))*s;
      terrainAt(terrain,x,y,at);
      if(at.forest<.22||at.rugged>.46||at.ice>.2)return;
      const stand=grove(x,y)-.5+smooth(.25,.95,at.forest)*.42;
      if(stand<.2||hash(ix,iy,91+tier)>smooth(.2,.46,stand)*(p>2.4?.72:.96))return;
      const latitude=Math.abs(90-y/4),northern=latitude>47+hash(ix,iy,92)*9,tropical=latitude<24;
      const kind=northern||(!tropical&&hash(ix,iy,93)<.3)?2:tropical?4:3;
      items.push({y:y*t.sy,x:x*t.sx,kind,size:(3.9+1.9*hash(ix,iy,94))*(1+.26*(top-tier))*fit,seed:ix*37+iy*13+tier});
    });
    items.sort((a,b)=>a.y-b.y);
    const big=p>=2.4;
    for(const item of items){
      const x=item.x-t.x0,y=item.y-t.y0,s=item.size;
      if(x<-60*u||x>t.w+60*u||y<-4*u||y>t.h+60*u)continue;
      if(item.kind===0)drawPeak(ctx,x,y,s,s*(1.12+hash(item.seed,1,3)*.26),item.seed,u,p>=1?1:0);
      else if(item.kind===1)drawHill(ctx,x,y,s*.72,s*1.5,item.seed,u);
      else if(item.kind===2)drawConifer(ctx,x,y,s*1.16,item.seed,u,big);
      else drawBroadleaf(ctx,x,y,s,item.seed,u,big,item.kind===4);
    }
  }
  // Sand as stipple, ice as drawn-out hatching. Neither has height, so they lie beneath the trees and peaks.
  function paintGround(ctx,scene,t){
    const terrain=scene.terrain;if(!terrain)return;
    const u=t.dpr,p=t.sx/t.dpr,top=Math.max(0,Math.round(Math.log2(p))),at={};
    ctx.fillStyle='rgba(112,78,38,.5)';ctx.beginPath();
    for(let tier=0;tier<=top;tier++)eachCell(2.5,tier,t,1,(ix,iy,s)=>{
      const x=(ix+hash(ix,iy,101+tier))*s,y=(iy+hash(ix,iy,111+tier))*s;
      terrainAt(terrain,x,y,at);if(at.arid<.26||hash(ix,iy,121+tier)>smooth(.24,.8,at.arid)*.8)return;
      const px=x*t.sx-t.x0,py=y*t.sy-t.y0,radius=(.42+hash(ix,iy,131)*.4)*u;
      ctx.moveTo(px+radius,py);ctx.arc(px,py,radius,0,Math.PI*2);
    });
    ctx.fill();
    if(p>=1.8){
      ctx.strokeStyle='rgba(112,78,38,.55)';ctx.lineWidth=.6*u;ctx.beginPath();
      for(let tier=0;tier<=top;tier++)eachCell(11,tier,t,4,(ix,iy,s)=>{
        const x=(ix+hash(ix,iy,141+tier))*s,y=(iy+hash(ix,iy,151+tier))*s;
        terrainAt(terrain,x,y,at);if(at.arid<.5||at.rugged>.2||hash(ix,iy,161+tier)>.45)return;
        const px=x*t.sx-t.x0,py=y*t.sy-t.y0,w=(6+hash(ix,iy,171)*7)*u;
        ctx.moveTo(px-w,py);ctx.quadraticCurveTo(px-w*.2,py-w*.5,px+w*.1,py-w*.05);ctx.quadraticCurveTo(px+w*.5,py-w*.28,px+w,py);
      });
      ctx.stroke();
    }
    ctx.strokeStyle='rgba(84,100,106,.42)';ctx.lineWidth=.6*u;ctx.beginPath();
    for(let tier=0;tier<=top;tier++)eachCell(5,tier,t,4,(ix,iy,s)=>{
      const x=(ix+hash(ix,iy,181+tier))*s,y=(iy+hash(ix,iy,191+tier))*s;
      terrainAt(terrain,x,y,at);if(at.ice<.5)return;
      const px=x*t.sx-t.x0,py=y*t.sy-t.y0,w=(3+hash(ix,iy,201)*6)*u;
      ctx.moveTo(px-w,py);ctx.quadraticCurveTo(px,py-u*.7,px+w,py);
    });
    ctx.stroke();
  }

  // ---------- Sheet furniture ----------
  const ROSES=[[552,232],[1022,500],[214,478],[1360,262]];
  function paintRhumbs(ctx,t){
    const u=t.dpr;ctx.lineWidth=.5*u;ctx.strokeStyle='rgba(122,62,44,.2)';ctx.beginPath();
    for(const [cx,cy] of ROSES){
      const px=cx*t.sx-t.x0,py=cy*t.sy-t.y0,reach=2200*Math.max(t.sx,t.sy);
      for(let i=0;i<32;i++){const a=i/32*Math.PI*2;ctx.moveTo(px,py);ctx.lineTo(px+Math.cos(a)*reach,py+Math.sin(a)*reach);}
    }
    ctx.stroke();
  }
  function paintGraticule(ctx,t){
    const u=t.dpr,p=t.sx/t.dpr,step=p>=7?20:p>=2.8?40:120;
    ctx.strokeStyle='rgba(58,42,26,.16)';ctx.lineWidth=.55*u;ctx.setLineDash([1.6*u,4.2*u]);ctx.beginPath();
    for(let x=Math.ceil(t.left/step)*step;x<=t.right;x+=step){if(x%1440===0||x===720)continue;ctx.moveTo(x*t.sx-t.x0,0);ctx.lineTo(x*t.sx-t.x0,t.h);}
    for(let y=Math.ceil(t.top/step)*step;y<=t.bottom;y+=step){if(y%720===0||y===360)continue;ctx.moveTo(0,y*t.sy-t.y0);ctx.lineTo(t.w,y*t.sy-t.y0);}
    ctx.stroke();ctx.setLineDash([]);
  }
  // The sheet's two folds: a soft valley, a sharp ink-worn edge, and a catch of light.
  function paintFolds(ctx,t){
    const u=t.dpr,foldX=720*t.sx-t.x0,foldY=360*t.sy-t.y0;
    const line=(style,width)=>{ctx.strokeStyle=style;ctx.lineWidth=width*u;ctx.beginPath();if(foldX>-8*u&&foldX<t.w+8*u){ctx.moveTo(foldX,0);ctx.lineTo(foldX,t.h);}if(foldY>-8*u&&foldY<t.h+8*u){ctx.moveTo(0,foldY);ctx.lineTo(t.w,foldY);}ctx.stroke();};
    line('rgba(70,52,30,.05)',5);line('rgba(70,52,30,.16)',1.3);line('rgba(255,250,235,.4)',.6);
  }
  function paintFoxing(ctx,t){
    const u=t.dpr,p=t.sx/t.dpr;if(p<.5)return;
    ctx.beginPath();
    eachCell(46,0,t,3,(ix,iy,s)=>{
      if(hash(ix,iy,211)>.32)return;
      const x=(ix+hash(ix,iy,221))*s*t.sx-t.x0,y=(iy+hash(ix,iy,231))*s*t.sy-t.y0,radius=(.7+hash(ix,iy,241)*1.8)*u*Math.min(2.2,Math.sqrt(p));
      ctx.moveTo(x+radius,y);ctx.arc(x,y,radius,0,Math.PI*2);
    });
    ctx.fillStyle='rgba(116,74,32,.13)';ctx.fill();
  }
  function grainPattern(ctx,scene,u){
    if(!scene.grain){
      const size=256,canvas=new OffscreenCanvas(size,size),g=canvas.getContext('2d'),image=g.createImageData(size,size),data=image.data;
      for(let y=0;y<size;y++)for(let x=0;x<size;x++){
        const fibre=(hash(x>>2,y,251)-.5)*14+(hash(x,y>>2,252)-.5)*14,speck=(hash(x,y,253)-.5)*22,v=232+fibre+speck;
        const i=(y*size+x)*4;data[i]=v;data[i+1]=v-1;data[i+2]=v-5;data[i+3]=255;
      }
      g.putImageData(image,0,0);scene.grain=canvas;
    }
    return ctx.createPattern(scene.grain,'repeat');
  }

  // ---------- Engraved ornaments, anchored to open water ----------
  const SHIP={
    hull:'M10 66Q14 60 26 61L72 61Q84 60 92 49L98 49L90 67Q78 80 50 80Q24 80 10 66Z M8 66L5 50L25 50L27 61',
    planks:'M13 69Q40 74 87 66M18 74Q44 79 80 72M30 61L30 66M44 61L44 66M58 61L58 66M72 61L72 66',
    masts:'M30 61L30 16M52 61L52 6M74 60L74 18M92 49L108 38',
    rigging:'M30 18L10 50M30 18L52 8M52 8L74 20M74 20L92 49M52 8L88 45',
    sails:['M38 16Q52 9 66 16Q70 26 66 34Q52 28 38 34Q34 26 38 16Z','M36 36Q52 29 68 36Q74 48 68 58Q52 52 36 58Q30 48 36 36Z','M66 24Q74 18 84 24Q87 32 84 38Q74 34 66 38Q63 32 66 24Z','M66 40Q75 35 86 40Q90 48 86 56Q75 51 66 56Q62 48 66 40Z','M30 20L13 46L30 46Z'],
    flags:['M52 6L52 0L63 3L52 6Z','M30 16L30 11L38 14L30 16Z'],
    cross:'M52 37L52 55M42 46L62 46',
    waves:'M-4 82Q4 76 12 82T28 82T44 82T60 82T76 82T92 82T108 82M6 90Q14 85 22 90T38 90M62 90Q70 85 78 90T94 90'
  };
  function drawShip(ctx,x,y,s,u,flip){
    ctx.save();ctx.translate(x,y);ctx.scale(flip?-s/100:s/100,s/100);ctx.translate(-50,-50);
    const line=(w)=>{ctx.lineWidth=w*u*100/s;};
    ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle=INK;
    ctx.fillStyle='#7b5a39';ctx.fill(new Path2D(SHIP.hull));line(.8);ctx.stroke(new Path2D(SHIP.hull));
    line(.45);ctx.stroke(new Path2D(SHIP.planks));
    line(.8);ctx.stroke(new Path2D(SHIP.masts));line(.32);ctx.stroke(new Path2D(SHIP.rigging));
    for(const sail of SHIP.sails){const path=new Path2D(sail);ctx.fillStyle='#f4e9cf';ctx.fill(path);line(.62);ctx.stroke(path);}
    ctx.strokeStyle='#a5311f';line(1.25);ctx.stroke(new Path2D(SHIP.cross));
    ctx.fillStyle='#a5311f';for(const flag of SHIP.flags)ctx.fill(new Path2D(flag));
    ctx.strokeStyle=WATER_INK;line(.55);ctx.stroke(new Path2D(SHIP.waves));
    ctx.restore();
  }
  const SERPENT={
    humps:['M28 58C30 34 52 34 54 58L47 58C46 44 37 44 36 58Z','M60 58C62 40 80 40 82 58L76 58C75 48 67 48 66 58Z','M88 58C89 46 102 46 103 58L98 58C97 52 93 52 92 58Z'],
    neck:'M4 58C2 36 8 18 22 14C28 12 32 14 36 18L44 20L40 25L34 24C26 22 20 30 18 42C17 48 18 54 19 58Z',
    fin:'M20 15L14 6L22 11L24 3L28 11L33 6L33 16',
    tail:'M108 58C112 52 116 44 124 42L130 34L132 46L138 50L126 50C120 52 116 56 114 58Z',
    jaw:'M44 20L52 19L46 26L38 26',
    scales:'M12 40Q16 38 20 40M10 48Q14 46 18 48M36 46Q42 42 48 46M66 50Q71 47 76 50M92 53Q95 51 99 53',
    waves:'M-2 60Q6 54 14 60T30 60T46 60T62 60T78 60T94 60T110 60T126 60M8 67Q14 63 20 67T36 67M72 67Q78 63 84 67T100 67'
  };
  function drawSerpent(ctx,x,y,s,u,flip){
    ctx.save();ctx.translate(x,y);ctx.scale(flip?-s/130:s/130,s/130);ctx.translate(-65,-40);
    const line=w=>{ctx.lineWidth=w*u*130/s;};ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle=INK;
    ctx.fillStyle='#5f7350';
    for(const piece of [...SERPENT.humps,SERPENT.neck,SERPENT.tail]){const path=new Path2D(piece);ctx.fill(path);line(.7);ctx.stroke(path);}
    ctx.fillStyle='#a5311f';{const fin=new Path2D(SERPENT.fin);ctx.fill(fin);line(.5);ctx.stroke(fin);}
    ctx.fillStyle='#e9dcc0';{const jaw=new Path2D(SERPENT.jaw);ctx.fill(jaw);line(.5);ctx.stroke(jaw);}
    line(.42);ctx.stroke(new Path2D(SERPENT.scales));
    ctx.fillStyle=INK;ctx.beginPath();ctx.arc(30,18,1.3,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle=WATER_INK;line(.55);ctx.stroke(new Path2D(SERPENT.waves));
    ctx.restore();
  }
  const WHALE={body:'M6 36C14 18 46 12 72 20C84 24 92 22 100 12L98 4L108 10L118 4L112 16C106 30 92 44 62 46C36 48 14 46 6 36Z',belly:'M8 37C24 44 46 45 66 42',fin:'M42 42C44 50 50 54 58 54C54 49 54 45 54 42Z',spout:'M30 14C28 8 24 6 19 6M30 14C30 7 31 4 34 1M30 14C33 8 37 6 42 7',waves:'M-6 50Q2 44 10 50T26 50T42 50T58 50T74 50T90 50T106 50M6 57Q12 53 18 57T34 57M58 57Q64 53 70 57T86 57'};
  function drawWhale(ctx,x,y,s,u,flip){
    ctx.save();ctx.translate(x,y);ctx.scale(flip?-s/110:s/110,s/110);ctx.translate(-55,-30);
    const line=w=>{ctx.lineWidth=w*u*110/s;};ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle=INK;
    {const body=new Path2D(WHALE.body);ctx.fillStyle='#50626a';ctx.fill(body);line(.72);ctx.stroke(body);}
    {const fin=new Path2D(WHALE.fin);ctx.fill(fin);ctx.stroke(fin);}
    line(.42);ctx.stroke(new Path2D(WHALE.belly));
    ctx.fillStyle='#f4e9cf';ctx.beginPath();ctx.arc(20,31,1.5,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle=WATER_INK;line(.55);ctx.stroke(new Path2D(WHALE.spout));ctx.stroke(new Path2D(WHALE.waves));
    ctx.restore();
  }
  const CROW='M2 13C8 10 14 10 20 12L24 2C26 8 27 11 28 13C33 13 37 11 40 12L37 14C36 17 33 19 28 19L24 27C23 22 22 20 20 18C14 18 8 16 2 13Z';
  function drawCrows(ctx,x,y,s,u){
    const flock=[[0,0,1],[-1.25,.72,.8],[1.2,.5,.88],[-.45,-.8,.72],[2.1,-.5,.66]];
    ctx.fillStyle='#231a12';
    const path=new Path2D(CROW);
    for(const [ox,oy,scale] of flock){
      const size=s*scale/40;
      ctx.save();ctx.translate(x+ox*s,y+oy*s);ctx.rotate(-.34+ox*.09);ctx.scale(size,size);ctx.translate(-20,-14);ctx.fill(path);ctx.restore();
    }
  }
  function drawRose(ctx,x,y,R,u,major){
    ctx.save();ctx.translate(x,y);ctx.lineJoin='round';ctx.lineCap='round';
    // Rings.
    ctx.strokeStyle=INK;ctx.lineWidth=.8*u;ctx.fillStyle='rgba(244,233,207,.84)';
    ctx.beginPath();ctx.arc(0,0,R*.74,0,Math.PI*2);ctx.fill();ctx.stroke();
    ctx.lineWidth=.45*u;ctx.beginPath();ctx.arc(0,0,R*.68,0,Math.PI*2);ctx.stroke();
    if(major){
      ctx.beginPath();for(let i=0;i<64;i++){const a=i/64*Math.PI*2,r0=R*.68,r1=R*(i%8?(i%4?.7:.715):.74);ctx.moveTo(Math.cos(a)*r0,Math.sin(a)*r0);ctx.lineTo(Math.cos(a)*r1,Math.sin(a)*r1);}ctx.stroke();
      ctx.beginPath();ctx.arc(0,0,R*.26,0,Math.PI*2);ctx.stroke();
    }
    // Sixteen fine points, eight half-winds, then the cardinal kites over them.
    const kite=(angle,length,width,dark,light)=>{
      const cos=Math.cos(angle),sin=Math.sin(angle),tip=[cos*length,sin*length],a=[Math.cos(angle-Math.PI/2)*width,Math.sin(angle-Math.PI/2)*width],b=[Math.cos(angle+Math.PI/2)*width,Math.sin(angle+Math.PI/2)*width];
      ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(a[0],a[1]);ctx.lineTo(tip[0],tip[1]);ctx.closePath();ctx.fillStyle=dark;ctx.fill();ctx.strokeStyle=INK;ctx.lineWidth=.45*u;ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(b[0],b[1]);ctx.lineTo(tip[0],tip[1]);ctx.closePath();ctx.fillStyle=light;ctx.fill();ctx.stroke();
    };
    if(major)for(let i=0;i<16;i++){const a=(i+.5)/16*Math.PI*2;ctx.strokeStyle=INK;ctx.lineWidth=.45*u;ctx.beginPath();ctx.moveTo(Math.cos(a)*R*.12,Math.sin(a)*R*.12);ctx.lineTo(Math.cos(a)*R*.62,Math.sin(a)*R*.62);ctx.stroke();}
    for(let i=0;i<4;i++)kite(Math.PI/4+i*Math.PI/2,R*.66,R*.1,'#a5311f','#f4e9cf');
    for(let i=0;i<4;i++)kite(i*Math.PI/2,R*.98,R*.13,INK,'#f4e9cf');
    // The north point carries a little fleur-de-lis.
    if(major){
      const n=R*.98;ctx.fillStyle=INK;ctx.beginPath();ctx.moveTo(0,-n-R*.2);ctx.quadraticCurveTo(R*.07,-n-R*.1,R*.015,-n+R*.02);ctx.quadraticCurveTo(-R*.01,-n,-R*.015,-n+R*.02);ctx.quadraticCurveTo(-R*.07,-n-R*.1,0,-n-R*.2);ctx.fill();
      for(const side of [-1,1]){ctx.beginPath();ctx.moveTo(side*R*.02,-n+R*.02);ctx.quadraticCurveTo(side*R*.17,-n-R*.02,side*R*.13,-n-R*.13);ctx.quadraticCurveTo(side*R*.1,-n-R*.05,side*R*.01,-n-R*.04);ctx.fill();}
    }
    ctx.fillStyle='#f4e9cf';ctx.beginPath();ctx.arc(0,0,R*.055,0,Math.PI*2);ctx.fill();ctx.strokeStyle=INK;ctx.lineWidth=.5*u;ctx.stroke();
    ctx.restore();
  }
  // Sheet coordinates; every one lies in open water.
  const ORNAMENTS=[
    {kind:'rose',x:ROSES[2][0],y:ROSES[2][1],size:48,major:true},
    {kind:'rose',x:ROSES[1][0],y:ROSES[1][1],size:32,major:true},
    {kind:'rose',x:ROSES[0][0],y:ROSES[0][1],size:16},
    {kind:'rose',x:ROSES[3][0],y:ROSES[3][1],size:14},
    {kind:'ship',x:634,y:176,size:40},
    {kind:'ship',x:296,y:372,size:36,flip:true},
    {kind:'ship',x:1130,y:446,size:34},
    {kind:'ship',x:670,y:470,size:30,flip:true},
    {kind:'serpent',x:92,y:196,size:58},
    {kind:'serpent',x:1262,y:560,size:44,flip:true},
    {kind:'whale',x:612,y:398,size:36,flip:true},
    {kind:'whale',x:958,y:560,size:30},
    {kind:'crows',x:870,y:26,size:13}
  ];
  function paintOrnaments(ctx,t){
    const u=t.dpr,p=t.sx/t.dpr,grow=u*p**.62;
    for(const item of ORNAMENTS){
      const size=item.size*grow,x=item.x*t.sx-t.x0,y=item.y*t.sy-t.y0,reach=size*(item.kind==='crows'?3.4:1.3);
      if(x<-reach||x>t.w+reach||y<-reach||y>t.h+reach)continue;
      if(item.kind==='rose')drawRose(ctx,x,y,size,u,item.major);
      else if(item.kind==='ship')drawShip(ctx,x,y,size,u,item.flip);
      else if(item.kind==='serpent')drawSerpent(ctx,x,y,size,u,item.flip);
      else if(item.kind==='whale')drawWhale(ctx,x,y,size,u,item.flip);
      else drawCrows(ctx,x,y,size,u);
    }
  }
  // Little runs of waves across the open sea, the engraver's way of saying "water".
  function paintSeaMarks(ctx,scene,t){
    const terrain=scene.terrain;if(!terrain)return;
    const u=t.dpr,p=t.sx/t.dpr,top=Math.max(0,Math.round(Math.log2(p))),at={};
    ctx.strokeStyle='rgba(84,62,36,.3)';ctx.lineWidth=.55*u;ctx.beginPath();
    for(let tier=0;tier<=top;tier++)eachCell(25,tier,t,3,(ix,iy,s)=>{
      if(hash(ix,iy,311+tier)>.62)return;
      const x=(ix+hash(ix,iy,321+tier))*s;let y=(iy+hash(ix,iy,331+tier))*s;
      terrainAt(terrain,x,y,at);if(at.land>.01)return;
      for(const [dx,dy] of [[-5,-3],[5,3],[-5,3]])terrainAt(terrain,x+dx,y+dy,at),at.land>.01&&(y=NaN);
      if(y!==y)return;
      const px=x*t.sx-t.x0,py=y*t.sy-t.y0,w=(2.1+hash(ix,iy,341)*1.3)*u,n=hash(ix,iy,351)<.5?2:3;
      for(let i=0;i<n;i++){const ox=px+(i-n/2)*w*2;ctx.moveTo(ox,py);ctx.quadraticCurveTo(ox+w*.5,py-w*.6,ox+w,py);ctx.quadraticCurveTo(ox+w*1.5,py+w*.6,ox+w*2,py);}
    });
    ctx.stroke();
  }

  // ---------- A tile ----------
  function createScene(){return {plates:{},layers:{},terrain:null,grain:null,scratch:null};}
  function addLayers(scene,layers){Object.assign(scene.layers,layers);if(layers.terrain)scene.terrain=layers.terrain;}
  function plate(ctx,image,t){
    const kx=image.width/1440,ky=image.height/720;
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    ctx.drawImage(image,t.left*kx,t.top*ky,(t.right-t.left)*kx,(t.bottom-t.top)*ky,0,0,t.w,t.h);
  }
  // Close in, finer hillshade tiles model the ground beneath the ink.
  const RELIEF_SPAN=90;
  function reliefTiles(tile,coverage){
    const left=tile.x0/tile.sx,top=tile.y0/tile.sy,right=(tile.x0+tile.w)/tile.sx,bottom=(tile.y0+tile.h)/tile.sy,keys=[];
    if(tile.sx/tile.dpr<4.5||!coverage)return keys;
    for(let y=Math.max(0,Math.floor(top/RELIEF_SPAN));y<=Math.min(coverage.length-1,Math.floor((bottom-.001)/RELIEF_SPAN));y++)
      for(let x=Math.max(0,Math.floor(left/RELIEF_SPAN));x<=Math.min(15,Math.floor((right-.001)/RELIEF_SPAN));x++)if(coverage[y]&(1<<x))keys.push({x,y,key:`16-${x}-${y}`});
    return keys;
  }
  function paintRelief(ctx,scene,t,p){
    if(p<4.5)return;
    ctx.save();ctx.globalCompositeOperation='multiply';ctx.globalAlpha=smooth(4.5,9,p)*.62;ctx.imageSmoothingQuality='high';
    for(const {x,y,key} of reliefTiles(t,scene.reliefCoverage)){
      const image=scene.relief?.get(key);if(!image)continue;
      ctx.drawImage(image,x*RELIEF_SPAN*t.sx-t.x0,y*RELIEF_SPAN*t.sy-t.y0,RELIEF_SPAN*t.sx,RELIEF_SPAN*t.sy);
    }
    ctx.restore();
  }
  function waterlines(ctx,scene,coast,t,p){
    const u=t.dpr,offsets=p<.8?[1.8,3.6]:p<2.2?[1.9,3.9,6.3]:[2.2,4.6,7.4,10.8],alphas=[.62,.44,.28,.16],hair=.5*u;
    let scratch=scene.scratch;
    if(!scratch||scratch.width<t.w||scratch.height<t.h){scratch=scene.scratch=new OffscreenCanvas(t.w,t.h);}
    const s=scratch.getContext('2d');
    s.setTransform(1,0,0,1,0,0);s.globalCompositeOperation='source-over';s.clearRect(0,0,scratch.width,scratch.height);s.lineJoin='round';s.lineCap='round';
    for(let i=offsets.length-1;i>=0;i--){
      const d=offsets[i]*u;
      s.globalCompositeOperation='source-over';s.strokeStyle=`rgba(74,54,30,${alphas[i]})`;s.lineWidth=d*2+hair;s.stroke(coast);
      s.globalCompositeOperation='destination-out';s.strokeStyle='#000';s.lineWidth=d*2-hair;s.stroke(coast);
    }
    ctx.drawImage(scratch,0,0);
  }
  function paintTile(ctx,scene,tile){
    const t={...tile};
    t.left=t.x0/t.sx;t.top=t.y0/t.sy;t.right=(t.x0+t.w)/t.sx;t.bottom=(t.y0+t.h)/t.sy;
    const {layers,plates}=scene,u=t.dpr,p=t.sx/t.dpr;
    ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.lineCap='round';ctx.lineJoin='round';
    const land=p>=6.5&&layers.land2||p>=2.2&&layers.land1||layers.land0||[];
    const lakes=(p>=2.2&&layers.lakes1||layers.lakes0||[]).filter(f=>f.rank<=(p>=7?8:p>=3.5?7:p>=1.8?5:3));
    const rivers=(p>=2.2&&layers.rivers1||layers.rivers0||[]).filter(f=>f.rank<=(p>=8?9:p>=5?8:p>=3?7:p>=1.6?5:3));
    // Sea.
    if(plates.sea)plate(ctx,plates.sea,t);else{ctx.fillStyle='#eadfc2';ctx.fillRect(0,0,t.w,t.h);}
    paintRhumbs(ctx,t);paintSeaMarks(ctx,scene,t);
    const reach=14*u/Math.min(t.sx,t.sy),fill=new Path2D(),coast=new Path2D();
    fillPath(fill,land,t,4/Math.min(t.sx,t.sy));strokePath(coast,land,t,reach);
    waterlines(ctx,scene,coast,t,p);
    // Land, cut crisply from its plate.
    ctx.save();ctx.clip(fill,'evenodd');
    if(plates.land)plate(ctx,plates.land,t);else{ctx.fillStyle=PAPER;ctx.fillRect(0,0,t.w,t.h);}
    // Pigment gathers where the wash met the coast.
    ctx.strokeStyle='rgba(122,86,44,.13)';ctx.lineWidth=7*u;ctx.stroke(coast);ctx.strokeStyle='rgba(122,86,44,.16)';ctx.lineWidth=3.2*u;ctx.stroke(coast);
    paintGround(ctx,scene,t);
    paintRelief(ctx,scene,t,p);
    ctx.restore();
    // Lakes.
    if(lakes.length){
      const water=new Path2D(),shore=new Path2D();fillPath(water,lakes,t,4/Math.min(t.sx,t.sy));strokePath(shore,lakes,t,2/Math.min(t.sx,t.sy));
      ctx.save();ctx.clip(water,'evenodd');if(plates.sea)plate(ctx,plates.sea,t);ctx.fillStyle='rgba(92,142,154,.62)';ctx.fillRect(0,0,t.w,t.h);ctx.restore();
      ctx.strokeStyle=WATER_INK;ctx.lineWidth=.6*u;ctx.stroke(shore);
    }
    // Rivers: a pale wash under a fine line, broader for the great ones.
    if(rivers.length){
      const paths=[new Path2D(),new Path2D(),new Path2D()];
      for(const river of rivers){const band=river.rank<=2?0:river.rank<=5?1:2;strokePath(paths[band],[river],t,2/Math.min(t.sx,t.sy),false);}
      const weight=clamp(Math.sqrt(p),1,2.6);
      ctx.strokeStyle='rgba(118,160,168,.6)';ctx.lineWidth=2.4*u*weight;ctx.stroke(paths[0]);
      ctx.strokeStyle=RIVER;ctx.lineWidth=1*u*weight;ctx.stroke(paths[0]);
      ctx.lineWidth=.72*u*weight;ctx.stroke(paths[1]);ctx.lineWidth=.52*u*weight;ctx.stroke(paths[2]);
    }
    // Borders in the dotted line of a hand-drawn chart.
    const borders=p>=3&&layers.borders1||layers.borders0||[];
    if(borders.length&&p>=.7){
      const path=new Path2D();strokePath(path,borders,t,2/Math.min(t.sx,t.sy),false);
      ctx.strokeStyle='rgba(74,50,28,.5)';ctx.lineWidth=1*u;ctx.setLineDash([.01,3.1*u]);ctx.stroke(path);ctx.setLineDash([]);
    }
    if(p>=1.6&&layers.regions?.length){
      const path=new Path2D();strokePath(path,layers.regions,t,2/Math.min(t.sx,t.sy),false);
      ctx.strokeStyle='rgba(74,50,28,.3)';ctx.lineWidth=.7*u;ctx.setLineDash([.01,2.6*u]);ctx.stroke(path);ctx.setLineDash([]);
    }
    ctx.save();ctx.clip(fill,'evenodd');paintTerrain(ctx,scene,t);ctx.restore();
    // Coast ink: two passes a hair apart read as a pen, not a plotter.
    ctx.strokeStyle=INK;ctx.globalAlpha=.82;ctx.lineWidth=.82*u;ctx.stroke(coast);
    ctx.globalAlpha=.18;ctx.lineWidth=1.7*u;ctx.stroke(coast);ctx.globalAlpha=1;
    paintGraticule(ctx,t);paintOrnaments(ctx,t);paintFolds(ctx,t);paintFoxing(ctx,t);
    ctx.save();ctx.globalCompositeOperation='multiply';ctx.fillStyle=grainPattern(ctx,scene,u);ctx.fillRect(0,0,t.w,t.h);ctx.restore();
  }
  globalThis.RedlineAtlasPainter=Object.freeze({decodeBundle,createScene,addLayers,paintTile,terrainAt,reliefTiles,ORNAMENTS});
})();
