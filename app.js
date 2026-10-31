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
  let animation = 0, running = false, lines = [], searchTimer, controller, searchVersion = 0, results = [], selected = -1;
  let resultsQuery = '', resultsReady = false, addingQuery = '';
  let progress=null,activeLeg=null,geometry=[],playback=null,lastTick=null;
  let traceZoom=null,idleZoom=null,suppressStopClickUntil=0,focused=null,cityFrame=null;
  const held=new Map();
  const labelSlots=new Map(),labelWidths=new Map(),zoomControls=document.querySelector('.zoom-controls');
  const WORLD_W=1440,WORLD_H=720,MAX_ZOOM=(4/3)**9;
  let view={x:0,y:0,w:WORLD_W,h:WORLD_H};
  let baseView={...view},viewFrame=0,zoomLevel=1,activeStopId=null;
  let atlas=null,lastLayout='',lastLayoutGeometry=null,mapOccluded=false,viewportBounds=null;
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
  let hiddenMapCities=new Set(),stopPeers=[],routeIndex=null,routeIndexGeometry=null,routeIndexKey='';
  function rebuildGeometry(){
    const names=stops.map(stop=>normalize(stop.name));
    stopPeers=stops.map((a,index)=>stops.flatMap((b,i)=>Math.abs(a.latitude-b.latitude)<.15&&Math.abs(a.longitude-b.longitude)<.15&&names[index]===names[i]?[i]:[]));
    hiddenMapCities=new Set(window.MAP_CITIES.flatMap((p,i)=>stops.some(s=>Math.abs(s.latitude-p.latitude)<.15&&Math.abs(s.longitude-p.longitude)<.15)?[i]:[]));
    geometry=stops.slice(1).map((place,i)=>{
      const interpolate=RedlineGeo.geoInterpolate([stops[i].longitude,stops[i].latitude],[place.longitude,place.latitude]);
      return RedlineTrace.measure(RedlineLayout.route(interpolate));
    });
    lines.forEach((path,i)=>{path._amount=null;path.setAttribute('d',geometry[i].path);});
  }
  function setPlayState(value) {
    running=value;$('play-label').textContent=value?'Pause':'Trace route';$('route-dock').classList.toggle('sailing',value);
    $('play-icon').firstElementChild.setAttribute('d',value?'M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z':'m5 3 8 5-8 5z');
  }
  function stopAnimation() {
    cancelAnimationFrame(animation);animation=0;lastTick=null;playback=null;idleZoom=null;setPlayState(false);
  }
  const stopShown=i=>!(activeLeg?.destination===i&&Math.abs(progress-i)>1e-7)&&(progress===null||i<=progress+1e-7||activeLeg?.origin===i);
  // A city visited twice (same name, close by: sources differ slightly) is named once, by the active visit or else the first one shown; its dot goes there too.
  function labelOwner(index){const peers=stopPeers[index]||[index];return peers.find(i=>stops[i].id===activeStopId&&stopShown(i))??peers.find(stopShown)??index;}
  function paintProgress(){
    lines.forEach((path,i)=>{
      const amount=progress===null?1:Math.max(0,Math.min(1,progress-i));
      // Reveal the cached arc by screen distance for a steady drawing speed.
      if(path._amount!==amount){
        path.style.visibility=amount===0?'hidden':'';
        path.setAttribute('d',geometry[i].pathAt(amount));
        path._amount=amount;
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
    stopAnimation();traceZoom=null;progress=null;activeLeg=null;activeStopId=null;focused=null;$('route-lines').replaceChildren();$('route-stops').replaceChildren();$('stop-list').replaceChildren();lines=[];
    stops.forEach((place,index)=>{
      if(index) {const path=svg('path',{class:'route-path'});$('route-lines').append(path);lines.push(path);}
      const [x,y]=project(place),group=svg('g',{'data-index':index,transform:`translate(${x} ${y})`}),dot=svg('circle',{cx:0,cy:0,r:4.5,class:'stop-dot'});
      const label=svg('text',{x:10,y:-12,class:'stop-label label-hidden'});
      label.textContent=place.name.toUpperCase();
      group.append(dot,label);group._point=[x,y];group._label=label;$('route-stops').append(group);
      group.setAttribute('role','button');group.setAttribute('aria-label',`Go to ${place.name}, stop ${index+1}`);
      group.addEventListener('pointerdown',event=>event.stopPropagation());
      // A mouse click focuses the city without leaving a keyboard focus ring on its dot, and keys then act on the map.
      group.addEventListener('mousedown',event=>event.preventDefault());
      // A pointer goes to the visit that owns the label; assistive technology clicks reach the exact stop it names.
      group.addEventListener('click',event=>{if(event.detail||document.activeElement?.matches?.('input,textarea'))map.focus({preventScroll:true});jumpToCity(event.detail?labelOwner(index):index);});
      // Return or Space on the city already in view sets sail from it (holding speeds up, as on the map).
      group.addEventListener('keydown',event=>{if(!['Enter',' '].includes(event.key))return;event.preventDefault();event.stopPropagation();if(event.repeat)return;if(focused===stops[index].id){held.set(event.key,performance.now());startTrace();}else jumpToCity(index);});
      const li=document.createElement('li'),number=document.createElement('span'),name=document.createElement('span'),remove=document.createElement('button'),grip=document.createElement('button');
      li.dataset.index=String(index);grip.type='button';grip.className='stop-grip';grip.title='Go to city · Drag to reorder';grip.setAttribute('aria-label',`Go to ${place.name}, stop ${index+1}; drag to reorder`);grip.setAttribute('aria-keyshortcuts','Alt+ArrowLeft Alt+ArrowRight');
      number.className='stop-number';number.textContent=String(index+1).padStart(2,'0');name.textContent=place.name;
      remove.className='remove-stop';remove.textContent='×';remove.setAttribute('aria-label',`Remove ${place.name}, stop ${index+1}`);
      remove.addEventListener('click',()=>{checkpoint('remove city');stops.splice(index,1);drawRoute();persist();$('status').textContent='';});
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
    $('toggle-stops').disabled=stops.length===0;
    $('status').textContent='';
    scheduleView();
  }
  // Label widths are measured once per name; Courier's fixed advance is the fallback.
  function labelWidth(text){
    const name=text.textContent;
    if(!labelWidths.has(name)){let width=0;try{width=text.getComputedTextLength();}catch{}if(!(width>0))return window.RedlineLabels?.estimate(name)??name.length*8.3;labelWidths.set(name,width);}
    return labelWidths.get(name);
  }
  function moveStop(from,to) {
    if(from===to)return;
    checkpoint('reorder cities');const [place]=stops.splice(from,1);stops.splice(to,0,place);drawRoute();persist();
    $('status').textContent='';
  }
  function startStopDrag(event,from,grip) {
    if(event.button!==0)return;
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
  function cameraFor(leg,direction){
    return RedlineTrace.camera(geometry[leg],cameraSpace(),baseView,project(stops[direction>0?leg+1:leg]),traceZoom);
  }
  function manualCamera(width){return {width,tracker:RedlineTrace.trackingCamera(view,cameraSpace(),baseView,MAX_ZOOM)};}
  function frameDistance(a,b){const space=cameraSpace();return Math.max(Math.abs(a.x-b.x)*space.width/b.w,Math.abs(a.y-b.y)*space.height/b.h,Math.abs(a.w-b.w)*space.width/b.w);}
  function beginLeg(target,direction,returnToOverview=false){
    const leg=direction>0?Math.floor(progress+1e-7):Math.ceil(progress-1e-7)-1;
    activeLeg={origin:direction>0?leg:leg+1,destination:direction>0?leg+1:leg};
    const defaultFrame=RedlineTrace.camera(geometry[leg],cameraSpace(),baseView,project(stops[activeLeg.destination])).arrival;
    playback={leg,target,direction,returnToOverview,nominalWidth:defaultFrame.w,manual:traceZoom?manualCamera(baseView.w/traceZoom):null,from:progress-leg,to:direction>0?1:0,startView:{...view},camera:cameraFor(leg,direction),timeline:RedlineTrace.timeline({
      from:progress-leg,to:direction>0?1:0,duration:RedlineTrace.duration(geometry[leg].length)
    })};
    paintProgress();
  }
  function runTo(target,{returnToOverview=false}={}){
    stopAnimation();if(!lines.length)return;
    if(progress===null)progress=0;
    target=Math.max(0,Math.min(lines.length,target));
    const direction=target>=progress?1:-1;
    reachedCity();paintProgress();
    if(Math.abs(progress-target)<1e-7){activeLeg=null;paintProgress();return;}
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){finishLeg(direction>0?target-1:target,direction);if(returnToOverview)goToStep(0);return;}
    beginLeg(target,direction,returnToOverview);setPlayState(true);lastTick=performance.now();
    function nextLeg(run){
      if(Math.abs(progress-run.target)<1e-7){if(run.returnToOverview)returnToWorld();else stopAnimation();return false;}
      beginLeg(run.target,run.direction,run.returnToOverview);return true;
    }
    function tick(now){
      const speed=[...held.values()].some(since=>now-since>=180)?2:1;
      const elapsed=lastTick===null?0:Math.max(0,Math.min(80,now-lastTick));lastTick=now;
      const run=playback;
      if(run.settling){
        run.settling.elapsed+=elapsed;
        view=run.manual.tracker.step(project(stops[run.direction>0?run.leg+1:run.leg]),traceZoom,elapsed);
        const settled=frameDistance(view,run.camera.arrival)<.2||run.settling.elapsed>=1800;
        if(settled)view={...run.camera.arrival};paintView();
        if(settled&&!nextLeg(run))return;
        animation=requestAnimationFrame(tick);return;
      }
      // Keep the visible drawing speed comfortable as the user moves closer.
      const pace=run.manual?Math.min(1,view.w/run.nominalWidth):1;
      const state=run.timeline.advance(elapsed*speed*pace);
      progress=run.leg+state.position;
      if(state.arrived)activeLeg=null;
      const amount=Math.abs(state.position-run.from)/Math.max(1e-9,Math.abs(run.to-run.from));
      const look=run.from+(run.to-run.from)*RedlineTrace.ease(amount);
      if(run.manual){
        const lead=run.direction*90*speed*pace/RedlineTrace.duration(geometry[run.leg].length);
        const position=Math.max(0,Math.min(1,state.position+lead));
        const point=geometry[run.leg].pointAt(position),here=geometry[run.leg].pointAt(state.position);
        // Never anticipate a jump across the map's date-line seam.
        view=run.manual.tracker.step(Math.abs(point[0]-here[0])>WORLD_W/2?here:point,traceZoom,elapsed);
      }else view=RedlineTrace.cameraView(run.startView,run.camera,geometry[run.leg].pointAt(look),amount);
      paintView();
      if(state.arrived)reachedCity();
      if(state.done){
        if(run.manual)run.settling={elapsed:0};
        else if(!nextLeg(run))return;
      }
      animation=requestAnimationFrame(tick);
    }
    animation=requestAnimationFrame(tick);
  }
  function startTrace(){
    if(running||!lines.length)return;
    resumeFromFocus();
    if(progress===null||progress>=lines.length){progress=0;traceZoom=null;}
    runTo(lines.length,{returnToOverview:true});
  }
  function trace(){if(running)stopAnimation();else startTrace();}
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
  const labelNodes=new Map();
  // Place names avoid the route's dots, its chosen label boxes, and the dock.
  function renderLabels(matrix,bounds,occupied,routes) {
    const layer=$('place-labels'),width=bounds.width,height=bounds.height;
    changed(layer,'viewBox',`0 0 ${width} ${height}`);
    const visible=new Set();
    const screen=(x,y)=>[x*matrix.a+matrix.e-bounds.left,y*matrix.d+matrix.f-bounds.top];
    function placeLabel(key,name,x,y,isCity) {
      const [sx,sy]=screen(x,y),font=isCity?11:12,w=name.length*(isCity?5.8:7.1)+12;
      const box={x:isCity?sx+5:sx-w/2,y:sy-(isCity?13:8),w,h:18};
      if(box.x<30||box.x+w>width-30||box.y<22||box.y+18>height-22)return;
      if(occupied.some(b=>box.x<b.x+b.w+6&&box.x+w+6>b.x&&box.y<b.y+b.h+3&&box.y+21>b.y))return;
      if(routes?.hits(box,4))return;
      occupied.push(box);visible.add(key);
      let node=labelNodes.get(key);
      if(!node){node=svg('g',{class:isCity?'city-label':'country-label'});if(isCity)node.append(svg('circle',{r:2}));const text=svg('text',{'font-size':font,'text-anchor':isCity?'start':'middle',x:isCity?7:0,y:isCity?-4:4});text.textContent=name;node.append(text);labelNodes.set(key,node);layer.append(node);}
      changed(node,'transform',`translate(${sx.toFixed(1)} ${sy.toFixed(1)})`);
    }
    if(zoomLevel>=1.3){
      for(let i=0;i<window.MAP_COUNTRIES.length;i++){
        const p=window.MAP_COUNTRIES[i];if(zoomLevel<1.25+Math.max(0,p.rank-2)*.42)continue;
        placeLabel(`country-${i}`,p.name.toUpperCase(),p.x,p.y,false);
      }
    }
    if(zoomLevel>=1.8){
      for(let i=0;i<window.MAP_CITIES.length&&visible.size<115;i++){
        const p=window.MAP_CITIES[i];
        const threshold=p.population>=8000000?1.8:(p.capital||p.population>=2000000)?2.5:p.population>=500000?3.8:p.population>=100000?4.5:5.3;
        if(zoomLevel<threshold)continue;
        if(hiddenMapCities.has(i))continue;
        placeLabel(`city-${i}`,p.name,...backgroundPoints[i],true);
      }
    }
    for(const [key,node] of labelNodes)if(!visible.has(key)){node.remove();labelNodes.delete(key);}
    $('map-labels').style.display=zoomLevel>=1.6?'none':'';
  }
  function constrainView(frame){
    const {w,h}=frame;
    return {...frame,x:w>=WORLD_W?(WORLD_W-w)/2:Math.max(0,Math.min(WORLD_W-w,frame.x)),y:h>=WORLD_H?(WORLD_H-h)/2:Math.max(0,Math.min(WORLD_H-h,frame.y))};
  }
  let antarcticaBottom=null;
  function paintAntarctica(matrix,bounds){
    const bottom=Math.max(WORLD_H,(bounds.top+bounds.height-matrix.f+2)/matrix.d);
    if(bottom===antarcticaBottom)return;antarcticaBottom=bottom;
    $('antarctica').setAttribute('transform',`translate(0 ${bottom/2}) scale(1 .5)`);
    [...$('antarctica').children].forEach((path,i)=>path.setAttribute('d',window.ANTARCTICA_POLYGONS[i].map(ring=>ring.map(([x,y],j)=>`${j?'L':'M'}${x},${y===WORLD_H?bottom:y}`).join('')+'Z').join('')));
  }
  function paintView() {
    if(viewFrame)cancelAnimationFrame(viewFrame);viewFrame=0;
    view=constrainView(view);
    // A full-screen album owns the frame budget. Playback still advances its
    // model; reveal its current position when the album is dismissed.
    if(mapOccluded)return;
    const bounds=map.getBoundingClientRect();if(!bounds.width||!bounds.height)return;viewportBounds=bounds;
    const matrix=mapMatrix(bounds);
    // All geometry reads precede writes. Asking SVG for its CTM after changing
    // viewBox used to force layout on every zoom / trace frame.
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
    changed(map,'viewBox',`${view.x} ${view.y} ${view.w} ${view.h}`);
    paintAntarctica(matrix,bounds);
    zoomLevel=baseView.w/view.w;
    $('zoom-in').disabled=zoomLevel>=MAX_ZOOM-.001;$('zoom-out').disabled=zoomLevel<=1.001;
    map.classList.toggle('zoomed-out',zoomLevel<=1.001);
    atlas?.paint(view,zoomLevel>=1.6);
    if(window.RedlineLabels&&(routeIndexGeometry!==geometry||routeIndexKey!==key)){
      routeIndex=RedlineLabels.indexLines(geometry.flatMap((leg,i)=>leg.segmentsAt(amounts[i])),{width:WORLD_W,height:WORLD_H});
      routeIndexGeometry=geometry;routeIndexKey=key;
    }
    const routes=routeIndex&&RedlineLabels.projectIndex(routeIndex,matrix,bounds);
    const occupied=paintStops(matrix,bounds,obstacles,routes);
    for(const label of $('map-labels').children){
      changed(label,'transform',`translate(${label.dataset.mapX} ${label.dataset.mapY}) scale(${1/matrix.a} ${1/matrix.d}) rotate(${label.dataset.mapRotation})`);
    }
    if(dock)occupied.push(...obstacles);
    renderLabels(matrix,bounds,occupied,routes);paintProgress();
  }
  function paintStops(matrix,bounds,obstacles,routes){
    const items=[],texts=[],occupied=[];
    [...$('route-stops').children].forEach((group,index)=>{
      const [x,y]=group._point,text=group._label;
      // Keep dots and labels at a fixed screen size while zooming.
      changed(group,'transform',`translate(${x} ${y}) scale(${1/matrix.a} ${1/matrix.d})`);
      // Unreached stops stay out of the layout while a trace reveals them.
      if(!stopShown(index))return;
      const sx=x*matrix.a+matrix.e-bounds.left,sy=y*matrix.d+matrix.f-bounds.top,id=stops[index].id;
      if(labelOwner(index)!==index){text.classList.add('label-hidden');occupied.push({x:sx-7,y:sy-7,w:14,h:14});return;}
      items.push({id,x:sx,y:sy,width:text._width??text.textContent.length*8.3,height:14,priority:id===activeStopId?-1:index});texts.push(text);
      occupied.push({x:sx-7,y:sy-7,w:14,h:14});
    });
    const flip=item=>{const end=item.x>bounds.width-180;return {name:end?'left-above':'right-above',x:end?-10:10,y:-12,anchor:end?'end':'start',box:{x:end?item.x-12-item.width:item.x+8,y:item.y-23,w:item.width+4,h:14}};};
    const placed=window.RedlineLabels?RedlineLabels.place(items,{width:bounds.width,height:bounds.height,obstacles,previous:labelSlots,routes}):items.map(flip);
    labelSlots.clear();
    placed.forEach((slot,i)=>{
      const text=texts[i];text.classList.toggle('label-hidden',!slot);if(!slot)return;
      labelSlots.set(items[i].id,slot.name);occupied.push(slot.box);
      if(text._slot!==slot.name){text._slot=slot.name;text.setAttribute('x',slot.x);text.setAttribute('y',slot.y);text.setAttribute('text-anchor',slot.anchor);}
    });
    return occupied;
  }
  function scheduleView(){if(!viewFrame)viewFrame=requestAnimationFrame(paintView);}
  function resizeMap(){
    const bounds=map.getBoundingClientRect();if(!bounds.width||!bounds.height)return;viewportBounds=bounds;
    // Fill the viewport with the original full-width map and flush poles.
    const w=WORLD_W,h=WORLD_H;
    const previousZoom=baseView.w/view.w,centerX=view.x+view.w/2,centerY=view.y+view.h/2;
    baseView={x:0,y:0,w,h};
    view=previousZoom<=1.001?{...baseView}:{x:centerX-w/previousZoom/2,y:centerY-h/previousZoom/2,w:w/previousZoom,h:h/previousZoom};
    paintView();reframeTrace();
  }
  function zoom(factor,clientX,clientY) {
    if(running&&playback?.phase!=='overview'){
      const run=playback,width=Math.max(baseView.w/MAX_ZOOM,Math.min(baseView.w,(run.manual?.width||view.w)*factor));
      traceZoom=baseView.w/width;run.camera=cameraFor(run.leg,run.direction);
      if(run.manual)run.manual.width=width;else run.manual=manualCamera(width);
      if(run.settling)run.settling.elapsed=0;
      return;
    }
    if(playback?.phase==='overview'){stopAnimation();showWorld();}
    const matrix=mapMatrix(viewportBounds||map.getBoundingClientRect()),rx=clientX===undefined ? .5 : Math.max(0,Math.min(1,((clientX-matrix.e)/matrix.a-view.x)/view.w)),ry=clientY===undefined ? .5 : Math.max(0,Math.min(1,((clientY-matrix.f)/matrix.d-view.y)/view.h));
    const width=Math.max(baseView.w/MAX_ZOOM,Math.min(baseView.w,(idleZoom?.width||view.w)*factor));
    const anchor={x:view.x+view.w*rx,y:view.y+view.h*ry,rx,ry};
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){stopAnimation();const height=width*baseView.h/baseView.w;view={x:anchor.x-rx*width,y:anchor.y-ry*height,w:width,h:height};paintView();return;}
    if(idleZoom){Object.assign(idleZoom,{width,anchor});return;}
    stopAnimation();cancelAnimationFrame(viewFrame);viewFrame=0;
    idleZoom={width,anchor,zoom:{value:Math.log(baseView.w/view.w),velocity:0},last:performance.now()};
    const tick=now=>{
      const motion=idleZoom,elapsed=Math.min(80,Math.max(0,now-motion.last));motion.last=now;
      motion.zoom=RedlineTrace.spring(motion.zoom,Math.log(baseView.w/motion.width),elapsed/1000,18);
      const level=Math.max(1,Math.min(MAX_ZOOM,Math.exp(motion.zoom.value))),w=baseView.w/level,h=w*baseView.h/baseView.w;
      view={x:motion.anchor.x-motion.anchor.rx*w,y:motion.anchor.y-motion.anchor.ry*h,w,h};
      if(Math.abs(w-motion.width)<.01){const h=motion.width*baseView.h/baseView.w;view={x:motion.anchor.x-motion.anchor.rx*motion.width,y:motion.anchor.y-motion.anchor.ry*h,w:motion.width,h};idleZoom=null;animation=0;paintView();return;}
      paintView();animation=requestAnimationFrame(tick);
    };
    animation=requestAnimationFrame(tick);
  }
  $('zoom-in').addEventListener('click',()=>zoom(.75));$('zoom-out').addEventListener('click',()=>zoom(4/3));
  $('reset-view').addEventListener('click',()=>showOverview());
  map.addEventListener('wheel',event=>{event.preventDefault();if(!event.deltaY)return;const units=event.deltaMode===1?16:event.deltaMode===2?(viewportBounds||map.getBoundingClientRect()).height:1;const delta=Math.max(-160,Math.min(160,event.deltaY*units));zoom(Math.exp(delta*(event.ctrlKey?.008:.0018)),event.clientX,event.clientY);},{passive:false});
  let drag=null;
  map.addEventListener('pointerdown',event=>{if(event.button!==0||baseView.w/view.w<=1.001)return;stopAnimation();const m=mapMatrix(viewportBounds||map.getBoundingClientRect());drag={x:event.clientX,y:event.clientY,vx:view.x,vy:view.y,scaleX:m.a,scaleY:m.d,id:event.pointerId};map.setPointerCapture(event.pointerId);map.classList.add('dragging');});
  map.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id||baseView.w/view.w<=1.001)return;view.x=drag.vx-(event.clientX-drag.x)/drag.scaleX;view.y=drag.vy-(event.clientY-drag.y)/drag.scaleY;scheduleView();});
  const endDrag=()=>{drag=null;map.classList.remove('dragging');};map.addEventListener('pointerup',endDrag);map.addEventListener('pointercancel',endDrag);map.addEventListener('lostpointercapture',endDrag);
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
    return {length,duration:Math.max(600,Math.min(1600,420+length*560)),at:t=>{
      const [u,s]=curve.at(t),w=Math.min(WORLD_W,WORLD_W*s/size),h=w*WORLD_H/WORLD_W;
      return {x:(fx[0]+u*(fx[1]-fx[0]))*(WORLD_W-w),y:(fy[0]+u*(fy[1]-fy[0]))*(WORLD_H-h),w,h};
    }};
  }
  function showWorld(){progress=null;activeLeg=null;activeStopId=null;traceZoom=null;focused=null;updateActiveStop();}
  function animateView(target,{overview=false,hold=0}={}){
    stopAnimation();cancelAnimationFrame(viewFrame);viewFrame=0;
    const finish=()=>{stopAnimation();view={...target};if(overview)showWorld();paintView();};
    const path=zoomPath(constrainView(view),target);
    if(matchMedia('(prefers-reduced-motion: reduce)').matches||path.length<1e-4){finish();return;}
    // Arrow keys during an overview move finish it instantly.
    if(overview)playback={phase:'overview'};
    const began=performance.now();
    const tick=now=>{
      const amount=Math.max(0,Math.min(1,(now-began-hold)/path.duration));
      view=path.at(RedlineTrace.ease(amount));paintView();
      if(amount===1){finish();return;}animation=requestAnimationFrame(tick);
    };
    animation=requestAnimationFrame(tick);
  }
  function returnToWorld(){animateView({...baseView},{overview:true,hold:320});if(playback)setPlayState(true);}
  // Enter, Home, and the globe: the complete route, with the camera easing back to the world.
  function showOverview(){stopAnimation();showWorld();paintProgress();animateView({...baseView},{overview:true});}
  // A clicked city is seen within the whole drawn trip; the arrows or play then continue from it.
  function jumpToCity(index){
    if(!stops[index])return;
    stopAnimation();traceZoom=null;progress=null;activeLeg=null;activeStopId=stops[index].id;focused=stops[index].id;updateActiveStop();paintProgress();
    animateView(cityFrame=RedlineTrace.pointFrame(project(stops[index]),cameraSpace(),baseView,Math.max(3,baseView.w/view.w)));
  }
  // A focused city the camera is still flying to, or resting on, moves into the free space the settled dock leaves.
  function reframeCity(){
    if(focused===null||running||idleZoom||drag||!animation&&frameDistance(view,cityFrame)>.5)return;
    const index=stops.findIndex(p=>p.id===focused);if(index>=0)animateView(cityFrame=RedlineTrace.pointFrame(project(stops[index]),cameraSpace(),baseView,baseView.w/cityFrame.w));
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
      // The second press finishes the current leg immediately, even before its first frame.
      finishLeg(playback.leg,direction);return;
    }
    if(progress===null&&direction<0){if(lines.length)finishLeg(lines.length-1,1);else goToStep(1);return;}
    const step=progress===null?0:(direction>0?Math.floor(progress+1e-7)+1:Math.ceil(progress-1e-7)+1);
    const next=direction>0&&step>=stops.length?0:step+direction;
    if(next<=0)showOverview();else goToStep(next);
  }
  $('previous-city').addEventListener('click',()=>stepTrip(-1));
  $('next-city').addEventListener('click',()=>stepTrip(1));
  // A click on a map control leaves the keys with the map, so Return sets sail rather than pressing it again.
  for(const id of ['previous-city','next-city','zoom-in','zoom-out','reset-view','toggle-stops'])$(id).addEventListener('click',event=>{if(event.detail)map.focus({preventScroll:true});});
  function collapseStops(collapsed){
    $('route-dock').classList.toggle('stops-collapsed',collapsed);$('route-stops-panel').hidden=collapsed;
    $('toggle-stops').setAttribute('aria-expanded',String(!collapsed));$('toggle-stops').setAttribute('aria-label',collapsed?'Show stops':'Collapse stops');$('toggle-stops').title=collapsed?'Show stops':'Collapse stops';
    try{localStorage.setItem('redline-cities-collapsed',String(collapsed));}catch{}scheduleView();
    // An animated dock reframes the camera once its height settles (or soon after, without transitions).
    clearTimeout(dockTimer);
    if($('route-dock').classList.contains('dock-motion')&&!matchMedia('(prefers-reduced-motion: reduce)').matches)dockTimer=setTimeout(settleDock,450);else settleDock();
  }
  // While the ports or the logbook fold, labels keep clear of the dock frame by frame; the last fold to end settles it.
  const stopsPanel=$('route-stops-panel'),dockPanels=[stopsPanel,$('trip-panel')],dockMoving=new Set();let dockTimer=0,dockMovingUntil=0;
  const dockSize=event=>dockPanels.includes(event.target)&&event.propertyName==='grid-template-rows';
  const followDock=()=>{if(performance.now()>dockMovingUntil)return;if(!animation)scheduleView();requestAnimationFrame(followDock);};
  function settleDock(){clearTimeout(dockTimer);dockTimer=0;dockMovingUntil=0;dockMoving.clear();scheduleView();reframeTrace();reframeCity();}
  for(const panel of dockPanels){
    panel.addEventListener('transitionrun',event=>{if(!dockSize(event))return;const idle=performance.now()>dockMovingUntil;dockMoving.add(panel);dockMovingUntil=performance.now()+600;clearTimeout(dockTimer);dockTimer=setTimeout(settleDock,600);if(idle)followDock();});
    panel.addEventListener('transitionend',event=>{if(dockSize(event)&&dockMoving.delete(panel)&&!dockMoving.size)settleDock();});
    // A cancelled fold (reversed, or hidden mid-way) is settled by whichever ends next, or the timer.
    panel.addEventListener('transitioncancel',event=>{if(dockSize(event))dockMoving.delete(panel);});
  }
  // Only the user's toggle animates; the saved state is restored at once.
  $('toggle-stops').addEventListener('click',()=>{$('route-dock').classList.add('dock-motion');collapseStops(!stopsPanel.hidden);});
  try{collapseStops(localStorage.getItem('redline-cities-collapsed')==='true');}catch{}
  function setMapOnly(hidden){
    document.body.classList.toggle('map-only',hidden);
    document.querySelectorAll('.route-dock,.zoom-controls,#trip-panel').forEach(el=>{el.inert=hidden;});
    if(hidden){closeSearch();map.focus({preventScroll:true});}scheduleView();reframeTrace();
  }
  $('info-button').addEventListener('click',()=>$('info-dialog').showModal());
  $('close-info').addEventListener('click',()=>$('info-dialog').close());
  $('info-dialog').addEventListener('click',event=>{if(event.target===$('info-dialog'))$('info-dialog').close();});
  map.addEventListener('dblclick',()=>{if(document.body.classList.contains('map-only'))setMapOnly(false);});
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.isComposing||event.target.closest?.('input,textarea,select,[contenteditable="true"],#trip-panel')||document.querySelector('dialog[open]'))return;
    if(event.key==='Escape'&&document.body.classList.contains('map-only')){event.preventDefault();setMapOnly(false);return;}
    if(event.key.toLowerCase()==='h'){event.preventDefault();setMapOnly(!document.body.classList.contains('map-only'));return;}
    // Space or Return starts or resumes the trace, and holding either doubles the speed.
    if(event.key===' '||event.key==='Enter'){
      if(event.target.closest?.('button,a,[role=button]')&&event.target.id!=='play')return;
      event.preventDefault();if(!held.has(event.key))held.set(event.key,performance.now());
      if(!event.repeat){if(event.target.id==='play')trace();else startTrace();}return;
    }
    // Backspace (Delete on a Mac keyboard) glides back to the whole-trip overview.
    if(event.key==='Backspace'||event.key==='Delete'){event.preventDefault();if(!event.repeat)showOverview();return;}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key)){
      event.preventDefault();if(event.repeat)return;
      if(event.key==='Home')showOverview();else stepTrip(['ArrowRight','ArrowDown'].includes(event.key)?1:-1);
    }
  });
  // The play button's own Space activation would toggle a second time.
  document.addEventListener('keyup',event=>{held.delete(event.key);if(event.key===' '&&event.target.id==='play')event.preventDefault();});
  window.addEventListener('blur',()=>held.clear());
  document.addEventListener('visibilitychange',()=>{if(document.hidden){held.clear();lastTick=null;}});
  atlas=RedlineAtlas.create($('land'),$('regions'),window.ATLAS_LAND,window.REGION_PATHS,$('country-borders'),window.ATLAS_BORDERS);
  for(const polygon of window.ANTARCTICA_POLYGONS)$('antarctica').append(svg('path'));
  for(const label of $('map-labels').children){label.dataset.mapX=label.getAttribute('x');label.dataset.mapY=label.getAttribute('y');label.dataset.mapRotation=label.getAttribute('transform')?.match(/rotate\(([-\d.]+)/)?.[1]||'0';label.setAttribute('x','0');label.setAttribute('y','0');}
  const photoVisibility=new MutationObserver(()=>{
    const hidden=$('photo-panel').open||$('photo-viewer').open;
    if(hidden===mapOccluded)return;mapOccluded=hidden;
    if(!hidden){lastLayout='';scheduleView();}
  });
  for(const id of ['photo-panel','photo-viewer'])photoVisibility.observe($(id),{attributes:true,attributeFilter:['open']});
  window.RedlineApp={
    showControls:()=>setMapOnly(false),
    closeSearch,
    refreshLayout:scheduleView,
    focusStop:id=>{const index=stops.findIndex(p=>p.id===id);if(index>=0){jumpToCity(index);map.focus({preventScroll:true});}return index>=0;},
    getStops:()=>stops.map(p=>({...p})),
    setStops:(items,{preserveView=false,preserveHistory=false}={})=>{if(!preserveHistory){undoStack.length=0;redoStack.length=0;updateUndo();}stops=items.map(p=>({...p,id:p.id||crypto.randomUUID()}));if(!preserveView)drawRoute();persist();},
    addCity:place=>{let existing=stops.find(p=>Math.abs(p.latitude-place.latitude)<.02&&Math.abs(p.longitude-place.longitude)<.02);if(existing)return {...existing};if(stops.length>=100)throw Error('A trip can contain up to 100 stops.');const added={...place,id:crypto.randomUUID()};checkpoint('add city');stops.push(added);drawRoute();persist();return {...added};},
    cityDistance:(a,b)=>RedlineGeo.geoDistance([a.longitude,a.latitude],[b.longitude,b.latitude])*6371,
  };
  new ResizeObserver(resizeMap).observe(map);
  // Dock size changes without a fold animation (reduced motion, the logbook's list filling in) still move the labels.
  const overlayObserver=new ResizeObserver(()=>{if(!animation)scheduleView();});
  overlayObserver.observe($('route-dock'));overlayObserver.observe($('trip-panel'));
  drawRoute();resizeMap();
})();
