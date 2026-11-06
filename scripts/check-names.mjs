/* Authoring tool, not part of `npm test`: finds names on the map that collide, clip, go missing, or flicker, by reading the final on-screen box of every
   name from the built page in one headless Chrome with a temporary profile. Atlas names are measured a box a letter, so curved and rotated ones are not one big rectangle.
   npm run build && node scripts/check-names.mjs [--dist dist] [--windows 1440x900,1440x820,844x390,390x844] [--routes starter,voyage,close,twice] [--trace] [--shots DIR] [--worst 6] [--json FILE] [--scratch DIR]
   The matrix runs without painting workers, because only the lettering is being read; --shots loads the page again with one worker to photograph the worst samples.
   Set CHROME to the browser's path if it is not in the usual Mac place. */
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execSync,spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {extname,join,resolve,sep} from 'node:path';

const option=(name,fallback)=>{const i=process.argv.indexOf(`--${name}`);return i<0?fallback:process.argv[i+1];};
const flag=name=>process.argv.includes(`--${name}`);
const dist=resolve(option('dist',new URL('../dist/',import.meta.url).pathname)),scratch=option('scratch',tmpdir()),shotDir=option('shots',''),worstCount=Number(option('worst',6));
const windows=option('windows','1440x900,1440x820,844x390,390x844').split(',').map(text=>text.split('x').map(Number));
const chromePath=process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const freeGB=()=>Number(execSync('df -k /System/Volumes/Data').toString().trim().split('\n').pop().split(/\s+/)[3])/1048576;

const place=(name,latitude,longitude)=>({name,country:'',latitude,longitude});
const ROUTES={
  starter:[place('New York',40.7128,-74.006),place('London',51.5085,-.1257),place('Cairo',30.0626,31.2497)],
  voyage:[place('Lisbon',38.7167,-9.1333),place('Seville',37.3891,-5.9845),place('Marrakesh',31.6342,-7.9999),place('Cadiz',36.5271,-6.2886),place('Rome',41.8919,12.5113),place('Athens',37.9838,23.7278),place('Istanbul',41.0138,28.9497),place('Cairo',30.0626,31.2497),place('Muscat',23.5841,58.4078),place('Mumbai',19.0728,72.8826),place('Kathmandu',27.7017,85.3206),place('Bangkok',13.754,100.5014),place('Singapore',1.2897,103.8501),place('Rio de Janeiro',-22.9068,-43.1729)],
  close:[place('Paris',48.8534,2.3488),place('Brussels',50.8503,4.3517),place('Amsterdam',52.374,4.8897),place('Cologne',50.9375,6.9603),place('Frankfurt',50.1109,8.6821),place('Strasbourg',48.5734,7.7521),place('Basel',47.5596,7.5886),place('Zurich',47.3769,8.5417),place('Milan',45.4642,9.19),place('Munich',48.1351,11.582),place('Vienna',48.2082,16.3738),place('Prague',50.088,14.4208)],
  twice:[place('London',51.5085,-.1257),place('Paris',48.8534,2.3488),place('Rome',41.8919,12.5113),place('Paris',48.8534,2.3488),place('Berlin',52.5244,13.4105)]
};
const routeNames=option('routes',Object.keys(ROUTES).join()).split(',');
// In sheet coordinates: where the camera goes, at each of these zooms.
const REGIONS={europe:[760,160],asia:[1200,228],america:[480,420],pacific:[120,360]},ZOOMS=[2,4,8,16,32,64];
const CAMERAS=[{name:'world',z:1,at:[720,360]},...Object.entries(REGIONS).flatMap(([region,at])=>ZOOMS.map(z=>({name:`${region} x${z}`,z,at})))];
const CLASSES={
  'stop-stop':'stop names overlapping stop names','stop-atlas':'stop names overlapping atlas names','atlas-atlas':'atlas names overlapping atlas names',
  'any-plate':'names under the title plate','any-dock':'names under the dock','any-controls':'names under the map controls','clipped':'names cut by the window edge',
  'stop-missing':'stop names missing though there is room','stop-far':'stop names over 24 px from their dot','stop-route':'stop names crossing the route line','atlas-route':'atlas names crossing the route line',
  'stop-dot':'stop names covering a stop dot','atlas-dot':'atlas names covering a stop dot','leader-name':'leader lines crossing other names','stop-twice':'a city visited twice named twice',
  'plate-missing':'world views without the title plate','great-missing':'continents and oceans absent from a world view','flicker-atlas':'atlas names flickering in a sweep','flicker-stop':'stop names flickering in a sweep','stop-jump':'stop names changing place in a sweep'
};

// Everything the page side needs. It reads what is on screen and moves the camera through the same wheel events a hand makes.
const agent=painting=>`(()=>{
  ${painting?'':'window.Worker=class{postMessage(){}terminate(){}};'}
  Object.defineProperty(navigator,'hardwareConcurrency',{value:2});
  Element.prototype.setPointerCapture=function(){};
  const raf=window.requestAnimationFrame.bind(window);let began=0;
  window.requestAnimationFrame=cb=>raf(t=>{began=performance.now();cb(t);});
  const $=id=>document.getElementById(id),rect=el=>{const r=el.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};};
  const ruler=document.createElement('canvas').getContext('2d');
  const inkOf=(text,font)=>{ruler.font=font;const m=ruler.measureText(text);return [m.actualBoundingBoxAscent,m.actualBoundingBoxDescent];};
  const N={costs:[],frames:null,places:new Map()};
  N.install=()=>{const a=RedlineApp.atlas,update=a.update;a.update=function(view,labels){N.costs.push(performance.now()-began);if(N.frames)N.frames.push(N.frame(view,labels));return update.call(this,view,labels);};};
  N.mark=()=>{began=performance.now();};
  // Each name's place on the sheet and its extent about that place, the first time it is seen.
  N.frame=(view,labels)=>{
    const r=$('map').getBoundingClientRect(),a=RedlineApp.atlas,kx=view.w/r.width,ky=view.h/r.height;
    for(const l of labels){
      const key=l.kind+':'+l.text;if(N.places.has(key))continue;
      const boxes=l.kind==='cartouche'?(s=>[{x:l.x-s.w/2,y:l.y-s.h/2,w:s.w,h:s.h}])(a.measure('cartouche',l.text,l.kicker)):a.outline(l);
      N.places.set(key,{x:view.x+l.x*kx,y:view.y+l.y*ky,left:Math.min(...boxes.map(b=>b.x))-l.x,right:Math.max(...boxes.map(b=>b.x+b.w))-l.x,top:Math.min(...boxes.map(b=>b.y))-l.y,bottom:Math.max(...boxes.map(b=>b.y+b.h))-l.y});
    }
    return {view:{...view},W:r.width,H:r.height,fixed:[rect($('route-dock')),rect(document.querySelector('.zoom-controls'))],atlas:labels.map(l=>l.kind+':'+l.text),stops:[...document.querySelectorAll('#route-stops>g')].map(g=>{const t=g._label;return g.style.opacity==='0'||t.classList.contains('label-hidden')?null:t._slot;})};
  };
  N.reset=()=>$('reset-view').click();
  N.wheel=(deltaY,x,y)=>{N.mark();$('map').dispatchEvent(new WheelEvent('wheel',{clientX:x,clientY:y,deltaY,bubbles:true,cancelable:true}));};
  // From the whole world, one anchor reaches any centred frame.
  N.anchor=(cx,cy,z)=>{const r=$('map').getBoundingClientRect(),w=1440/z,h=720/z,clamp=v=>Math.max(0,Math.min(1,v));return [clamp((cx-w/2)/Math.max(1e-6,1440-w))*r.width,clamp((cy-h/2)/Math.max(1e-6,720-h))*r.height];};
  N.go=(cx,cy,z)=>{N.reset();if(z<=1)return;const [x,y]=N.anchor(cx,cy,z),total=Math.log(z)/.0034,steps=Math.ceil(total/150);for(let i=0;i<steps;i++)N.wheel(-total/steps,x,y);};
  N.next=()=>$('next-city').click();
  N.route=stops=>{RedlineApp.setStops(stops.map((s,i)=>({...s,id:'check-'+i})));};
  // Back within a moment of leaving, or gone within a moment of arriving, while it could still have stayed: well inside the window throughout.
  const flips=(frames,keysOf,inside)=>{
    const seen=new Map(),limit=20;let flickers=0;const names=new Set();
    frames.forEach((frame,i)=>{for(const key of keysOf(frame)){if(!seen.has(key))seen.set(key,[]);seen.get(key).push(i);}});
    for(const [key,at] of seen){
      let start=at[0];
      for(let i=1;i<=at.length;i++){
        if(i<at.length&&at[i]-at[i-1]===1)continue;
        const end=at[i-1],next=i<at.length?at[i]:Infinity;
        if(next-end>1&&next-end<=limit){let held=true;for(let f=end+1;f<next;f++)if(!inside(key,frames[f]))held=false;if(held){flickers++;names.add(key);}}
        else if(end-start<limit&&start>0&&end<frames.length-1&&inside(key,frames[end+1])){flickers++;names.add(key);}
        start=at[i];
      }
    }
    return {flickers,names:[...names].slice(0,12)};
  };
  N.score=frames=>{
    // Not while the dock or the controls lie over it either.
    const inView=(p,f,pad)=>{const sx=(p.x-f.view.x)*f.W/f.view.w,sy=(p.y-f.view.y)*f.H/f.view.h,l=sx+p.left,r=sx+p.right,t=sy+p.top,b=sy+p.bottom;return l>pad&&r<f.W-pad&&t>pad&&b<f.H-pad&&!f.fixed.some(o=>l<o.x+o.w+pad&&r>o.x-pad&&t<o.y+o.h+pad&&b>o.y-pad);};
    const groups=[...document.querySelectorAll('#route-stops>g')];
    // Nor outside the zooms at which the sweep ever showed it, which are its rank's business.
    const zooms=new Map();for(const f of frames){const z=f.view.w;for(const key of f.atlas){const known=zooms.get(key);if(!known)zooms.set(key,[z,z]);else{known[0]=Math.min(known[0],z);known[1]=Math.max(known[1],z);}}}
    const atlas=flips(frames,f=>f.atlas,(key,f)=>{const [low,high]=zooms.get(key);return f.view.w>=low&&f.view.w<=high&&inView(N.places.get(key),f,8);});
    const stop=flips(frames,f=>f.stops.flatMap((slot,i)=>slot?[i]:[]),(i,f)=>{const [x,y]=groups[i]._point;return inView({x,y,left:0,right:0,top:0,bottom:0},f,8);});
    let jumps=0;for(let i=1;i<frames.length;i++)frames[i].stops.forEach((slot,j)=>{const was=frames[i-1].stops[j];if(slot&&was&&slot!==was)jumps++;});
    return {frames:frames.length,atlas,stop,jumps};
  };
  const framed=()=>new Promise(done=>raf(()=>done()));
  // One wheel step a frame: a brisk hand, doubling the zoom about every quarter of a second.
  N.sweepZoom=async(cx,cy)=>{
    N.reset();N.frames=[];N.places.clear();const [x,y]=N.anchor(cx,cy,8),total=Math.log(64)/.0034,steps=90;
    for(let i=0;i<steps;i++){N.wheel(-total/steps,x,y);await framed();}for(let i=0;i<steps;i++){N.wheel(total/steps,x,y);await framed();}
    const out=N.score(N.frames);N.frames=null;return out;
  };
  N.sweepPan=async(cx,cy,z,dx,dy,steps=70)=>{
    N.go(cx,cy,z);const map=$('map'),r=map.getBoundingClientRect(),pointer=(type,x,y)=>map.dispatchEvent(new PointerEvent(type,{pointerId:7,pointerType:'mouse',button:0,clientX:x,clientY:y,bubbles:true,cancelable:true}));
    const x0=r.width/2,y0=r.height/2;pointer('pointerdown',x0,y0);N.frames=[];N.places.clear();
    for(let i=1;i<=steps;i++){pointer('pointermove',x0+dx*i/steps,y0+dy*i/steps);await framed();}
    pointer('pointerup',x0+dx,y0+dy);const out=N.score(N.frames);N.frames=null;return out;
  };
  N.settle=async()=>{for(let i=0;i<40;i++)await framed();};
  N.settled=async()=>{await framed();await framed();return N.read();};
  // The camera's own frames during a real trace, with a full reading at each port.
  N.sail=async(limit=120000)=>{
    N.reset();N.frames=[];N.places.clear();N.costs.length=0;const shots=[];let step=$('map').dataset.tripStep;
    $('play').click();const start=performance.now();
    while(performance.now()-start<limit){
      await framed();
      const now=$('map').dataset.tripStep;if(now!==step&&now!=='0'){step=now;shots.push(N.read());}
      if($('play-label').textContent!=='Pause')break;
    }
    const costs=[...N.costs].sort((a,b)=>a-b),score=N.score(N.frames);N.frames=null;
    return {seconds:(performance.now()-start)/1000,shots,score,costMedian:costs[costs.length>>1],cost95:costs[costs.length*.95|0],cost99:costs[costs.length*.99|0],costMax:costs.at(-1),frames:costs.length};
  };
  N.cost=()=>{N.costs.length=0;const [x,y]=N.anchor(760,160,8),total=Math.log(32)/.0034,steps=160;N.reset();N.costs.length=0;for(let i=0;i<steps;i++)N.wheel(-total/steps,x,y);for(let i=0;i<steps;i++)N.wheel(total/steps,x,y);const c=[...N.costs].sort((a,b)=>a-b);return {median:c[c.length>>1],p95:c[c.length*.95|0],max:c.at(-1),frames:c.length};};
  N.read=()=>{
    const a=RedlineApp.atlas,r=$('map').getBoundingClientRect(),labels=a.labels,view=a.view,plate=labels.find(l=>l.kind==='cartouche');
    const atlas=labels.filter(l=>l.kind!=='cartouche').map(l=>({kind:l.kind,text:l.text,x:l.x,y:l.y,angle:l.angle||0,boxes:a.outline(l)}));
    const stops=[...document.querySelectorAll('#route-stops>g')].map((g,i)=>{
      const t=g._label,dot=rect(g.querySelector('.stop-dot')),hidden=t.classList.contains('label-hidden'),shown=g.style.opacity!=='0',font=getComputedStyle(t).font,[up,down]=inkOf(t.textContent,font),m=/translate\\(([-\\d.e]+)[ ,]+([-\\d.e]+)\\)/.exec(g.getAttribute('transform')||''),cell=rect(t);
      const baseline=m?Number(m[2])+Number(t.getAttribute('y')||0):0,d=g._leader.getAttribute('d'),leader=d&&/M0,0L(-?[\\d.]+),(-?[\\d.]+)/.exec(d);
      return {i,text:t.textContent,hidden,shown,slot:t._slot||null,dot:{x:dot.x+dot.w/2,y:dot.y+dot.h/2},width:cell.w,box:hidden||!shown?null:{x:cell.x-1.6,y:baseline-up-1.6,w:cell.w+3.2,h:up+down+3.2},ink:[up,down],leader:leader?[dot.x+dot.w/2,dot.y+dot.h/2,dot.x+dot.w/2+Number(leader[1]),dot.y+dot.h/2+Number(leader[2])]:null};
    });
    const segs=[];for(const path of document.querySelectorAll('#route-lines path')){const d=path.getAttribute('d');if(!d)continue;let last=null;for(const [,cmd,x,y] of d.matchAll(/([ML])(-?[\\d.]+),(-?[\\d.]+)/g)){const p=[Number(x),Number(y)];if(cmd==='L'&&last)segs.push([last[0],last[1],p[0],p[1]]);last=p;}}
    let plateBox=null;if(plate){const s=a.measure('cartouche',plate.text,plate.kicker);plateBox={x:plate.x-s.w/2,y:plate.y-s.h/2,w:s.w,h:s.h};}
    return {W:r.width,H:r.height,view:{...view},zoom:1440/view.w,atlas,stops,segs,plate:plateBox,dock:rect($('route-dock')),controls:rect(document.querySelector('.zoom-controls'))};
  };
  // Lettering ink lying outside every measured box means the boxes are wrong, not the map.
  N.inkOutside=()=>{
    const map=$('map'),g=map.getContext('2d'),dpr=map.width/map.getBoundingClientRect().width,d=g.getImageData(0,0,map.width,map.height).data,reading=N.read(),inside=new Uint8Array(map.width*map.height);
    const mark=b=>{for(let y=Math.max(0,Math.floor((b.y-2)*dpr));y<Math.min(map.height,Math.ceil((b.y+b.h+2)*dpr));y++)inside.fill(1,y*map.width+Math.max(0,Math.floor((b.x-2)*dpr)),y*map.width+Math.min(map.width,Math.ceil((b.x+b.w+2)*dpr)));};
    for(const name of reading.atlas)name.boxes.forEach(mark);if(reading.plate)mark(reading.plate);
    let out=0,ink=0;for(let i=0;i<inside.length;i++)if(d[i*4+3]>64){ink++;if(!inside[i])out++;}
    return {ink,out};
  };
  window.__names=N;
})()`;

const inflate=(b,p)=>({x:b.x-p,y:b.y-p,w:b.w+p*2,h:b.h+p*2});
const hit=(a,b,slack=1)=>Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>slack&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>slack;
const anyHit=(as,bs,slack)=>as.some(a=>bs.some(b=>hit(a,b,slack)));
const crosses=([x0,y0,x1,y1],r)=>{
  let low=0,high=1;
  for(const [start,delta,min,max] of [[x0,x1-x0,r.x,r.x+r.w],[y0,y1-y0,r.y,r.y+r.h]]){
    if(Math.abs(delta)<1e-9){if(start<min||start>max)return false;continue;}
    const a=(min-start)/delta,b=(max-start)/delta;low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));if(low>high)return false;
  }
  return true;
};
const distanceTo=(p,r)=>Math.hypot(Math.max(r.x-p.x,0,p.x-r.x-r.w),Math.max(r.y-p.y,0,p.y-r.y-r.h));

// One reading becomes findings, by class. Each finding names what it found, so a report can be read without the screen.
function judge(s){
  const found=[],say=(kind,text)=>found.push([kind,text]);
  // A name wholly off screen is not a name on screen.
  const seen=b=>b.x+b.w>0&&b.y+b.h>0&&b.x<s.W&&b.y<s.H,stops=s.stops.filter(t=>t.box&&seen(t.box)),atlas=s.atlas.filter(a=>a.boxes.some(seen)),names=[...stops.map(t=>({kind:'stop',text:t.text,boxes:[t.box],stop:t})),...atlas.map(a=>({kind:'atlas',text:a.text,boxes:a.boxes}))];
  const onScreen=p=>p.x>=0&&p.x<=s.W&&p.y>=0&&p.y<=s.H,dots=s.stops.filter(t=>t.shown&&onScreen(t.dot));
  for(let i=0;i<names.length;i++){
    const a=names[i];
    for(let j=i+1;j<names.length;j++){
      const b=names[j];if(!anyHit(a.boxes,b.boxes))continue;
      say(a.kind==='stop'?(b.kind==='stop'?'stop-stop':'stop-atlas'):'atlas-atlas',`${a.text} / ${b.text}`);
    }
    if(s.plate&&anyHit(a.boxes,[s.plate]))say('any-plate',a.text);
    if(anyHit(a.boxes,[s.dock]))say('any-dock',a.text);
    if(anyHit(a.boxes,[s.controls]))say('any-controls',a.text);
    if(a.boxes.some(b=>b.x<-.5||b.y<-.5||b.x+b.w>s.W+.5||b.y+b.h>s.H+.5))say('clipped',a.text);
    if(s.segs.some(seg=>a.boxes.some(b=>crosses(seg,b))))say(a.kind==='stop'?'stop-route':'atlas-route',a.text);
    for(const dot of dots){
      if(a.stop===dot)continue;
      const mark=inflate({x:dot.dot.x,y:dot.dot.y,w:0,h:0},4.5);
      if(anyHit(a.boxes,[mark]))say(a.kind==='stop'?'stop-dot':'atlas-dot',`${a.text} on ${dot.text}`);
    }
  }
  for(const t of stops){
    if(distanceTo(t.dot,t.box)>24)say('stop-far',`${t.text} ${Math.round(distanceTo(t.dot,t.box))}px`);
    if(t.leader)for(const n of names)if(n.stop!==t&&n.boxes.some(b=>crosses(t.leader,b)))say('leader-name',`${t.text} across ${n.text}`);
  }
  const named=new Map();for(const t of stops){const key=`${t.text}|${Math.round(t.dot.x)}|${Math.round(t.dot.y)}`;named.set(key,(named.get(key)||0)+1);}
  for(const [key,count] of named)if(count>1)say('stop-twice',key.split('|')[0]);
  // Room means one of the near places around the dot is free of the window edge and the fixtures, and 2 px clear of other stop names and other dots. Atlas names give way, and the line may be crossed.
  const fixtures=[s.dock,s.controls,...(s.plate?[s.plate]:[])];
  for(const t of s.stops){
    if(!t.hidden||!t.shown||!onScreen(t.dot)||fixtures.some(f=>hit(inflate({x:t.dot.x,y:t.dot.y,w:0,h:0},1),f,0)))continue;
    // Named by a visit before, or by a dot it cannot be told from.
    if(stops.some(o=>Math.hypot(o.dot.x-t.dot.x,o.dot.y-t.dot.y)<(o.text===t.text?4:2.5)))continue;
    const [up,down]=t.ink,w=t.width+3.2,h=up+down+3.2,room=[[8,-10-h],[8,4],[-8-w,-10-h],[-8-w,4],[-w/2,-10-h],[-w/2,10],[10,-h/2],[-10-w,-h/2]].some(([dx,dy])=>{
      const b={x:t.dot.x+dx,y:t.dot.y+dy,w,h};
      return b.x>=0&&b.y>=0&&b.x+b.w<=s.W&&b.y+b.h<=s.H&&!fixtures.some(f=>hit(b,f))&&!stops.some(o=>hit(inflate(b,2),o.box))&&!dots.some(o=>o!==t&&hit(inflate(b,2),inflate({x:o.dot.x,y:o.dot.y,w:0,h:0},4.5)));
    });
    if(room)say('stop-missing',t.text);
  }
  if(s.zoom<=1.001){
    if(!s.plate)say('plate-missing','title plate');
    const great=new Set(atlas.filter(a=>a.kind==='continent'||a.kind==='ocean').map(a=>a.text));
    for(const name of ['North America','South America','Europe','Africa','Asia','Australia','Pacific Ocean','Atlantic Ocean','Indian Ocean','Southern Ocean','Arctic Ocean'])if(!great.has(name))say('great-missing',name);
  }
  return found;
}

const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.jpg':'image/jpeg','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.bin':'application/octet-stream','.svg':'image/svg+xml'};
const server=createServer(async(request,response)=>{
  try{
    const url=new URL(request.url,'http://localhost'),path=resolve(dist,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!path.startsWith(dist+sep))throw Error();
    const bytes=await readFile(path);response.writeHead(200,{'content-type':types[extname(path)]||'application/octet-stream','cache-control':'no-store'}).end(bytes);
  }catch{response.writeHead(404).end();}
});
await new Promise(ready=>server.listen(0,'127.0.0.1',ready));
const base=`http://127.0.0.1:${server.address().port}/`;

// One Chrome, closed and its profile deleted when the job is done, whatever happens.
async function withChrome(job){
  if(freeGB()<2)throw Error(`Only ${freeGB().toFixed(2)} GB of disk is free.`);
  const profile=await mkdtemp(join(scratch,'redline-names-'));
  const browser=spawn(chromePath,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--mute-audio','--hide-scrollbars','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const closed=new Promise(done=>browser.once('exit',done));
  try{
    const endpoint=await new Promise((yes,no)=>{let log='';browser.stderr.on('data',chunk=>{log+=chunk;const found=/ws:\/\/\S+/.exec(log);if(found)yes(found[0]);});browser.once('error',no);setTimeout(()=>no(Error('No DevTools address from Chrome.')),20000);});
    let targets=[];for(let i=0;i<50&&!targets.some(t=>t.type==='page');i++){targets=await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json`)).json();await sleep(100);}
    const socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(open=>socket.addEventListener('open',open));
    let nextId=1;const waiting=new Map(),errors=[];
    socket.addEventListener('message',({data})=>{
      const m=JSON.parse(data);
      if(m.id&&waiting.has(m.id)){const {yes,no}=waiting.get(m.id);waiting.delete(m.id);m.error?no(Error(JSON.stringify(m.error))):yes(m.result);}
      else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
    });
    const send=(method,params={})=>new Promise((yes,no)=>{const id=nextId++;waiting.set(id,{yes,no});socket.send(JSON.stringify({id,method,params}));});
    const js=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    await send('Page.enable');await send('Runtime.enable');await send('Emulation.setFocusEmulationEnabled',{enabled:true});
    const quiet=(on=true)=>send('Emulation.setEmulatedMedia',{features:on?[{name:'prefers-reduced-motion',value:'reduce'}]:[]});
    await quiet();
    const open=async([width,height],painting=false)=>{
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      const {identifier}=await send('Page.addScriptToEvaluateOnNewDocument',{source:agent(painting)});
      await send('Page.navigate',{url:base});
      for(let i=0;i<200&&!await js('!!(window.RedlineApp&&window.__names&&document.fonts.status==="loaded")').catch(()=>false);i++)await sleep(50);
      await send('Page.removeScriptToEvaluateOnNewDocument',{identifier});
      await js('document.fonts.ready.then(()=>{__names.install();})');await sleep(120);
    };
    return await job({send,js,open,quiet,errors});
  }finally{
    browser.kill('SIGTERM');await Promise.race([closed,sleep(4000)]);if(browser.exitCode===null)browser.kill('SIGKILL');
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}

const tally={},perWindow={},perRoute={},samples=[],sweeps=[],costs=[],traces=[],inks=[];let reads=0;
const addTo=(table,key,kind)=>{(table[key]??={})[kind]=(table[key][kind]||0)+1;};
function record(reading,where){
  const found=judge(reading);reads++;
  for(const [kind] of found){tally[kind]=(tally[kind]||0)+1;addTo(perWindow,where.window,kind);addTo(perRoute,where.route,kind);}
  samples.push({...where,zoom:+reading.zoom.toFixed(2),names:reading.atlas.length,stops:reading.stops.filter(t=>t.box&&t.box.x+t.box.w>0&&t.box.y+t.box.h>0&&t.box.x<reading.W&&t.box.y<reading.H).length,found});
}
function recordSweep(score,where){
  const add=(kind,count)=>{if(!count)return;tally[kind]=(tally[kind]||0)+count;(perWindow[where.window]??={})[kind]=(perWindow[where.window][kind]||0)+count;(perRoute[where.route]??={})[kind]=(perRoute[where.route][kind]||0)+count;};
  add('flicker-atlas',score.atlas.flickers);add('flicker-stop',score.stop.flickers);add('stop-jump',score.jumps);
  sweeps.push({...where,frames:score.frames,flickerAtlas:score.atlas.flickers,flickerStop:score.stop.flickers,jumps:score.jumps,names:score.atlas.names});
}

await withChrome(async({js,open,quiet,errors})=>{
  for(const size of windows){
    const label=size.join('x');
    if(freeGB()<2)throw Error('Disk is nearly full; stopping.');
    await open(size);
    for(const route of routeNames){
      await js(`__names.route(${JSON.stringify(ROUTES[route])})`);
      for(const camera of CAMERAS){
        const reading=await js(`(__names.go(${camera.at[0]},${camera.at[1]},${camera.z}),__names.read())`);
        record(reading,{window:label,route,camera:camera.name,at:camera.at,z:camera.z});
        // Now and then, that the boxes are telling the truth about the pixels.
        if(camera.z===1||camera.z===8&&camera.name.startsWith('europe')){await js('__names.settle()');inks.push({window:label,route,camera:camera.name,...await js('__names.inkOutside()')});}
      }
      // Each port, as the arrows or a trace arrive there.
      await js('__names.reset()');
      for(let i=0;i<ROUTES[route].length;i++){await js('__names.next()');await sleep(400);record(await js('__names.settled()'),{window:label,route,camera:`arrive ${i+1} ${ROUTES[route][i].name}`,step:i+1});}
      for(const [region,at] of Object.entries(REGIONS))recordSweep(await js(`__names.sweepZoom(${at[0]},${at[1]})`),{window:label,route,sweep:`zoom ${region}`});
      recordSweep(await js(`__names.sweepPan(${REGIONS.europe[0]},${REGIONS.europe[1]},4,${-Math.round(size[0]*.8)},${Math.round(size[1]*.1)})`),{window:label,route,sweep:'pan x4 east from Europe'});
      if(route==='voyage')costs.push({window:label,route,...await js('__names.cost()')});
    }
    if(flag('trace')){
      await quiet(false);
      // A real trace at the real pace, reading the screen at each arrival. The voyage in every window, the others in the first.
      for(const route of size===windows[0]?routeNames:['voyage']){
        await js(`__names.route(${JSON.stringify(ROUTES[route])})`);
        const sail=await js('__names.sail()');
        sail.shots.forEach((reading,i)=>record(reading,{window:label,route,camera:`trace port ${i+1}`,step:i+2}));
        recordSweep(sail.score,{window:label,route,sweep:'trace'});
        traces.push({window:label,route,seconds:+sail.seconds.toFixed(1),frames:sail.frames,costMedian:+sail.costMedian.toFixed(2),cost95:+sail.cost95.toFixed(2),cost99:+sail.cost99.toFixed(2),costMax:+sail.costMax.toFixed(2),flickerAtlas:sail.score.atlas.flickers,flickerStop:sail.score.stop.flickers,jumps:sail.score.jumps,names:sail.score.atlas.names});
      }
      await quiet();
    }
    if(errors.length)console.log(`Page errors at ${label}:`,errors.splice(0).slice(0,5));
  }
});

// Worst first: the ugliest kinds count most.
const weight={'stop-stop':8,'any-dock':6,'any-controls':6,'any-plate':6,'stop-atlas':5,'atlas-atlas':4,clipped:4,'stop-missing':3,'stop-route':2,'atlas-route':2,'stop-dot':3,'atlas-dot':2,'leader-name':3,'stop-far':1,'stop-twice':8,'plate-missing':3,'great-missing':1};
const badness=s=>s.found.reduce((sum,[kind])=>sum+(weight[kind]||1),0);
const worst=[...samples].sort((a,b)=>badness(b)-badness(a)).slice(0,worstCount);
if(shotDir&&worst.length){
  await mkdir(shotDir,{recursive:true});
  await withChrome(async({js,open,send})=>{
    for(const [index,s] of worst.entries()){
      if(freeGB()<2)throw Error('Disk is nearly full; stopping.');
      await open(s.window.split('x').map(Number),true);
      await js(`__names.route(${JSON.stringify(ROUTES[s.route])})`);
      if(s.step){await js('__names.reset()');for(let i=0;i<s.step;i++)await js('__names.next()');}
      else if(s.at)await js(`__names.go(${s.at[0]},${s.at[1]},${s.z})`);
      await js('__names.settle()');
      // Tiles have settled once none has arrived for a while.
      let count=-1;for(let i=0;i<40;i++){const now=await js('document.querySelectorAll(".atlas-tile").length');if(now===count&&i>6)break;count=now;await sleep(500);}
      await js('__names.settle()');
      const name=`${String(index+1).padStart(2,'0')}-${s.window}-${s.route}-${s.camera.replace(/\W+/g,'_')}.jpg`;
      const {data}=await send('Page.captureScreenshot',{format:'jpeg',quality:72});
      await writeFile(join(shotDir,name),Buffer.from(data,'base64'));s.shot=name;
    }
  });
}
await new Promise(done=>server.close(done));

const table=(rows,keys)=>{for(const key of keys)console.log(`  ${String(key).padEnd(14)}${Object.keys(CLASSES).filter(kind=>rows[key]?.[kind]).map(kind=>`${kind} ${rows[key][kind]}`).join(', ')||'clear'}`);};
console.log(`${reads} readings, ${sweeps.length} sweeps, ${samples.reduce((n,s)=>n+s.names,0)} atlas names and ${samples.reduce((n,s)=>n+s.stops,0)} stop names read in all.`);
for(const [kind,about] of Object.entries(CLASSES))console.log(`${String(tally[kind]||0).padStart(6)}  ${kind.padEnd(14)} ${about}`);
console.log('By window:');table(perWindow,windows.map(w=>w.join('x')));
console.log('By route:');table(perRoute,routeNames);
{const ink=inks.reduce((n,i)=>n+i.ink,0),out=inks.reduce((n,i)=>n+i.out,0),worst=[...inks].sort((a,b)=>b.out/(b.ink||1)-a.out/(a.ink||1))[0];console.log(`Lettering ink outside the measured boxes: ${out} of ${ink} pixels over ${inks.length} checks${worst?`, at worst ${worst.out} of ${worst.ink} at ${worst.window} ${worst.route} ${worst.camera}`:''}.`);}
console.log('Layout cost per frame during a zoom sweep, 1:8 to 1:256 of the sheet, Chrome (ms):');for(const c of costs)console.log(`  ${c.window}  median ${c.median.toFixed(2)}, 95th ${c.p95.toFixed(2)}, max ${c.max.toFixed(2)}, over ${c.frames} frames`);
if(traces.length){console.log('Real traces:');for(const t of traces)console.log(`  ${t.window} ${t.route}: ${t.seconds} s, ${t.frames} frames, layout median ${t.costMedian} ms, 95th ${t.cost95}, 99th ${t.cost99}, max ${t.costMax}; flicker ${t.flickerAtlas} atlas, ${t.flickerStop} stop; ${t.jumps} jumps${t.names.length?` (${t.names.join(', ')})`:''}`);}
console.log(`Worst ${worst.length}:`);
for(const s of worst){const kinds={};for(const [kind] of s.found)kinds[kind]=(kinds[kind]||0)+1;console.log(`  ${s.window} ${s.route} ${s.camera} (x${s.zoom}, ${s.names} atlas, ${s.stops} stop)${s.shot?` ${s.shot}`:''}: ${Object.entries(kinds).map(([kind,n])=>`${kind} ${n}`).join(', ')}`);for(const [kind,text] of s.found.slice(0,10))console.log(`      ${kind}: ${text}`);}
if(option('json',''))await writeFile(option('json',''),JSON.stringify({tally,perWindow,perRoute,costs,traces,inks,sweeps,samples},null,0));
