(() => {
  'use strict';
  const $=id=>document.getElementById(id),app=window.RedlineApp,SVG='http://www.w3.org/2000/svg';
  let current=null,photos=[],pending=[],busy=false,dirty=false,suppress=false,resumePhotos=false,cityIndex=null,cityIndexRequest=null,exifReady=null,photoPanelRequest=0,photosRequested=false;
  let activeCity='',galleryItems=[],importing=false,photoMode='',dragDepth=0,selecting=false,thumbQueue=Promise.resolve();
  const reviewPageSize=70;
  let reviewPage=0,reviewTurn=null;
  let warmOriginals=new Set(),sheetKey='',tabsKey='',sheetWarmTimer=0,tabColumns=1,sheetFollow=0,tabJump=false,sheetHeld=null;
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
  // The open trip and its route are kept together, per tab, so a reload can never attach another tab's route to this trip. localStorage only starts a fresh tab.
  const TAB_STATE='redline-tab-state-v1';
  const storedState=store=>{try{return JSON.parse(store().getItem(TAB_STATE)||'null');}catch{return null;}};
  const usableDraft=draft=>Array.isArray(draft)&&draft.length<=100&&draft.every(p=>p&&typeof p.name==='string'&&p.name.length<=120&&Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180);
  const tabState=[storedState(()=>sessionStorage),storedState(()=>localStorage)].find(state=>usableDraft(state?.draft));
  let bootDraft=null,stale=false,storageFull=false,backupOffer=null,cityDownload=null;
  if(tabState){current=tabState.current;bootDraft=tabState.draft;}
  else try{current=JSON.parse(localStorage.getItem('redline-saved-trip')||'null');}catch{}
  if(current&&(!current.id||!Number.isInteger(current.revision)))current=null;
  function remember(){
    const state=JSON.stringify({current,draft:app.getStops()});
    for(const write of [()=>sessionStorage.setItem(TAB_STATE,state),()=>localStorage.setItem(TAB_STATE,state),()=>localStorage.removeItem('redline-saved-trip')])try{write();}catch{}
  }
  function update(){
    $('trip-title').textContent=current?.title||'';
    $('save-trip').classList.toggle('dirty',dirty);
    $('photo-count').textContent=photos.length?String(photos.length):'';
    $('save-trip').disabled=busy;$('new-trip').disabled=busy;$('choose-photos').disabled=busy;$('trips-button').disabled=busy;
    $('export-trip').disabled=busy||!current;$('backup-trips').disabled=busy;$('import-trips').disabled=busy;
    document.querySelectorAll('#photo-gallery button,#album-pages button,#photo-review button,#photo-review input,#photo-review select,#gallery-filter button,#gallery-actions button,#gallery-actions select,#trip-list button,#trip-list input,#backup-list button,#trip-message button').forEach(el=>el.disabled=busy);
    $('cancel-photo-import').disabled=busy;$('select-photos').disabled=busy;
    updateCurrentTrip();updateBulkSelection();updateUploadButton();updateChosen();renderPhotoMode();
  }
  const messageTimers={};
  // Album notes fade away on their own; errors stay until something else is said.
  function message(id,text,error=false){
    const el=$(id);el.replaceChildren();el.textContent=text||'';el.classList.toggle('error',error);clearTimeout(messageTimers[id]);
    if(id==='photo-message'&&text&&!error&&!/…$/.test(text))messageTimers[id]=setTimeout(()=>{if(el.textContent===text)el.textContent='';},4200);
    // Parts of a backup still to download stay on offer, because a forgotten part would be a lost part.
    if(id==='trip-message'&&!text)showBackupOffer();
  }
  function showError(id,error){message(id,error.message||'Please try again.',true);}
  const api=(path,options={})=>window.RedlineStorage.api(path,options);

  // Route maps show the same painted sheet as the main map, cut to the route. Paintings are kept for reuse.
  const sheetCuts=new Map();
  function paintedSheet(box){
    const atlas=app.atlas,key=[box.x,box.y,box.w,box.h].map(n=>n.toFixed(1)).join();
    if(!atlas?.supported)return Promise.resolve(null);
    if(sheetCuts.has(key))return sheetCuts.get(key);
    const job=(async()=>{
      const width=720,height=Math.round(width/Math.max(.5,box.w/box.h)),bitmap=await atlas.paintRegion(box,width,height,1.4);if(!bitmap)return null;
      const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close?.();
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.86));return blob?URL.createObjectURL(blob):null;
    })();
    sheetCuts.set(key,job);
    if(sheetCuts.size>32){const [oldest,value]=sheetCuts.entries().next().value;sheetCuts.delete(oldest);value.then(url=>{if(url)URL.revokeObjectURL(url);});}
    return job;
  }
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
    svg.append(node('rect',{x:-1440,y:-720,width:4320,height:2160,class:'route-map-sea'}),node('use',{href:'#land',class:'route-map-land'}));
    paintedSheet(box).then(url=>{if(!url)return;const image=node('image',{x:box.x,y:box.y,width:box.w,height:box.h,preserveAspectRatio:'none',href:url});svg.children[1]?.after(image);});
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
  const albumPanel=$('photo-panel'),fullscreenButton=$('album-fullscreen');
  const index=$('album-index'),drawer=$('album-drawer'),edge=$('album-edge'),tabs=$('gallery-filter');
  const reading=()=>albumPanel.classList.contains('expanded');
  const coverReading=()=>reading()&&$('album-book').dataset.mode==='album'&&$('album-book').classList.contains('closed-front');
  let indexCloseTimer=0,windowMotion=null;
  function stopWindowMotion(){
    windowMotion?.cancel();windowMotion=null;delete $('album-book').dataset.windowMotion;
  }
  function beginBookResize(){
    const book=$('album-book'),before=book.getBoundingClientRect();
    stopWindowMotion();book.dataset.windowMotion='true';return before;
  }
  function finishBookResize(before,duration=520){
    const book=$('album-book'),after=book.getBoundingClientRect();
    if(!before?.width||!after.width||!canAnimate(book)||Math.abs(before.width-after.width)+Math.abs(before.height-after.height)+Math.abs(before.left-after.left)+Math.abs(before.top-after.top)<1){stopWindowMotion();return;}
    const motion=book.animate([
      {transformOrigin:'0 0',transform:`translate(${before.left-after.left}px, ${before.top-after.top}px) scale(${before.width/after.width}, ${before.height/after.height})`},
      {transformOrigin:'0 0',transform:'none'}
    ],{duration,easing:'cubic-bezier(.22,.75,.2,1)',fill:'both'});
    windowMotion=motion;
    motion.finished.catch(()=>{}).then(()=>{if(windowMotion===motion){windowMotion=null;motion.cancel();delete book.dataset.windowMotion;}});
  }
  function syncWindowCover(){
    const cover=coverReading(),changed=albumPanel.classList.contains('cover-view')!==cover;
    albumPanel.classList.toggle('cover-view',cover);
    // The cover over the map and the full window are different books, with different rails.
    if(changed){showIndex(false);renderTabs(photoGroups());}
    else tabs.inert=tabs.classList.contains('away')||reading()&&!cover&&!albumPanel.classList.contains('index-open');
  }
  function showIndex(open){
    clearTimeout(indexCloseTimer);indexCloseTimer=0;
    if(coverReading())open=false;
    // Only uncovering the rail finds the current tab: the pointer drifting back onto an open rail keeps its scroll.
    const uncovering=open&&!albumPanel.classList.contains('index-open');
    drawer.inert=!open&&!coverReading();tabs.inert=tabs.classList.contains('away')||reading()&&!coverReading()&&!open;
    albumPanel.classList.toggle('index-open',reading()&&open);
    edge.setAttribute('aria-expanded',String(open));
    if(uncovering)markTab();
  }
  const toolbar=$('album-toolbar'),topEdge=$('album-top-edge');
  function showToolbar(open){
    topEdge.setAttribute('aria-expanded',String(open));
    toolbar.inert=reading()&&!open;
  }
  topEdge.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch')showToolbar(true);});
  topEdge.addEventListener('click',()=>{showToolbar(true);$('album-view').focus({preventScroll:true});});
  toolbar.addEventListener('pointerleave',event=>{
    if(reading()&&event.pointerType!=='touch'&&!toolbar.matches(':has(:focus-visible)'))showToolbar(false);
  });
  toolbar.addEventListener('focusout',event=>{if(reading()&&!toolbar.contains(event.relatedTarget))showToolbar(false);});
  function windowView(expanded,restoreFocus=true){
    if(expanded===reading())return;
    finishReviewTurn();settleView();
    if(turning)renderAlbum();
    // The sheet's columns change with the window, so its place is kept by the print at the top.
    const place=mode()==='sheet'?sheetPlace():null,before=restoreFocus?beginBookResize():null;
    if(expanded&&tabs.contains(document.activeElement))albumPanel.focus({preventScroll:true});
    albumPanel.classList.toggle('expanded',expanded);
    fullscreenButton.setAttribute('aria-pressed',String(expanded));
    index.hidden=topEdge.hidden=!expanded;
    showToolbar(false);
    fullscreenButton.setAttribute('aria-label',expanded?'Exit window view':'Fill window with album');
    fullscreenButton.title=expanded?'Exit window view (F or Esc)':'Fill window (F) · Top edge for toolbar · Right edge for city tabs';
    showIndex(false);
    if(mode()==='album')renderGallery();
    syncWindowCover();
    // The rail is a different height here, in every mode.
    renderTabs(photoGroups());
    keepSheetPlace(place);
    if(expanded||restoreFocus)(expanded?albumPanel:fullscreenButton).focus({preventScroll:true});
    if(before)finishBookResize(before);
  }
  fullscreenButton.addEventListener('click',()=>windowView(!reading()));
  $('album-restore').addEventListener('click',()=>windowView(false));
  edge.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch')showIndex(true);});
  edge.addEventListener('click',()=>{
    showIndex(true);
    (tabs.querySelector('[aria-current="true"]')||tabs.firstElementChild||$('album-restore')).focus({preventScroll:true});
  });
  const onIndex=node=>node&&(index.contains(node)||drawer.contains(node)||tabs.contains(node));
  const indexFocused=()=>onIndex(document.activeElement);
  const inIndexReach=event=>onIndex(event.target)||event.clientX>=Math.min(innerWidth-180,tabs.getBoundingClientRect().left-24);
  function leaveIndex(){
    if(!reading()||indexFocused()||indexCloseTimer)return;
    indexCloseTimer=setTimeout(()=>{indexCloseTimer=0;if(!indexFocused())showIndex(false);},220);
  }
  for(const rail of [index,drawer,tabs]){
    // A tab moves beneath the cursor as the book slides. Leaving one small
    // element is not leaving the index: the entire right-side corridor stays open.
    rail.addEventListener('pointerenter',()=>{if(reading())showIndex(true);});
    rail.addEventListener('focusout',event=>{if(reading()&&!onIndex(event.relatedTarget))showIndex(false);});
  }
  tabs.addEventListener('focusin',()=>{if(reading())showIndex(true);});
  albumPanel.addEventListener('pointermove',event=>{
    if(reading()&&event.pointerType!=='touch'&&albumPanel.classList.contains('index-open')&&!onIndex(event.target)&&!indexFocused()){
      if(inIndexReach(event)){clearTimeout(indexCloseTimer);indexCloseTimer=0;}
      else leaveIndex();
    }
    // A skim through the top edge never entered the toolbar, so its own pointerleave cannot put it away. offsetHeight ignores the slide, so it can still be reached mid-motion.
    if(topEdge.getAttribute('aria-expanded')==='true'&&reading()&&event.pointerType!=='touch'&&event.target!==topEdge&&!toolbar.contains(event.target)&&event.clientY>toolbar.offsetHeight+24&&!toolbar.matches(':has(:focus-visible)'))showToolbar(false);
  });
  albumPanel.addEventListener('pointerleave',event=>{if(event.pointerType!=='touch')leaveIndex();});
  albumPanel.addEventListener('pointerdown',event=>{
    if(reading()&&!inIndexReach(event))showIndex(false);
    if(reading()&&event.target!==topEdge&&!toolbar.contains(event.target))showToolbar(false);
  });
  $('gallery-filter').addEventListener('click',event=>{
    if(reading()&&event.target.closest('.album-tab')){showIndex(false);albumPanel.focus({preventScroll:true});}
  });
  function finishAlbumClose(focus){
    stopWindowMotion();clearTimeout(indexCloseTimer);
    clearTimeout(sheetWarmTimer);clearTimeout(sheetFollow);sheetFollow=0;tabJump=false;sheetHeld=null;
    window.RedlineAlbumMotion.clearPreloads();
    $('photos-button').setAttribute('aria-expanded','false');
    if($('photo-panel').open)$('photo-panel').close();
    // Native close hides immediately; animation cleanup cannot flash into view.
    if(turning){const token=turning;turning=null;token.animations.forEach(animation=>animation.cancel());}
    albumMotion?.scene?.dispose();delete $('album-book').dataset.preparing;
    $('album-pages').replaceChildren();
    // Retain previews only for an open album, not while exploring the map.
    $('photo-gallery').replaceChildren();sheetKey='';
    const queued=albumMotion?.queued;
    albumMotion=null;delete $('photo-panel').dataset.departing;$('photo-panel').style.removeProperty('--album-exit-delay');photosRequested=false;dragDepth=0;$('photo-drop-hint').hidden=true;
    setSelecting(false);renderPhotoMode();document.body.classList.remove('sheet-open');
    if(!focus&&!$('trip-panel').hidden)$('trip-panel').focus({preventScroll:true});
    else restorePanelFocus('photo-panel',focus);
    const after=afterAlbumClose;afterAlbumClose=null;after?.();
    // Photos dropped on a book that was shutting go on to review rather than vanish.
    if(queued)showPhotos().then(()=>importPhotos(queued));
  }
  let afterAlbumClose=null;
  function closePanel(id,{focus=false}={}){
    if(id==='trip-panel'){
      $(id).hidden=true;$('trip-switcher').open=false;closeTripMenus();app.refreshLayout?.();
      $(triggers[id]).setAttribute('aria-expanded','false');restorePanelFocus(id,focus);return;
    }
    if(albumMotion?.phase==='closing')return;
    finishReviewTurn();settleView();
    // A book closed from window view folds down through its size instead of snapping to the smaller one first. Any shrink still running is stopped, so the cover measures the real book.
    const folding=reading()&&$(id).open?beginBookResize():null;
    windowView(false,false);if(!folding)stopWindowMotion();
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
    if(folding)finishBookResize(folding);
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
  document.addEventListener('keydown',event=>{if(isOpen('trip-panel')&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.isComposing&&!document.querySelector('dialog[open]')&&!event.target.closest?.('input,textarea,select,[contenteditable="true"],#trip-panel,dialog')&&(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','Backspace','Delete'].includes(event.key)||[' ','Enter'].includes(event.key)&&!event.target.closest?.('button,a,[role=button]')))closePanel('trip-panel');},true);
  {
    const panel=$('photo-panel');
    panel.addEventListener('close',()=>{if(!panel.open&&$('photos-button').getAttribute('aria-expanded')==='true')closePanel('photo-panel');});
    panel.addEventListener('cancel',event=>{event.preventDefault();if(panel.classList.contains('expanded')){windowView(false);return;}if(selecting){setSelecting(false);$('select-photos').focus({preventScroll:true});return;}closePanel('photo-panel',{focus:true});});
    let pressed=null;panel.addEventListener('pointerdown',event=>{pressed=viewMotion||reviewTurn?null:event.target;});
    panel.addEventListener('click',event=>{
      // Only a press and release on the backdrop closes; a drag that ends there does not.
      const started=pressed;pressed=null;if(started!==event.target)return;
      // The turning book is inert, so a press or release on it would otherwise fall through to the stage and shut the album.
      if(viewMotion||reviewTurn)return;
      const target=event.target,book=$('album-book'),shut=mode()==='album'&&book.matches('.closed-front,.closed-back');
      // Empty foot and header look like plain map, and so does the box around a shut book or between far-apart tabs. A near miss on a tab does not count.
      const near=(nodes,reach)=>[...nodes].some(node=>{const r=node.getBoundingClientRect();return r.right>r.left&&event.clientX>=r.left-reach&&event.clientX<=r.right+reach&&event.clientY>=r.top-reach&&event.clientY<=r.bottom+reach;});
      const beside=target===tabs&&!near(tabs.children,4);
      if(target.matches?.('.album-foot,.album-top')&&near(target.querySelectorAll('button,input,select'),8))return;
      if(!(target===panel||beside||target.matches?.('.album-stage,.album-foot,.album-top,.album-title,#album-display')||shut&&(target===book||target===$('album-pages'))))return;
      // Window view fills the screen, so nothing there is outside the album: a stray click only folds the tabs away, and the toolbar is not a way out.
      if(reading()&&!coverReading()){showIndex(false);return;}
      if(reading()&&toolbar.contains(target))return;
      closePanel('photo-panel',{focus:'map'});
    });
  }
  function discardPending(){pending.forEach(p=>{URL.revokeObjectURL(p.url);if(p.thumbUrl)URL.revokeObjectURL(p.thumbUrl);});pending=[];storageFull=false;renderReview();if($('photo-panel').open)renderGallery();}
  function canSwitch(){return !(dirty||pending.length)||confirm('Discard unsaved changes and switch trips?');}
  // A trip deleted elsewhere leaves nothing to save over. Its route and any pending photos stay here, ready to save as a new trip.
  const missingTrip='This trip is no longer in this browser. Name it to save the route again, or import a backup.';
  function detachMissingTrip(){photoPanelRequest++;photos.forEach(p=>window.RedlinePostcards.forget(p.id));photos=[];current=null;activeCity='';stale=false;dirty=app.getStops().length>0;remember();renderGallery();$('trip-name').value='';update();}
  // Refusals about the open trip: a newer save elsewhere means its row must reload it, and a missing trip detaches.
  function tripTrouble(error){
    if(!current)return error;
    if(error.status===409)stale=true;
    if(error.status!==404)return error;
    detachMissingTrip();return Object.assign(Error(missingTrip),{status:404});
  }
  // The logbook may have folded during a long export or import, so anything that must be read reopens it.
  function logbookAlert(text){if(!isOpen('trip-panel'))openTrips();message('trip-message',text,true);}

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
  // A save from the seal or an export refreshes an open logbook, and focus stays on the same voyage.
  function listFocus(){const el=document.activeElement,row=el?.closest?.('#trip-list .trip-card');return row?{id:row.dataset.tripId,part:el.classList.contains('trip-more')?'.trip-more':'.trip-open'}:null;}
  async function refreshLogbook(focus=null){
    if(!isOpen('trip-panel'))return;
    // A half-typed rename survives the rebuild.
    const form=$('trip-list').querySelector('.trip-rename-form'),active=document.activeElement,renaming=form&&{id:form.closest('.trip-card').dataset.tripId,value:form.querySelector('input').value,focused:form.contains(active)};
    await listTrips(renaming?null:focus);if(!renaming)return;
    const item=[...$('trip-list').querySelectorAll('.trip-card')].find(el=>el.dataset.tripId===renaming.id),trip=tripCache.find(t=>t.id===renaming.id);if(!item||!trip)return;
    startRename(item,trip);const input=item.querySelector('.trip-rename-form input');input.value=renaming.value;
    if(!renaming.focused){const row=focus&&[...$('trip-list').querySelectorAll('.trip-card')].find(el=>el.dataset.tripId===focus.id);(row?.querySelector(focus.part)||(active?.isConnected?active:null))?.focus({preventScroll:true});}
  }
  function closeTripMenus(except=null){document.querySelectorAll('#trip-list .trip-menu').forEach(menu=>{if(menu===except)return;menu.hidden=true;menu.previousElementSibling?.setAttribute('aria-expanded','false');});}
  // A row for the open trip just folds the logbook, unless another tab has saved it since: then choosing it loads the latest version.
  const openRow=(trip,event)=>trip.id===current?.id&&!stale?closePanel('trip-panel',{focus:event.detail?'map':true}):loadTrip(trip.id,{keyboard:!event.detail});
  function tripCard(trip,index){
    const item=document.createElement('li'),map=document.createElement('div'),body=document.createElement('div'),open=document.createElement('button'),name=document.createElement('span'),detail=document.createElement('span');
    item.className='trip-card';item.dataset.tripId=trip.id;item.style.setProperty('--i',String(Math.min(index,12)));item.classList.toggle('active',trip.id===current?.id);
    map.className='trip-map';map.append(routeMap(trip.points||[]));
    if(trip.coverUrl){const cover=document.createElement('img');cover.className='trip-cover';cover.src=trip.coverUrl;cover.alt='';cover.loading='lazy';cover.style.setProperty('--tilt',`${(hash(trip.id)%7-3)*1.1}deg`);map.append(cover);}
    open.type='button';open.className='trip-open';open.disabled=busy;name.className='trip-name';name.textContent=trip.title;open.append(name);
    if(trip.id===current?.id){open.setAttribute('aria-current','true');const badge=document.createElement('span');badge.className='trip-current';badge.textContent='Open now';body.append(badge);}
    detail.className='trip-meta';detail.textContent=[plural(trip.stopCount??0,'stop'),trip.photoCount?photoLabel(trip.photoCount):'',tripDate(trip.updatedAt)].filter(Boolean).join(' · ');
    body.className='trip-card-body';body.prepend(open);body.append(detail);
    open.addEventListener('click',event=>openRow(trip,event));
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
      renderBackups();$('trip-search-label').hidden=trips.length<7;if(trips.length<7)$('trip-search').value='';renderTripCards(focus);
    }catch(error){showError('trip-message',error);}
  }
  function renderBackups(){
    const list=$('backup-list'),backed=tripCache.filter(trip=>trip.backedUpAt).sort((a,b)=>b.backedUpAt.localeCompare(a.backedUpAt));list.replaceChildren();
    for(const trip of backed){
      const row=document.createElement('li'),button=document.createElement('button'),name=document.createElement('span'),date=document.createElement('span');
      button.type='button';button.disabled=busy;name.textContent=trip.title;
      date.textContent=`${trip.backupSource==='import'?'Imported':'Exported'} ${tripDate(trip.backedUpAt)}${[trip.updatedAt,trip.changedAt].some(at=>at>trip.backedUpAt)?' · changed since':''}`;
      button.append(name,date);button.addEventListener('click',event=>openRow(trip,event));row.append(button);list.append(row);
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
    }catch(error){showError('trip-message',current?.id===trip.id?tripTrouble(error):error);}finally{busy=false;update();await listTrips({id:trip.id});}
  }
  async function deleteTrip(trip){
    if(busy)return;
    const extra=trip.photoCount?` and its ${photoLabel(trip.photoCount)} and postcards`:'';
    if(!confirm(`Delete “${trip.title}”${extra}? This can’t be undone. Use Export first if you might want it later.`))return;
    busy=true;update();
    try{
      await api(`/trips/${trip.id}`,{method:'DELETE'});
      if(current?.id===trip.id){discardPending();detachMissingTrip();}
      message('trip-message',`Deleted “${trip.title}”.`);
    }catch(error){showError('trip-message',error);}finally{busy=false;update();await listTrips({id:trip.id});}
  }
  async function loadTrip(id,{keyboard=true}={}){
    if(busy||!canSwitch())return;
    busy=true;update();let loaded=false;
    try{const data=await api(`/trips/${id}`);photoPanelRequest++;discardPending();activeCity='';setSelecting(false);suppress=true;app.setStops(data.trip.stops);suppress=false;current={id:data.trip.id,title:data.trip.title,revision:data.trip.revision,hash:fingerprint()};stale=false;photos=data.photos;dirty=false;reopen=lastPages.get(id)||null;albumPage=reopen?.index??0;remember();renderGallery();closePanel('trip-panel');message('trip-message','');loaded=true;}
    catch(error){showError('trip-message',error);}
    // Focus leaves the folded logbook for its tab (enabled again once busy clears), or for the map after a click.
    finally{suppress=false;busy=false;update();const active=document.activeElement;if(loaded&&(!active||active===document.body||$('trip-panel').contains(active)))$(keyboard?'trips-button':'map').focus({preventScroll:true});}
  }
  async function saveCurrent(title){
    const route=app.getStops(),name=(title||current?.title||'').trim();if(!name)throw Error('Give this trip a name.');
    let data;
    try{data=await api(current?`/trips/${current.id}`:'/trips',{method:current?'PUT':'POST',body:JSON.stringify({title:name,stops:route,...(current?{revision:current.revision}:{})})});}
    catch(error){throw tripTrouble(error);}
    // Persist the canonical saved route, but never replace edits made during the request.
    if(fingerprint()===JSON.stringify(route)&&JSON.stringify(data.trip.stops)!==JSON.stringify(route)){
      const sameRoute=routeContent(route)===routeContent(data.trip.stops)&&route.every((stop,i)=>stop.id===data.trip.stops[i].id);
      suppress=true;try{app.setStops(data.trip.stops,{preserveView:sameRoute,preserveHistory:true});}finally{suppress=false;}
    }
    current={id:data.trip.id,title:data.trip.title,revision:data.trip.revision,hash:JSON.stringify(data.trip.stops)};stale=false;dirty=fingerprint()!==current.hash;remember();update();return data.trip;
  }
  // Only the logbook's own scroller moves: the panel around it is still unfolding.
  function revealInLogbook(el){
    const scroller=$('trip-panel').querySelector('.logbook-scroll'),box=scroller.getBoundingClientRect(),target=el.getBoundingClientRect(),above=target.top-(box.top+12),below=target.bottom-(box.top+scroller.clientHeight)+12;
    if(above<0)scroller.scrollTop+=above;else if(below>0)scroller.scrollTop+=Math.min(below,above);
  }
  // An already open logbook keeps what is being typed into it.
  function openTrips(note=''){
    const wasOpen=isOpen('trip-panel');openPanel('trip-panel');
    if(!wasOpen){$('trip-name').value=current?.title||'';$('trip-search').value='';listTrips();}
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
      if(resumePhotos){resumePhotos=false;closePanel('trip-panel');album=true;}else{await listTrips();if(refocus&&isOpen('trip-panel'))$('trip-name').focus({preventScroll:true});}
    }
    catch(error){showError('trip-message',error);}finally{busy=false;update();if(album)showPhotos();}
  });
  $('new-trip').addEventListener('click',()=>{if(!canSwitch())return;discardPending();setSelecting(false);current=null;stale=false;photos=[];activeCity='';albumPage=0;suppress=true;app.setStops([]);suppress=false;dirty=false;remember();update();renderGallery();closePanel('trip-panel');$('destination').focus();});
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',event=>closePanel(button.dataset.close,{focus:event.detail?'map':true})));
  document.addEventListener('pointerdown',event=>{if(!event.target.closest?.('.trip-menu,.trip-more'))closeTripMenus();},true);
  window.addEventListener('resize',()=>{stopWindowMotion();if(!$('photo-panel').open||resizeFrame)return;resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;finishReviewTurn();if(albumMotion){albumMotion.refresh=true;return;}settleView();const had=$('album-pages').contains(document.activeElement)||!!turning?.had;renderGallery();if(view==='album')keepAlbumFocus(had);if(mode()==='sheet')keepSheetPlace(sheetHeld);});});
  window.addEventListener('redline:routechange',()=>{remember();if(suppress)return;dirty=current?fingerprint()!==current.hash:app.getStops().length>0;update();if($('photo-panel').open){renderReview();renderGallery();}});
  window.addEventListener('beforeunload',event=>{if(pending.length||dirty){event.preventDefault();event.returnValue='';}});

  // ---------- Photos ----------
  function coverScene(opening){
    const book=$('album-book'),displayMode=mode(),source=displayMode==='album'?$('album-pages'):$('album-sheet');
    const closed=book.dataset.preparing&&!opening?'front':displayMode==='album'?(book.classList.contains('closed-front')?'front':book.classList.contains('closed-back')?'back':''):'';
    const scene=window.RedlineAlbumMotion.create({book,source,cover:pageElement({type:'cover'},0,'right'),two:twoPage(),closed,opening:opening||!!book.dataset.preparing});
    return scene;
  }
  async function showPhotos(){
    // An import keeps running with the album shut, and reopening shows its review. A running save does not: this would replace the photos it is adding to.
    if(busy&&!importing||albumMotion?.phase==='closing')return;
    if($('photo-panel').open){if(!albumMotion)renderGallery();return;}
    if(photosRequested)return;
    photosRequested=true;const version=++photoPanelRequest;
    try{
      if(!requireTrip()||version!==photoPanelRequest)return;
      const tripId=current.id,place=lastPages.get(tripId)||{type:'title',index:step()};
      const token={phase:'opening',place,displayMode:pending.length||importing?'review':view};albumMotion=token;
      // Nothing is drawn until the photos arrive, so pressing A builds one spread once.
      reopen=null;albumPage=0;drawn=null;openPanel('photo-panel');renderPhotoMode();message('photo-message','');
      // The dialog focused a control that has just gone inert, which would drop keyboard and screen-reader users out of the album.
      if(!$('photo-panel').contains(document.activeElement)||$('album-modes').contains(document.activeElement))$('photo-panel').focus({preventScroll:true});
      const animated=canAnimate($('album-pages')),book=$('album-book');
      if(animated)book.dataset.preparing='true';
      const data=await api(`/trips/${tripId}`);
      if(version!==photoPanelRequest||current?.id!==tripId||albumMotion!==token)return;
      photos=data.photos;pages=albumPages();
      albumPage=clampPage(pageAt(place));token.place=placeAt(albumPage,twoPage());
      token.displayMode=pending.length||importing?'review':view;
      renderGallery();renderReview();update();
      if(view==='sheet')$('photo-scroll').scrollTop=lastScrolls.get(tripId)||0;
      if(animated){
        // Decode just this spread while the book is still out of sight.
        const source=token.displayMode==='album'?$('album-pages'):$('album-sheet'),rect=source.getBoundingClientRect();
        const images=[...source.querySelectorAll('img')].filter(img=>{const r=img.getBoundingClientRect();return !rect.height||r.bottom>=rect.top&&r.top<=rect.bottom;});
        await window.RedlineAlbumMotion.prepareImages(images,{reveal:()=>albumMotion===token});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        if(version!==photoPanelRequest||albumMotion!==token)return;
        token.scene=coverScene(true);
        await token.scene.open();
        if(version!==photoPanelRequest||albumMotion!==token||token.phase!=='opening')return;
        token.scene.dispose();
      }
      albumMotion=null;renderPhotoMode();warmSheet();
      if(token.refresh){renderReview();renderGallery();}
      if(token.queued)importPhotos(token.queued);
    }catch(error){if(version===photoPanelRequest){const queued=albumMotion?.queued;albumMotion?.scene?.dispose();delete $('album-book').dataset.preparing;albumMotion=null;openPanel('photo-panel');renderGallery();showError('photo-message',error);if(queued)importPhotos(queued);}}
    finally{if(version===photoPanelRequest)photosRequested=false;}
  }
  $('photos-button').addEventListener('click',event=>{if(photosRequested||$('photo-panel').open){closePanel('photo-panel');return;}clickOpened=event.detail>0;showPhotos();clickOpened=false;});
  document.addEventListener('keydown',async event=>{
    const viewer=$('photo-viewer').open,info=$('info-dialog').open;
    if(event.key==='Escape'&&!event.defaultPrevented&&!viewer&&!info){
      if(isOpen('trip-panel')){event.preventDefault();closePanel('trip-panel',{focus:true});return;}
      if($('photo-panel').open){event.preventDefault();if(albumPanel.classList.contains('expanded')){windowView(false);return;}if(selecting){setSelecting(false);$('select-photos').focus({preventScroll:true});return;}closePanel('photo-panel',{focus:true});return;}
    }
    if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.isComposing||event.target.closest?.('input:not([type=checkbox]):not(#album-scrub),textarea,select,[contenteditable="true"]'))return;
    if($('photo-panel').open&&!viewer&&!info&&event.key.toLowerCase()==='f'){
      event.preventDefault();
      if(!event.repeat&&!fullscreenButton.disabled)windowView(!reading());
      return;
    }
    // Keep keyboard turns from racing a cover that is opening or closing.
    if(!viewer&&(albumMotion||viewMotion)&&['ArrowRight','ArrowLeft','PageDown','PageUp','Home','End'].includes(event.key)){event.preventDefault();return;}
    if($('photo-panel').open&&!viewer&&mode()==='review'&&['ArrowLeft','ArrowRight','PageUp','PageDown'].includes(event.key)){
      event.preventDefault();if(!event.repeat)turnReview(['ArrowLeft','PageUp'].includes(event.key)?-1:1);return;
    }
    if(reading()&&!viewer&&mode()==='sheet'&&['ArrowRight','ArrowLeft','PageUp','PageDown'].includes(event.key)){
      event.preventDefault();
      const scroll=$('photo-scroll'),direction=['ArrowLeft','PageUp'].includes(event.key)?-1:1;
      scroll.scrollBy({top:direction*scroll.clientHeight*.9,behavior:reduced()?'instant':'smooth'});return;
    }
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

  function loadExif(){
    if(window.exifr)return Promise.resolve();
    if(!exifReady)exifReady=new Promise((resolve,reject)=>{
      const script=document.createElement('script');let settled=false;
      const finish=()=>{
        if(settled)return;settled=true;clearTimeout(timer);script.onload=script.onerror=null;
        if(window.exifr)resolve();
        else{script.remove();exifReady=null;reject(Error('Could not load photo metadata reader.'));}
      };
      // Metadata is optional: a stalled request must still allow manual city assignment.
      const timer=setTimeout(finish,3000);
      script.src='vendor/exifr.js';script.onload=script.onerror=finish;document.head.append(script);
    });
    return exifReady;
  }
  async function loadCityIndex(){
    if(cityIndex)return cityIndex;
    if(!cityIndexRequest)cityIndexRequest=(async()=>{
      // A batch waits 3 s at most, but the download carries on, so a slow link gets the index for a later photo or batch. Only a hung request is abandoned, leaving the next batch free to retry.
      if(!cityDownload){
        const controller=new AbortController(),hung=setTimeout(()=>{controller.abort();cityDownload=null;},120000);
        const job=cityDownload=fetch('photo-cities.json',{signal:controller.signal}).then(response=>{
          if(!response.ok)throw Error('Could not load city locations.');return response.json();
        }).then(index=>{
          if(!Array.isArray(index))throw Error('Could not load city locations.');
          return cityIndex=index;
        }).catch(error=>{if(cityDownload===job)cityDownload=null;throw error;}).finally(()=>clearTimeout(hung));
        job.catch(()=>{});
      }
      let timer;
      try{return await Promise.race([cityDownload,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Could not load city locations.')),3000);})]);}
      finally{clearTimeout(timer);}
    })();
    return cityIndexRequest;
  }
  async function matchCity(gps){
    if(!gps||!Number.isFinite(gps.latitude)||!Number.isFinite(gps.longitude)||Math.abs(gps.latitude)>90||Math.abs(gps.longitude)>180)return null;
    let best=null,distance=Infinity;
    for(const stop of app.getStops()){const d=app.cityDistance(gps,stop);if(d<distance){distance=d;best=stop;}}
    if(best&&distance<=25)return {...best,existing:true};
    // A day around one city is one new stop, as it would be if that city were already on the route.
    for(const entry of pending){const city=entry.candidate;if(city&&!city.existing&&app.cityDistance(gps,city)<=8)return city;}
    const index=await loadCityIndex();best=null;distance=40;
    const longitudeRange=.6/Math.max(.08,Math.cos(gps.latitude*Math.PI/180));
    for(const [name,latitude,longitude,country,cityLatitude,cityLongitude] of index){if(Math.abs(latitude-gps.latitude)>.5||Math.abs(((longitude-gps.longitude+540)%360)-180)>longitudeRange)continue;const place={name,latitude,longitude,country,admin1:''},d=app.cityDistance(gps,place);if(d<distance){distance=d;best=cityLatitude===undefined?place:{...place,latitude:cityLatitude,longitude:cityLongitude};}}
    // The index holds ISO codes, and a new stop should read like the others on the route.
    if(best)try{best.country=new Intl.DisplayNames(['en'],{type:'region'}).of(best.country)||best.country;}catch{}
    // Several parts of a city that is new to the route are one stop.
    if(best)for(const entry of pending){const city=entry.candidate;if(city&&!city.existing&&city.name===best.name&&city.latitude===best.latitude&&city.longitude===best.longitude)return city;}
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
        await window.RedlineAlbumMotion.idle();
        if(!$('photo-panel').open)return;
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
    // A trip deleted elsewhere leaves the album with nothing to add to, so this leads to naming one.
    if(!files.length||busy||!requireTrip())return;
    // A drop while the cover moves waits for it. Starting now would orphan the opening and strand the book, inert and half built.
    if(albumMotion){(albumMotion.queued??=[]).push(...files);return;}
    // Retry unavailable geography once per batch, rather than waiting on every photo.
    if(!cityIndex)cityIndexRequest=null;
    finishReviewTurn();
    setSelecting(false);busy=true;importing=true;photoPanelRequest++;photosRequested=false;update();let lastError='',noIndex=false;const unread=[];
    try{
      await loadExif().catch(()=>{});
      for(let i=0;i<files.length;i++){
        message('photo-message',`Reading ${i+1} of ${files.length}…`);setProgress(i,files.length);
        try{
          if(!/^image\//.test(files[i].type)&&!(/\.(jpe?g|png|webp|hei[cf]|avif)$/i.test(files[i].name)))throw Error('Choose image files only.');
          let gps=null;try{gps=await exifr.gps(files[i]);}catch{}
          const {blob,thumb,width,height}=await cleanImage(files[i]);let candidate=null;try{candidate=await matchCity(gps);}catch{noIndex=true;}
          const entry={id:crypto.randomUUID(),name:files[i].name,blob,thumb,width,height,url:URL.createObjectURL(blob),thumbUrl:thumb?URL.createObjectURL(thumb):'',candidate,selected:candidate?(candidate.existing?candidate.id:'match'):'',checked:true};
          pending.push(entry);renderReview(true);
        }catch(error){unread.push(files[i].name);lastError=error.message;}
      }
      const failed=unread.length,notes=[];
      // Unreadable files never enter review, so this note is the only record of which ones were left out.
      if(failed)notes.push(`${failed} photo${failed===1?'':'s'} could not be read and ${failed===1?'was':'were'} not added: ${unread.slice(0,10).join(', ')}${failed>10?` and ${failed-10} more`:''}. ${lastError}`);
      if(noIndex)notes.push('Could not load city locations in time, so GPS was not used. Choose their cities below.');
      message('photo-message',notes.join(' '),notes.length>0);
    }catch(error){showError('photo-message',error);}finally{busy=false;importing=false;setProgress(0,0);update();renderReview();}
  }
  const fileDrag=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
  // The viewer sits inside the album, but a drop on it would import behind its backdrop, with all the feedback out of sight.
  const dropsHere=()=>!busy&&!$('photo-viewer').open;
  $('photo-panel').addEventListener('dragenter',event=>{if(!fileDrag(event))return;event.preventDefault();dragDepth++;if(dropsHere())$('photo-drop-hint').hidden=false;});
  $('photo-panel').addEventListener('dragover',event=>{if(!fileDrag(event))return;event.preventDefault();event.dataTransfer.dropEffect=dropsHere()?'copy':'none';});
  $('photo-panel').addEventListener('dragleave',event=>{if(!fileDrag(event))return;dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('photo-drop-hint').hidden=true;});
  $('photo-panel').addEventListener('drop',event=>{if(!fileDrag(event))return;event.preventDefault();dragDepth=0;$('photo-drop-hint').hidden=true;if(!$('photo-viewer').open)importPhotos([...event.dataTransfer.files]);});
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
    if(confirm(`Discard ${photoLabel(pending.length)} from this import?`)){discardPending();message('photo-message','');afterReview().focus({preventScroll:true});}
  });
  // Window view keeps its toolbar inert, so Add photos cannot take focus there.
  const afterReview=()=>reading()?albumPanel:$('choose-photos');
  const mode=()=>albumMotion?(albumMotion.displayMode||'album'):pending.length||importing?'review':view;
  function renderPhotoMode(){
    const current_=mode(),reviewing=current_==='review',moving=!!albumMotion||!!viewMotion||!!reviewTurn;
    $('photo-panel').dataset.motion=albumMotion?.phase||'';
    $('album-book').inert=moving;$('album-modes').inert=!!albumMotion;
    $('choose-photos').disabled=busy||moving;fullscreenButton.disabled=busy||moving||selecting;
    if(current_!==photoMode){$('photo-scroll').scrollTop=0;photoMode=current_;}
    $('album-book').dataset.mode=current_;
    $('album-book').style.setProperty('--page-depth',`${current_==='album'?Math.max(0,Math.min(6,(lastPage()-step()-shownPage())*1.5)):5}px`);
    // One page at a time, the book gives up only the room its tabs use, and none when they are away.
    $('album-book').style.setProperty('--tab-gutter',`${!reviewing&&photos.length?tabColumns*TAB_STRIP+4:0}px`);
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
    $('gallery-filter').classList.toggle('away',reviewing||!photos.length);syncWindowCover();
    $('photo-panel').classList.toggle('selecting',selecting&&!reviewing);
  }
  function warmPreviews(){
    if(!$('photo-panel').open||albumMotion?.phase==='closing'||busy)return;
    const groups=photoGroups(),index=Math.max(0,groups.findIndex(group=>group.id===activeCity));
    // On the way to All Photos, warm the active chapter and the cities after it.
    // Only small thumbnails enter this bounded, retained cache.
    const ordered=[...groups.slice(index),...groups.slice(0,index)];
    window.RedlineAlbumMotion.preload(ordered.flatMap(group=>group.items.map(photo=>photo.thumbUrl)).filter(Boolean).slice(0,40));
  }
  // Turns and tab jumps need what lies around the open page, then each chapter's opening prints. Window view shows originals, so only the nearest of those are held.
  function warmPages(){
    if(!$('photo-panel').open||albumMotion||busy)return;
    const around=offsets=>offsets.flatMap(distance=>visiblePages(shownPage()+distance*step())).flatMap(i=>pages[i]?.items||[]);
    const near=reading()?around([0,1,-1]).map(photo=>photo.url):around([0,1,-1,2,-2]).map(photo=>photo.thumbUrl||photo.url);
    const firsts=pages.filter(page=>page.type==='city'&&page.first).flatMap(page=>page.items.map(photo=>photo.thumbUrl));
    const originals=reading()?new Set(near):null;
    window.RedlineAlbumMotion.release([...warmOriginals].filter(url=>!originals?.has(url)));warmOriginals=originals||new Set();
    window.RedlineAlbumMotion.preload([...near,...firsts].filter(Boolean).slice(0,48));
  }
  function warmSheet(){
    clearTimeout(sheetWarmTimer);
    sheetWarmTimer=setTimeout(()=>{
      if(!$('photo-panel').open||$('photo-viewer').open||mode()!=='album'||albumMotion||viewMotion||turning||busy)return;
      if(!reading())renderSheet(photoGroups());
      warmPages();
    },160);
  }
  function applyView(next){
    window.RedlineAlbumMotion.release([...warmOriginals]);warmOriginals=new Set();
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
    finishReviewTurn();
    const book=$('album-book');
    if(!canAnimate(book)||!$('photo-panel').open){applyView(next);return;}
    // Finish a turning leaf before taking the outgoing spread's snapshot.
    if(turning)renderAlbum();
    // These two sizes differ too much for one turn: a short landscape page is narrower than its sheet, so goToCity would measure the wrong columns and land on the wrong city.
    if(!twoPage()&&innerWidth>innerHeight){applyView(next);return;}
    // Window view's cover over the map is far smaller than the page it opens onto, so the book glides between them.
    if(reading()&&book.classList.contains('closed-front')){const before=beginBookResize();applyView(next);finishBookResize(before);return;}
    // A shrink still running would be measured and pinned, then snap back at the end.
    stopWindowMotion();
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
  function previewButton(item,open,{saved=false,original=false}={}){
    const button=document.createElement('button'),image=document.createElement('img');button.type='button';button.className='photo-image';
    image.src=original?item.url:item.thumbUrl||item.url;image.alt='';image.loading='lazy';image.decoding='async';image.draggable=false;
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
    const container=$('photo-review'),fragment=document.createDocumentFragment(),stops=app.getStops();
    // Save reads every page, so a stop removed from the route must release its photos on unseen pages too.
    if(!incremental){const ids=new Set(stops.map(stop=>stop.id));for(const entry of pending)if(entry.selected&&entry.selected!=='match'&&!ids.has(entry.selected))entry.selected='';}
    const lastPage=Math.max(0,Math.ceil(pending.length/reviewPageSize)-1);
    reviewPage=Math.min(reviewPage,lastPage);
    const start=reviewPage*reviewPageSize,end=Math.min(start+reviewPageSize,pending.length);
    const citySelect=document.createElement('select');
    if(!incremental||pending.length-1<end)cityOptions(citySelect,'Choose city…');
    // While decoding, append just the new visible print. Bulk controls refresh once at the end.
    for(let index=incremental?Math.max(start,pending.length-1):start;index<end;index++){
      const entry=pending[index];
      const row=document.createElement('div'),tools=document.createElement('div'),select=citySelect.cloneNode(true),pick=document.createElement('label'),checkbox=document.createElement('input'),mark=document.createElement('span');
      row.className='photo-tile review-photo';row.dataset.pendingId=entry.id;tools.className='photo-tile-tools';pick.className='photo-pick';checkbox.type='checkbox';checkbox.checked=entry.checked;checkbox.disabled=busy;checkbox.setAttribute('aria-label',`Select ${entry.name||`photo ${index+1}`}`);mark.className='photo-check';mark.innerHTML=icons.check;pick.append(checkbox,mark);
      checkbox.addEventListener('change',()=>{entry.checked=checkbox.checked;updateBulkSelection();});
      const image=previewButton(entry,(event,button)=>{
        const collection=pending.map(p=>({...p,city:p.selected==='match'?p.candidate:app.getStops().find(s=>s.id===p.selected)}));
        window.RedlinePostcards.open(collection.find(p=>p.id===entry.id),null,collection,null,button);
      });image.disabled=busy;
      select.setAttribute('aria-label',`City for ${entry.name||`photo ${index+1}`}`);
      if(entry.candidate&&!entry.candidate.existing)select.add(new Option(`${entry.candidate.name} (from GPS, new stop)`,'match'));
      if(entry.selected!=='match'&&!stops.some(s=>s.id===entry.selected))entry.selected='';select.value=entry.selected;select.disabled=busy;row.classList.toggle('needs-city',!entry.selected);
      // A tile can be too narrow for a long name, so the whole of it is a hover away.
      const nameCity=()=>{select.title=entry.selected?select.selectedOptions[0]?.text||'':'';};nameCity();
      select.addEventListener('change',()=>{entry.selected=select.value;row.classList.toggle('needs-city',!entry.selected);nameCity();updateUploadButton();});
      if(entry.candidate){const badge=document.createElement('span');badge.className='gps-badge';badge.innerHTML=icons.pin;badge.append(entry.candidate.existing?'Matched':'GPS');badge.title=`Location data suggests ${entry.candidate.name}`;tools.append(badge);}
      const remove=removeButton(`Remove ${entry.name||`photo ${index+1}`} from import`,()=>{
        URL.revokeObjectURL(entry.url);if(entry.thumbUrl)URL.revokeObjectURL(entry.thumbUrl);pending=pending.filter(p=>p.id!==entry.id);renderReview();if(!pending.length)renderGallery();
        (container.children[Math.min(index-reviewPage*reviewPageSize,container.children.length-1)]?.querySelector('.remove-photo')||afterReview()).focus({preventScroll:true});
      });tools.append(select);row.prepend(image,pick,remove);row.append(tools);fragment.append(row);
    }
    if(incremental){container.append(fragment);return;}
    container.replaceChildren(fragment);
    $('review-pager').hidden=lastPage===0;
    $('review-prev').disabled=busy||reviewPage===0;
    $('review-next').disabled=busy||reviewPage===lastPage;
    $('review-range').textContent=pending.length?`${start+1}–${end} of ${pending.length}`:'';

    $('photo-bulk').hidden=!pending.length;
    cityOptions($('bulk-photo-city'),'Assign a city…');
    const seen=new Set();for(const entry of pending){const city=entry.candidate;if(city&&!city.existing){const key=`${city.latitude},${city.longitude}`;if(!seen.has(key)){seen.add(key);$('bulk-photo-city').add(new Option(`${city.name} (from GPS, new stop)`,`gps:${entry.id}`));}}}
    updateBulkSelection();updateUploadButton();renderPhotoMode();
  }
  function finishReviewTurn(){
    if(!reviewTurn)return;
    const turn=reviewTurn;reviewTurn=null;turn.scene?.dispose();renderPhotoMode();
  }
  async function turnReview(delta){
    const last=Math.ceil(pending.length/reviewPageSize)-1;
    if(busy||albumMotion||mode()!=='review')return;
    if(reviewTurn){
      reviewTurn.target=Math.max(0,Math.min(last,reviewTurn.target+delta));return;
    }
    const target=reviewPage+delta,book=$('album-book'),sheet=$('album-sheet');
    if(target<0||target>last)return;
    const turn={target,scene:null};reviewTurn=turn;
    try{
      while(reviewTurn===turn&&reviewPage!==turn.target){
        const direction=Math.sign(turn.target-reviewPage);
        const apply=()=>{reviewPage+=direction;renderReview();$('photo-scroll').scrollTop=0;return sheet;};
        if(!canAnimate(book)){apply();continue;}
        stopWindowMotion();
        turn.scene=window.RedlineAlbumMotion.changeView({book,source:sheet,apply,direction:-direction,two:twoPage()});
        await turn.scene.play();
        if(reviewTurn===turn){turn.scene.dispose();turn.scene=null;}
      }
    }finally{if(reviewTurn===turn)finishReviewTurn();}
  }
  // The pager lies in the book, which goes inert for a turn and drops focus. It returns to the button, or to the other one if this page is the last.
  for(const [id,delta] of [['review-prev',-1],['review-next',1]])$(id).addEventListener('click',async()=>{
    await turnReview(delta);const at=document.activeElement,button=$(id);
    if(!at||at===document.body||at===button)(button.disabled?$(delta<0?'review-next':'review-prev'):button).focus({preventScroll:true});
  });
  function updateBulkSelection(){
    const selected=pending.filter(p=>p.checked).length,all=$('select-all-photos');all.checked=selected>0&&selected===pending.length;all.indeterminate=selected>0&&selected<pending.length;all.disabled=busy;
    $('photo-selection-count').textContent=selected?`${selected} selected`:'Select all';$('bulk-photo-city').disabled=busy||!selected;
    document.querySelectorAll('#photo-review .photo-tile').forEach((row,index)=>{row.querySelector('input').checked=!!pending[reviewPage*reviewPageSize+index]?.checked;});
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
    if(busy||!requireTrip())return;const ready=pending.filter(p=>p.selected);if(!ready.length)return;
    // Check room before touching the route, so a batch that cannot fit changes nothing.
    const known=app.getStops(),fresh=[];
    for(const entry of ready)if(entry.selected==='match'&&![...known,...fresh].some(p=>Math.abs(p.latitude-entry.candidate.latitude)<.02&&Math.abs(p.longitude-entry.candidate.longitude)<.02))fresh.push(entry.candidate);
    if(known.length+fresh.length>100){message('photo-message',`These photos would add ${plural(fresh.length,'stop')}, and a trip holds 100. Choose existing stops for some of them.`,true);return;}
    busy=true;photoPanelRequest++;photosRequested=false;update();renderReview();
    const saved=new Set();
    let firstSaved=null;
    try{
      // Each new stop announces a route change. The album redraws once, when this is done, rather than once for each.
      suppress=true;
      try{for(const entry of ready){if(entry.selected==='match'){const stop=app.addCity(entry.candidate);entry.selected=stop.id;}}}
      finally{suppress=false;dirty=fingerprint()!==current.hash;}
      if(dirty)await saveCurrent();
      for(let i=0;i<ready.length;i++){
        const entry=ready[i];message('photo-message',`Saving ${i+1} of ${ready.length}…`);setProgress(i,ready.length);
        const form=new FormData();form.append('photo',entry.blob,'photo.jpg');form.append('stopId',entry.selected);
        if(entry.thumb)form.append('thumb',entry.thumb,'thumb.jpg');if(entry.width&&entry.height){form.append('width',String(entry.width));form.append('height',String(entry.height));}
        const {photo}=await api(`/trips/${current.id}/photos`,{method:'POST',body:form});photos.push(photo);firstSaved??=photo;saved.add(entry);URL.revokeObjectURL(entry.url);if(entry.thumbUrl)URL.revokeObjectURL(entry.thumbUrl);
      }
      storageFull=false;message('photo-message',pending.length>saved.size?'Choose a city for the remaining photos.':`${photoLabel(ready.length)} saved.`);
    }catch(error){if(error.status===507)storageFull=true;showError('photo-message',tripTrouble(error));}finally{
      pending=pending.filter(entry=>!saved.has(entry));
      busy=false;setProgress(0,0);renderReview();update();renderGallery();
      // Land on the page where the new photos were mounted.
      if(!pending.length&&firstSaved&&view==='album')turnTo(pageOfPhoto(firstSaved.id),{instant:true});
      if(!pending.length)afterReview().focus({preventScroll:true});
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
  const postcardBadge=()=>{const card=document.createElement('span');card.className='postcard-badge';card.title='Postcard written';card.innerHTML=icons.postcard;return card;};
  // A tile keeps its place in All photos, so its badge follows the postcard without redrawing the sheet.
  window.addEventListener('redline:postcardchange',event=>{
    const {id,postcard,revision}=event.detail,photo=photos.find(photo=>photo.id===id);if(!photo)return;
    photo.postcard=postcard;photo.postcardRevision=revision;
    const tile=[...$('photo-gallery').querySelectorAll('.photo-tile')].find(tile=>tile.dataset.photoId===id),badge=tile?.querySelector('.postcard-badge');
    if(tile&&hasPostcard(photo)!==!!badge){if(badge)badge.remove();else tile.append(postcardBadge());}
  });
  function viewerActions(){return {remove:photo=>deletePhotos([photo.id],{ask:false})};}
  function photoGroups(){
    const groups=new Map(),stops=app.getStops(),order=new Map(stops.map((stop,index)=>[stop.id,index]));
    for(const photo of photos){const key=photo.stopId||'unplaced';if(!groups.has(key))groups.set(key,{id:key,name:photo.city?.name||'Other photos',country:photo.city?.country||'',stop:order.get(key),items:[]});groups.get(key).items.push(photo);}
    return [...groups.values()].sort((a,b)=>(a.stop??Infinity)-(b.stop??Infinity)||a.name.localeCompare(b.name));
  }
  function openPhoto(photo,group,origin){window.RedlinePostcards.open(photo,api,group.items,viewerActions(),origin);}
  function mapButton(group){
    const show=document.createElement('button');show.type='button';show.className='icon-button gallery-map-button';show.innerHTML=icons.pin;show.title=`Show ${group.name} on the map`;show.setAttribute('aria-label',`Show ${group.name} on the map`);show.disabled=busy;
    // The map is not painted while the book is on it: fly once the cover has shut, or nobody sees the flight.
    show.addEventListener('click',()=>{afterAlbumClose=()=>app.focusStop?.(group.id);closePanel('photo-panel',{focus:'map'});});return show;
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
  // A focused tab keeps keyboard focus when the tabs are rebuilt, as they are when their contents or layout change.
  // Dividers cascade down the book's edge in staggered columns, each column stepping out from behind the last.
  const TAB_STRIP=27,TAB_ROOT=28;
  // Dividers are as tall as the longest name needs, within reason. Long lists get more columns rather than clipped names.
  function tabLayout(groups){
    const count=groups.length,book=$('album-book'),two=twoPage();
    // The rail itself is the measure, because window view keeps room below it for the exit button.
    const height=$('gallery-filter').clientHeight||(book.clientHeight||innerHeight*.78)-2*(parseFloat(getComputedStyle(book).paddingTop)||12)-10;
    const longest=Math.max(0,...groups.map(group=>[...group.name].length)),tall=Math.max(92,Math.min(146,28+Math.min(18,longest)*7.6)),fit=Math.max(1,Math.floor(height/tall)),stage=book.parentElement;
    // Columns in the margin the book leaves anyway cost it nothing. A tall window with very many cities can give up some of the book for more; a short one has none to spare.
    const room=two&&stage?.clientWidth?Math.round(((stage.clientWidth-48-Math.min(stage.clientHeight-16,840)*1.5)/2-32)/TAB_STRIP):6,spare=Math.max(3,Math.min(6,room));
    // Odd columns start half a tab lower, so they hold one fewer whenever there is more than one row.
    const holds=(rows,columns)=>rows*columns-(rows>1?Math.floor(columns/2):0);
    const roomy=two&&stage?.clientWidth?Math.min(stage.clientHeight-16,(stage.clientWidth-48-2*(spare*TAB_STRIP+18)-28)/1.5,840):0;
    const maxColumns=!two?3:roomy>=500&&holds(Math.floor((roomy-42)/64),spare)<count?6:spare;
    // The fewest rows those columns allow, for the tallest tabs, then only the columns they need.
    let rows=Math.max(1,Math.min(count,fit)),columns=1;
    while(holds(rows,maxColumns)<count)rows++;
    while(holds(rows,columns)<count)columns++;
    return {rows,columns,tall:Math.max(44,Math.min(tall,height/rows))};
  }
  function renderTabs(groups){
    const chapters=albumPages(),nav=$('gallery-filter'),focused=nav.contains(document.activeElement)?document.activeElement.dataset.filter:null;
    // More columns can narrow a two-page book, which changes how many fit. Settle that first, or the first draw cuts the bottom tabs.
    const book=$('album-book'),width=layout=>`${layout.columns*TAB_STRIP+18}px`;
    let layout=tabLayout(groups);
    for(let pass=0;pass<6&&book.style.getPropertyValue('--tab-width')!==width(layout);pass++){book.style.setProperty('--tab-width',width(layout));layout=tabLayout(groups);}
    const {rows,columns,tall}=layout;tabColumns=columns;
    nav.style.setProperty('--tab-h',`${tall}px`);nav.style.setProperty('--tab-strip',`${TAB_STRIP}px`);nav.style.setProperty('--tab-root',`${TAB_ROOT}px`);
    const key=JSON.stringify([busy,rows,columns,tall,groups.map(group=>[group.id,group.name,group.items.length,chapters.findIndex(page=>page.type==='city'&&page.first&&page.group.id===group.id)])]);
    if(key===tabsKey){markTab();return;}tabsKey=key;
    let column=0,row=0;
    nav.replaceChildren(...groups.map(group=>{
      // Odd columns start half a tab lower and hold one fewer, so every name stays clear of its neighbours.
      if(row>=rows-(column%2&&rows>1?1:0)){column++;row=0;}
      const tab=document.createElement('button');tab.type='button';tab.className='album-tab';tab.dataset.filter=group.id;tab.disabled=busy;
      for(const [name,value] of [['--tab-order',100-column],['--tab-column',column],['--tab-row',row+(column%2&&rows>1?.5:0)]])tab.style.setProperty(name,String(value));
      row++;
      const page=folioOf(chapters.findIndex(page=>page.type==='city'&&page.first&&page.group.id===group.id));
      const name=document.createElement('span'),number=document.createElement('span');name.className='tab-name';name.textContent=group.name;
      // Longer names letter smaller rather than running off the divider.
      if(tall>=60)name.style.fontSize=`${Math.max(10.5,Math.min(14,(tall-26)/Math.max(1,[...group.name].length)/.6))}px`;number.className='chip-stop';number.textContent=String(page);number.setAttribute('aria-hidden','true');tab.append(number,name);
      tab.title=`${group.name} · page ${page} · ${photoLabel(group.items.length)}`;tab.setAttribute('aria-label',tab.title);tab.addEventListener('click',()=>goToCity(group.id));
      return tab;
    }));
    markTab();if(focused)[...nav.children].find(tab=>tab.dataset.filter===focused)?.focus({preventScroll:true});
  }
  // The whole rail is one Tab stop: the current tab, or the first. Arrow keys walk it, so a long trip is not forty presses to get past.
  function roveTabs(stop){for(const tab of tabs.children){const index=tab===stop?0:-1;if(tab.tabIndex!==index)tab.tabIndex=index;}}
  // A scrollbar would eat the outer column, so a quiet fade marks an end with more beyond it.
  function railEnds(){tabs.toggleAttribute('data-more-start',tabs.scrollTop>1);tabs.toggleAttribute('data-more-end',tabs.scrollTop+tabs.clientHeight<tabs.scrollHeight-1);}
  // Scroll only the tab rail. scrollIntoView can move the book's hidden
  // overflow ancestors and expose the stems through its 3D pages. A long rail keeps the tab clear of its fade.
  function showTab(tab){
    const fade=tabs.scrollHeight-tabs.clientHeight>1?28:0;
    if(tab.offsetTop-fade<tabs.scrollTop)tabs.scrollTop=Math.max(0,tab.offsetTop-fade);
    else if(tab.offsetTop+tab.offsetHeight+fade>tabs.scrollTop+tabs.clientHeight)tabs.scrollTop=tab.offsetTop+tab.offsetHeight+fade-tabs.clientHeight;
    railEnds();
  }
  // The current tab scrolls into view in a long row or column of tabs.
  function markTab(){
    [...tabs.children].forEach(tab=>{const on=tab.dataset.filter===activeCity;tab.setAttribute('aria-pressed',String(on));if(on)tab.setAttribute('aria-current','true');else tab.removeAttribute('aria-current');});
    const tab=tabs.querySelector('[aria-current="true"]');
    if(!tabs.contains(document.activeElement))roveTabs(tab||tabs.firstElementChild);
    if(tab)showTab(tab);else railEnds();
  }
  tabs.addEventListener('scroll',railEnds,{passive:true});
  tabs.addEventListener('focusin',event=>{if(event.target!==tabs)roveTabs(event.target);});
  tabs.addEventListener('focusout',event=>{if(!tabs.contains(event.relatedTarget))roveTabs(tabs.querySelector('[aria-current="true"]')||tabs.firstElementChild);});
  tabs.addEventListener('keydown',event=>{
    if(!['ArrowUp','ArrowDown'].includes(event.key)||event.altKey||event.ctrlKey||event.metaKey)return;
    const list=[...tabs.children],next=list[list.indexOf(event.target)+(event.key==='ArrowDown'?1:-1)];
    event.preventDefault();if(next&&!next.disabled){next.focus({preventScroll:true});showTab(next);}
  });

  function goToCity(id,{instant=false}={}){
    activeCity=id;markTab();
    if(view==='album'){const index=pages.findIndex(page=>page.type==='city'&&page.first&&page.group.id===id);if(index>=0)turnTo(index,{instant});return;}
    // A city picked in All Photos is where the album should be on returning to it. Photos may have moved here, so its pages are read afresh.
    if(!instant){pages=albumPages();const index=pages.findIndex(page=>page.type==='city'&&page.first&&page.group.id===id);if(index>=0){albumPage=clampPage(index);if(drawn)drawn.place=null;}}
    const section=[...$('photo-gallery').querySelectorAll('.gallery-city')].find(el=>el.dataset.stopId===id);
    if(!section)return;
    const scroll=$('photo-scroll'),top=scroll.scrollTop+section.getBoundingClientRect().top-scroll.getBoundingClientRect().top;
    tabJumped();
    // Only the sheet scrolls; the book and modal must stay fixed during a view change.
    if(instant||reduced()||!scroll.scrollTo)scroll.scrollTop=top;else scroll.scrollTo({top,behavior:'smooth'});
  }
  // The print at the top of All Photos. Rows run in order, so a few reads find it among thousands.
  function sheetPlace(){
    const scroll=$('photo-scroll'),top=scroll.getBoundingClientRect().top,tiles=$('photo-gallery').querySelectorAll('.photo-tile');let low=0,high=tiles.length;
    while(low<high){const middle=(low+high)>>1;if(tiles[middle].getBoundingClientRect().bottom>top)high=middle;else low=middle+1;}
    return tiles[low]?{tile:tiles[low],offset:tiles[low].getBoundingClientRect().top-top}:null;
  }
  function keepSheetPlace(place){if(!place?.tile.isConnected)return;const scroll=$('photo-scroll');scroll.scrollTop+=place.tile.getBoundingClientRect().top-scroll.getBoundingClientRect().top-place.offset;}
  // The tab follows All Photos as it scrolls, read at a walking pace rather than every frame.
  function followSheet(){
    sheetHeld=sheetPlace();
    const scroll=$('photo-scroll'),top=scroll.getBoundingClientRect().top+24,sections=$('photo-gallery').querySelectorAll('.gallery-city');let low=0,high=sections.length;
    while(low<high){const middle=(low+high)>>1;if(sections[middle].getBoundingClientRect().top>top)high=middle;else low=middle+1;}
    // A short last city can never reach the top, so the end of the sheet counts as reaching it.
    const section=scroll.scrollTop+scroll.clientHeight>=scroll.scrollHeight-2?sections[sections.length-1]:sections[low-1];
    if(section&&section.dataset.stopId!==activeCity){activeCity=section.dataset.stopId;markTab();}
  }
  // A tab's own jump owns the highlight until the scrolling it started has stopped.
  function tabJumped(){tabJump=true;clearTimeout(sheetFollow);sheetFollow=setTimeout(()=>{sheetFollow=0;tabJump=false;sheetHeld=sheetPlace();},160);}
  $('photo-scroll').addEventListener('scroll',()=>{
    if(tabJump){tabJumped();return;}
    if(sheetFollow||mode()!=='sheet'||albumMotion||viewMotion)return;
    sheetFollow=setTimeout(()=>{sheetFollow=0;if(mode()==='sheet'&&!albumMotion&&!viewMotion)followSheet();},120);
  },{passive:true});

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
    const button=previewButton(photo,(event,origin)=>{if(Date.now()<suppressClick)return;openPhoto(photo,group,origin);},{saved:true,original:reading()});button.classList.add('print-photo');
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
    // Window view has no arrows or slider, so a mouse needs a corner on every page there, covers included. The back cover's turns backwards.
    if(!['cover','back','blank'].includes(page.type)||(side==='single'&&page.type!=='back')||reading()){
      const corner=document.createElement('button');corner.type='button';corner.className='page-corner';corner.tabIndex=-1;corner.setAttribute('aria-hidden','true');
      corner.addEventListener('click',()=>turnTo(shownPage()+(side==='left'||page.type==='back'?-1:1)*step()));el.append(corner);
    }
    return el;
  }
  function stateClasses(index){
    const book=$('album-book'),last=lastPage();
    book.classList.toggle('closed-front',index===0);book.classList.toggle('closed-back',index===last);
    // The strip of unread leaves dwindles as the turn begins, however the page was reached.
    if(mode()==='album')book.style.setProperty('--page-depth',`${Math.max(0,Math.min(6,(last-step()-index)*1.5))}px`);
    syncWindowCover();
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
    // Window view hides the foot, and a live region inside display:none says nothing, so it speaks here instead.
    const spoken=reading()?$('album-position').textContent:'';if($('album-live').textContent!==spoken)$('album-live').textContent=spoken;
    // The slider speaks the same page names and numbers as the label.
    const scrub=$('album-scrub');scrub.min='0';scrub.max=String(last);scrub.step=String(step());scrub.value=String(at);scrub.disabled=!last;scrub.setAttribute('aria-valuetext',$('album-position').textContent);
    // Keep the chosen tab when its city shares these pages; otherwise follow the first city on them.
    if(cities.length&&!cities.some(city=>city.id===activeCity))activeCity=cities[0].id;markTab();warmPages();
  }
  // Focus on a page that turned away (a contents entry, say) moves to the current tab, so the keyboard keeps its place.
  function keepAlbumFocus(had){
    const active=document.activeElement;if(!had||active&&active!==document.body)return;
    if(reading()){albumPanel.focus({preventScroll:true});return;}
    const tab=[...$('gallery-filter').children].find(el=>el.getAttribute('aria-current')==='true');
    (tab&&!$('gallery-filter').inert?tab:$('album-next').disabled?$('album-previous'):$('album-next')).focus({preventScroll:true});
  }
  // A page turns over its spine: the leaf carries the old page on its front and the next on its back.
  async function turnTo(target,{instant=false}={}){
    if(!pages.length)pages=albumPages();
    // A second press toward the page already turning to lets that turn finish.
    if(turning&&!instant&&clampPage(target)===turning.target)return;
    let had=$('album-pages').contains(document.activeElement);
    if(turning){const token=turning;turning=null;had||=token.had;token.animations.forEach(animation=>animation.cancel());albumPage=token.target;}
    target=clampPage(target);
    if(target===albumPage){renderAlbum();keepAlbumFocus(had);return;}
    const from=albumPage,forward=target>from,root=$('album-pages');
    if(instant||!canAnimate(root)||!$('photo-panel').open){albumPage=target;renderAlbum();keepAlbumFocus(had);return;}
    const coverTurn=[from,target].some(index=>index===0||index===lastPage());
    const resize=reading()&&(from===0)!==(target===0)?beginBookResize():null;
    const duration=coverTurn?900:Math.min(1000,720+Math.abs(target-from)*12);
    $('album-book').style.setProperty('--turn-duration',`${duration}ms`);
    const token={target,animations:[],had};turning=token;
    // Carry the binding on the paper itself during a cover turn. A fixed
    // full-spread board otherwise appears before the cover reaches that side.
    const bound=page=>{
      if(!coverTurn)return page;
      const board=document.createElement('div');
      board.className=`album-bound-page ${page.classList.contains('left')?'left':page.classList.contains('right')?'right':'single'}`;
      board.dataset.type=page.dataset.type;board.append(page);return board;
    };
    if(twoPage()){
      const left=forward?from-1:target-1,right=forward?target:from,frontIndex=forward?from:from-1,backIndex=forward?target-1:target;
      const under=[pageElement(pages[left],left,'left'),pageElement(pages[right],right,'right')];
      const leaf=document.createElement('div'),front=pageElement(pages[frontIndex],frontIndex,forward?'right':'left'),back=pageElement(pages[backIndex],backIndex,forward?'left':'right');
      leaf.className=`album-leaf ${forward?'turn-forward':'turn-back'}${coverTurn?' cover-turn':''}`;
      const frontShade=shade(),backShade=shade(),cast=shade('cast');front.append(frontShade);back.append(backShade);under[forward?1:0].append(cast);
      const frontFace=bound(front),backFace=bound(back);frontFace.classList.add('leaf-face','leaf-front');backFace.classList.add('leaf-face','leaf-back');
      leaf.append(frontFace,backFace);root.replaceChildren(...under.map(bound),leaf);stateClasses(target);updateAlbumNav(target);
      token.settled=()=>{backShade.remove();cast.remove();back.classList.remove('leaf-face','leaf-back');return forward?[back,under[1]]:[under[0],back];};
      token.animations.push(...RedlineAlbumMotion.turnLeaf({leaf,frontShade,backShade,cast,forward,duration}));
    }else{
      const below=pageElement(pages[forward?target:from],forward?target:from,'single'),above=pageElement(pages[forward?from:target],forward?from:target,'single');
      const face=bound(above);face.classList.add('single-leaf');if(coverTurn)face.classList.add('cover-turn');
      root.replaceChildren(bound(below),face);stateClasses(target);updateAlbumNav(target);
      token.settled=()=>{above.classList.remove('single-leaf','cover-turn');return [forward?below:above];};
      token.animations.push(...RedlineAlbumMotion.turnLeaf({leaf:face,forward,two:false,duration:560}));
    }
    if(resize)finishBookResize(resize,duration);
    await Promise.all(token.animations.map(animation=>animation.finished)).catch(()=>{});
    if(turning!==token)return;
    // The pages are settled where they lie. Rebuilding would replace prints already painted as the leaf disappears.
    albumPage=target;turning=null;if(drawn)drawn.place=null;
    root.replaceChildren(...token.settled());token.animations.forEach(animation=>animation.cancel());
    stateClasses(target);updateAlbumNav(target);renderPhotoMode();warmSheet();keepAlbumFocus(had);
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
  // A vertical pan or pinch belongs to the browser, and a cancelled press is no swipe.
  $('album-pages').addEventListener('pointercancel',()=>{swipe=null;});

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
        if(hasPostcard(photo))tile.append(postcardBadge());
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
    }catch(error){showError('photo-message',tripTrouble(error));throw error;}
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
    }catch(error){showError('photo-message',tripTrouble(error));throw error;}
    finally{busy=false;update();renderGallery();}
  }
  async function restore(){
    if(bootDraft&&JSON.stringify(bootDraft)!==fingerprint()){suppress=true;app.setStops(bootDraft);suppress=false;}
    bootDraft=null;remember();
    // A route never saved is still work to protect, unless it is only the starter route.
    if(!current){dirty=app.getStops().length>0&&!app.isStarterRoute?.();update();return;}
    const cached=current,initial=fingerprint(),photoVersion=photoPanelRequest;dirty=initial!==cached.hash;
    // Older versions regenerated default stop IDs. Equal city content is still a clean route.
    try{if(dirty&&routeContent(app.getStops())===routeContent(JSON.parse(cached.hash)))dirty=false;}catch{}
    update();
    try{
      const data=await api(`/trips/${cached.id}`);if(current!==cached)return;
      if(photoVersion===photoPanelRequest)photos=data.photos;
      if(!dirty&&fingerprint()===initial){if(JSON.stringify(data.trip.stops)!==initial){suppress=true;app.setStops(data.trip.stops);suppress=false;}current={id:data.trip.id,title:data.trip.title,revision:data.trip.revision,hash:fingerprint()};remember();}
      if($('photo-panel').open)renderGallery();update();
    }catch(error){if(current!==cached)return;if(error.status===404){detachMissingTrip();openTrips(missingTrip);}else{openTrips();showError('trip-message',error);}}
    finally{suppress=false;}
  }
  function downloadBackup(blob,name){
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.hidden=true;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  const backupFileName=title=>title.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}_-]+/gu,'-').replace(/^-+|-+$/g,'')||'Redline-trip';
  // The browser gives no signal that a file arrived, so this reports only what is known. Returns whether the logbook's date was recorded.
  async function finishBackup(last,notes,files=1){
    const note=notes.length?` ${notes.join(' ')}`:'';
    try{await window.RedlineStorage.recordBackup(last);}
    catch{logbookAlert(`Backup sent to your browser’s downloads, but its date could not be recorded in the logbook.${note}`);return false;}
    const text=`Backup sent to your browser’s downloads. Check that ${files>1?`all ${files} files`:'the file'} arrived, and keep ${files>1?'them':'it'} somewhere private.${note}`;
    if(note)logbookAlert(text);else message('trip-message',text);
    return true;
  }
  // A backup over one file goes out a part per click: browsers may block a burst of downloads, and a part lost that way would go unnoticed.
  function showBackupOffer(){
    if(!backupOffer)return null;
    const {parts,next,notes}=backupOffer,button=document.createElement('button');
    message('trip-message',`This backup needs ${parts.length} files, each up to 2 GB. Sent ${next} to your browser’s downloads so far. It is not complete until you have them all; import each one to restore it.${notes.length?` ${notes.join(' ')}`:''}`,notes.length>0);
    button.type='button';button.className='small-button primary-button';button.disabled=busy;button.textContent=`Download part ${next+1} of ${parts.length}`;button.addEventListener('click',nextBackupPart);
    $('trip-message').append(' ',button);return button;
  }
  async function nextBackupPart(){
    const offer=backupOffer;if(busy||!offer)return;
    downloadBackup(offer.parts[offer.next],offer.name(offer.next));offer.next++;
    if(offer.next<offer.parts.length){showBackupOffer().focus({preventScroll:true});return;}
    backupOffer=null;$('trip-panel').focus({preventScroll:true});
    if(await finishBackup(offer.parts.at(-1),offer.notes,offer.parts.length))await refreshLogbook();
  }
  async function exportTrips(all,tripId=current?.id){
    if(busy)return;const focus=listFocus();let saved=false;const notes=[];busy=true;update();
    try{
      const own=!!current&&(all||tripId===current.id);
      // A refusal comes first, so it changes nothing. Photos that could not be saved for lack of room never block rescuing the rest.
      if(all||own){
        if(pending.length&&current&&!storageFull)throw Error('Save or cancel the pending photos before exporting.');
        if(pending.length)notes.push('The pending photos are not in it.');
      }
      if(own&&dirty){
        let lost=0;try{const kept=new Set(app.getStops().map(stop=>stop.id));lost=JSON.parse(current.hash||'[]').filter(stop=>!kept.has(stop.id)).length;}catch{}
        if(lost&&!confirm(`This backup would also save your route changes, removing ${plural(lost,'stop')} from “${current.title}”. OK saves them; Cancel backs up the last saved route.`))notes.push('Your unsaved route changes are not in it.');
        // A backup matters most when saving is failing, so the save is best effort; what it holds is stated.
        else try{await saveCurrent();saved=true;}catch(error){if(error.status===404&&!all)throw error;notes.push(error.status===404?error.message:'Your latest route edits could not be saved and are not in it.');}
      }else if(all&&!current&&dirty)notes.push('Your unsaved route is not in this backup. Name and save it first to include it.');
      const parts=await window.RedlineStorage.exportParts(all?null:tripId);
      const base=all?'Redline-backup':backupFileName(tripCache.find(trip=>trip.id===tripId)?.title||current?.title||'');
      const name=index=>parts.length>1?`${base}-part-${index+1}-of-${parts.length}.redline`:`${base}.redline`;
      downloadBackup(parts[0],name(0));
      backupOffer=parts.length>1?{parts,next:1,name,notes}:null;
      if(backupOffer){if(isOpen('trip-panel'))showBackupOffer();else openTrips();}
      else if(await finishBackup(parts[0],notes))saved=true;
    }catch(error){logbookAlert(error.message||'Please try again.');}finally{busy=false;update();if(saved)await refreshLogbook(focus);}
  }
  $('export-trip').addEventListener('click',()=>exportTrips(false));
  $('backup-trips').addEventListener('click',()=>exportTrips(true));
  $('import-trips').addEventListener('click',()=>$('trip-backup-file').click());
  $('trip-backup-file').addEventListener('change',async event=>{
    const file=event.target.files[0];event.target.value='';if(!file||busy)return;
    busy=true;update();message('trip-message','Importing…');
    try{const result=await window.RedlineStorage.importArchive(file);await listTrips();message('trip-message',`${result.tripCount} trip${result.tripCount===1?'':'s'} imported.`);}
    catch(error){logbookAlert(error.message||'Please try again.');}finally{busy=false;update();}
  });
  restore();
})();
