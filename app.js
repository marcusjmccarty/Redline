(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const city = (name, country, latitude, longitude, admin1 = '') => ({name, country, latitude, longitude, admin1});
  const places = [
    city('New York','United States',40.7128,-74.006,'New York'),
    city('London','United Kingdom',51.5085,-0.1257,'England'),
    city('Cairo','Egypt',30.0626,31.2497),
    city('Paris','France',48.8534,2.3488),city('Rome','Italy',41.8919,12.5113),
    city('Tokyo','Japan',35.6895,139.6917),city('Sydney','Australia',-33.8679,151.2073),
    city('Chicago','United States',41.85,-87.65,'Illinois'),city('Denver','United States',39.7392,-104.9847,'Colorado'),
    city('Los Angeles','United States',34.0522,-118.2437,'California'),city('San Francisco','United States',37.7749,-122.4194,'California'),
    city('Lisbon','Portugal',38.7167,-9.1333),city('Madrid','Spain',40.4165,-3.7026),
    city('Athens','Greece',37.9838,23.7278),city('Istanbul','Türkiye',41.0138,28.9497),
    city('Kathmandu','Nepal',27.7017,85.3206),city('Beijing','China',39.9075,116.3972),
    city('Shanghai','China',31.2222,121.4581),city('Bangkok','Thailand',13.754,100.5014),
    city('Singapore','Singapore',1.2897,103.8501),city('Mumbai','India',19.0728,72.8826),
    city('Delhi','India',28.6519,77.2315),city('Marrakesh','Morocco',31.6342,-7.9999),
    city('Nairobi','Kenya',-1.2833,36.8167),city('Cape Town','South Africa',-33.9258,18.4232),
    city('Rio de Janeiro','Brazil',-22.9068,-43.1729),city('Buenos Aires','Argentina',-34.6132,-58.3772),
    city('Lima','Peru',-12.0432,-77.0282),city('Mexico City','Mexico',19.4285,-99.1277),
    city('Honolulu','United States',21.3069,-157.8583,'Hawaii'),city('Auckland','New Zealand',-36.8485,174.7635),
    city('Muscat','Oman',23.5841,58.4078),city('Dublin','Ireland',53.3331,-6.2489),
    city('Berlin','Germany',52.5244,13.4105),city('Prague','Czechia',50.088,14.4208),
    city('Kraków','Poland',50.0614,19.9366),city('Reykjavík','Iceland',64.1355,-21.8954)
  ];
  const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  // A well-known prefix match beats a hamlet with the exact typed name ("Kyo" → Kyoto).
  const relevance = q => p => {const name=normalize(p.name);return Math.log10((p.population||0)+10)+(name===q?3:name.startsWith(q)?1.5:0);};
  const byRelevance = query => {const score=relevance(normalize(query));return (a,b)=>score(b)-score(a);};
  let stops = places.slice(0,3).map(p => ({...p}));
  try {
    const saved = JSON.parse(localStorage.getItem('redline-route-v1'));
    if (Array.isArray(saved) && saved.length <= 100 && saved.every(p => p && typeof p.name === 'string' && p.name.length <= 120 && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180)) stops = saved;
  } catch {}
  const map = $('map'), input = $('destination');
  const atlasView=RedlineAtlasView.create(map,JSON.parse($('atlas-assets').textContent),{labelsReady:()=>{lastLayout='';scheduleView();}});
  let animation = 0, running = false, lines = [], searchTimer, controller, searchVersion = 0, results = [], selected = -1;
  let resultsQuery = '', resultsReady = false, addingQuery = '';
  let progress=null,activeLeg=null,geometry=[],playback=null,lastTick=null;
  let traceZoom=null,idleZoom=null,suppressStopClickUntil=0,focused=null;
  const held=new Map();
  const labelSlots=new Map(),labelWidths=new Map(),zoomControls=document.querySelector('.zoom-controls');
  const WORLD_W=1440,WORLD_H=720,MAX_ZOOM=RedlineTrace.maxZoom;
  let view={x:0,y:0,w:WORLD_W,h:WORLD_H};
  let baseView={...view},viewFrame=0,zoomLevel=1,activeStopId=null;
  let lastLayout='',lastLayoutGeometry=null,lastLaidView={...view},mapOccluded=false,viewportBounds=null;
  const changed=(node,name,value)=>{const text=String(value);if(node.getAttribute(name)!==text)node.setAttribute(name,text);};
  const mapMatrix=bounds=>({a:bounds.width/view.w,b:0,c:0,d:bounds.height/view.h,e:bounds.left-view.x*bounds.width/view.w,f:bounds.top-view.y*bounds.height/view.h});
  stops=stops.map(p=>({...p,id:p.id||crypto.randomUUID()}));
  const undoStack=[],redoStack=[];
  const copyRoute=()=>stops.map(stop=>({...stop}));
  function updateUndo(){
    $('undo-route').disabled=!undoStack.length;
    $('undo-route').title=undoStack.length?`Undo ${undoStack.at(-1).label} (Ctrl / ⌘ + Z)`:'Undo route edit (Ctrl / ⌘ + Z)';
  }
  function checkpoint(label){undoStack.push({route:copyRoute(),label});if(undoStack.length>100)undoStack.shift();redoStack.length=0;updateUndo();}
  function undoRoute(redo=false){
    const from=redo?redoStack:undoStack,to=redo?undoStack:redoStack,entry=from.pop();if(!entry)return;
    to.push({route:copyRoute(),label:entry.label});stops=entry.route.map(stop=>({...stop}));drawRoute();persist();updateUndo();
    if($('undo-route').disabled&&document.activeElement===$('undo-route'))$('trip-panel').focus({preventScroll:true});
  }
  $('undo-route').addEventListener('click',()=>undoRoute());
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.altKey||event.isComposing||!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='z'||event.target.closest?.('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]'))return;
    event.preventDefault();if(!event.repeat)undoRoute(event.shiftKey);
  });
  const persist=()=>{try{localStorage.setItem('redline-route-v1',JSON.stringify(stops));}catch{}window.dispatchEvent(new CustomEvent('redline:routechange'));};
  // Give a fresh or legacy draft stable stop identities before it can be saved.
  persist();
  const project=p=>RedlineLayout.project([p.longitude,p.latitude]);
  const backgroundPoints=window.MAP_CITIES.map(project);
  let hiddenMapCities=new Set(),stopPeers=[],routeIndex=null,routeIndexGeometry=null,routeMatrix=null,routeMatrixKey='',nameGrid=null;
  function rebuildGeometry(){
    const names=stops.map(stop=>normalize(stop.name));
    stopPeers=stops.map((a,index)=>stops.flatMap((b,i)=>Math.abs(a.latitude-b.latitude)<.15&&Math.abs(a.longitude-b.longitude)<.15&&names[index]===names[i]?[i]:[]));
    hiddenMapCities=new Set(window.MAP_CITIES.flatMap((p,i)=>stops.some(s=>Math.abs(s.latitude-p.latitude)<.15&&Math.abs(s.longitude-p.longitude)<.15)?[i]:[]));
    geometry=stops.slice(1).map((place,i)=>{
      const interpolate=RedlineGeo.geoInterpolate([stops[i].longitude,stops[i].latitude],[place.longitude,place.latitude]);
      return RedlineTrace.measure(RedlineLayout.route(interpolate));
    });
    lines.forEach(path=>{path._amount=null;path.removeAttribute('d');});
  }
  function setPlayState(value) {
    running=value;$('play-label').textContent=value?'Pause':'Trace route';
    $('play-icon').firstElementChild.setAttribute('d',value?'M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z':'m5 3 8 5-8 5z');
  }
  function stopAnimation() {
    stopGlide();cancelAnimationFrame(animation);animation=0;lastTick=null;playback=null;idleZoom=null;setPlayState(false);
  }
  const stopShown=i=>!(activeLeg?.destination===i&&activeLeg.destination>activeLeg.origin&&Math.abs(progress-i)>1e-7)&&(progress===null||i<=progress+1e-7||activeLeg?.origin===i);
  // A city visited twice (same name, close by: sources differ slightly) is named once, by the active visit or else the first one shown; its dot goes there too.
  function labelOwner(index){const peers=stopPeers[index]||[index];return peers.find(i=>stops[i].id===activeStopId&&stopShown(i))??peers.find(stopShown)??peers[0];}
  // Later stops paint over earlier ones, so a generous target can lie over a neighbour's dot. The closest dot shown is the one meant.
  function nearestStop(event,index){
    let best=index,distance=Infinity;
    [...$('route-stops').children].forEach((group,i)=>{
      if(!stopShown(i))return;
      const box=group.querySelector('.stop-dot').getBoundingClientRect(),d=Math.hypot(box.left+box.width/2-event.clientX,box.top+box.height/2-event.clientY);
      if(d<distance){distance=d;best=i;}
    });
    return best;
  }
  function paintProgress(){
    lines.forEach((path,i)=>{
      const amount=progress===null?1:Math.max(0,Math.min(1,progress-i));
      // Reveal the cached arc by screen distance for a steady drawing speed.
      if(path._amount!==amount||path._matrix!==routeMatrixKey){
        // A leg wholly off screen costs nothing: no string to build and no path for the browser to parse.
        const b=geometry[i].bounds,m=routeMatrix,seen=amount>0&&m&&b.right*m.a+m.e>-4&&b.left*m.a+m.e<viewportBounds.width+4&&b.bottom*m.d+m.f>-4&&b.top*m.d+m.f<viewportBounds.height+4;
        if(seen||!path._blank){path.style.visibility=seen?'':'hidden';const d=seen?geometry[i].screenPathAt(amount,m):'';path.setAttribute('d',d);path._halo.setAttribute('d',d);path._blank=!seen;}
        path._amount=amount;path._matrix=routeMatrixKey;
      }
    });
    [...$('route-stops').children].forEach((node,i)=>{
      const visible=stopShown(i);
      if(node._shown===visible)return;node._shown=visible;
      node.style.opacity=visible?'1':'0';node.setAttribute('aria-hidden',String(!visible));
      node.setAttribute('tabindex',visible?'0':'-1');node.style.pointerEvents=visible?'':'none';
    });
  }
  function drawRoute() {
    // Rebuilding the list would drop keyboard focus to the page, where the next Space sets sail behind the logbook.
    const had=document.activeElement,hadRow=had?.closest?.('#stop-list li'),hadIndex=hadRow?[...$('stop-list').children].indexOf(hadRow):-1,hadPart=had?.classList?.contains('remove-stop')?'.remove-stop':'.stop-grip';
    stopAnimation();traceZoom=null;progress=null;activeLeg=null;activeStopId=null;focused=null;$('route-halos').replaceChildren();$('route-lines').replaceChildren();$('route-stops').replaceChildren();$('stop-list').replaceChildren();lines=[];
    stops.forEach((place,index)=>{
      if(index) {const path=svg('path',{class:'route-path',id:`route-ink-${index}`}),halo=svg('path',{class:'route-halo','aria-hidden':'true'});path._halo=halo;$('route-halos').append(halo);$('route-lines').append(path);lines.push(path);}
      const [x,y]=project(place),group=svg('g',{'data-index':index,visibility:'hidden'}),dot=svg('circle',{cx:0,cy:0,r:4.5,class:'stop-dot'});
      const label=svg('text',{x:10,y:-12,class:'stop-label label-hidden'});
      label.textContent=place.name.toUpperCase();
      const leader=svg('path',{class:'stop-leader','aria-hidden':'true'}),hit=svg('circle',{r:12,fill:'transparent'});group.append(leader,dot,hit,label);group._leader=leader;group._point=[x,y];group._label=label;$('route-stops').append(group);
      group.setAttribute('role','button');group.setAttribute('aria-label',`Go to ${place.name}, stop ${index+1}`);
      group.addEventListener('pointerdown',event=>{event.stopPropagation();closeSearch();});
      // A mouse click focuses the city without leaving a keyboard focus ring on its dot, and keys then act on the map.
      group.addEventListener('mousedown',event=>event.preventDefault());
      // A pointer goes to the visit that owns the label; assistive technology clicks reach the exact stop it names.
      group.addEventListener('click',event=>{if(event.detail||document.activeElement?.matches?.('input,textarea'))map.focus({preventScroll:true});jumpToCity(event.detail?labelOwner(event.target===hit?nearestStop(event,index):index):index);});
      // Return or Space on the city already in view sets sail from it (holding speeds up, as on the map).
      group.addEventListener('keydown',event=>{if(!['Enter',' '].includes(event.key))return;event.preventDefault();event.stopPropagation();if(event.repeat)return;if(focused===stops[index].id||running){held.set(event.key,performance.now());startTrace();}else jumpToCity(index);});
      // A keyboard user tabbing to a port out of view is shown it, at the zoom already chosen.
      group.addEventListener('focus',()=>{if(running)return;const [px,py]=group._point;if(px<view.x||px>view.x+view.w||py<view.y||py>view.y+view.h)animateView(RedlineTrace.pointFrame(group._point,cameraSpace(),baseView,baseView.w/view.w));});
      const li=document.createElement('li'),number=document.createElement('span'),name=document.createElement('span'),remove=document.createElement('button'),grip=document.createElement('button');
      li.dataset.index=String(index);grip.type='button';grip.className='stop-grip';grip.title='Go to city · Drag to reorder';grip.setAttribute('aria-label',`Go to ${place.name}, stop ${index+1}; drag to reorder`);grip.setAttribute('aria-keyshortcuts','Alt+ArrowLeft Alt+ArrowRight');
      number.className='stop-number';number.textContent=String(index+1).padStart(2,'0');name.textContent=place.name;
      remove.className='remove-stop';remove.textContent='×';remove.setAttribute('aria-label',`Remove ${place.name}, stop ${index+1}`);
      remove.addEventListener('click',event=>{if(event.detail)$('trip-panel').focus({preventScroll:true});checkpoint('remove city');stops.splice(index,1);drawRoute();persist();$('status').textContent='';});
      grip.append(number,name);li.append(grip,remove);$('stop-list').append(li);
      grip.addEventListener('click',event=>{if(event.detail){if(performance.now()<suppressStopClickUntil)return;map.focus({preventScroll:true});}jumpToCity(index);});
      grip.addEventListener('keydown',event=>{if(!event.altKey||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const to=index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1);if(to>=0&&to<stops.length){moveStop(index,to);$('stop-list').children[to].querySelector('.stop-grip').focus();}});
      grip.addEventListener('pointerdown',event=>startStopDrag(event,index,grip));
    });
    rebuildGeometry();
    for(const text of $('route-stops').querySelectorAll('.stop-label'))text._width=labelWidth(text);
    $('empty-hint').hidden=stops.length>0;$('stop-list').hidden=stops.length===0;
    $('play').disabled=stops.length<2;$('clear').disabled=stops.length===0;
    updateActiveStop();
    $('status').textContent='';
    if(hadRow){const rows=$('stop-list').children;(rows[Math.min(hadIndex,rows.length-1)]?.querySelector(hadPart)||$('trip-panel')).focus();}
    scheduleView();
  }
  // Label widths are measured once per name; 8.3 px a character is the fallback for 13 px lettering.
  function labelWidth(text){
    const name=text.textContent;
    if(!labelWidths.has(name)){let width=0;try{width=text.getComputedTextLength();}catch{}if(!(width>0))return RedlineLabels.estimate(name);labelWidths.set(name,width);}
    // Do not trust a transient font or layout measurement below that floor.
    // A short cached width lets long names overlap indefinitely.
    return Math.max(labelWidths.get(name),RedlineLabels.estimate(name));
  }
  function moveStop(from,to) {
    if(from===to)return;
    checkpoint('reorder cities');const [place]=stops.splice(from,1);stops.splice(to,0,place);drawRoute();persist();
    $('status').textContent='';
  }
  function startStopDrag(event,from,grip) {
    // On a touch screen a swipe along the list scrolls it; only the numeral picks a stop up.
    if(event.button!==0||event.pointerType==='touch'&&!event.target.closest('.stop-number'))return;
    const list=$('stop-list'),item=grip.closest('li'),box=grip.getBoundingClientRect(),startX=event.clientX,startY=event.clientY;
    let moved=false,to=from,preview=null;
    grip.setPointerCapture(event.pointerId);
    const cleanup=()=>{preview?.remove();item.classList.remove('dragging');document.body.classList.remove('reordering');[...list.children].forEach(el=>el.classList.remove('drop-target'));grip.removeEventListener('pointermove',onMove);grip.removeEventListener('pointerup',onUp);grip.removeEventListener('pointercancel',onCancel);grip.removeEventListener('lostpointercapture',onCancel);document.removeEventListener('keydown',onKey);if(grip.hasPointerCapture(event.pointerId))grip.releasePointerCapture(event.pointerId);};
    const onMove=e=>{
      if(e.pointerId!==event.pointerId||Math.hypot(e.clientX-startX,e.clientY-startY)<5&&!moved)return;
      if(!moved){moved=true;item.classList.add('dragging');document.body.classList.add('reordering');preview=document.createElement('div');preview.className='stop-drag-preview';preview.setAttribute('aria-hidden','true');preview.append(...[...grip.children].map(n=>n.cloneNode(true)));document.body.append(preview);}
      preview.style.transform=`translate3d(${e.clientX-(startX-box.left)}px,${e.clientY-(startY-box.top)}px,0) rotate(-2deg)`;
      const listBox=list.getBoundingClientRect();if(e.clientY<listBox.top+16)list.scrollTop-=12;else if(e.clientY>listBox.bottom-16)list.scrollTop+=12;
      const hit=document.elementFromPoint(e.clientX,e.clientY)?.closest('#stop-list li');
      if(hit){to=Number(hit.dataset.index);[...list.children].forEach(el=>el.classList.toggle('drop-target',el===hit&&to!==from));}
    };
    const onUp=e=>{if(e.pointerId!==event.pointerId)return;const box=list.getBoundingClientRect(),inside=e.clientX>=box.left-12&&e.clientX<=box.right+12&&e.clientY>=box.top-12&&e.clientY<=box.bottom+12;if(moved)suppressStopClickUntil=performance.now()+350;cleanup();if(moved&&inside)moveStop(from,to);};
    const onCancel=()=>cleanup(),onKey=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();cleanup();}};
    grip.addEventListener('pointermove',onMove);grip.addEventListener('pointerup',onUp);grip.addEventListener('pointercancel',onCancel);grip.addEventListener('lostpointercapture',onCancel);document.addEventListener('keydown',onKey);
  }
  function reachedCity(){
    activeStopId=progress===null?null:stops[Math.floor(progress+1e-7)]?.id||null;
    updateActiveStop();
  }
  function cameraSpace(){
    const bounds=map.getBoundingClientRect(),{width,height}=bounds,padding=Math.min(54,width*.09,height*.08);
    const dock=$('route-dock').getBoundingClientRect();
    const bottom=!document.body.classList.contains('map-only')&&dock.top>bounds.top+height*.25?Math.min(height-padding,dock.top-bounds.top-28):height-padding;
    return {width,height,left:padding,right:width-padding,top:padding,bottom:Math.max(padding+60,bottom)};
  }
  function cameraFor(leg,direction,zoom=traceZoom){
    return RedlineTrace.camera(geometry[leg],cameraSpace(),baseView,project(stops[direction>0?leg+1:leg]),zoom,geometry[leg-1],geometry[leg+1]);
  }
  function manualCamera(width){return {width,tracker:RedlineTrace.trackingCamera(view,cameraSpace(),baseView,MAX_ZOOM)};}
  function frameDistance(a,b){const space=cameraSpace();return Math.max(Math.abs(a.x-b.x)*space.width/b.w,Math.abs(a.y-b.y)*space.height/b.h,Math.abs(a.w-b.w)*space.width/b.w);}
  function beginLeg(target,direction,returnToOverview=false){
    const leg=direction>0?Math.floor(progress+1e-7):Math.ceil(progress-1e-7)-1;
    activeLeg={origin:direction>0?leg:leg+1,destination:direction>0?leg+1:leg};
    const autoCamera=cameraFor(leg,direction,null),defaultFrame=autoCamera.arrival;
    playback={leg,target,direction,returnToOverview,nominalWidth:defaultFrame.w,manual:traceZoom?manualCamera(baseView.w/traceZoom):null,from:progress-leg,to:direction>0?1:0,startView:{...view},camera:traceZoom?cameraFor(leg,direction):autoCamera,timeline:traceZoom?RedlineTrace.timeline({
      from:progress-leg,to:direction>0?1:0,duration:RedlineTrace.duration(geometry[leg].length),widthRatio:traceZoom?1:defaultFrame.w/view.w,easeStops:!traceZoom
    }):RedlineTrace.journey({geometry:geometry[leg],space:cameraSpace(),start:view,plan:autoCamera,from:progress-leg,to:direction>0?1:0})};
    atlasView.prefetch(playback.camera.arrival);
    paintProgress();
  }
  function runTo(target,{returnToOverview=false}={}){
    stopAnimation();if(!lines.length)return;
    if(progress===null)progress=0;
    target=Math.max(0,Math.min(lines.length,target));
    const direction=target>=progress?1:-1;
    reachedCity();paintProgress();scheduleView();
    if(Math.abs(progress-target)<1e-7){activeLeg=null;paintProgress();return;}
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){finishLeg(direction>0?target-1:target,direction);return;}
    beginLeg(target,direction,returnToOverview);setPlayState(true);lastTick=performance.now();
    let speed=1;
    function nextLeg(run){
      if(Math.abs(progress-run.target)<1e-7){if(run.returnToOverview)returnToWorld();else stopAnimation();return false;}
      beginLeg(run.target,run.direction,run.returnToOverview);return true;
    }
    function tick(now){
      const targetSpeed=[...held.values()].some(since=>now-since>=180)?2:1;
      const elapsed=lastTick===null?0:Math.max(0,Math.min(80,now-lastTick));lastTick=now;
      // Integrate the speed ramp over this frame so 60 and 120 Hz cover the same distance.
      const decay=Math.exp(-elapsed/110),travel=targetSpeed*elapsed+(speed-targetSpeed)*110*(1-decay);
      speed=targetSpeed+(speed-targetSpeed)*decay;
      const run=playback;
      if(run.settling){
        run.settling.elapsed+=travel;
        view=run.manual.tracker.step(project(stops[run.direction>0?run.leg+1:run.leg]),traceZoom,elapsed);
        const settled=frameDistance(view,run.camera.arrival)<.2||run.settling.elapsed>=620;
        if(settled)view={...run.camera.arrival};paintView();
        if(settled&&!nextLeg(run))return;
        animation=requestAnimationFrame(tick);return;
      }
      // Keep the visible drawing speed comfortable as the user moves closer.
      const pace=run.manual?Math.max(.45,Math.min(1,view.w/run.nominalWidth)):1;
      const state=run.timeline.advance(travel*pace);
      progress=run.leg+state.position;
      if(state.arrived)activeLeg=null;
      if(run.manual){
        const lead=run.direction*90*speed*pace/RedlineTrace.duration(geometry[run.leg].length);
        const position=Math.max(0,Math.min(1,state.position+lead));
        const point=geometry[run.leg].pointAt(position),here=geometry[run.leg].pointAt(state.position);
        if(run.tipX!==undefined&&Math.abs(here[0]-run.tipX)>WORLD_W/2)run.manual.tracker.jump(here);run.tipX=here[0];
        // Never anticipate a jump across the map's date-line seam.
        view=run.manual.tracker.step(Math.abs(point[0]-here[0])>WORLD_W/2?here:point,traceZoom,elapsed);
      }else view=RedlineTrace.cameraView(run.startView,run.camera,geometry[run.leg].pointAt(state.position),state.time);
      paintView();
      if(state.arrived){reachedCity();scheduleView();}
      if(state.done){
        if(run.manual)run.settling={elapsed:0};
        else if(!nextLeg(run))return;
      }
      animation=requestAnimationFrame(tick);
    }
    animation=requestAnimationFrame(tick);
  }
  function endGlide(){if(playback?.phase!=='overview')return false;stopAnimation();showWorld();view={...baseView};paintView();return true;}
  function startTrace(){
    endGlide();
    if(running||!lines.length)return;
    resumeFromFocus();
    if(progress===null||progress>=lines.length)progress=0;
    runTo(lines.length,{returnToOverview:true});
  }
  function trace(){if(endGlide())return;if(running)stopAnimation();else startTrace();}
  function reframeTrace(){if(running&&playback?.phase!=='overview'){const {target,returnToOverview}=playback;if(playback.settling){playback.camera=cameraFor(playback.leg,playback.direction);playback.manual=manualCamera(baseView.w/traceZoom);playback.settling={elapsed:0};}else runTo(target,{returnToOverview});}}
  function closeSearch() {
    clearTimeout(searchTimer);searchVersion++;controller?.abort();addingQuery='';$('destination-form').removeAttribute('aria-busy');$('suggestion-panel').hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');selected=-1;
  }
  function addStop(place) {
    if(stops.length>=100){$('status').textContent='This map holds up to 100 stops. Remove a stop to add another.';closeSearch();return;}
    const previous=stops.at(-1);
    if(previous&&Math.abs(previous.latitude-place.latitude)<.01&&Math.abs(previous.longitude-place.longitude)<.01){$('status').textContent='That is already your last stop.';closeSearch();return;}
    const {name,country='',admin1='',latitude,longitude}=place;
    checkpoint('add city');stops.push({name,country,admin1,latitude,longitude,id:place.id||crypto.randomUUID()});input.value='';closeSearch();drawRoute();persist();$('status').textContent='';input.focus();
  }
  function showResults(items,message='') {
    results=items;selected=-1;input.removeAttribute('aria-activedescendant');$('suggestions').replaceChildren();
    items.forEach((place,index)=>{
      const button=document.createElement('button'),name=document.createElement('strong'),detail=document.createElement('small');
      button.type='button';button.id=`result-${index}`;button.setAttribute('role','option');button.setAttribute('aria-selected','false');button.tabIndex=-1;
      name.textContent=place.name;detail.textContent=[place.admin1,place.country].filter(Boolean).join(', ');
      button.append(name,detail);button.addEventListener('click',()=>addStop(place));button.addEventListener('mousedown',event=>event.preventDefault());$('suggestions').append(button);
    });
    $('search-message').textContent=message;$('suggestion-panel').hidden=false;input.setAttribute('aria-expanded','true');
  }
  function localResults(query) {
    // Indexed cities come first so duplicates keep their population for ranking.
    const q=normalize(query),pool=[...window.MAP_CITIES,...places],seen=new Set();
    return pool.filter(p=>{const key=`${normalize(p.name)}:${Math.round(p.latitude*10)}:${Math.round(p.longitude*10)}`;if(seen.has(key))return false;seen.add(key);return normalize(p.name).includes(q)||normalize(`${p.name}, ${p.country}`).includes(q);}).sort(byRelevance(query)).slice(0,7);
  }
  async function search(query,version,autoAdd=false) {
    controller?.abort();controller=new AbortController();const currentController=controller;
    const timeout=setTimeout(()=>currentController.abort(),9000);
    try {
      const response=await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=7&language=en&format=json`,{signal:currentController.signal});
      if(!response.ok)throw new Error('Search unavailable');
      const data=await response.json();if(version!==searchVersion)return;
      const items=(data.results||[]).filter(p=>Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)).map(p=>({...city(p.name,p.country||'',p.latitude,p.longitude,p.admin1||''),population:p.population||0}));
      const combined=[...items];
      for(const p of localResults(query))if(!combined.some(i=>Math.abs(i.latitude-p.latitude)<.15&&Math.abs(i.longitude-p.longitude)<.15))combined.push(p);
      combined.sort(byRelevance(query));
      resultsQuery=query;resultsReady=true;addingQuery='';$('destination-form').removeAttribute('aria-busy');
      if(autoAdd&&combined.length){addStop(combined[0]);return;}
      showResults(combined.slice(0,7),combined.length?'':'No places found. Try the city name without a country or region.');
    } catch {
      if(version!==searchVersion)return;
      const local=localResults(query);
      resultsQuery=query;resultsReady=true;addingQuery='';$('destination-form').removeAttribute('aria-busy');
      if(autoAdd&&local.length){addStop(local[0]);return;}
      showResults(local,local.length?'Live search is unavailable. These saved places are still available.':'Couldn’t reach destination search. Check your connection and try again.');
    } finally {clearTimeout(timeout);}
  }
  function scheduleSearch(immediate=false) {
    clearTimeout(searchTimer);controller?.abort();addingQuery='';$('destination-form').removeAttribute('aria-busy');const version=++searchVersion,query=input.value.trim();resultsQuery=query;resultsReady=false;
    if(query.length<2){showResults([],'Type at least two letters of a city name.');return;}
    showResults(localResults(query),'Searching places…');
    searchTimer=setTimeout(()=>search(query,version),immediate?0:350);
  }
  input.addEventListener('input',()=>scheduleSearch());
  input.addEventListener('keydown',event=>{
    if(event.key==='Escape'){if(!$('suggestion-panel').hidden)event.preventDefault();closeSearch();return;}
    if((event.key==='ArrowDown'||event.key==='ArrowUp')&&results.length&&!$('suggestion-panel').hidden){
      event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:-1)+results.length)%results.length;
      [...$('suggestions').children].forEach((el,i)=>el.setAttribute('aria-selected',String(i===selected)));
      input.setAttribute('aria-activedescendant',`result-${selected}`);$('suggestions').children[selected].scrollIntoView({block:'nearest'});
    }
  });
  $('destination-form').addEventListener('submit',event=>{
    event.preventDefault();
    if(event.isComposing)return;
    const query=input.value.trim();
    if(query.length<2){scheduleSearch(true);return;}
    if(addingQuery===query)return;
    if(selected>=0&&!$('suggestion-panel').hidden){addStop(results[selected]);return;}
    if(resultsQuery===query&&resultsReady&&results.length){addStop(results[0]);return;}
    clearTimeout(searchTimer);controller?.abort();const version=++searchVersion;addingQuery=query;
    $('destination-form').setAttribute('aria-busy','true');showResults(localResults(query),'Finding and adding your destination…');
    search(query,version,true);
  });
  document.addEventListener('pointerdown',event=>{if(!$('destination-form').contains(event.target)&&!$('suggestion-panel').contains(event.target))closeSearch();});
  $('play').addEventListener('click',trace);
  $('clear').addEventListener('click',()=>{if(!stops.length)return;checkpoint('clear route');stops=[];drawRoute();persist();input.value='';closeSearch();$('undo-route').focus({preventScroll:true});});
  // The chart's great names, in sheet coordinates: where a hand would letter them on an empty map.
  const GREAT_NAMES=[['continent','North America',318,150,-3,.04],['continent','South\nAmerica',495,414,0,0],['continent','Europe',790,146,0,0],['continent','Africa',800,330,0,0],['continent','Asia',1092,172,0,0],['continent','Australia',1250,472,0,0],['ocean','Pacific Ocean',164,330,-6,.12],['ocean','Atlantic\nOcean',602,280,0,0],['ocean','Indian Ocean',1000,412,8,-.08],['ocean','Southern Ocean',1185,640,0,.04],['ocean','Arctic Ocean',1120,30,0,0]];
  // Keep ocean names in their own water even when a narrow window makes
  // screen-sized lettering much wider than its geographic anchor.
  const OCEAN_BOUNDS={
    'Pacific Ocean':[32,265,302,420], 'Atlantic\nOcean':[540,220,666,352],
    'Indian Ocean':[919,382,1117,498], 'Southern Ocean':[1025,602,1370,666],
    'Arctic Ocean':[865,7,1370,55]
  };
  // Every other name appears as you come close enough to read it, and leaves once it spans the window.
  const nameZoom={1:1.5,2:2.4,3:4,4:6.5};
  const chartName=(kind,text,x,y,from,{angle=0,curve=0,until=Infinity,spread=0,roam=0,city=-1}={})=>({kind,text,x,y,from,angle,curve,until,spread,roam,city,print:null,era:-1,shown:-2,dx:0,dy:0,lost:-Infinity,lostZoom:1});
  // Best first: continents and oceans, then countries, then the rest. Where a name of a large place meets the line or a port it can move over a little, up to two of its roam each way.
  const chartNames=[
    GREAT_NAMES.map(([kind,name,x,y,angle,curve])=>chartName(kind,name,x,y,0,{angle,curve,until:1.6,roam:kind==='ocean'?8:18})),
    window.MAP_COUNTRIES.map(p=>chartName('country',p.name,p.x,p.y,Math.max(1.3,1.25+Math.max(0,p.rank-2)*.42),{roam:9})),
    (window.ATLAS_NAMES||[]).map(name=>chartName(name.kind,name.name,name.x,name.y,nameZoom[name.rank]||9,{angle:name.kind==='land'||name.kind==='desert'?0:name.angle,spread:name.spread,roam:name.rank<=2?9:0})),
    window.MAP_CITIES.map((p,i)=>chartName(p.capital?'capital':'city',p.name,...backgroundPoints[i],p.population>=8000000?1.8:(p.capital||p.population>=2000000)?2.5:p.population>=500000?3.8:p.population>=100000?4.5:5.3,{city:i}))
  ];
  const NUDGES=[[0,0],[0,-1],[0,1],[1,0],[-1,0],[1,-1],[-1,-1],[1,1],[-1,1],[0,-2],[0,2],[2,0],[-2,0],[2,-1],[-2,-1],[2,1],[-2,1],[1,-2],[-1,-2],[1,2],[-1,2]],AT_HOME=[[0,0]];
  // Where the chart's title goes, on the sheet, in order. Each is open water as far east as its limit, and a small window's plate is too wide for the Pacific.
  const PLATE_SPOTS=[[208,574,470],[208,556,470],[208,538,470],[208,520,470],[200,480,470],[200,440,470],[200,410,470],[200,380,470],[930,574,1410],[930,552,1410],[930,530,1410]];
  // The air around a new name, which sets how full the chart looks. It is measured from the ink.
  const NAME_GAP=9,NAME_REST=700,STOP_REST=350;
  let plateSpot=-1,layoutRound=0,restFrom=-Infinity,namesResting=false,restTimer=0;
  // Places name-by-name into the shared grid, after the route's own names and with the same fixtures in it. A name lettered last time keeps its place on a slacker rule than a new arrival's, so nothing flickers on the line between fitting and not.
  function renderLabels(matrix,bounds,grid,routes) {
    const width=bounds.width,height=bounds.height,labels=[],round=++layoutRound,now=performance.now(),a=matrix.a,d=matrix.d,e=matrix.e-bounds.left,f=matrix.f-bounds.top,probe={x:0,y:0,w:0,h:0},reach=Math.max(.6,Math.min(1,width/1440));
    function clear(print,sx,sy,margin,gap,pad){
      if(sx+print.left<margin||sx+print.right>width-margin||sy+print.top<margin||sy+print.bottom>height-margin)return false;
      for(const b of print.boxes){
        probe.x=sx+b.x;probe.y=sy+b.y;probe.w=b.w;probe.h=b.h;
        if(grid.hits(probe.x,probe.y,b.w,b.h,gap)||routes.hits(probe,pad))return false;
      }
      return true;
    }
    function letter(name,sx,sy,print){
      for(const b of print.boxes)grid.add({x:sx+b.x,y:sy+b.y,w:b.w,h:b.h});
      labels.push({kind:name.kind,text:name.text,x:sx,y:sy,angle:name.angle,curve:name.curve});name.shown=round;
    }
    function tryName(name,keeping){
      if(zoomLevel<name.from*(keeping?.97:1)||zoomLevel>=name.until*(keeping?1.03:1)||name.spread*a>width*(keeping?.96:.9)||name.city>=0&&hiddenMapCities.has(name.city))return;
      const sx=name.x*a+e,sy=name.y*d+f;
      if(sx<-500||sx>width+500||sy<-300||sy>height+300)return;
      if(name.era!==atlasView.era){name.print=atlasView.footprint(name.kind,name.text,name.angle,name.curve);name.era=atlasView.era;}
      const print=name.print;
      const region=OCEAN_BOUNDS[name.text],fits=(x,y)=>!region||x+print.left>=region[0]*a+e&&x+print.right<=region[2]*a+e&&y+print.top>=region[1]*d+f&&y+print.bottom<=region[3]*d+f;
      if(keeping&&fits(sx+name.dx,sy+name.dy)&&clear(print,sx+name.dx,sy+name.dy,3,4,3)){letter(name,sx+name.dx,sy+name.dy,print);return;}
      // One just crowded out stays out for a moment and a little zoom, because what crowded it may itself be about to go, and back and forth is flickering.
      if(!keeping&&name.lost>=restFrom&&now-name.lost<NAME_REST&&Math.abs(Math.log(zoomLevel/name.lostZoom))<.7){namesResting=true;return;}
      const unit=name.roam*reach;
      for(const [i,j] of unit?NUDGES:AT_HOME){
        const dx=i*unit,dy=j*unit;
        if(fits(sx+dx,sy+dy)&&clear(print,sx+dx,sy+dy,8,NAME_GAP,4)){name.dx=dx;name.dy=dy;letter(name,sx+dx,sy+dy,print);return;}
      }
      if(keeping){name.lost=now;name.lostZoom=zoomLevel;}
    }
    // The title piece keeps out of the way of the route and the dock, in the empty far south. Only the whole world's scale has room for it.
    if(zoomLevel<(plateSpot>=0?1.648:1.6)){
      const title=$('trip-title').textContent.trim()||'The Known World',size=atlasView.measure('cartouche',title,'A chart of'),print={left:-size.w/2,top:-size.h/2,right:size.w/2,bottom:size.h/2,boxes:[{x:-size.w/2,y:-size.h/2,w:size.w,h:size.h}]};
      const at=([x,y])=>[Math.min(width-10-size.w/2,Math.max(14+size.w/2,x*a+e)),y*d+f],spots=plateSpot>=0?[plateSpot,...PLATE_SPOTS.keys()]:PLATE_SPOTS.keys();let chosen=-1;
      for(const i of spots){
        const [cx,cy]=at(PLATE_SPOTS[i]);
        // In sheet units, because the sheet stretches to the window.
        if((cx+size.w/2-e)/a>PLATE_SPOTS[i][2])continue;
        if(i===plateSpot?clear(print,cx,cy,4,3,3):clear(print,cx,cy,10,6,4)){chosen=i;grid.add({x:cx-size.w/2,y:cy-size.h/2,w:size.w,h:size.h});labels.push({kind:'cartouche',text:title,kicker:'A chart of',x:cx,y:cy});break;}
      }
      plateSpot=chosen;
    }else plateSpot=-1;
    // Continents and oceans always have first call. Then names already lettered claim their places before any new arrival, best first, so one change does not cascade through the crowd as the camera moves.
    const sweep=(tiers,keeping)=>{for(const tier of tiers)for(let i=0;i<tier.length&&labels.length<130;i++){
      const name=tier[i];
      if((name.shown===round-1)===keeping&&name.shown!==round)tryName(name,keeping);
    }};
    const great=chartNames.slice(0,1),others=chartNames.slice(1);
    sweep(great,true);sweep(great,false);sweep(others,true);sweep(others,false);
    return labels;
  }
  function constrainView(frame){
    const {w,h}=frame;
    return {...frame,x:w>=WORLD_W?(WORLD_W-w)/2:Math.max(0,Math.min(WORLD_W-w,frame.x)),y:h>=WORLD_H?(WORLD_H-h)/2:Math.max(0,Math.min(WORLD_H-h,frame.y))};
  }
  function paintView() {
    if(viewFrame)cancelAnimationFrame(viewFrame);viewFrame=0;
    view=constrainView(view);
    // A full-screen album owns the frame budget. Playback still advances its
    // model; reveal its current position when the album is dismissed.
    if(mapOccluded)return;
    const bounds=map.getBoundingClientRect();if(!bounds.width||!bounds.height)return;viewportBounds=bounds;
    const matrix=mapMatrix(bounds);
    routeMatrix={a:matrix.a,d:matrix.d,e:matrix.e-bounds.left,f:matrix.f-bounds.top};
    routeMatrixKey=[routeMatrix.a,routeMatrix.d,routeMatrix.e,routeMatrix.f].join(',');
    // All geometry reads precede writes, so a camera frame never forces layout.
    const local=(el,pad)=>{const r=el.getBoundingClientRect();return {x:r.left-bounds.left-pad,y:r.top-bounds.top-pad,w:r.width+pad*2,h:r.height+pad*2};};
    const controls=!document.body.classList.contains('map-only'),dock=controls?local($('route-dock'),8):null,obstacles=[];
    if(controls){obstacles.push({x:dock.x+4,y:dock.y+4,w:dock.w-8,h:dock.h-8});if(zoomControls)obstacles.push(local(zoomControls,4));if(!$('trip-panel').hidden)obstacles.push(local($('trip-panel'),8));}
    // Route geometry stays in map coordinates. Camera motion transforms only
    // each queried label box instead of re-projecting and re-indexing every arc.
    const amounts=geometry.map((leg,i)=>progress===null||activeLeg&&Math.min(activeLeg.origin,activeLeg.destination)===i?1:Math.max(0,Math.min(1,progress-i)));
    const key=amounts.join(',');
    const layout=JSON.stringify([view,bounds.width,bounds.height,bounds.left,bounds.top,obstacles,key,activeStopId,stops.map((_,i)=>stopShown(i))]);
    if(layout===lastLayout&&lastLayoutGeometry===geometry){paintProgress();return;}
    lastLayout=layout;lastLayoutGeometry=geometry;
    // A camera that jumped, rather than moved, owes nothing to where names were.
    if(Math.abs(Math.log(view.w/lastLaidView.w))>.3||Math.abs(view.x-lastLaidView.x)>view.w*.5||Math.abs(view.y-lastLaidView.y)>view.h*.5){labelSlots.clear();layoutRound+=2;restFrom=performance.now();}
    lastLaidView={...view};
    zoomLevel=baseView.w/view.w;
    $('zoom-in').disabled=zoomLevel>=MAX_ZOOM-.001;$('zoom-out').disabled=zoomLevel<=1.001;
    map.classList.toggle('zoomed-out',zoomLevel<=1.001);
    // Names keep off the whole route from the start, drawn or not, so nothing has to leave as the ink reaches it, and the index need only be built once.
    if(routeIndexGeometry!==geometry){
      routeIndex=RedlineLabels.indexLines(geometry.flatMap(leg=>leg.segmentsAt(1)),{width:WORLD_W,height:WORLD_H});
      routeIndexGeometry=geometry;layoutRound+=2;restFrom=performance.now();
    }
    const routes=RedlineLabels.projectIndex(routeIndex,matrix,bounds);
    if(!nameGrid?.fits(bounds.width,bounds.height))nameGrid=RedlineLabels.occupancy(bounds.width,bounds.height);
    nameGrid.clear();namesResting=false;
    paintStops(matrix,bounds,obstacles,routes,nameGrid);
    // Map and lettering land in the same frame as the route above them.
    atlasView.update(view,renderLabels(matrix,bounds,nameGrid,routes));paintProgress();
    // A camera at rest lays nothing out, so a name resting must be asked for when its rest is over.
    if(namesResting&&!restTimer)restTimer=setTimeout(()=>{restTimer=0;lastLayout='';scheduleView();},NAME_REST);
  }
  function paintStops(matrix,bounds,obstacles,routes,grid){
    const items=[],texts=[],now=performance.now();
    [...$('route-stops').children].forEach((group,index)=>{
      const [x,y]=group._point,text=group._label;
      // The overlay uses CSS pixels. Camera jumps move a pin without ever
      // scaling its radius, including the first frame that reveals a stop.
      const sx=x*matrix.a+matrix.e-bounds.left,sy=y*matrix.d+matrix.f-bounds.top;
      changed(group,'transform',`translate(${sx} ${sy})`);
      if(group.hasAttribute('visibility'))group.removeAttribute('visibility');
      // A name goes with its dot: one out of the window has no name in it, and stops well off screen cost nothing.
      const off=sx<-300||sx>bounds.width+300||sy<-300||sy>bounds.height+300,outside=sx<-6||sx>bounds.width+6||sy<-6||sy>bounds.height+6;
      if(off||outside){if(group._leader.hasAttribute('d'))group._leader.removeAttribute('d');if(!text.classList.contains('label-hidden'))text.classList.add('label-hidden');if(!off)grid.add({x:sx-4.5,y:sy-4.5,w:9,h:9});return;}
      // Stops the trace has yet to reach hold their places unseen, so nothing has to move when they arrive. A city visited twice remembers one place.
      if(labelOwner(index)!==index){if(group._leader.hasAttribute('d'))group._leader.removeAttribute('d');if(!text.classList.contains('label-hidden'))text.classList.add('label-hidden');grid.add({x:sx-4.5,y:sy-4.5,w:9,h:9});return;}
      const id=stops[stopPeers[index]?.[0]??index].id;
      const active=stops[index].id===activeStopId,rest=!active&&text._lost>=restFrom&&now-text._lost<STOP_REST;namesResting||=rest;
      items.push({id,x:sx,y:sy,width:text._width??text.textContent.length*8.3,height:15,priority:active?-1:index,unseen:!stopShown(index),rest});texts.push(text);
    });
    const placed=RedlineLabels.place(items,{width:bounds.width,height:bounds.height,obstacles,previous:labelSlots,clusterDistance:2.5,gap:6,routes,grid});
    labelSlots.clear();
    placed.forEach((slot,i)=>{
      const text=texts[i],leader=text.parentNode._leader;
      if(slot?.leader){const [[x,y],[tx,ty]]=slot.leader;changed(leader,'d',`M0,0L${(tx-x).toFixed(1)},${(ty-y).toFixed(1)}`);}
      else if(leader.hasAttribute('d'))leader.removeAttribute('d');
      const hidden=text.classList.contains('label-hidden');
      // Crowded out just now, it rests as an atlas name does, and does not flicker back.
      if(!slot&&!hidden&&stopShown(+text.parentNode.dataset.index))text._lost=now;
      if(hidden===!!slot)text.classList.toggle('label-hidden',!slot);if(!slot)return;
      labelSlots.set(items[i].id,slot.name);
      if(text._slot!==slot.name){text._slot=slot.name;text.setAttribute('x',slot.x);text.setAttribute('y',slot.y);text.setAttribute('text-anchor',slot.anchor);}
    });
  }
  function scheduleView(){if(!viewFrame)viewFrame=requestAnimationFrame(paintView);}
  let resizeTimer=0;
  function resizeMap(){
    const bounds=map.getBoundingClientRect();if(!bounds.width||!bounds.height)return;viewportBounds=bounds;
    // Fill the viewport with the original full-width map and flush poles.
    const w=WORLD_W,h=WORLD_H;
    const previousZoom=baseView.w/view.w,centerX=view.x+view.w/2,centerY=view.y+view.h/2;
    baseView={x:0,y:0,w,h};
    view=previousZoom<=1.001?{...baseView}:{x:centerX-w/previousZoom/2,y:centerY-h/previousZoom/2,w:w/previousZoom,h:h/previousZoom};
    // A dragged window edge must not restart the leg, and its ease-in, every frame.
    // Tiles are layers now rather than a stretched canvas, so even a map behind the album must refit or it leaves a bare band.
    const occluded=mapOccluded;mapOccluded=false;paintView();mapOccluded=occluded;clearTimeout(resizeTimer);resizeTimer=setTimeout(reframeTrace,150);
  }
  function zoom(factor,clientX,clientY) {
    // A drag's origin is stale once the scale changes; carrying on from it would throw the map across the sheet.
    if(drag){drag=null;map.classList.remove('dragging');}
    if(running&&playback?.phase!=='overview'){
      const run=playback,width=Math.max(baseView.w/MAX_ZOOM,Math.min(baseView.w,(run.manual?.width||view.w)*factor));
      traceZoom=baseView.w/width;run.camera=cameraFor(run.leg,run.direction);
      if(run.manual)run.manual.width=width;else run.manual=manualCamera(width);
      // A hand on the wheel at a port moves the camera now, not when the port's moment is over.
      if(run.settling||run.dwell>0)run.settling={elapsed:0};
      return;
    }
    if(playback?.phase==='overview'){stopAnimation();showWorld();}
    const matrix=mapMatrix(viewportBounds||map.getBoundingClientRect()),rx=clientX===undefined ? .5 : Math.max(0,Math.min(1,((clientX-matrix.e)/matrix.a-view.x)/view.w)),ry=clientY===undefined ? .5 : Math.max(0,Math.min(1,((clientY-matrix.f)/matrix.d-view.y)/view.h));
    const width=Math.max(baseView.w/MAX_ZOOM,Math.min(baseView.w,(idleZoom?.width||view.w)*factor));
    // A zoom chosen at rest carries into the next trace. Back out to the whole world, it hands over to the automatic camera again.
    if(width!==(idleZoom?.width||view.w))traceZoom=progress===null&&focused===null&&width>=baseView.w?null:baseView.w/width;
    const anchor={x:view.x+view.w*rx,y:view.y+view.h*ry,rx,ry};
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){stopAnimation();const height=width*baseView.h/baseView.w;view={x:anchor.x-rx*width,y:anchor.y-ry*height,w:width,h:height};paintView();return;}
    if(idleZoom){Object.assign(idleZoom,{width,anchor});return;}
    stopAnimation();cancelAnimationFrame(viewFrame);viewFrame=0;
    idleZoom={width,anchor,zoom:{value:Math.log(baseView.w/view.w),velocity:0},last:performance.now()};
    const tick=now=>{
      const motion=idleZoom,elapsed=Math.min(80,Math.max(0,now-motion.last));motion.last=now;
      motion.zoom=RedlineTrace.spring(motion.zoom,Math.log(baseView.w/motion.width),elapsed/1000,32);
      const level=Math.max(1,Math.min(MAX_ZOOM,Math.exp(motion.zoom.value))),w=baseView.w/level,h=w*baseView.h/baseView.w;
      view={x:motion.anchor.x-motion.anchor.rx*w,y:motion.anchor.y-motion.anchor.ry*h,w,h};
      if(Math.abs(w-motion.width)*(viewportBounds?.width||1440)/w<1){const h=motion.width*baseView.h/baseView.w;view={x:motion.anchor.x-motion.anchor.rx*motion.width,y:motion.anchor.y-motion.anchor.ry*h,w:motion.width,h};idleZoom=null;animation=0;paintView();return;}
      paintView();animation=requestAnimationFrame(tick);
    };
    animation=requestAnimationFrame(tick);
  }
  $('zoom-in').addEventListener('click',()=>zoom(.6));$('zoom-out').addEventListener('click',()=>zoom(1/.6));
  $('reset-view').addEventListener('click',()=>showOverview());
  $('map-shell').addEventListener('wheel',event=>{event.preventDefault();if(!event.deltaY)return;const units=event.deltaMode===1?33:event.deltaMode===2?(viewportBounds||map.getBoundingClientRect()).height:1;const delta=Math.max(-160,Math.min(160,event.deltaY*units));zoom(Math.exp(delta*(event.ctrlKey?.012:.0034)),event.clientX,event.clientY);},{passive:false});
  let drag=null,glide=0,pinchDistance=0;
  const touches=new Map();
  function stopGlide(){if(glide){cancelAnimationFrame(glide);glide=0;}}
  // A flicked map coasts briefly to a stop, as paper does on a table.
  function coast(vx,vy){
    let last=performance.now();stopGlide();
    const step=now=>{
      const dt=Math.min(40,now-last);last=now;const decay=Math.exp(-dt/170);vx*=decay;vy*=decay;
      if(Math.hypot(vx,vy)<.02){glide=0;return;}
      view={...view,x:view.x-vx*dt*view.w/(viewportBounds?.width||1),y:view.y-vy*dt*view.h/(viewportBounds?.height||1)};paintView();glide=requestAnimationFrame(step);
    };
    glide=requestAnimationFrame(step);
  }
  map.addEventListener('pointerdown',event=>{
    stopGlide();
    if(event.pointerType==='touch'){
      touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if(touches.size===2){drag=null;map.classList.remove('dragging');const [a,b]=[...touches.values()];pinchDistance=Math.hypot(a.x-b.x,a.y-b.y);map.setPointerCapture(event.pointerId);return;}
    }
    if(event.button!==0||baseView.w/view.w<=1.001)return;const m=mapMatrix(viewportBounds||map.getBoundingClientRect());drag={x:event.clientX,y:event.clientY,vx:view.x,vy:view.y,scaleX:m.a,scaleY:m.d,id:event.pointerId,lastX:event.clientX,lastY:event.clientY,lastT:event.timeStamp,speedX:0,speedY:0};map.setPointerCapture(event.pointerId);map.classList.add('dragging');
  });
  map.addEventListener('pointermove',event=>{
    if(touches.has(event.pointerId)){
      touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
      if(touches.size===2){
        const [a,b]=[...touches.values()],distance=Math.hypot(a.x-b.x,a.y-b.y);
        if(pinchDistance&&distance)zoom(pinchDistance/distance,(a.x+b.x)/2,(a.y+b.y)/2);
        pinchDistance=distance;return;
      }
    }
    if(!drag||event.pointerId!==drag.id||baseView.w/view.w<=1.001)return;
    // A press alone leaves the voyage sailing; only a real drag takes the camera, from wherever it has got to.
    if(!drag.moving){
      if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<4)return;
      if(playback?.phase==='overview')showWorld();
      stopAnimation();const m=mapMatrix(viewportBounds||map.getBoundingClientRect());Object.assign(drag,{moving:true,vx:view.x,vy:view.y,scaleX:m.a,scaleY:m.d});
    }
    const dt=Math.max(1,event.timeStamp-drag.lastT);drag.speedX=.7*(event.clientX-drag.lastX)/dt+.3*drag.speedX;drag.speedY=.7*(event.clientY-drag.lastY)/dt+.3*drag.speedY;drag.lastX=event.clientX;drag.lastY=event.clientY;drag.lastT=event.timeStamp;
    view.x=drag.vx-(event.clientX-drag.x)/drag.scaleX;view.y=drag.vy-(event.clientY-drag.y)/drag.scaleY;scheduleView();
  });
  const endDrag=event=>{
    touches.delete(event.pointerId);if(touches.size<2)pinchDistance=0;
    if(drag&&event.type==='pointerup'&&event.timeStamp-drag.lastT<60&&Math.hypot(drag.speedX,drag.speedY)>.25&&!matchMedia('(prefers-reduced-motion: reduce)').matches)coast(drag.speedX,drag.speedY);
    drag=null;map.classList.remove('dragging');
  };
  map.addEventListener('pointerup',endDrag);map.addEventListener('pointercancel',endDrag);map.addEventListener('lostpointercapture',endDrag);
  // Safari reports a trackpad pinch as gesture events rather than a control-wheel.
  let gestureScale=1;
  $('map-shell').addEventListener('gesturestart',event=>{event.preventDefault();gestureScale=1;});
  // iOS fires these alongside the touch pointers, which have the pinch already.
  $('map-shell').addEventListener('gesturechange',event=>{event.preventDefault();if(!touches.size)zoom(gestureScale/event.scale,event.clientX,event.clientY);gestureScale=event.scale;});
  $('map-shell').addEventListener('gestureend',event=>event.preventDefault());
  function updateActiveStop(){
    const step=activeStopId?stops.findIndex(p=>p.id===activeStopId)+1:0;
    map.dataset.tripStep=String(Math.max(0,step));
    $('previous-city').disabled=stops.length===0;$('next-city').disabled=stops.length===0;
    const previousLabel=step===0&&stops.length?'Last city':step===1?'Whole trip':'Previous city';
    $('previous-city').setAttribute('aria-label',previousLabel);$('previous-city').title=previousLabel;
    const nextLabel=step===stops.length&&stops.length?'Whole trip':'Next city';
    $('next-city').setAttribute('aria-label',nextLabel);$('next-city').title=nextLabel;
    [...$('stop-list').children].forEach((node,i)=>{const grip=node.querySelector('.stop-grip');if(step===i+1)grip.setAttribute('aria-current','step');else grip.removeAttribute('aria-current');});
  }
  // van Wijk & Nuij optimal zoom-and-pan: share u of the centre line and width w at path parameter t.
  function smoothZoom([x0,y0,w0],[x1,y1,w1],rho=Math.SQRT2){
    const d=Math.hypot(x1-x0,y1-y0),r2=rho*rho;
    if(d<1e-6*Math.max(w0,w1)){const S=Math.log(w1/w0)/rho;return {S,peak:Math.max(w0,w1),at:t=>[t,w0*Math.exp(rho*t*S)]};}
    const r0=-Math.asinh((w1*w1-w0*w0+r2*r2*d*d)/(2*w0*r2*d)),r1=-Math.asinh((w1*w1-w0*w0-r2*r2*d*d)/(2*w1*r2*d)),S=(r1-r0)/rho,c=Math.cosh(r0),s=Math.sinh(r0);
    return {S,peak:r0<0&&r1>0?w0*c:Math.max(w0,w1),at:t=>{const a=rho*t*S+r0;return [w0/(r2*d)*(c*Math.tanh(a)-s),w0*c/Math.cosh(a)];}};
  }
  function zoomPath(from,to){
    // Measure in screen pixels so both axes share one scale despite the stretched sheet.
    const {width,height}=map.getBoundingClientRect(),size=Math.max(1,width,height),ax=width/WORLD_W,ay=height/WORLD_H;
    const point=f=>[(f.x+f.w/2)*ax,(f.y+f.h/2)*ay,size*f.w/WORLD_W],a=point(from),b=point(to);
    let curve=smoothZoom(a,b);const length=Math.abs(curve.S);
    // A long hop between close views would back out past the whole world; flatten the arc instead.
    if(curve.peak>size){let low=.05,high=Math.SQRT2;for(let i=0;i<20;i++){const mid=(low+high)/2;if(smoothZoom(a,b,mid).peak>size)high=mid;else low=mid;}curve=smoothZoom(a,b,low);}
    // Interpolate each frame's share of the free margin, so no frame is clamped against the sheet's edge.
    const share=(f,key,span)=>span>1e-3?f[key]/span:null,fx=[share(from,'x',WORLD_W-from.w),share(to,'x',WORLD_W-to.w)],fy=[share(from,'y',WORLD_H-from.h),share(to,'y',WORLD_H-to.h)];
    for(const f of [fx,fy]){f[0]??=f[1]??.5;f[1]??=f[0];}
    return {length,duration:Math.max(300,Math.min(820,220+length*280)),at:t=>{
      const [u,s]=curve.at(t),w=Math.min(WORLD_W,WORLD_W*s/size),h=w*WORLD_H/WORLD_W;
      return {x:(fx[0]+u*(fx[1]-fx[0]))*(WORLD_W-w),y:(fy[0]+u*(fy[1]-fy[0]))*(WORLD_H-h),w,h};
    }};
  }
  function showWorld(){progress=null;activeLeg=null;activeStopId=null;traceZoom=null;focused=null;updateActiveStop();}
  function animateView(target,{overview=false,home=false,hold=0,speed=1}={}){
    stopAnimation();cancelAnimationFrame(viewFrame);viewFrame=0;
    const finish=()=>{stopAnimation();view={...target};if(overview)showWorld();paintView();};
    const path=zoomPath(constrainView(view),target);atlasView.prefetch(target);
    if(matchMedia('(prefers-reduced-motion: reduce)').matches||path.length<1e-4){finish();return;}
    // Arrow keys during an overview move finish it instantly.
    if(overview)playback={phase:'overview'};
    const duration=(home?Math.max(path.duration,RedlineTrace.zoomDuration(target.w/view.w)):path.duration)/speed;
    const began=performance.now();
    const tick=now=>{
      const amount=Math.max(0,Math.min(1,(now-began-hold)/duration));
      view=path.at(RedlineTrace.ease(amount));paintView();
      if(amount===1){finish();return;}animation=requestAnimationFrame(tick);
    };
    animation=requestAnimationFrame(tick);
  }
  function returnToWorld(){animateView({...baseView},{overview:true,home:true,hold:held.size?0:320,speed:held.size?2:1});if(playback)setPlayState(true);}
  // Backspace, Home, and the globe: the complete route, with the camera easing back to the world.
  function showOverview(speed=1){stopAnimation();showWorld();paintProgress();animateView({...baseView},{overview:true,speed});}
  // A clicked city is seen within the whole drawn trip; the arrows or play then continue from it.
  function jumpToCity(index){
    if(!stops[index])return;
    const level=Math.max(3,baseView.w/view.w);
    stopAnimation();if(traceZoom)traceZoom=level;progress=null;activeLeg=null;activeStopId=stops[index].id;focused=stops[index].id;updateActiveStop();paintProgress();
    animateView(RedlineTrace.pointFrame(project(stops[index]),cameraSpace(),baseView,level));
  }
  function resumeFromFocus(){
    if(focused===null||running)return false;
    const index=stops.findIndex(p=>p.id===focused);focused=null;if(index<0)return false;
    progress=index;activeLeg=null;reachedCity();paintProgress();return true;
  }
  function goToStep(step){
    step=Math.max(0,Math.min(stops.length,step));
    if(!step){stopAnimation();showWorld();view={...baseView};paintView();return;}
    const to=step-1;
    if(progress===null)progress=0;
    runTo(to);
    if(!lines.length){activeStopId=stops[0]?.id||null;updateActiveStop();paintProgress();}
  }
  function finishLeg(leg,direction){
    const arrival=playback?.leg===leg&&playback.direction===direction?playback.camera.arrival:cameraFor(leg,direction).arrival;
    stopAnimation();cancelAnimationFrame(viewFrame);viewFrame=0;
    progress=direction>0?leg+1:leg;activeLeg=null;reachedCity();
    view={...arrival};paintView();
  }
  function stepTrip(direction){
    if(!stops.length)return;
    resumeFromFocus();
    if(playback?.phase==='overview'){goToStep(0);if(direction<0)stepTrip(-1);return;}
    if(running){
      // The second press finishes the current leg immediately, even before its first frame. At a port that leg is over, so it steps from there.
      if(!(playback.dwell>0)){finishLeg(playback.leg,direction);return;}
      stopAnimation();
    }
    if(progress===null&&direction<0){if(lines.length)finishLeg(lines.length-1,1);else goToStep(1);return;}
    const step=progress===null?0:(direction>0?Math.floor(progress+1e-7)+1:Math.ceil(progress-1e-7)+1);
    const next=direction>0&&step>=stops.length?0:step+direction;
    if(next<=0)showOverview();else goToStep(next);
  }
  $('previous-city').addEventListener('click',()=>stepTrip(-1));
  $('next-city').addEventListener('click',()=>stepTrip(1));
  // A click on a map control leaves the keys with the map, so Return sets sail rather than pressing it again.
  for(const id of ['previous-city','play','next-city','zoom-in','zoom-out','reset-view'])$(id).addEventListener('click',event=>{if(event.detail)map.focus({preventScroll:true});});
  // The stop list moved into the logbook, which folds on its own; an old preference has nothing left to hide.
  try{localStorage.removeItem('redline-cities-collapsed');}catch{}
  function setMapOnly(hidden){
    document.body.classList.toggle('map-only',hidden);
    document.querySelectorAll('.route-dock,.zoom-controls,#trip-panel').forEach(el=>{el.inert=hidden;});
    if(hidden){closeSearch();map.focus({preventScroll:true});}scheduleView();reframeTrace();
  }
  $('info-button').addEventListener('click',()=>$('info-dialog').showModal());
  $('close-info').addEventListener('click',()=>$('info-dialog').close());
  $('info-dialog').addEventListener('click',event=>{if(event.target===$('info-dialog'))$('info-dialog').close();});
  map.addEventListener('dblclick',event=>{if(document.body.classList.contains('map-only'))setMapOnly(false);else zoom(event.shiftKey?2:.5,event.clientX,event.clientY);});
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.isComposing||event.target.closest?.('input,textarea,select,[contenteditable="true"],#trip-panel')||document.querySelector('dialog[open]'))return;
    if(event.key==='Escape'&&document.body.classList.contains('map-only')){event.preventDefault();setMapOnly(false);return;}
    if(event.key.toLowerCase()==='h'){event.preventDefault();if(!event.repeat)setMapOnly(!document.body.classList.contains('map-only'));return;}
    // Space or Return starts or resumes the trace, and holding either speeds it up.
    if(event.key===' '||event.key==='Enter'){
      if(event.target.closest?.('button,a,[role=button]')&&event.target.id!=='play')return;
      event.preventDefault();if(!held.has(event.key))held.set(event.key,performance.now());
      if(!event.repeat){if(event.target.id==='play')trace();else startTrace();}return;
    }
    // Backspace (Delete on a Mac keyboard) glides back to the whole-trip overview.
    if(event.key==='Backspace'||event.key==='Delete'){event.preventDefault();if(!event.repeat)showOverview(1.35);return;}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key)){
      event.preventDefault();if(event.repeat)return;
      if(event.key==='Home')showOverview();else stepTrip(['ArrowRight','ArrowDown'].includes(event.key)?1:-1);
    }
  });
  // The play button's own Space activation would toggle a second time.
  document.addEventListener('keyup',event=>{held.delete(event.key);if(event.key===' '&&event.target.id==='play')event.preventDefault();});
  // Consume Escape after the focused editor and page controls have handled it.
  // Cancel dialogs ourselves so Safari never receives an unhandled Escape to
  // leave its window fullscreen mode. Keyup is consumed for the same reason.
  window.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||event.isComposing)return;
    if(!event.defaultPrevented&&!event.repeat){
      // The innermost dialog: the photo viewer sits inside the album, so the first one open is the wrong one.
      const dialog=[...document.querySelectorAll('dialog[open]')].at(-1);
      if(dialog){if(dialog.dispatchEvent(new Event('cancel',{cancelable:true})))dialog.close();}
      else if(!endGlide()&&running)stopAnimation();
    }
    event.preventDefault();event.stopPropagation();
  });
  window.addEventListener('keyup',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();}});
  window.addEventListener('blur',()=>held.clear());
  document.addEventListener('visibilitychange',()=>{if(document.hidden){held.clear();lastTick=null;}});
  // Route thumbnails draw on these simple shapes until the painted sheet is ready.
  $('land').append(...window.ATLAS_LAND.map(d=>svg('path',{d})));
  document.fonts?.ready?.then(()=>{labelWidths.clear();for(const text of $('route-stops').querySelectorAll('.stop-label'))text._width=labelWidth(text);lastLayout='';scheduleView();});
  // The chart's title piece follows the trip's name.
  new MutationObserver(()=>{lastLayout='';scheduleView();}).observe($('trip-title'),{childList:true,characterData:true,subtree:true});
  const photoVisibility=new MutationObserver(()=>{
    const hidden=$('photo-panel').open||$('photo-viewer').open;
    if(hidden===mapOccluded)return;mapOccluded=hidden;
    if(hidden)atlasView.release();else{lastLayout='';scheduleView();}
  });
  for(const id of ['photo-panel','photo-viewer'])photoVisibility.observe($(id),{attributes:true,attributeFilter:['open']});
  window.RedlineApp={
    showControls:()=>setMapOnly(false),
    closeSearch,
    refreshLayout:scheduleView,
    atlas:atlasView,
    focusStop:id=>{const index=stops.findIndex(p=>p.id===id);if(index>=0){jumpToCity(index);map.focus({preventScroll:true});}return index>=0;},
    getStops:()=>stops.map(p=>({...p})),
    isStarterRoute:()=>stops.length===3&&stops.every((s,i)=>s.name===places[i].name&&s.latitude===places[i].latitude&&s.longitude===places[i].longitude),
    setStops:(items,{preserveView=false,preserveHistory=false}={})=>{if(!preserveHistory){undoStack.length=0;redoStack.length=0;updateUndo();if(!preserveView)view={...baseView};}stops=items.map(p=>({...p,id:p.id||crypto.randomUUID()}));if(!preserveView)drawRoute();persist();},
    addCity:place=>{let existing=stops.find(p=>Math.abs(p.latitude-place.latitude)<.02&&Math.abs(p.longitude-place.longitude)<.02);if(existing)return {...existing};if(stops.length>=100)throw Error('A trip can contain up to 100 stops.');const added={...place,id:crypto.randomUUID()};checkpoint('add city');stops.push(added);drawRoute();persist();return {...added};},
    cityDistance:(a,b)=>RedlineGeo.geoDistance([a.longitude,a.latitude],[b.longitude,b.latitude])*6371,
  };
  new ResizeObserver(resizeMap).observe(map);
  // The dock or the logbook changing size (its list filling in) moves the labels.
  const overlayObserver=new ResizeObserver(()=>{if(!animation)scheduleView();});
  overlayObserver.observe($('route-dock'));overlayObserver.observe($('trip-panel'));
  drawRoute();resizeMap();
  window.RedlineMapIntro?.start(atlasView);
})();
