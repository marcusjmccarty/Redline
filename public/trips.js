(() => {
  'use strict';
  const $=id=>document.getElementById(id),app=window.RedlineApp,SVG='http://www.w3.org/2000/svg';
  let current=null,photos=[],pending=[],busy=false,dirty=false,suppress=false,resumePhotos=false,cityIndex=null,exifReady=null,photoPanelRequest=0,photosRequested=false;
  let activeCity='',galleryItems=[],importing=false,photoMode='',dragDepth=0,selecting=false,thumbQueue=Promise.resolve();
  let sheetKey='',tabsKey='',sheetWarmTimer=0;
  let view='album',albumPage=0,pages=[],turning=null,tripCache=[],resizeFrame=0,anchor=null,drawn=null,reopen=null,albumMotion=null,viewMotion=null;
  const chosen=new Set(),thumbJobs=new Set(),lastPages=new Map(),lastScrolls=new Map();
  const photoLabel=count=>`${count} photo${count===1?'':'s'}`;
  const plural=(count,word)=>`${count} ${word}${count===1?'':'s'}`;
  const fingerprint=()=>JSON.stringify(app.getStops());
  const routeContent=route=>JSON.stringify(route.map(({name,country='',admin1='',latitude,longitude})=>({name,country,admin1,latitude,longitude})));
  const reduced=()=>!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const canAnimate=el=>typeof el?.animate==='function'&&'finished' in (window.Animation?.prototype||{})&&!reduced();
  // A turn already under way counts as arrived, so quick presses add up.
  const shownPage=()=>turning?.target??albumPage;
  // The album lies open across two pages on wide screens and whenever the screen is held landscape, like a real one; portrait phones and tablets show one page.
  const twoPage=()=>innerWidth>=900||innerWidth>=600&&innerWidth>innerHeight;
  const stopNumber=index=>String(index+1).padStart(2,'0');
  const hash=text=>{let h=7;for(const c of String(text))h=(h*31+c.charCodeAt(0))|0;return Math.abs(h);};
  const icons={
    pin:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17s5-4.6 5-8.6a5 5 0 0 0-10 0c0 4 5 8.6 5 8.6z"/><circle cx="10" cy="8.4" r="1.8"/></svg>',
    more:'<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="15" cy="10" r="1.3"/></svg>',
    postcard:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5.5h14v9H3zM10.5 8h4M10.5 10.5h4M5.5 8h3"/></svg>',
    check:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8.4 2.6 2.6L12 5.6"/></svg>',
    photos:'<svg viewBox="0 0 56 56" aria-hidden="true"><path d="M11 14 8 44l33 3 1-6M16 9h32v32H16zM16 32l9-10 7 7 5-5 11 12"/><circle cx="37" cy="18" r="3"/></svg>'
  };
  try{current=JSON.parse(localStorage.getItem('redline-saved-trip')||'null');}catch{}
  if(current&&(!current.id||!Number.isInteger(current.revision)))current=null;
  function remember(){try{if(current)localStorage.setItem('redline-saved-trip',JSON.stringify(current));else localStorage.removeItem('redline-saved-trip');}catch{}}
  function update(){
    $('trip-title').textContent=current?.title||'';
    $('save-trip').classList.toggle('dirty',dirty);
    $('photo-count').textContent=photos.length?String(photos.length):'';
    $('save-trip').disabled=busy;$('new-trip').disabled=busy;$('choose-photos').disabled=busy;$('trips-button').disabled=busy;
    $('export-trip').disabled=busy||!current;$('backup-trips').disabled=busy;$('import-trips').disabled=busy;
    document.querySelectorAll('#photo-gallery button,#album-pages button,#photo-review button,#photo-review input,#photo-review select,#gallery-filter button,#gallery-actions button,#gallery-actions select,#trip-list button,#trip-list input,#backup-list button').forEach(el=>el.disabled=busy);
    $('cancel-photo-import').disabled=busy;$('select-photos').disabled=busy;
    updateCurrentTrip();updateBulkSelection();updateUploadButton();updateChosen();renderPhotoMode();
  }
  const messageTimers={};
  // Album notes fade away on their own; errors stay until something else is said.
  function message(id,text,error=false){
    const el=$(id);el.replaceChildren();el.textContent=text||'';el.classList.toggle('error',error);clearTimeout(messageTimers[id]);
    if(id==='photo-message'&&text&&!error&&!/…$/.test(text))messageTimers[id]=setTimeout(()=>{if(el.textContent===text)el.textContent='';},4200);
  }
  function showError(id,error){message(id,error.message||'Please try again.',true);}
  const api=(path,options={})=>window.RedlineStorage.api(path,options);

  // A small parchment map of a route, drawn from the map's own land shapes.
  function routeMap(points,{pad=46,aspect=2}={}){
    const svg=document.createElementNS(SVG,'svg'),node=(tag,attrs)=>{const el=document.createElementNS(SVG,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);return el;};
    svg.setAttribute('class','route-map');svg.setAttribute('aria-hidden','true');svg.setAttribute('preserveAspectRatio','xMidYMid slice');
    const L=window.RedlineLayout,G=window.RedlineGeo;
    let box={x:0,y:0,w:1440,h:720},d='';
    if(L&&G&&points.length){
      const xs=[],ys=[];
      points.forEach((point,i)=>{const [x,y]=L.project(point);xs.push(x);ys.push(y);if(i)d+=L.route(G.geoInterpolate(points[i-1],point));});
      let w=Math.max(Math.max(...xs)-Math.min(...xs),150)+pad*2,h=Math.max(Math.max(...ys)-Math.min(...ys),75)+pad*2;
      if(w/h<aspect)w=h*aspect;else h=w/aspect;
      if(w<1440)box={x:(Math.max(...xs)+Math.min(...xs))/2-w/2,y:(Math.max(...ys)+Math.min(...ys))/2-h/2,w,h};
    }
    svg.setAttribute('viewBox',`${box.x.toFixed(1)} ${box.y.toFixed(1)} ${box.w.toFixed(1)} ${box.h.toFixed(1)}`);
    svg.append(node('rect',{x:-1440,y:-720,width:4320,height:2160,class:'route-map-sea'}),node('rect',{x:-1440,y:-720,width:4320,height:2160,fill:'url(#grid)',opacity:'.6'}),node('use',{href:'#land',class:'route-map-land'}));
    if(d)svg.append(node('path',{d,class:'route-map-line'}));
    const r=Math.max(2.2,box.w/150);
    if(L)points.forEach(point=>{const [x,y]=L.project(point);svg.append(node('circle',{cx:x,cy:y,r,class:'route-map-stop'}));});
    return svg;
  }

  // The logbook is a sheet beside the map; the album is a modal book. Only one is open at a time.
  const triggers={'trip-panel':'trips-button','photo-panel':'photos-button'};
  const isOpen=id=>id==='trip-panel'?!$(id).hidden:$(id).open;
  // Closing returns focus to where the panel was opened from: the keyboard's place, or the map after a click,
  // a shortcut on the map, or a close by pointer, so Return then sets sail instead of reopening the panel.
  const openedFrom={};let clickOpened=false;
  function restorePanelFocus(id,focus){
    if(!focus)return;
    const back=focus==='map'?$('map'):openedFrom[id];
    (back?.isConnected&&back!==document.body&&!back.closest('[hidden],[inert]')?back:$(triggers[id])).focus({preventScroll:true});
  }
  function finishAlbumClose(focus){
    clearTimeout(sheetWarmTimer);
    window.RedlineAlbumMotion.clearPreloads();
    $('photos-button').setAttribute('aria-expanded','false');
    if($('photo-panel').open)$('photo-panel').close();
    // Native close hides immediately; animation cleanup cannot flash into view.
    if(turning){const token=turning;turning=null;token.animations.forEach(animation=>animation.cancel());}
    albumMotion?.scene?.dispose();$('album-book').querySelector('.album-loading-cover')?.remove();delete $('album-book').dataset.preparing;
    $('album-pages').replaceChildren();
    albumMotion=null;delete $('photo-panel').dataset.departing;$('photo-panel').style.removeProperty('--album-exit-delay');photosRequested=false;dragDepth=0;$('photo-drop-hint').hidden=true;
    setSelecting(false);renderPhotoMode();document.body.classList.remove('sheet-open');
    if(!focus&&!$('trip-panel').hidden)$('trip-panel').focus({preventScroll:true});
    else restorePanelFocus('photo-panel',focus);
  }
  function closePanel(id,{focus=false}={}){
    if(id==='trip-panel'){
      $(id).hidden=true;$('trip-switcher').open=false;closeTripMenus();app.refreshLayout?.();
      $(triggers[id]).setAttribute('aria-expanded','false');restorePanelFocus(id,focus);return;
    }
    if(albumMotion?.phase==='closing')return;
    settleView();
    // Bookmark before folding the cover, including an interrupted opening or page turn.
    const place=albumMotion?.place||(drawn?.trip===current?.id?placeAt(shownPage(),drawn.two):null);
    if(current&&place)lastPages.set(current.id,place);
    if(current&&mode()==='sheet')lastScrolls.set(current.id,$('photo-scroll').scrollTop);
    photoPanelRequest++;
    if(!$(id).open||!canAnimate($('album-pages'))){
      if(turning){const token=turning;turning=null;token.animations.forEach(a=>a.cancel());}
      finishAlbumClose(focus);return;
    }
    const token=albumMotion||{place,displayMode:mode()};
    // An interrupted opening reverses its existing cover instead of rebuilding pages.
    if(!token.scene){
      if(turning){const turn=turning;turning=null;turn.animations.forEach(a=>a.cancel());albumPage=turn.target;renderAlbum();}
      token.scene=coverScene(false);
    }
    token.phase='closing';albumMotion=token;renderPhotoMode();
    token.scene.close(duration=>{$('photo-panel').style.setProperty('--album-exit-delay',`${Math.max(0,duration-180)}ms`);$('photo-panel').dataset.departing='true';}).finally(()=>{
      if(albumMotion===token)finishAlbumClose(focus);
    });
  }

  function openPanel(id){
    if(!isOpen(id)){const at=document.activeElement;openedFrom[id]=clickOpened||!at||at===document.body?$('map'):at;}
    for(const other of Object.keys(triggers))if(other!==id&&isOpen(other))closePanel(other);
    app.closeSearch?.();$(triggers[id]).setAttribute('aria-expanded','true');
    if(id==='trip-panel'){$(id).hidden=false;app.refreshLayout?.();return;}
    if(!$(id).open)$(id).showModal();document.body.classList.add('sheet-open');
  }
  // The logbook folds away when you work elsewhere: on the map, or in the planner's search, ports and travel controls.
  const keepsLogbook='.voyage-head,#trip-panel';
  document.addEventListener('pointerdown',event=>{if(isOpen('trip-panel')&&!event.target.closest?.(`${keepsLogbook},dialog`))closePanel('trip-panel');},true);
  document.addEventListener('focusin',event=>{if(isOpen('trip-panel')&&!event.target.closest?.(`${keepsLogbook},dialog`))closePanel('trip-panel');});
  // Travel keys pressed outside the logbook fold it first, so the voyage never plays behind it.
  document.addEventListener('keydown',event=>{if(isOpen('trip-panel')&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.isComposing&&!document.querySelector('dialog[open]')&&!event.target.closest?.('input,textarea,select,[contenteditable="true"],#trip-panel,dialog')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','Backspace','Delete'].includes(event.key))closePanel('trip-panel');},true);
  {
    const panel=$('photo-panel');
    panel.addEventListener('close',()=>{if($('photos-button').getAttribute('aria-expanded')==='true')closePanel('photo-panel');});
    panel.addEventListener('cancel',event=>{event.preventDefault();if(selecting){setSelecting(false);$('select-photos').focus({preventScroll:true});return;}closePanel('photo-panel',{focus:true});});
    let pressed=null;panel.addEventListener('pointerdown',event=>{pressed=event.target;});
    panel.addEventListener('click',event=>{
      // Only a press and release on the backdrop closes; a drag that ends there does not.
      const started=pressed;pressed=null;if(started!==event.target)return;
      if(event.target===panel||event.target.classList?.contains('album-stage'))closePanel('photo-panel',{focus:'map'});
    });
  }
  function discardPending(){pending.forEach(p=>{URL.revokeObjectURL(p.url);if(p.thumbUrl)URL.revokeObjectURL(p.thumbUrl);});pending=[];renderReview();}
  function canSwitch(){return !(dirty||pending.length)||confirm('Discard unsaved changes and switch trips?');}

  // ---------- Trips ----------
  function tripDate(value){const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';return date.toLocaleDateString(undefined,{month:'short',day:'numeric',...(date.getFullYear()===new Date().getFullYear()?{}:{year:'numeric'})});}
  function updateCurrentTrip(){
    const stops=app.getStops();
    $('current-trip-label').textContent=current?'Trip':'New trip';
    $('trip-state').textContent=current?(dirty?'Unsaved changes':'All changes saved'):stops.length?`${plural(stops.length,'stop')} · not saved yet`:'Add a destination to begin';
    $('trip-state').classList.toggle('unsaved',!current||dirty);
    const button=$('trip-name-form').querySelector('button'),renamed=!!current&&$('trip-name').value.trim()!==current.title,settled=!!current&&!dirty&&!renamed;
    button.textContent=!current?'Save':dirty?'Save changes':renamed?'Rename':'Saved';
    button.classList.toggle('quiet',settled);button.disabled=busy||settled;
  }
  $('trip-name').addEventListener('input',()=>updateCurrentTrip());
  function drawCurrentMap(){$('current-trip-map').replaceChildren(routeMap(app.getStops().map(stop=>[stop.longitude,stop.latitude])));}
  // A save from the seal or an export refreshes an open logbook, and focus stays on the same voyage.
  function listFocus(){const el=document.activeElement,row=el?.closest?.('#trip-list .trip-card');return row?{id:row.dataset.tripId,part:el.classList.contains('trip-more')?'.trip-more':'.trip-open'}:null;}
  async function refreshLogbook(focus=null){
    if(!isOpen('trip-panel'))return;drawCurrentMap();
    // A half-typed rename survives the rebuild.
    const form=$('trip-list').querySelector('.trip-rename-form'),active=document.activeElement,renaming=form&&{id:form.closest('.trip-card').dataset.tripId,value:form.querySelector('input').value,focused:form.contains(active)};
    await listTrips(renaming?null:focus);if(!renaming)return;
    const item=[...$('trip-list').querySelectorAll('.trip-card')].find(el=>el.dataset.tripId===renaming.id),trip=tripCache.find(t=>t.id===renaming.id);if(!item||!trip)return;
    startRename(item,trip);const input=item.querySelector('.trip-rename-form input');input.value=renaming.value;
    if(!renaming.focused){const row=focus&&[...$('trip-list').querySelectorAll('.trip-card')].find(el=>el.dataset.tripId===focus.id);(row?.querySelector(focus.part)||(active?.isConnected?active:null))?.focus({preventScroll:true});}
  }
  function closeTripMenus(except=null){document.querySelectorAll('#trip-list .trip-menu').forEach(menu=>{if(menu===except)return;menu.hidden=true;menu.previousElementSibling?.setAttribute('aria-expanded','false');});}
  function tripCard(trip,index){
    const item=document.createElement('li'),map=document.createElement('div'),body=document.createElement('div'),open=document.createElement('button'),name=document.createElement('span'),detail=document.createElement('span');
    item.className='trip-card saved-trip';item.dataset.tripId=trip.id;item.style.setProperty('--i',String(Math.min(index,12)));item.classList.toggle('active',trip.id===current?.id);
    map.className='trip-map';map.append(routeMap(trip.points||[]));
    if(trip.coverUrl){const cover=document.createElement('img');cover.className='trip-cover';cover.src=trip.coverUrl;cover.alt='';cover.loading='lazy';cover.style.setProperty('--tilt',`${(hash(trip.id)%7-3)*1.1}deg`);map.append(cover);}
    open.type='button';open.className='trip-open';open.disabled=busy;name.className='trip-name';name.textContent=trip.title;open.append(name);
    if(trip.id===current?.id){open.setAttribute('aria-current','true');const badge=document.createElement('span');badge.className='trip-current';badge.textContent='Open now';body.append(badge);}
    detail.className='trip-meta';detail.textContent=[plural(trip.stopCount??0,'stop'),trip.photoCount?photoLabel(trip.photoCount):'',tripDate(trip.updatedAt)].filter(Boolean).join(' · ');
    body.className='trip-card-body';body.prepend(open);body.append(detail);
    open.addEventListener('click',event=>trip.id===current?.id?closePanel('trip-panel',{focus:event.detail?'map':true}):loadTrip(trip.id,{keyboard:!event.detail}));
    const more=document.createElement('button'),menu=document.createElement('div');
    more.type='button';more.className='icon-button trip-more';more.innerHTML=icons.more;more.title='More';more.setAttribute('aria-label',`More for ${trip.title}`);more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');more.disabled=busy;
    menu.className='trip-menu';menu.setAttribute('role','menu');menu.hidden=true;
    const entry=(className,label,action)=>{const button=document.createElement('button');button.type='button';button.className=className;button.setAttribute('role','menuitem');button.textContent=label;button.disabled=busy;button.addEventListener('click',()=>{closeTripMenus();more.focus({preventScroll:true});action();});menu.append(button);};
    entry('trip-rename','Rename',()=>startRename(item,trip));entry('trip-export','Export',()=>exportTrips(false,trip.id));entry('trip-delete','Delete…',()=>deleteTrip(trip));
    more.addEventListener('click',()=>{const show=menu.hidden;closeTripMenus(menu);menu.hidden=!show;more.setAttribute('aria-expanded',String(show));if(show){menu.scrollIntoView?.({block:'nearest'});menu.querySelector('button')?.focus({preventScroll:true});}});
    menu.addEventListener('keydown',event=>{
      const items=[...menu.querySelectorAll('button')],at=items.indexOf(document.activeElement);
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeTripMenus();more.focus({preventScroll:true});}
      else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();items[(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();}
      else if(event.key==='Tab')closeTripMenus();
    });
    item.append(map,body,more,menu);return item;
  }
  function renderTripCards(focus=null){
    const list=$('trip-list'),query=$('trip-search').value.trim().toLowerCase(),shown=tripCache.filter(trip=>!query||trip.title.toLowerCase().includes(query));
    list.replaceChildren(...shown.map(tripCard));
    if(!tripCache.length||!shown.length){const empty=document.createElement('li');empty.className='trip-empty';empty.textContent=tripCache.length?'No trip by that name.':'No saved trips yet. Name this trip above to save it.';list.append(empty);}
    if(focus&&isOpen('trip-panel')){
      const row=[...list.querySelectorAll('.trip-card')].find(el=>el.dataset.tripId===focus.id);
      (row?.querySelector(focus.part||'.trip-open')||list.querySelector('.trip-open')||$('trip-name')).focus({preventScroll:true});
    }
  }
  // Rebuilding the list keeps keyboard focus on the same trip, or on the sheet itself.
  async function listTrips(focus=null){
    try{
      const {trips}=await api('/trips');tripCache=trips;
      $('trips-summary').textContent=trips.length?`${plural(trips.length,'trip')} kept in this browser`:'No saved trips yet';
      renderBackups();$('trip-search-label').hidden=trips.length<7;if(trips.length<7)$('trip-search').value='';renderTripCards(focus);
    }catch(error){showError('trip-message',error);}
  }
  function renderBackups(){
    const list=$('backup-list'),backed=tripCache.filter(trip=>trip.backedUpAt).sort((a,b)=>b.backedUpAt.localeCompare(a.backedUpAt));list.replaceChildren();
    for(const trip of backed){
      const row=document.createElement('li'),button=document.createElement('button'),name=document.createElement('span'),date=document.createElement('span');
      button.type='button';button.disabled=busy;name.textContent=trip.title;
      date.textContent=`${trip.backupSource==='import'?'Imported':'Exported'} ${tripDate(trip.backedUpAt)}`;
      button.append(name,date);button.addEventListener('click',event=>trip.id===current?.id?closePanel('trip-panel',{focus:event.detail?'map':true}):loadTrip(trip.id,{keyboard:!event.detail}));row.append(button);list.append(row);
    }
    if(!backed.length){const row=document.createElement('li');row.className='trip-empty';row.textContent='Export a trip or import a backup to list it here.';list.append(row);}
  }
  $('trip-search').addEventListener('input',()=>renderTripCards());
  function startRename(item,trip){
    const body=item.querySelector('.trip-card-body'),form=document.createElement('form'),input=document.createElement('input'),save=document.createElement('button'),cancel=document.createElement('button');
    form.className='trip-rename-form';input.value=trip.title;input.maxLength=80;input.required=true;input.setAttribute('aria-label','Trip name');
    save.type='submit';save.textContent='Rename';cancel.type='button';cancel.className='text-button';cancel.textContent='Cancel';
    form.append(input,save,cancel);body.replaceChildren(form);item.classList.add('renaming');input.focus();input.select();
    const back=()=>renderTripCards({id:trip.id,part:'.trip-more'});
    cancel.addEventListener('click',back);
    input.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();back();}});
    form.addEventListener('submit',async event=>{event.preventDefault();await renameTrip(trip,input.value);});
  }
  async function renameTrip(trip,title){
    if(busy)return;busy=true;update();
    try{
      // The open trip is checked against the revision this tab last saw, so a rename
      // never hides another tab's newer route behind an "All changes saved" state.
      const open=current?.id===trip.id,result=await api(`/trips/${trip.id}/title`,{method:'PUT',body:JSON.stringify({title,revision:open?current.revision:trip.revision})});
      if(open&&current?.id===trip.id){current={...current,title:result.trip.title,revision:result.trip.revision};remember();if(document.activeElement!==$('trip-name'))$('trip-name').value=current.title;}
      message('trip-message','Trip renamed.');
    }catch(error){showError('trip-message',error);}finally{busy=false;update();await listTrips({id:trip.id});}
  }
  async function deleteTrip(trip){
    if(busy)return;
    const extra=trip.photoCount?` and its ${photoLabel(trip.photoCount)} and postcards`:'';
    if(!confirm(`Delete “${trip.title}”${extra}? This can’t be undone. Use Export first if you might want it later.`))return;
    busy=true;update();
    try{
      await api(`/trips/${trip.id}`,{method:'DELETE'});
      if(current?.id===trip.id){
        photoPanelRequest++;discardPending();photos.forEach(p=>window.RedlinePostcards.forget(p.id));photos=[];current=null;activeCity='';
        dirty=app.getStops().length>0;remember();renderGallery();$('trip-name').value='';
      }
      message('trip-message',`Deleted “${trip.title}”.`);
    }catch(error){showError('trip-message',error);}finally{busy=false;update();await listTrips({id:trip.id});}
  }
  async function loadTrip(id,{keyboard=true}={}){
    if(busy||!canSwitch())return;
    busy=true;update();let loaded=false;
    try{const data=await api(`/trips/${id}`);photoPanelRequest++;discardPending();activeCity='';setSelecting(false);suppress=true;app.setStops(data.trip.stops);suppress=false;current={id:data.trip.id,title:data.trip.title,revision:data.trip.revision,hash:fingerprint()};photos=data.photos;dirty=false;reopen=lastPages.get(id)||null;albumPage=reopen?.index??0;remember();renderGallery();closePanel('trip-panel');message('trip-message','');loaded=true;}
    catch(error){showError('trip-message',error);}
    // Focus leaves the folded logbook for its tab (enabled again once busy clears), or for the map after a click.
    finally{suppress=false;busy=false;update();const active=document.activeElement;if(loaded&&(!active||active===document.body||$('trip-panel').contains(active)))$(keyboard?'trips-button':'map').focus({preventScroll:true});}
  }
  async function saveCurrent(title){
    const route=app.getStops(),name=(title||current?.title||'').trim();if(!name)throw Error('Give this trip a name.');
    const data=await api(current?`/trips/${current.id}`:'/trips',{method:current?'PUT':'POST',body:JSON.stringify({title:name,stops:route,...(current?{revision:current.revision}:{})})});
    // Persist the canonical saved route, but never replace edits made during the request.
    if(fingerprint()===JSON.stringify(route)&&JSON.stringify(data.trip.stops)!==JSON.stringify(route)){
      const sameRoute=routeContent(route)===routeContent(data.trip.stops)&&route.every((stop,i)=>stop.id===data.trip.stops[i].id);
      suppress=true;try{app.setStops(data.trip.stops,{preserveView:sameRoute,preserveHistory:true});}finally{suppress=false;}
    }
    current={id:data.trip.id,title:data.trip.title,revision:data.trip.revision,hash:JSON.stringify(data.trip.stops)};dirty=fingerprint()!==current.hash;remember();update();return data.trip;
  }
  // Only the logbook's own scroller moves: the panel around it is still unfolding.
  function revealInLogbook(el){
    const scroller=$('trip-panel').querySelector('.logbook-scroll'),box=scroller.getBoundingClientRect(),target=el.getBoundingClientRect(),above=target.top-(box.top+12),below=target.bottom-(box.top+scroller.clientHeight)+12;
    if(above<0)scroller.scrollTop+=above;else if(below>0)scroller.scrollTop+=Math.min(below,above);
  }
  // An already open logbook keeps what is being typed into it.
  function openTrips(note=''){
    const wasOpen=isOpen('trip-panel');openPanel('trip-panel');
    if($('route-stops-panel').hidden)$('toggle-stops').click();
    if(!wasOpen){$('trip-name').value=current?.title||'';$('trip-search').value='';drawCurrentMap();listTrips();}
    message('trip-message',note);updateCurrentTrip();
    if(!current||note){$('trip-name').focus({preventScroll:true});revealInLogbook($('trip-name-form'));if(note)revealInLogbook($('trip-message'));}else $('trip-panel').focus({preventScroll:true});
  }
  // Opening the album never commits route edits; saving or moving photos does that first.
  function requireTrip(){
    if(!current){resumePhotos=true;openTrips('Name and save this trip to add photos.');return false;}
    return true;
  }
  $('trips-button').addEventListener('click',event=>{if(isOpen('trip-panel')){closePanel('trip-panel',{focus:event.detail?'map':false});return;}resumePhotos=false;clickOpened=event.detail>0;openTrips();clickOpened=false;});
  $('save-trip').addEventListener('click',async()=>{
    if(!current){if(isOpen('trip-panel')&&$('trip-name').value.trim())$('trip-name-form').requestSubmit();else openTrips();return;}
    const focus=listFocus();let saved=false;busy=true;update();
    try{await saveCurrent();saved=true;$('save-trip-label').textContent='Saved';setTimeout(()=>$('save-trip-label').textContent='Save',1300);}catch(error){openTrips();showError('trip-message',error);}finally{busy=false;update();if(saved)await refreshLogbook(focus);}
  });
  $('trip-name-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    // A saved form disables its button, so keyboard focus moves back to the name.
    const refocus=document.activeElement===$('trip-name-form').querySelector('button');let album=false;busy=true;update();
    try{
      const renaming=current&&!dirty&&$('trip-name').value.trim()!==current.title;
      await saveCurrent($('trip-name').value);message('trip-message',renaming?'Trip renamed.':'');
      // A voyage named so its photos can be added goes on to its album once saving is done.
      if(resumePhotos){resumePhotos=false;closePanel('trip-panel');album=true;}else{drawCurrentMap();await listTrips();if(refocus&&isOpen('trip-panel'))$('trip-name').focus({preventScroll:true});}
    }
    catch(error){showError('trip-message',error);}finally{busy=false;update();if(album)showPhotos();}
  });
  $('new-trip').addEventListener('click',()=>{if(!canSwitch())return;discardPending();setSelecting(false);current=null;photos=[];activeCity='';albumPage=0;suppress=true;app.setStops([]);suppress=false;dirty=false;remember();update();renderGallery();closePanel('trip-panel');$('destination').focus();});
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',event=>closePanel(button.dataset.close,{focus:event.detail?'map':true})));
  document.addEventListener('pointerdown',event=>{if(!event.target.closest?.('.trip-menu,.trip-more'))closeTripMenus();},true);
  window.addEventListener('resize',()=>{if(!$('photo-panel').open||resizeFrame)return;resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;if(albumMotion){albumMotion.refresh=true;return;}settleView();if(view!=='album')return;const had=$('album-pages').contains(document.activeElement)||!!turning?.had;renderAlbum();keepAlbumFocus(had);});});
  window.addEventListener('redline:routechange',()=>{if(suppress)return;dirty=current?fingerprint()!==current.hash:app.getStops().length>0;update();if(isOpen('trip-panel'))drawCurrentMap();if($('photo-panel').open){renderReview();renderGallery();}});
  window.addEventListener('beforeunload',event=>{if(pending.length||dirty){event.preventDefault();event.returnValue='';}});

  // ---------- Photos ----------
  function coverScene(opening){
    const book=$('album-book'),displayMode=mode(),source=displayMode==='album'?$('album-pages'):$('album-sheet');
    const closed=book.dataset.preparing&&!opening?'front':displayMode==='album'?(book.classList.contains('closed-front')?'front':book.classList.contains('closed-back')?'back':''):'';
    const scene=window.RedlineAlbumMotion.create({book,source,cover:pageElement({type:'cover'},0,'right'),two:twoPage(),closed,opening:opening||!!book.dataset.preparing});
    return scene;
  }
  async function showPhotos(city){
    if(busy||albumMotion?.phase==='closing')return;
    if(city!==undefined){activeCity=city;setSelecting(false);}
    if($('photo-panel').open){if(!albumMotion){renderGallery();if(city)goToCity(city);}return;}
    if(photosRequested)return;
    photosRequested=true;const version=++photoPanelRequest;
    try{
      if(!requireTrip()||version!==photoPanelRequest)return;
      const tripId=current.id,place=lastPages.get(tripId)||{type:'title',index:step()};
      const token={phase:'opening',place,displayMode:pending.length||importing?'review':view};albumMotion=token;
      reopen=null;albumPage=0;openPanel('photo-panel');renderAlbum();renderGallery();renderReview();message('photo-message','');
      const animated=canAnimate($('album-pages')),book=$('album-book');
      if(animated){const cover=pageElement({type:'cover'},0,'right');cover.classList.add('album-loading-cover');book.dataset.preparing='true';book.append(cover);}
      const data=await api(`/trips/${tripId}`);
      if(version!==photoPanelRequest||current?.id!==tripId||albumMotion!==token)return;
      photos=data.photos;renderAlbum();renderGallery();
      const cityPage=city?pages.findIndex(page=>page.type==='city'&&page.first&&page.group.id===city):-1;
      albumPage=clampPage(cityPage>=0?cityPage:pageAt(place));token.place=placeAt(albumPage,twoPage());
      token.displayMode=pending.length||importing?'review':view;
      renderAlbum();renderGallery();renderReview();update();
      if(view==='sheet'){if(city)goToCity(city,{instant:true});else $('photo-scroll').scrollTop=lastScrolls.get(tripId)||0;}
      if(animated){
        // Decode just this spread, keeping the closed cover on top while it is prepared.
        const source=token.displayMode==='album'?$('album-pages'):$('album-sheet'),rect=source.getBoundingClientRect();
        const images=[...source.querySelectorAll('img')].filter(img=>{const r=img.getBoundingClientRect();return !rect.height||r.bottom>=rect.top&&r.top<=rect.bottom;});
        await Promise.all(images.map(async img=>{try{img.loading='eager';await img.decode();img.closest('.photo-image')?.classList.add('loaded');}catch{}}));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        if(version!==photoPanelRequest||albumMotion!==token)return;
        token.scene=coverScene(true);
        await token.scene.open();
        if(version!==photoPanelRequest||albumMotion!==token||token.phase!=='opening')return;
        token.scene.dispose();
      }
      albumMotion=null;renderPhotoMode();warmSheet();
      if(token.refresh){renderReview();renderGallery();}
    }catch(error){if(version===photoPanelRequest){albumMotion?.scene?.dispose();$('album-book').querySelector('.album-loading-cover')?.remove();delete $('album-book').dataset.preparing;albumMotion=null;openPanel('photo-panel');renderGallery();showError('photo-message',error);}}
    finally{if(version===photoPanelRequest)photosRequested=false;}
  }
  $('photos-button').addEventListener('click',event=>{if(photosRequested||$('photo-panel').open){closePanel('photo-panel');return;}clickOpened=event.detail>0;showPhotos();clickOpened=false;});
  document.addEventListener('keydown',async event=>{
    const viewer=$('photo-viewer').open,info=$('info-dialog').open;
    if(event.key==='Escape'&&!event.defaultPrevented&&!viewer&&!info){
      if(isOpen('trip-panel')){event.preventDefault();closePanel('trip-panel',{focus:true});return;}
      if($('photo-panel').open){event.preventDefault();if(selecting){setSelecting(false);$('select-photos').focus({preventScroll:true});return;}closePanel('photo-panel',{focus:true});return;}
    }
    if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.isComposing||event.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    // Keep keyboard turns from racing a cover that is opening or closing.
    if((albumMotion||viewMotion)&&['ArrowRight','ArrowLeft','PageDown','PageUp','Home','End'].includes(event.key)){event.preventDefault();return;}
    // The album turns like a book from the keyboard.
    if($('photo-panel').open&&!viewer&&mode()==='album'){
      const turns={ArrowRight:step(),PageDown:step(),ArrowLeft:-step(),PageUp:-step()};
      if(event.key in turns){event.preventDefault();turnTo(shownPage()+turns[event.key]);return;}
      if(event.key==='Home'||event.key==='End'){event.preventDefault();turnTo(event.key==='Home'?0:lastPage());return;}
    }
    const key=event.key.toLowerCase(),button={l:'trips-button',s:'save-trip',a:'photos-button'}[key];
    if(!button||info)return;
    if(viewer){if(key==='a'){event.preventDefault();if(!event.repeat){await window.RedlinePostcards.close();if(!$('photo-viewer').open)closePanel('photo-panel',{focus:true});}}return;}
    event.preventDefault();if(event.repeat)return;
    if(document.body.classList.contains('map-only'))window.RedlineApp.showControls();
    if(key==='a'&&$('photo-panel').open){closePanel('photo-panel',{focus:true});return;}
    if(key==='l'&&isOpen('trip-panel')){closePanel('trip-panel',{focus:true});return;}
    $(button).click();
  });

  function loadExif(){if(window.exifr)return Promise.resolve();if(!exifReady)exifReady=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='vendor/exifr.js';script.onload=resolve;script.onerror=()=>{exifReady=null;reject(Error('Could not load photo metadata reader.'));};document.head.append(script);});return exifReady;}
  async function loadCityIndex(){if(cityIndex)return cityIndex;const response=await fetch('photo-cities.json');if(!response.ok)throw Error('Could not load city locations.');cityIndex=await response.json();return cityIndex;}
  async function matchCity(gps){
    if(!gps||!Number.isFinite(gps.latitude)||!Number.isFinite(gps.longitude)||Math.abs(gps.latitude)>90||Math.abs(gps.longitude)>180)return null;
    let best=null,distance=Infinity;
    for(const stop of app.getStops()){const d=app.cityDistance(gps,stop);if(d<distance){distance=d;best=stop;}}
    if(best&&distance<=25)return {...best,existing:true};
    const index=await loadCityIndex();best=null;distance=40;
    const longitudeRange=.6/Math.max(.08,Math.cos(gps.latitude*Math.PI/180));
    for(const [name,latitude,longitude,country] of index){if(Math.abs(latitude-gps.latitude)>.5||Math.abs(((longitude-gps.longitude+540)%360)-180)>longitudeRange)continue;const place={name,latitude,longitude,country,admin1:''},d=app.cityDistance(gps,place);if(d<distance){distance=d;best=place;}}
    return best;
  }
  // Draws an image into a fresh JPEG, which also leaves every metadata block behind.
  async function encode(source,width,height,longest,quality){
    const factor=Math.min(1,longest/Math.max(width,height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*factor));canvas.height=Math.max(1,Math.round(height*factor));
    const ctx=canvas.getContext('2d');ctx.imageSmoothingQuality='high';ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,0,0,canvas.width,canvas.height);
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Could not process this photo.')),'image/jpeg',quality));
    const size={width:canvas.width,height:canvas.height};canvas.width=1;canvas.height=1;return {blob,...size};
  }
  async function cleanImage(file){
    if(file.size>30*1024*1024)throw Error('Use a photo smaller than 30 MB.');
    let bitmap;
    try{bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});}catch{
      const url=URL.createObjectURL(file);try{bitmap=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(Error('This browser cannot read that photo. Export it as JPEG and try again.'));image.src=url;});}finally{URL.revokeObjectURL(url);}
    }
    try{
      const width=bitmap.width||bitmap.naturalWidth,height=bitmap.height||bitmap.naturalHeight;
      if(!width||!height||width*height>60000000)throw Error('Use a photo smaller than 60 megapixels.');
      const full=await encode(bitmap,width,height,2400,.88);
      if(full.blob.type!=='image/jpeg'||full.blob.size>4*1024*1024)throw Error('Could not reduce this photo below 4 MB.');
      let thumb=null;try{thumb=(await encode(bitmap,width,height,640,.8)).blob;if(thumb.type!=='image/jpeg'||thumb.size>1024*1024)thumb=null;}catch{}
      return {blob:full.blob,thumb,width:full.width,height:full.height};
    }finally{bitmap.close?.();}
  }
  // Older and imported photos get a small preview the first time they are shown.
  function backfillThumb(photo,image){
    if(photo.thumbUrl||thumbJobs.has(photo.id)||!image.naturalWidth||!current)return;
    thumbJobs.add(photo.id);
    thumbQueue=thumbQueue.then(async()=>{
      await new Promise(resolve=>setTimeout(resolve,0));
      try{
        const {blob}=await encode(image,image.naturalWidth,image.naturalHeight,640,.8),form=new FormData();
        form.append('thumb',blob,'thumb.jpg');form.append('width',String(image.naturalWidth));form.append('height',String(image.naturalHeight));
        const {photo:saved}=await api(`/photos/${photo.id}/thumb`,{method:'PUT',body:form});Object.assign(photo,{thumbUrl:saved.thumbUrl,width:saved.width,height:saved.height});
      }catch{}finally{thumbJobs.delete(photo.id);}
    });
  }
  $('choose-photos').addEventListener('click',()=>$('photo-files').click());
  $('photo-files').addEventListener('change',async event=>{
    const files=[...event.target.files];event.target.value='';await importPhotos(files);
  });
  function setProgress(done,total){const bar=$('photo-progress');bar.hidden=!total;bar.style.setProperty('--progress',total?String(done/total):'0');bar.setAttribute('aria-valuenow',String(done));bar.setAttribute('aria-valuemax',String(total||1));}
  async function importPhotos(files){
    if(!files.length||busy||!current)return;
    if(files.length+pending.length>30){message('photo-message','Choose up to 30 photos at a time.',true);return;}
    setSelecting(false);busy=true;importing=true;photoPanelRequest++;photosRequested=false;update();let failed=0,lastError='';
    try{
      await loadExif().catch(()=>{});
      for(let i=0;i<files.length;i++){
        message('photo-message',`Reading ${i+1} of ${files.length}…`);setProgress(i,files.length);
        try{
          if(!/^image\//.test(files[i].type)&&!(/\.(jpe?g|png|webp|hei[cf]|avif)$/i.test(files[i].name)))throw Error('Choose image files only.');
          let gps=null;try{gps=await exifr.gps(files[i]);}catch{}
          const {blob,thumb,width,height}=await cleanImage(files[i]);let candidate=null;try{candidate=await matchCity(gps);}catch{}
          const entry={id:crypto.randomUUID(),name:files[i].name,blob,thumb,width,height,url:URL.createObjectURL(blob),thumbUrl:thumb?URL.createObjectURL(thumb):'',candidate,selected:candidate?(candidate.existing?candidate.id:'match'):'',checked:true};
          pending.push(entry);renderReview(true);
        }catch(error){failed++;lastError=error.message;}
      }
      message('photo-message',failed?`${failed} photo${failed===1?'':'s'} could not be read. ${lastError}`:'',failed>0);renderReview();
    }catch(error){showError('photo-message',error);}finally{busy=false;importing=false;setProgress(0,0);update();renderReview();}
  }
  const fileDrag=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
  $('photo-panel').addEventListener('dragenter',event=>{if(!fileDrag(event))return;event.preventDefault();dragDepth++;if(!busy)$('photo-drop-hint').hidden=false;});
  $('photo-panel').addEventListener('dragover',event=>{if(!fileDrag(event))return;event.preventDefault();event.dataTransfer.dropEffect=busy?'none':'copy';});
  $('photo-panel').addEventListener('dragleave',event=>{if(!fileDrag(event))return;dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('photo-drop-hint').hidden=true;});
  $('photo-panel').addEventListener('drop',event=>{if(!fileDrag(event))return;event.preventDefault();dragDepth=0;$('photo-drop-hint').hidden=true;importPhotos([...event.dataTransfer.files]);});
  // Dragging photos over a saved trip opens its album; a drop anywhere never replaces the app.
  document.addEventListener('dragenter',event=>{if(fileDrag(event)&&!$('photo-panel').open&&current&&!busy&&!document.querySelector('dialog[open]'))showPhotos();});
  document.addEventListener('dragover',event=>{if(!fileDrag(event))return;event.preventDefault();if(!event.target.closest?.('#photo-panel'))event.dataTransfer.dropEffect=current&&!busy?'copy':'none';});
  document.addEventListener('drop',event=>{
    if(!fileDrag(event))return;event.preventDefault();dragDepth=0;$('photo-drop-hint').hidden=true;
    if(event.target.closest?.('#photo-panel')||$('photo-viewer').open)return;
    const files=[...event.dataTransfer.files];
    if(!current){openTrips('Name and save this trip to add photos.');resumePhotos=true;return;}
    if($('photo-panel').open)importPhotos(files);else showPhotos().then(()=>importPhotos(files));
  });
  $('cancel-photo-import').addEventListener('click',()=>{
    if(busy||!pending.length)return;
    if(confirm(`Discard ${photoLabel(pending.length)} from this import?`)){discardPending();message('photo-message','');$('choose-photos').focus({preventScroll:true});}
  });
  const mode=()=>albumMotion?(albumMotion.displayMode||'album'):pending.length||importing?'review':view;
  function renderPhotoMode(){
    const current_=mode(),reviewing=current_==='review',moving=!!albumMotion||!!viewMotion;
    $('photo-panel').dataset.motion=albumMotion?.phase||'';
    $('album-book').inert=moving;$('album-modes').inert=!!albumMotion;
    $('choose-photos').disabled=busy||moving;
    if(current_!==photoMode){$('photo-scroll').scrollTop=0;photoMode=current_;}
    $('album-book').dataset.mode=current_;
    $('album-book').style.setProperty('--page-depth',`${current_==='album'?Math.max(0,Math.min(6,(lastPage()-step()-shownPage())*1.5)):5}px`);
    $('photos-heading').textContent=reviewing?'Add photos':'Photos';
    $('photo-trip-name').textContent=current?.title||'';
    $('gallery-count').textContent=photoLabel(photos.length);$('gallery-count').hidden=reviewing||!photos.length;
    $('choose-photos').querySelector('span').textContent=pending.length?'Add more':'Add photos';
    // Controls that fade away also leave the tab order, so they can't turn a hidden album.
    $('album-pages').hidden=current_!=='album';$('album-sheet').hidden=current_==='album';$('album-foot').classList.toggle('away',current_!=='album');$('album-foot').inert=current_!=='album'||moving;
    $('photo-gallery').hidden=current_!=='sheet';$('photo-review').hidden=!reviewing;
    $('photo-review').setAttribute('aria-busy',String(importing));
    $('gallery-toolbar').hidden=current_!=='sheet'||!photos.length||selecting;
    $('gallery-actions').hidden=current_!=='sheet'||!selecting;
    $('photo-bulk').hidden=!pending.length;$('photo-import-actions').hidden=!pending.length;
    $('album-view').setAttribute('aria-pressed',String(view==='album'));$('sheet-view').setAttribute('aria-pressed',String(view==='sheet'));
    $('album-view').disabled=$('sheet-view').disabled=reviewing;$('album-modes').classList.toggle('away',reviewing);
    $('gallery-filter').classList.toggle('away',reviewing||!photos.length);$('gallery-filter').inert=reviewing||!photos.length;
    $('photo-panel').classList.toggle('selecting',selecting&&!reviewing);
  }
  function warmPreviews(){
    if(!$('photo-panel').open||albumMotion?.phase==='closing'||busy)return;
    const groups=photoGroups(),index=Math.max(0,groups.findIndex(group=>group.id===activeCity));
    // Warm the active chapter and the following city while the cover/page is
    // opening. Only small thumbnails enter this bounded, retained cache.
    const ordered=[...groups.slice(index),...groups.slice(0,index)];
    window.RedlineAlbumMotion.preload(ordered.flatMap(group=>group.items.map(photo=>photo.thumbUrl)).filter(Boolean).slice(0,40));
  }
  function warmSheet(){
    clearTimeout(sheetWarmTimer);
    sheetWarmTimer=setTimeout(()=>{
      if(!$('photo-panel').open||$('photo-viewer').open||mode()!=='album'||albumMotion||viewMotion||turning||busy)return;
      const groups=photoGroups();renderSheet(groups);
      warmPreviews();
    },160);
  }
  function applyView(next){
    view=next;selecting=false;chosen.clear();anchor=null;renderGallery();
    if(next==='sheet'&&activeCity)goToCity(activeCity,{instant:true});
  }
  function settleView(){
    if(!viewMotion)return;
    const token=viewMotion;viewMotion=null;token.scene?.dispose();
    if(view!==token.target)applyView(token.target);else if(token.refresh)renderGallery();else renderPhotoMode();
  }
  async function setView(next){
    if(viewMotion){viewMotion.target=next;return;}
    if(view===next||albumMotion)return;
    const book=$('album-book');
    if(!canAnimate(book)||!$('photo-panel').open){applyView(next);return;}
    // Finish a turning leaf before taking the outgoing spread's snapshot.
    if(turning)renderAlbum();
    const source=view==='album'?$('album-pages'):$('album-sheet'),token={target:next};viewMotion=token;
    token.scene=window.RedlineAlbumMotion.changeView({book,source,two:twoPage(),direction:next==='sheet'?-1:1,apply:()=>{applyView(next);return next==='album'?$('album-pages'):$('album-sheet');}});
    await token.scene.play();if(viewMotion!==token)return;
    viewMotion=null;token.scene.dispose();if(token.refresh)renderGallery();else renderPhotoMode();
    if(token.target!==view)setView(token.target);
  }
  $('album-view').addEventListener('click',()=>setView('album'));
  $('sheet-view').addEventListener('click',()=>setView('sheet'));
  $('sheet-view').addEventListener('pointerenter',warmPreviews);
  $('sheet-view').addEventListener('focus',warmPreviews);
  function cityOptions(select,emptyLabel){
    select.replaceChildren(new Option(emptyLabel,''));
    app.getStops().forEach((stop,i)=>select.add(new Option(`${stopNumber(i)} · ${stop.name}${stop.country?', '+stop.country:''}`,stop.id)));
  }
  const clampRatio=value=>Math.min(2.4,Math.max(.45,value));
  function setRatio(el,item){el.style.setProperty('--ratio',(item.width&&item.height?clampRatio(item.width/item.height):4/3).toFixed(3));}
  function previewButton(item,open,{saved=false}={}){
    const button=document.createElement('button'),image=document.createElement('img');button.type='button';button.className='photo-image';
    image.src=item.thumbUrl||item.url;image.alt='';image.loading='lazy';image.decoding='async';image.draggable=false;
    image.addEventListener('load',()=>{
      button.classList.add('loaded');
      if(!item.width&&image.naturalWidth){item.width=image.naturalWidth;item.height=image.naturalHeight;const holder=button.closest('[data-photo-id]');if(holder)setRatio(holder,item);}
      if(saved&&!item.thumbUrl)backfillThumb(item,image);
    },{once:true});
    // Re-rendered images that are already decoded appear at once instead of fading in again.
    if(image.complete&&image.naturalWidth)button.classList.add('loaded');
    button.setAttribute('aria-label',item.city?.name?`Open photo in ${item.city.name}`:`Expand ${item.name||'photo'}`);button.append(image);button.addEventListener('click',event=>open(event,button));return button;
  }
  function removeButton(label,remove){
    const button=document.createElement('button');button.type='button';button.className='remove-photo';button.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>';button.title=label;button.setAttribute('aria-label',label);button.disabled=busy;button.addEventListener('click',remove);return button;
  }
  function renderReview(incremental=false){
    if(albumMotion?.scene){albumMotion.refresh=true;return;}
    const container=$('photo-review'),fragment=document.createDocumentFragment(),existing=new Set(incremental?[...container.children].map(row=>row.dataset.pendingId):[]),stops=app.getStops();
    pending.forEach((entry,index)=>{
      if(existing.has(entry.id))return;
      const row=document.createElement('div'),tools=document.createElement('div'),select=document.createElement('select'),pick=document.createElement('label'),checkbox=document.createElement('input'),mark=document.createElement('span');
      row.className='photo-tile review-photo';row.dataset.pendingId=entry.id;row.style.setProperty('--tilt',`${(hash(entry.id)%7-3)*.6}deg`);tools.className='photo-tile-tools';pick.className='photo-pick';checkbox.type='checkbox';checkbox.checked=entry.checked;checkbox.disabled=busy;checkbox.setAttribute('aria-label',`Select ${entry.name||`photo ${index+1}`}`);mark.className='photo-check';mark.innerHTML=icons.check;pick.append(checkbox,mark);
      checkbox.addEventListener('change',()=>{entry.checked=checkbox.checked;updateBulkSelection();});
      const image=previewButton(entry,(event,button)=>{
        const collection=pending.map(p=>({...p,city:p.selected==='match'?p.candidate:app.getStops().find(s=>s.id===p.selected)}));
        window.RedlinePostcards.open(collection.find(p=>p.id===entry.id),null,collection,null,button);
      });image.disabled=busy;
      cityOptions(select,'Choose city…');select.setAttribute('aria-label',`City for ${entry.name||`photo ${index+1}`}`);
      if(entry.candidate&&!entry.candidate.existing)select.add(new Option(`${entry.candidate.name} (from GPS, new stop)`,'match'));
      if(entry.selected!=='match'&&!stops.some(s=>s.id===entry.selected))entry.selected='';select.value=entry.selected;select.disabled=busy;row.classList.toggle('needs-city',!entry.selected);select.addEventListener('change',()=>{entry.selected=select.value;row.classList.toggle('needs-city',!entry.selected);updateUploadButton();});
      if(entry.candidate){const badge=document.createElement('span');badge.className='gps-badge';badge.innerHTML=icons.pin;badge.append(entry.candidate.existing?'Matched':'GPS');badge.title=`Location data suggests ${entry.candidate.name}`;tools.append(badge);}
      const remove=removeButton(`Remove ${entry.name||`photo ${index+1}`} from import`,()=>{
        URL.revokeObjectURL(entry.url);if(entry.thumbUrl)URL.revokeObjectURL(entry.thumbUrl);pending=pending.filter(p=>p.id!==entry.id);renderReview();
        (container.children[Math.min(index,pending.length-1)]?.querySelector('.remove-photo')||$('choose-photos')).focus({preventScroll:true});
      });tools.append(select);row.prepend(image,pick,remove);row.append(tools);fragment.append(row);
    });
    if(incremental)container.append(fragment);else container.replaceChildren(fragment);
    $('photo-bulk').hidden=!pending.length;
    cityOptions($('bulk-photo-city'),'Assign a city…');
    const seen=new Set();for(const entry of pending){const city=entry.candidate;if(city&&!city.existing){const key=`${city.latitude},${city.longitude}`;if(!seen.has(key)){seen.add(key);$('bulk-photo-city').add(new Option(`${city.name} (from GPS, new stop)`,`gps:${entry.id}`));}}}
    updateBulkSelection();updateUploadButton();renderPhotoMode();
  }
  function updateBulkSelection(){
    const selected=pending.filter(p=>p.checked).length,all=$('select-all-photos');all.checked=selected>0&&selected===pending.length;all.indeterminate=selected>0&&selected<pending.length;all.disabled=busy;
    $('photo-selection-count').textContent=selected?`${selected} selected`:'Select all';$('bulk-photo-city').disabled=busy||!selected;
    document.querySelectorAll('#photo-review .photo-tile').forEach(row=>{const entry=pending.find(p=>p.id===row.dataset.pendingId);row.classList.toggle('selected',!!entry?.checked);row.querySelector('input').checked=!!entry?.checked;});
  }
  $('select-all-photos').addEventListener('change',()=>{pending.forEach(entry=>entry.checked=$('select-all-photos').checked);updateBulkSelection();});
  $('bulk-photo-city').addEventListener('change',()=>{
    const value=$('bulk-photo-city').value;if(!value||busy)return;
    const candidate=value.startsWith('gps:')?pending.find(p=>p.id===value.slice(4))?.candidate:null;
    for(const entry of pending.filter(p=>p.checked)){if(candidate){entry.candidate={...candidate};entry.selected='match';}else entry.selected=value;}
    renderReview();
  });
  function updateUploadButton(){
    const ready=pending.filter(p=>p.selected).length,unassigned=pending.length-ready;
    $('upload-photos').hidden=!pending.length;$('upload-photos').disabled=busy||ready===0;
    $('upload-photos').textContent=ready?`Save ${photoLabel(ready)}`:'Save photos';
    $('photo-ready-count').textContent=unassigned?`${unassigned} need${unassigned===1?'s':''} a city`:'';
  }
  $('upload-photos').addEventListener('click',async()=>{
    if(busy)return;const ready=pending.filter(p=>p.selected);if(!ready.length)return;busy=true;photoPanelRequest++;photosRequested=false;update();renderReview();
    let firstSaved=null;
    try{
      for(const entry of ready){if(entry.selected==='match'){const stop=app.addCity(entry.candidate);entry.selected=stop.id;}}
      if(dirty)await saveCurrent();
      for(let i=0;i<ready.length;i++){
        const entry=ready[i];message('photo-message',`Saving ${i+1} of ${ready.length}…`);setProgress(i,ready.length);
        const form=new FormData();form.append('photo',entry.blob,'photo.jpg');form.append('stopId',entry.selected);
        if(entry.thumb)form.append('thumb',entry.thumb,'thumb.jpg');if(entry.width&&entry.height){form.append('width',String(entry.width));form.append('height',String(entry.height));}
        const {photo}=await api(`/trips/${current.id}/photos`,{method:'POST',body:form});photos.push(photo);firstSaved??=photo;pending=pending.filter(p=>p.id!==entry.id);URL.revokeObjectURL(entry.url);if(entry.thumbUrl)URL.revokeObjectURL(entry.thumbUrl);
      }
      message('photo-message',pending.length?'Choose a city for the remaining photos.':`${photoLabel(ready.length)} saved.`);
    }catch(error){showError('photo-message',error);}finally{
      busy=false;setProgress(0,0);update();renderReview();renderGallery();
      // Land on the page where the new photos were mounted.
      if(!pending.length&&firstSaved&&view==='album')turnTo(pageOfPhoto(firstSaved.id),{instant:true});
      if(!pending.length)$('choose-photos').focus({preventScroll:true});
    }
  });

  // Saved photos: grouped by city in route order.
  const hasPostcard=photo=>Object.values(photo.postcard||{}).some(value=>typeof value==='string'&&value.trim());
  const photoCaption=photo=>(photo.caption||'').trim();
  window.addEventListener('redline:captionchange',event=>{
    const {id,caption,revision}=event.detail,photo=photos.find(photo=>photo.id===id);if(!photo)return;
    photo.caption=caption;photo.captionRevision=revision;
    for(const figure of $('album-pages').querySelectorAll('.print')){
      if(figure.dataset.photoId!==id)continue;
      let label=figure.querySelector('figcaption');
      if(!caption){label?.remove();continue;}
      if(!label){label=document.createElement('figcaption');figure.append(label);}label.textContent=caption;
    }
  });
  function viewerActions(){
    return {
      cities:()=>app.getStops(),
      move:async(photo,stopId)=>{await movePhotos([photo.id],stopId);return photos.find(p=>p.id===photo.id)||photo;},
      remove:photo=>deletePhotos([photo.id],{ask:false})
    };
  }
  function photoGroups(){
    const groups=new Map(),stops=app.getStops(),order=new Map(stops.map((stop,index)=>[stop.id,index]));
    for(const photo of photos){const key=photo.stopId||'unplaced';if(!groups.has(key))groups.set(key,{id:key,name:photo.city?.name||'Other photos',country:photo.city?.country||'',stop:order.get(key),items:[]});groups.get(key).items.push(photo);}
    return [...groups.values()].sort((a,b)=>(a.stop??Infinity)-(b.stop??Infinity)||a.name.localeCompare(b.name));
  }
  function openPhoto(photo,group,origin){window.RedlinePostcards.open(photo,api,group.items,viewerActions(),origin);}
  function mapButton(group){
    const show=document.createElement('button');show.type='button';show.className='icon-button gallery-map-button';show.innerHTML=icons.pin;show.title=`Show ${group.name} on the map`;show.setAttribute('aria-label',`Show ${group.name} on the map`);show.disabled=busy;
    show.addEventListener('click',()=>{closePanel('photo-panel');app.focusStop?.(group.id);});return show;
  }
  function renderGallery(){
    if(albumMotion?.scene){albumMotion.refresh=true;return;}
    if(viewMotion?.scene){viewMotion.refresh=true;return;}
    const groups=photoGroups();
    if(activeCity&&!groups.some(group=>group.id===activeCity))activeCity='';
    galleryItems=groups.flatMap(group=>group.items);
    for(const id of [...chosen])if(!photos.some(photo=>photo.id===id))chosen.delete(id);
    renderTabs(groups);
    if(mode()==='album')renderAlbum();else renderSheet(groups);
    if(selecting)cityOptions($('move-photos'),'Move to…');
    updateChosen();renderPhotoMode();if(mode()==='album')warmSheet();
  }
  // City dividers stick out of the album's edge, like the tabs in a real one.
  // A focused tab keeps keyboard focus when the tabs are rebuilt, as they are after every turn.
  function renderTabs(groups){
    const chapters=albumPages(),nav=$('gallery-filter'),focused=nav.contains(document.activeElement)?document.activeElement.dataset.filter:null;
    const key=JSON.stringify([busy,groups.map(group=>[group.id,group.name,group.items.length,chapters.findIndex(page=>page.type==='city'&&page.first&&page.group.id===group.id)])]);
    if(key===tabsKey){markTab();return;}tabsKey=key;
    nav.replaceChildren(...groups.map((group,i)=>{
      const tab=document.createElement('button');tab.type='button';tab.className='album-tab';tab.dataset.filter=group.id;tab.style.setProperty('--tab',String(i%6));tab.disabled=busy;
      const page=folioOf(chapters.findIndex(page=>page.type==='city'&&page.first&&page.group.id===group.id));
      const number=document.createElement('span');number.className='chip-stop';number.textContent=String(page).padStart(2,'0');number.title=`Page ${page}`;tab.append(number);
      const name=document.createElement('span'),count=document.createElement('span');name.className='tab-name';name.textContent=group.name;count.className='chip-count';count.textContent=String(group.items.length);tab.append(name,count);
      tab.title=`${group.name} · page ${page} · ${photoLabel(group.items.length)}`;tab.setAttribute('aria-label',tab.title);tab.addEventListener('click',()=>goToCity(group.id));
      return tab;
    }));
    markTab();if(focused)[...nav.children].find(tab=>tab.dataset.filter===focused)?.focus({preventScroll:true});
  }
  // The current tab scrolls into view in a long row or column of tabs.
  function markTab(){
    const nav=$('gallery-filter');
    [...nav.children].forEach(tab=>{const on=tab.dataset.filter===activeCity;tab.setAttribute('aria-pressed',String(on));if(on)tab.setAttribute('aria-current','true');else tab.removeAttribute('aria-current');});
    const tab=nav.querySelector('[aria-current="true"]');if(!tab)return;
    // Scroll only the tab rail. scrollIntoView can move the book's hidden
    // overflow ancestors and expose the stems through its 3D pages.
    if(twoPage()){
      if(tab.offsetTop<nav.scrollTop)nav.scrollTop=tab.offsetTop;
      else if(tab.offsetTop+tab.offsetHeight>nav.scrollTop+nav.clientHeight)nav.scrollTop=tab.offsetTop+tab.offsetHeight-nav.clientHeight;
    }else{
      if(tab.offsetLeft<nav.scrollLeft)nav.scrollLeft=tab.offsetLeft;
      else if(tab.offsetLeft+tab.offsetWidth>nav.scrollLeft+nav.clientWidth)nav.scrollLeft=tab.offsetLeft+tab.offsetWidth-nav.clientWidth;
    }
  }

  function goToCity(id,{instant=false}={}){
    activeCity=id;markTab();
    if(view==='album'){const index=pages.findIndex(page=>page.type==='city'&&page.first&&page.group.id===id);if(index>=0)turnTo(index,{instant});return;}
    const section=[...$('photo-gallery').querySelectorAll('.gallery-city')].find(el=>el.dataset.stopId===id);
    if(!section)return;
    const scroll=$('photo-scroll'),top=scroll.scrollTop+section.getBoundingClientRect().top-scroll.getBoundingClientRect().top;
    // Only the sheet scrolls; the book and modal must stay fixed during a view change.
    if(instant||reduced()||!scroll.scrollTo)scroll.scrollTop=top;else scroll.scrollTo({top,behavior:'smooth'});
  }

  // ---------- The album ----------
  // Pages run cover, endpaper, title, contents, city chapters, endpaper, back cover. Side by side,
  // spread s shows pages 2s−1 and 2s, so a closed book shows only its front or its back cover.
  // `albumPage` is a page index; with two pages it is the right-hand page of the open spread.
  function mixedPhotos(items){
    const portrait=items.filter(photo=>photo.height>photo.width*1.05),landscape=items.filter(photo=>!(photo.height>photo.width*1.05));
    if(!portrait.length||!landscape.length)return items;
    // Evenly distribute the less common shape across the chapter, retaining
    // the original order within each shape and the same arrangement on reopen.
    const result=[],portraitFirst=items[0]===portrait[0];let p=0,l=0;
    while(p<portrait.length||l<landscape.length){
      const a=(p+.5)/portrait.length,b=(l+.5)/landscape.length;
      if(p<portrait.length&&(l===landscape.length||a<b||a===b&&portraitFirst))result.push(portrait[p++]);
      else result.push(landscape[l++]);
    }
    return result;
  }
  function albumPages(){
    const groups=photoGroups().map(group=>({...group,items:mixedPhotos(group.items)})),list=[{type:'cover'},{type:'inside'},{type:'title'}],rows=contentsRows();
    // Long voyages continue their contents over as many pages as they need.
    if(groups.length>1)for(let i=0;i<groups.length;i+=rows)list.push({type:'contents',groups:groups.slice(i,i+rows),continued:i>0});
    let photoPage=0;
    for(const group of groups){
      let from=0,page=0;
      while(from<group.items.length){
        const remaining=group.items.length-from;
        // An odd cadence moves the three-print layout between left and right
        // pages, continuing across chapters instead of resetting on one side.
        let room=photoPage%5===0&&!(group.items.length<=16&&group.items.length%4===0)?3:4;
        if(remaining<=4)room=remaining;else if(remaining===5)room=3;
        list.push({type:'city',group,items:group.items.slice(from,from+room),first:page===0,from});from+=room;page++;photoPage++;
      }
    }
    if(!photos.length)list.push({type:'empty'});
    // Side by side, the closing endpaper falls on a right-hand page, so the back cover closes the book alone.
    if(twoPage()&&list.length%2)list.push({type:'blank'});
    list.push({type:'inside',end:true},{type:'back'});
    return list;
  }
  // A contents page lists eight ports, or fewer on a short page: margins take about a sixth of it,
  // the heading up to two lines (about 70px, as 'continued' wraps), and each row 18px at the smallest type.
  const CONTENTS_ROWS=8;
  function contentsRows(){const book=$('album-book'),style=getComputedStyle(book),page=book.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);return page>0?Math.max(3,Math.min(CONTENTS_ROWS,Math.floor((page*.84-70)/18))):CONTENTS_ROWS;}
  const lastPage=()=>twoPage()?pages.length:pages.length-1;
  function clampPage(index){index=Math.max(0,Math.min(index,lastPage()));return twoPage()?Math.ceil(index/2)*2:index;}
  const visiblePages=index=>twoPage()?[index-1,index]:[index];
  const step=()=>twoPage()?2:1;
  function pageOfPhoto(id){pages=albumPages();return pages.findIndex(page=>page.type==='city'&&page.items.some(photo=>photo.id===id));}
  const folioOf=index=>index-1;
  function shade(kind='turn'){const el=document.createElement('span');el.className=`page-shade ${kind}`;el.setAttribute('aria-hidden','true');return el;}
  function folio(el,index,page){if(!['city','contents','empty'].includes(page.type))return;const number=document.createElement('span');number.className='folio';number.textContent=String(folioOf(index));el.append(number);}
  function printElement(photo,group,position){
    const figure=document.createElement('figure'),frame=document.createElement('div'),corners=document.createElement('span');
    figure.className='print';figure.dataset.photoId=photo.id;setRatio(figure,photo);
    figure.style.setProperty('--tilt',`${((hash(photo.id)%9)-4)*.38}deg`);
    frame.className='print-frame';corners.className='print-corners';corners.setAttribute('aria-hidden','true');
    const button=previewButton(photo,(event,origin)=>{if(Date.now()<suppressClick)return;openPhoto(photo,group,origin);},{saved:true});button.classList.add('print-photo');
    button.setAttribute('aria-label',`Open photo ${position+1} of ${group.items.length} in ${group.name}`);
    frame.append(button,corners);figure.append(frame);
    const note=photoCaption(photo);
    if(note){const caption=document.createElement('figcaption');caption.textContent=note;figure.append(caption);}
    return figure;
  }
  // Prints are arranged by shape: portraits stand side by side or run down the page beside a landscape.
  function layoutOf(items){
    const portrait=items.map(photo=>photo.width&&photo.height?photo.height>photo.width*1.05:false),n=items.length;
    if(n===2)return portrait.some(Boolean)?'n-2 side':'n-2';
    if(n===3)return portrait[0]?'n-3 tall':'n-3';
    return `n-${n}`;
  }
  function coverFace(el,back=false){
    el.classList.add(back?'album-back':'album-cover');
    el.innerHTML=back
      ?'<div class="back-mark"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-width=".9"/><path d="M20 4 22.4 17.6 36 20 22.4 22.4 20 36 17.6 22.4 4 20 17.6 17.6Z" fill="currentColor"/></svg><p>Redline</p></div>'
      :'<div class="cover-plate"><svg class="cover-emblem" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-width=".9"/><circle cx="20" cy="20" r="13.5" fill="none" stroke="currentColor" stroke-width=".5" stroke-dasharray="1 2"/><path d="M20 4 22.4 17.6 36 20 22.4 22.4 20 36 17.6 22.4 4 20 17.6 17.6Z" fill="currentColor"/></svg><p class="cover-kicker">A travel album</p><p class="cover-title"></p><span class="cover-rule"></span><p class="cover-meta"></p></div>';
    if(!back){
      el.querySelector('.cover-title').textContent=current?.title||'Photos';
      const stops=app.getStops();el.querySelector('.cover-meta').textContent=[plural(stops.length,'stop'),photoLabel(photos.length)].join(' · ');
    }
  }
  function pageElement(page,index,side){
    const el=document.createElement('section');el.className=`album-page ${side}`;el.dataset.page=String(index);el.dataset.type=page?.type||'void';
    if(!page){el.classList.add('void');el.setAttribute('aria-hidden','true');return el;}
    el.classList.add(`page-${page.type}`);
    if(page.type==='cover'||page.type==='back')coverFace(el,page.type==='back');
    else if(page.type==='inside'){
      if(!page.end){el.innerHTML='<div class="bookplate"><span class="bookplate-rule"></span><p class="bookplate-label">This album belongs to the trip</p><p class="bookplate-title"></p><span class="bookplate-rule"></span></div>';el.querySelector('.bookplate-title').textContent=current?.title||'Travels';}
    }else if(page.type==='title'){
      const stops=app.getStops(),block=document.createElement('div');block.className='title-block';
      block.innerHTML='<p class="eyebrow">Our travels</p><h3 class="album-name"></h3><p class="title-meta"></p><div class="title-map"></div><p class="title-route"></p>';
      block.querySelector('.album-name').textContent=current?.title||'Photos';
      block.querySelector('.title-meta').textContent=[plural(stops.length,'stop'),photoLabel(photos.length)].join(' · ');
      block.querySelector('.title-map').append(routeMap(stops.map(stop=>[stop.longitude,stop.latitude]),{aspect:1.6}));
      const names=stops.map(stop=>stop.name);block.querySelector('.title-route').textContent=(names.length>8?[...names.slice(0,4),'…',...names.slice(-3)]:names).join(' → ');
      el.append(block);
    }else if(page.type==='contents'){
      const block=document.createElement('div'),list=document.createElement('ol');block.className='contents';
      block.innerHTML=`<p class="eyebrow">Contents</p><h3 class="contents-title">${page.continued?'Places, continued':'Places'}</h3>`;list.className='contents-list';
      for(const group of page.groups){
        const at=pages.findIndex(other=>other.type==='city'&&other.first&&other.group===group),item=document.createElement('li'),button=document.createElement('button');
        button.type='button';button.disabled=busy;
        button.innerHTML='<span class="contents-no"></span><span class="contents-name"></span><span class="contents-dots" aria-hidden="true"></span><span class="contents-page"></span>';
        button.querySelector('.contents-no').textContent=group.stop!==undefined?stopNumber(group.stop):'·';
        button.querySelector('.contents-name').textContent=group.name;button.querySelector('.contents-page').textContent=String(folioOf(at));
        button.setAttribute('aria-label',`${group.name}, page ${folioOf(at)}`);button.addEventListener('click',()=>goToCity(group.id));
        item.append(button);list.append(item);
      }
      block.append(list);el.append(block);
    }else if(page.type==='empty'){
      const empty=document.createElement('div'),art=document.createElement('div'),label=document.createElement('p'),hint=document.createElement('p'),add=document.createElement('button');empty.className='photo-empty';
      art.className='photo-empty-art';art.innerHTML=icons.photos;label.textContent='No photos yet';hint.className='photo-empty-hint';hint.textContent='Drop photos onto the album or add them from your device. Photos with location data find their city on your route.';
      add.type='button';add.className='small-button';add.textContent='Add photos';add.disabled=busy;add.addEventListener('click',()=>$('choose-photos').click());empty.append(art,label,hint,add);el.append(empty);
    }else if(page.type==='city'){
      const {group}=page,head=document.createElement('header');head.className='page-head';
      if(page.first){
        const number=document.createElement('span'),title=document.createElement('h3'),detail=document.createElement('p');
        number.className='page-stop';number.textContent=group.stop!==undefined?`Stop ${stopNumber(group.stop)}`:'Elsewhere';
        title.className='city-name';title.textContent=group.name;detail.className='page-country';detail.textContent=[group.country,photoLabel(group.items.length)].filter(Boolean).join(' · ');
        head.append(number,title,detail);if(group.stop!==undefined)head.append(mapButton(group));
      }else{head.classList.add('continued');head.textContent=`${group.name}, continued`;}
      const prints=document.createElement('div');prints.className=`prints ${layoutOf(page.items)}`;
      page.items.forEach((photo,i)=>prints.append(printElement(photo,group,page.from+i)));
      el.append(head,prints);
    }
    folio(el,index,page);
    if(!['cover','back','blank'].includes(page.type)||(side==='single'&&page.type!=='back')){
      const corner=document.createElement('button');corner.type='button';corner.className='page-corner';corner.tabIndex=-1;corner.setAttribute('aria-hidden','true');
      corner.addEventListener('click',()=>turnTo(shownPage()+(side==='left'?-1:1)*step()));el.append(corner);
    }
    return el;
  }
  function stateClasses(index){
    const book=$('album-book'),last=lastPage();
    book.classList.toggle('closed-front',index===0);book.classList.toggle('closed-back',index===last);
    // The page block thickens on the side already read.
    const read=last?index/last:0;$('album-pages').style.setProperty('--read',read.toFixed(3));
  }
  // Page numbers change with the layout (one page or two, and how many ports a contents page holds),
  // so the album keeps its place by what is on the page: the back cover, the endpapers, or the same page.
  function placeAt(index,two){
    if(drawn?.place&&index===albumPage&&two===drawn.two)return drawn.place;
    const shown=(two?[index-1,index]:[index]).map(i=>pages[i]);
    if(shown.some(other=>other?.type==='back'))return {back:true,index};
    // The chosen city's page anchors the place, or else the first page with something on it.
    const page=shown.find(other=>other?.type==='city'&&other.group.id===activeCity)||shown.find(other=>other&&other.type!=='blank'&&!other.end);
    if(!page)return {end:true,index};
    return {type:page.type,id:page.group?.id??page.groups?.[0]?.id,from:page.from,index};
  }
  function pageAt(place){
    if(place.back)return lastPage();
    const found=pages.findIndex(page=>place.end?page.end:page.type===place.type&&!page.end&&(page.group?page.group.id===place.id&&page.from===place.from:!page.groups||page.groups.some(group=>group.id===place.id)));
    return found<0?place.index:found;
  }
  function renderAlbum(){
    if(turning){const token=turning;turning=null;token.animations.forEach(animation=>animation.cancel());albumPage=token.target;}
    const two=twoPage(),rows=contentsRows(),reflow=drawn&&(drawn.two!==two||drawn.rows!==rows),place=reopen||(reflow?placeAt(albumPage,drawn.two):null);
    reopen=null;pages=albumPages();albumPage=clampPage(place?pageAt(place):albumPage);drawn={two,rows,trip:current?.id,place:reflow?place:null};
    const root=$('album-pages');root.classList.toggle('single',!two);
    root.replaceChildren(...visiblePages(albumPage).map((index,i)=>pageElement(pages[index],index,two?(i?'right':'left'):'single')));
    stateClasses(albumPage);updateAlbumNav();
  }
  // The cities on these pages, left page first.
  const citiesAt=index=>[...new Map(visiblePages(index).map(i=>pages[i]).filter(page=>page?.type==='city').map(page=>[page.group.id,page.group])).values()];
  // The page label and tabs follow a turn as soon as it starts.
  function updateAlbumNav(at=albumPage){
    const last=lastPage(),cities=citiesAt(at),shown=visiblePages(at).filter(i=>['city','contents','empty'].includes(pages[i]?.type));
    $('album-previous').disabled=at<=0;$('album-next').disabled=at>=last;
    const types=visiblePages(at).map(i=>pages[i]?.type);
    const where=types.includes('cover')?'Front cover':types.includes('back')?'Back cover':types.includes('title')?'Title page':cities.length?cities.map(city=>city.name).join(' & '):types.includes('contents')?'Contents':types.includes('empty')?'No photos yet':'Endpapers';
    $('album-position').textContent=[where,shown.length&&!types.includes('title')?`${shown.length>1?'pages':'page'} ${shown.map(folioOf).join('–')}`:''].filter(Boolean).join(' · ');
    // The slider speaks the same page names and numbers as the label.
    const scrub=$('album-scrub');scrub.min='0';scrub.max=String(last);scrub.step=String(step());scrub.value=String(at);scrub.disabled=!last;scrub.setAttribute('aria-valuetext',$('album-position').textContent);
    // Keep the chosen tab when its city shares these pages; otherwise follow the first city on them.
    if(cities.length&&!cities.some(city=>city.id===activeCity))activeCity=cities[0].id;markTab();warmPreviews();
  }
  function preload(index){for(const i of visiblePages(index))for(const photo of pages[i]?.items||[]){const image=new Image();image.decoding='async';image.src=photo.thumbUrl||photo.url;}}
  // Focus on a page that turned away (a contents entry, say) moves to the current tab, so the keyboard keeps its place.
  function keepAlbumFocus(had){
    const active=document.activeElement;if(!had||active&&active!==document.body)return;
    const tab=[...$('gallery-filter').children].find(el=>el.getAttribute('aria-current')==='true');
    (tab&&!$('gallery-filter').inert?tab:$('album-next').disabled?$('album-previous'):$('album-next')).focus({preventScroll:true});
  }
  // A page turns over its spine: the leaf carries the old page on its front and the next on its back.
  async function turnTo(target,{instant=false,duration=null,settle=true}={}){
    if(!pages.length)pages=albumPages();
    // A second press toward the page already turning to lets that turn finish.
    if(turning&&!instant&&clampPage(target)===turning.target)return;
    let had=$('album-pages').contains(document.activeElement);
    if(turning){const token=turning;turning=null;had||=token.had;token.animations.forEach(animation=>animation.cancel());albumPage=token.target;}
    target=clampPage(target);
    if(target===albumPage){renderAlbum();keepAlbumFocus(had);return;}
    const from=albumPage,forward=target>from,root=$('album-pages');
    if(instant||!canAnimate(root)||!$('photo-panel').open){albumPage=target;renderAlbum();keepAlbumFocus(had);preload(target+(forward?1:-1)*step());return;}
    const coverTurn=[from,target].some(index=>index===0||index===lastPage());
    const timing={duration:duration??(coverTurn?900:Math.min(1000,720+Math.abs(target-from)*12)),easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'};
    $('album-book').style.setProperty('--turn-duration',`${timing.duration}ms`);
    const token={target,animations:[],had};turning=token;
    if(twoPage()){
      const left=forward?from-1:target-1,right=forward?target:from,frontIndex=forward?from:from-1,backIndex=forward?target-1:target;
      const under=[pageElement(pages[left],left,'left'),pageElement(pages[right],right,'right')];
      const leaf=document.createElement('div'),front=pageElement(pages[frontIndex],frontIndex,forward?'right':'left'),back=pageElement(pages[backIndex],backIndex,forward?'left':'right');
      leaf.className=`album-leaf ${forward?'turn-forward':'turn-back'}`;front.classList.add('leaf-face','leaf-front');back.classList.add('leaf-face','leaf-back');
      const frontShade=shade(),backShade=shade(),cast=shade('cast');front.append(frontShade);back.append(backShade);under[forward?1:0].append(cast);
      leaf.append(front,back);root.replaceChildren(...under,leaf);stateClasses(target);updateAlbumNav(target);
      token.animations.push(...RedlineAlbumMotion.turnLeaf({leaf,frontShade,backShade,cast,forward,duration:timing.duration}));
    }else{
      const below=pageElement(pages[forward?target:from],forward?target:from,'single'),above=pageElement(pages[forward?from:target],forward?from:target,'single');
      above.classList.add('single-leaf');root.replaceChildren(below,above);stateClasses(target);updateAlbumNav(target);
      token.animations.push(...RedlineAlbumMotion.turnLeaf({leaf:above,forward,two:false,duration:duration??560}));
    }
    await Promise.all(token.animations.map(animation=>animation.finished)).catch(()=>{});
    if(turning!==token)return;albumPage=target;if(!settle)return;turning=null;renderGallery();keepAlbumFocus(had);preload(target+(forward?1:-1)*step());
  }
  $('album-previous').addEventListener('click',()=>turnTo(shownPage()-step()));
  $('album-next').addEventListener('click',()=>turnTo(shownPage()+step()));
  $('album-scrub').addEventListener('input',()=>turnTo(Number($('album-scrub').value),{instant:true}));
  let swipe=null,suppressClick=0;
  $('album-pages').addEventListener('pointerdown',event=>{swipe=event.pointerType==='touch'?{x:event.clientX,y:event.clientY,id:event.pointerId}:null;});
  $('album-pages').addEventListener('pointerup',event=>{
    if(!swipe||swipe.id!==event.pointerId)return;const dx=event.clientX-swipe.x,dy=event.clientY-swipe.y;swipe=null;
    if(Math.abs(dx)<50||Math.abs(dx)<Math.abs(dy)*1.4)return;
    suppressClick=Date.now()+400;turnTo(shownPage()+(dx<0?1:-1)*step());
  });

  // "All photos": a contact sheet, where photos are selected, moved, and deleted.
  function renderSheet(groups){
    const container=$('photo-gallery');
    const key=JSON.stringify([current?.id,busy,selecting,groups.map(group=>[group.id,group.name,group.country,group.stop,group.items.map(photo=>[photo.id,photo.thumbUrl||photo.url,photo.captionRevision,photo.postcardRevision,hasPostcard(photo)])])]);
    if(sheetKey===key)return;sheetKey=key;
    const fragment=document.createDocumentFragment();
    if(!photos.length){
      const empty=document.createElement('div'),art=document.createElement('div'),label=document.createElement('p'),hint=document.createElement('p'),add=document.createElement('button');empty.className='photo-empty';
      art.innerHTML=icons.photos;art.className='photo-empty-art';label.textContent='No photos yet';hint.className='photo-empty-hint';hint.textContent='Drop photos here or add them from your device. Photos with location data find their city on your route.';
      add.type='button';add.className='small-button';add.textContent='Add photos';add.disabled=busy;add.addEventListener('click',()=>$('choose-photos').click());empty.append(art,label,hint,add);fragment.append(empty);
    }
    for(const group of groups){
      const section=document.createElement('section'),top=document.createElement('div'),place=document.createElement('div'),heading=document.createElement('h3'),count=document.createElement('span'),grid=document.createElement('div');
      section.className='gallery-city';section.dataset.stopId=group.id;top.className='gallery-city-heading';heading.textContent=group.name;count.className='gallery-city-count';count.textContent=photoLabel(group.items.length);
      if(group.stop!==undefined){const number=document.createElement('span');number.className='gallery-stop-number';number.textContent=stopNumber(group.stop);top.append(number);}
      place.className='gallery-city-place';place.append(heading);
      if(group.country){const detail=document.createElement('p');detail.className='gallery-city-country';detail.textContent=group.country;place.append(detail);}
      top.append(place,count);if(group.stop!==undefined)top.append(mapButton(group));
      grid.className='photo-grid';
      group.items.forEach((photo,i)=>{
        const tile=document.createElement('div');tile.className='photo-tile';tile.dataset.photoId=photo.id;
        const button=previewButton(photo,(event,origin)=>{if(selecting){toggleChosen(photo.id,event.shiftKey);return;}openPhoto(photo,group,origin);},{saved:true});
        button.setAttribute('aria-label',`${selecting?'Select':'Open'} photo ${i+1} in ${group.name}`);
        if(selecting){button.setAttribute('aria-pressed',String(chosen.has(photo.id)));const mark=document.createElement('span');mark.className='photo-check';mark.innerHTML=icons.check;tile.append(mark);}
        if(hasPostcard(photo)){const card=document.createElement('span');card.className='postcard-badge';card.title='Postcard written';card.innerHTML=icons.postcard;tile.append(card);}
        tile.prepend(button);grid.append(tile);
      });
      section.append(top,grid);fragment.append(section);
    }
    container.replaceChildren(fragment);
  }
  function setSelecting(value){
    if(selecting===value)return;selecting=value;chosen.clear();anchor=null;
    if(value&&view!=='sheet'){view='sheet';}
    if($('photo-panel').open)renderGallery();else renderPhotoMode();
  }
  // Shift-click selects every photo between the last photo clicked and this one, like Photos.
  function toggleChosen(id,range=false){
    const order=galleryItems.map(photo=>photo.id),from=order.indexOf(anchor),to=order.indexOf(id);
    if(range&&from>=0&&to>=0){for(const key of order.slice(Math.min(from,to),Math.max(from,to)+1))chosen.add(key);}
    else{if(chosen.has(id))chosen.delete(id);else chosen.add(id);anchor=id;}
    updateChosen();
  }
  function updateChosen(){
    const count=chosen.size,visible=galleryItems.length;
    $('gallery-selection-count').textContent=count?`${count} selected`:'Tap photos to select';
    $('select-visible').textContent=count&&galleryItems.every(photo=>chosen.has(photo.id))?'Clear':'Select all';
    $('select-visible').disabled=busy||!visible;$('move-photos').disabled=busy||!count;$('delete-photos').disabled=busy||!count;
    document.querySelectorAll('#photo-gallery .photo-tile').forEach(tile=>{const on=chosen.has(tile.dataset.photoId);tile.classList.toggle('chosen',on);if(selecting)tile.querySelector('.photo-image')?.setAttribute('aria-pressed',String(on));});
  }
  // Select, a bulk move, or a bulk delete can hide or disable the focused control; focus moves to Done, Select, or the album.
  function keepFocus(){const at=document.activeElement,gone=el=>!el||el===document.body||el.disabled||!!el.closest('[hidden]');if($('photo-panel').open&&gone(at))[selecting&&$('done-selecting'),$('select-photos'),$('photo-panel')].find(el=>el&&!gone(el))?.focus({preventScroll:true});}
  $('select-photos').addEventListener('click',()=>{setSelecting(!selecting);keepFocus();});
  $('done-selecting').addEventListener('click',()=>{setSelecting(false);$('select-photos').focus({preventScroll:true});});
  $('select-visible').addEventListener('click',()=>{const all=galleryItems.every(photo=>chosen.has(photo.id));for(const photo of galleryItems)all?chosen.delete(photo.id):chosen.add(photo.id);updateChosen();});
  $('move-photos').addEventListener('change',()=>{const stopId=$('move-photos').value;$('move-photos').value='';if(stopId&&chosen.size)movePhotos([...chosen],stopId).catch(()=>{}).then(keepFocus);});
  $('delete-photos').addEventListener('click',()=>{if(chosen.size)deletePhotos([...chosen]).catch(()=>{}).then(keepFocus);});
  async function movePhotos(ids,stopId){
    if(busy||!current)throw Error('Please wait for the current change to finish.');
    busy=true;update();
    try{
      if(dirty)await saveCurrent();
      const {photos:moved}=await api(`/trips/${current.id}/photos`,{method:'PUT',body:JSON.stringify({ids,stopId})});
      for(const result of moved)Object.assign(photos.find(photo=>photo.id===result.id)||{},{stopId:result.stopId,city:result.city});
      const city=moved[0]?.city?.name||'that city';chosen.clear();if(selecting)setSelecting(false);
      message('photo-message',`Moved ${photoLabel(moved.length)} to ${city}.`);
    }catch(error){showError('photo-message',error);throw error;}
    finally{busy=false;update();renderGallery();}
  }
  async function deletePhotos(ids,{ask=true}={}){
    if(busy||!current)throw Error('Please wait for the current change to finish.');
    if(ask&&!confirm(`Delete ${photoLabel(ids.length)} and ${ids.length===1?'its postcard':'their postcards'}? This can’t be undone.`))return false;
    busy=true;update();
    try{
      await api(`/trips/${current.id}/photos`,{method:'DELETE',body:JSON.stringify({ids})});
      const gone=new Set(ids);photos=photos.filter(photo=>!gone.has(photo.id));ids.forEach(id=>{window.RedlinePostcards.forget(id);chosen.delete(id);});
      if(selecting&&!photos.length)setSelecting(false);
      message('photo-message',`${photoLabel(ids.length)} deleted.`);return true;
    }catch(error){showError('photo-message',error);throw error;}
    finally{busy=false;update();renderGallery();}
  }
  async function restore(){
    if(!current){update();return;}
    const cached=current,initial=fingerprint(),photoVersion=photoPanelRequest;dirty=initial!==cached.hash;
    // Older versions regenerated default stop IDs. Equal city content is still a clean route.
    try{if(dirty&&routeContent(app.getStops())===routeContent(JSON.parse(cached.hash)))dirty=false;}catch{}
    update();
    try{
      const data=await api(`/trips/${cached.id}`);if(current!==cached)return;
      if(photoVersion===photoPanelRequest)photos=data.photos;
      if(!dirty&&fingerprint()===initial){suppress=true;app.setStops(data.trip.stops);suppress=false;current={id:data.trip.id,title:data.trip.title,revision:data.trip.revision,hash:fingerprint()};remember();}
      if($('photo-panel').open)renderGallery();update();
    }catch(error){if(current!==cached)return;if(error.status===404){current=null;photos=[];remember();update();}else{openTrips();showError('trip-message',error);}}
    finally{suppress=false;}
  }
  function downloadBackup(blob,name){
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.hidden=true;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  async function exportTrips(all,tripId=current?.id){
    if(busy)return;const focus=listFocus();let saved=false;busy=true;update();
    try{
      const own=!!current&&(all||tripId===current.id);
      if(own&&dirty){if(!current)throw Error('Name and save this trip before exporting.');await saveCurrent();saved=true;}
      if(own&&pending.length)throw Error('Save the pending photos before exporting.');
      if(!all&&!tripId)throw Error('Name and save this trip before exporting.');
      const blob=await window.RedlineStorage.exportArchive(all?null:tripId);
      const title=all?'Redline-backup':(tripCache.find(trip=>trip.id===tripId)?.title||current?.title||'Redline-trip');
      downloadBackup(blob,`${title.replace(/[^a-zA-Z0-9_-]+/g,'-')}.redline`);
      try{await window.RedlineStorage.recordBackup(blob);saved=true;message('trip-message','Backup downloaded. Keep it somewhere private.');}
      catch{message('trip-message','Backup downloaded, but its date could not be recorded in the logbook.',true);}
    }catch(error){showError('trip-message',error);}finally{busy=false;update();if(saved)await refreshLogbook(focus);}
  }
  $('export-trip').addEventListener('click',()=>exportTrips(false));
  $('backup-trips').addEventListener('click',()=>exportTrips(true));
  $('import-trips').addEventListener('click',()=>$('trip-backup-file').click());
  $('trip-backup-file').addEventListener('change',async event=>{
    const file=event.target.files[0];event.target.value='';if(!file||busy)return;
    busy=true;update();message('trip-message','Importing…');
    try{const result=await window.RedlineStorage.importArchive(file);await listTrips();message('trip-message',`${result.tripCount} trip${result.tripCount===1?'':'s'} imported.`);}
    catch(error){showError('trip-message',error);}finally{busy=false;update();}
  });
  restore();
})();
