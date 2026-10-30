(() => {
  'use strict';
  const $=id=>document.getElementById(id),app=window.RedlineApp;
  let current=null,photos=[],pending=[],busy=false,dirty=false,suppress=false,resumePhotos=false,cityIndex=null,exifReady=null,photoPanelRequest=0,photosRequested=false;
  let galleryFilter='',galleryItems=[],importing=false,photoMode='',dragDepth=0,selecting=false,thumbQueue=Promise.resolve();
  const chosen=new Set(),thumbJobs=new Set();
  const photoLabel=count=>`${count} photo${count===1?'':'s'}`;
  const plural=(count,word)=>`${count} ${word}${count===1?'':'s'}`;
  const fingerprint=()=>JSON.stringify(app.getStops());
  const routeContent=route=>JSON.stringify(route.map(({name,country='',admin1='',latitude,longitude})=>({name,country,admin1,latitude,longitude})));
  const icons={
    pin:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17s5-4.6 5-8.6a5 5 0 0 0-10 0c0 4 5 8.6 5 8.6z"/><circle cx="10" cy="8.4" r="1.8"/></svg>',
    pencil:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 15.5h2.6l8.2-8.2-2.6-2.6-8.2 8.2zM11.4 6l2.6 2.6"/></svg>',
    trash:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M8 6V4.2h4V6M6.2 6l.7 10h6.2l.7-10M8.6 8.6v5M11.4 8.6v5"/></svg>',
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
    document.querySelectorAll('#photo-gallery button,#photo-review button,#photo-review input,#photo-review select,#gallery-filter button,#gallery-actions button,#gallery-actions select,#trip-list button,#trip-list input').forEach(el=>el.disabled=busy);
    $('cancel-photo-import').disabled=busy;$('select-photos').disabled=busy;
    $('trip-name-form').querySelector('button').disabled=busy;
    $('trip-state').textContent=current?(dirty?'Unsaved changes to this trip':'All changes saved'):app.getStops().length?'This route isn’t saved yet':'';
    $('trip-name-form').querySelector('button').textContent=current?'Save':'Save trip';
    updateBulkSelection();updateUploadButton();updateChosen();renderPhotoMode();
  }
  function message(id,text,error=false){const el=$(id);el.replaceChildren();el.textContent=text||'';el.classList.toggle('error',error);}
  function showError(id,error){message(id,error.message||'Please try again.',true);}
  const api=(path,options={})=>window.RedlineStorage.api(path,options);

  // One popup at a time: the Trips menu sits on the route dock; Photos is a drawer.
  function layoutDrawer(){
    const panel=$('photo-panel'),dock=$('route-dock'),zoom=document.querySelector('.zoom-controls'),open=!panel.hidden;
    let inset=0,covered=false;dock.style.removeProperty('left');dock.style.removeProperty('width');zoom.style.removeProperty('right');
    if(open){
      const box=panel.getBoundingClientRect(),free=box.left-24;inset=Math.max(0,innerWidth-box.left);
      if(innerWidth>650&&free>=520){dock.style.left=`${free/2+12}px`;dock.style.width=`${Math.min(640,free-48)}px`;zoom.style.right=`${inset+24}px`;}else covered=true;
    }
    document.body.classList.toggle('drawer-open',open);document.body.classList.toggle('dock-covered',covered);
    dock.inert=covered||document.body.classList.contains('map-only');app.setInsets?.({right:open&&!covered?inset:0});
  }
  function fitTripMenu(){const dock=$('route-dock').getBoundingClientRect();$('trip-panel').style.maxHeight=`${Math.max(220,dock.top-20)}px`;}
  function closePanel(id){
    $(id).hidden=true;
    if(id==='photo-panel'){photosRequested=false;photoPanelRequest++;dragDepth=0;$('photo-drop-hint').hidden=true;$('photos-button').setAttribute('aria-expanded','false');setSelecting(false);layoutDrawer();}
    else $('trips-button').setAttribute('aria-expanded','false');
  }
  function openPanel(id){
    for(const other of ['trip-panel','photo-panel'])if(other!==id&&!$(other).hidden)closePanel(other);
    app.closeSearch?.();$(id).hidden=false;
    if(id==='photo-panel'){$('photos-button').setAttribute('aria-expanded','true');layoutDrawer();$('photo-panel').focus({preventScroll:true});}
    else {$('trips-button').setAttribute('aria-expanded','true');fitTripMenu();}
  }
  function discardPending(){pending.forEach(p=>{URL.revokeObjectURL(p.url);if(p.thumbUrl)URL.revokeObjectURL(p.thumbUrl);});pending=[];renderReview();}
  function canSwitch(){return !(dirty||pending.length)||confirm('Discard unsaved changes and switch trips?');}

  function tripDate(value){const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';return date.toLocaleDateString(undefined,{month:'short',day:'numeric',...(date.getFullYear()===new Date().getFullYear()?{}:{year:'numeric'})});}
  function iconButton(className,label,icon){const button=document.createElement('button');button.type='button';button.className=`icon-button ${className}`;button.title=label;button.setAttribute('aria-label',label);button.innerHTML=icon;button.disabled=busy;return button;}
  // Rebuilding the list keeps keyboard focus on the same trip, or on the menu itself.
  async function listTrips(focus=null){
    try{
      const {trips}=await api('/trips'),list=$('trip-list');list.replaceChildren();
      for(const trip of trips){
        const item=document.createElement('li'),open=document.createElement('button'),name=document.createElement('span'),detail=document.createElement('span');
        item.className='saved-trip';item.dataset.tripId=trip.id;item.classList.toggle('active',trip.id===current?.id);
        open.type='button';open.className='trip-open';open.disabled=busy;name.className='trip-name';name.textContent=trip.title;detail.className='trip-meta';
        detail.textContent=[plural(trip.stopCount??0,'stop'),trip.photoCount?photoLabel(trip.photoCount):'',tripDate(trip.updatedAt)].filter(Boolean).join(' · ');
        if(trip.id===current?.id)open.setAttribute('aria-current','true');
        open.append(name,detail);open.addEventListener('click',()=>trip.id===current?.id?closePanel('trip-panel'):loadTrip(trip.id));
        const rename=iconButton('trip-rename',`Rename ${trip.title}`,icons.pencil),remove=iconButton('trip-delete',`Delete ${trip.title}`,icons.trash);
        rename.addEventListener('click',()=>startRename(item,trip));remove.addEventListener('click',()=>deleteTrip(trip));
        item.append(open,rename,remove);list.append(item);
      }
      if(!trips.length){const empty=document.createElement('li');empty.className='trip-empty';empty.textContent='No saved trips yet. Name this route above to keep it.';list.append(empty);}
      if(focus&&!$('trip-panel').hidden){
        const row=[...list.querySelectorAll('.saved-trip')].find(el=>el.dataset.tripId===focus.id);
        (row?.querySelector(focus.part||'.trip-open')||list.querySelector('.trip-open')||$('trip-panel')).focus({preventScroll:true});
      }
    }catch(error){showError('trip-message',error);}
  }
  function startRename(item,trip){
    const form=document.createElement('form'),input=document.createElement('input'),save=document.createElement('button'),cancel=document.createElement('button');
    form.className='trip-rename-form';input.value=trip.title;input.maxLength=80;input.required=true;input.setAttribute('aria-label','Trip name');
    save.type='submit';save.textContent='Rename';cancel.type='button';cancel.className='text-button';cancel.textContent='Cancel';
    form.append(input,save,cancel);item.replaceChildren(form);input.focus();input.select();
    const back=()=>listTrips({id:trip.id,part:'.trip-rename'});
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
      if(open&&current?.id===trip.id){current={...current,title:result.trip.title,revision:result.trip.revision};remember();if(!$('trip-name').matches(':focus'))$('trip-name').value=current.title;}
      message('trip-message','Trip renamed.');
    }catch(error){showError('trip-message',error);}finally{busy=false;update();await listTrips({id:trip.id});}
  }
  async function deleteTrip(trip){
    if(busy)return;
    const extra=trip.photoCount?` and its ${photoLabel(trip.photoCount)} and postcards`:'';
    if(!confirm(`Delete “${trip.title}”${extra}? This can’t be undone. Use Export trip first if you might want it later.`))return;
    busy=true;update();
    try{
      await api(`/trips/${trip.id}`,{method:'DELETE'});
      if(current?.id===trip.id){
        photoPanelRequest++;discardPending();photos.forEach(p=>window.RedlinePostcards.forget(p.id));photos=[];current=null;galleryFilter='';
        dirty=app.getStops().length>0;remember();renderGallery();$('trip-name').value='';
      }
      message('trip-message',`Deleted “${trip.title}”.`);
    }catch(error){showError('trip-message',error);}finally{busy=false;update();await listTrips({id:trip.id});}
  }
  async function loadTrip(id){
    if(busy||!canSwitch())return;
    busy=true;update();
    try{const data=await api(`/trips/${id}`);photoPanelRequest++;discardPending();galleryFilter='';setSelecting(false);suppress=true;app.setStops(data.trip.stops);suppress=false;current={id:data.trip.id,title:data.trip.title,revision:data.trip.revision,hash:fingerprint()};photos=data.photos;dirty=false;remember();renderGallery();closePanel('trip-panel');message('trip-message','');}
    catch(error){showError('trip-message',error);}finally{suppress=false;busy=false;update();}
  }
  async function saveCurrent(title){
    const route=app.getStops(),name=(title||current?.title||'').trim();if(!name)throw Error('Give this trip a name.');
    const data=await api(current?`/trips/${current.id}`:'/trips',{method:current?'PUT':'POST',body:JSON.stringify({title:name,stops:route,...(current?{revision:current.revision}:{})})});
    // Persist the canonical saved route, but never replace edits made during the request.
    if(fingerprint()===JSON.stringify(route)&&JSON.stringify(data.trip.stops)!==JSON.stringify(route)){
      const sameRoute=routeContent(route)===routeContent(data.trip.stops)&&route.every((stop,i)=>stop.id===data.trip.stops[i].id);
      suppress=true;try{app.setStops(data.trip.stops,{preserveView:sameRoute});}finally{suppress=false;}
    }
    current={id:data.trip.id,title:data.trip.title,revision:data.trip.revision,hash:JSON.stringify(data.trip.stops)};dirty=fingerprint()!==current.hash;remember();update();return data.trip;
  }
  function openTrips(note=''){
    openPanel('trip-panel');$('trip-name').value=current?.title||'';message('trip-message',note);listTrips();
    if(!current)$('trip-name').focus();else $('trip-panel').focus({preventScroll:true});
  }
  // Opening the album never commits route edits; saving or moving photos does that first.
  function requireTrip(){
    if(!current){resumePhotos=true;openTrips('Name and save this trip to add photos.');return false;}
    return true;
  }
  $('trips-button').addEventListener('click',()=>{if(!$('trip-panel').hidden){closePanel('trip-panel');return;}resumePhotos=false;openTrips();});
  $('save-trip').addEventListener('click',async()=>{
    if(!current){openTrips();return;}
    busy=true;update();try{await saveCurrent();$('save-trip').textContent='Saved';setTimeout(()=>$('save-trip').textContent='Save',1300);}catch(error){openTrips();showError('trip-message',error);}finally{busy=false;update();}
  });
  $('trip-name-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;busy=true;update();
    try{await saveCurrent($('trip-name').value);message('trip-message','');closePanel('trip-panel');if(resumePhotos){resumePhotos=false;showPhotos();}}
    catch(error){showError('trip-message',error);}finally{busy=false;update();}
  });
  $('new-trip').addEventListener('click',()=>{if(!canSwitch())return;discardPending();setSelecting(false);current=null;photos=[];galleryFilter='';suppress=true;app.setStops([]);suppress=false;dirty=false;remember();update();renderGallery();closePanel('trip-panel');$('destination').focus();});
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>{closePanel(button.dataset.close);$(button.dataset.close==='photo-panel'?'photos-button':'trips-button').focus({preventScroll:true});}));
  // The Trips menu closes when you work elsewhere, like any other menu.
  document.addEventListener('pointerdown',event=>{
    if($('trip-panel').hidden||document.querySelector('dialog[open]'))return;
    if(!event.target.closest?.('#trip-panel,#trips-button,#save-trip,#photos-button'))closePanel('trip-panel');
  },true);
  $('destination').addEventListener('focus',()=>{if(!$('trip-panel').hidden)closePanel('trip-panel');});
  window.addEventListener('resize',()=>{if(!$('photo-panel').hidden)layoutDrawer();if(!$('trip-panel').hidden)fitTripMenu();});
  window.addEventListener('redline:routechange',()=>{if(suppress)return;dirty=current?fingerprint()!==current.hash:app.getStops().length>0;update();if(!$('photo-panel').hidden){renderReview();renderGallery();}else updatePhotoCounts();});
  window.addEventListener('beforeunload',event=>{if(pending.length||dirty){event.preventDefault();event.returnValue='';}});
  async function showPhotos(filter){
    if(busy)return;
    if(filter!==undefined){galleryFilter=filter;setSelecting(false);}
    if(!$('photo-panel').hidden){renderGallery();$('photo-scroll').scrollTop=0;return;}
    if(photosRequested)return;
    photosRequested=true;const version=++photoPanelRequest;
    try{
      if(!requireTrip()||version!==photoPanelRequest)return;
      openPanel('photo-panel');renderGallery();renderReview();message('photo-message','');
      const tripId=current.id,data=await api(`/trips/${tripId}`);if(version!==photoPanelRequest||current?.id!==tripId)return;
      photos=data.photos;renderGallery();update();
    }catch(error){if(version===photoPanelRequest){openPanel('photo-panel');showError('photo-message',error);}}
    finally{if(version===photoPanelRequest)photosRequested=false;}
  }
  $('photos-button').addEventListener('click',()=>{if(photosRequested||!$('photo-panel').hidden){closePanel('photo-panel');return;}showPhotos();});
  window.addEventListener('redline:openphotos',event=>{if(document.body.classList.contains('map-only'))app.showControls();showPhotos(event.detail?.stopId||'');});
  document.addEventListener('keydown',async event=>{
    if(event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('dialog[open]')){
      if(!$('trip-panel').hidden){event.preventDefault();closePanel('trip-panel');$('trips-button').focus({preventScroll:true});return;}
      if(!$('photo-panel').hidden){
        event.preventDefault();
        if(selecting){setSelecting(false);$('select-photos').focus({preventScroll:true});return;}
        closePanel('photo-panel');$('photos-button').focus({preventScroll:true});return;
      }
    }
    if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.isComposing||event.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    const key=event.key.toLowerCase(),button={t:'trips-button',s:'save-trip',p:'photos-button'}[key];
    if(!button)return;
    if($('photo-viewer').open){if(key==='p'){event.preventDefault();if(!event.repeat){await window.RedlinePostcards.close();if(!$('photo-viewer').open)closePanel('photo-panel');}}return;}
    if(document.querySelector('dialog[open]'))return;
    event.preventDefault();if(event.repeat)return;
    if(document.body.classList.contains('map-only'))window.RedlineApp.showControls();
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
      try{
        const {blob}=await encode(image,image.naturalWidth,image.naturalHeight,640,.8),form=new FormData();
        form.append('thumb',blob,'thumb.jpg');form.append('width',String(image.naturalWidth));form.append('height',String(image.naturalHeight));
        const {photo:saved}=await api(`/photos/${photo.id}/thumb`,{method:'PUT',body:form});Object.assign(photo,{thumbUrl:saved.thumbUrl,width:saved.width,height:saved.height});
      }catch{}
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
          pending.push(entry);renderReview();
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
  // Dragging photos over a saved trip opens its gallery; a drop anywhere never replaces the app.
  document.addEventListener('dragenter',event=>{if(fileDrag(event)&&$('photo-panel').hidden&&current&&!busy&&!document.querySelector('dialog[open]'))showPhotos();});
  document.addEventListener('dragover',event=>{if(!fileDrag(event))return;event.preventDefault();if(!event.target.closest?.('#photo-panel'))event.dataTransfer.dropEffect=current&&!busy?'copy':'none';});
  document.addEventListener('drop',event=>{
    if(!fileDrag(event))return;event.preventDefault();dragDepth=0;$('photo-drop-hint').hidden=true;
    if(event.target.closest?.('#photo-panel')||document.querySelector('dialog[open]'))return;
    const files=[...event.dataTransfer.files];
    if(!current){openTrips('Name and save this trip to add photos.');resumePhotos=true;return;}
    if(!$('photo-panel').hidden)importPhotos(files);else showPhotos().then(()=>importPhotos(files));
  });
  $('cancel-photo-import').addEventListener('click',()=>{
    if(busy||!pending.length)return;
    if(confirm(`Discard ${photoLabel(pending.length)} from this import?`)){discardPending();message('photo-message','');$('choose-photos').focus({preventScroll:true});}
  });
  function renderPhotoMode(){
    const reviewing=!!pending.length||importing,mode=reviewing?'review':'gallery';
    if(mode!==photoMode){$('photo-scroll').scrollTop=0;photoMode=mode;}
    $('photos-heading').textContent=reviewing?'Add photos':'Photos';
    $('photo-trip-name').textContent=current?.title||'';
    $('gallery-count').hidden=reviewing||!photos.length;
    $('choose-photos').querySelector('span').textContent=pending.length?'Add more':'Add photos';
    $('photo-gallery').hidden=reviewing;
    $('gallery-toolbar').hidden=reviewing||!photos.length||selecting;
    $('gallery-actions').hidden=reviewing||!selecting;
    $('photo-review').hidden=!reviewing;
    $('photo-review').setAttribute('aria-busy',String(importing));
    $('photo-bulk').hidden=!pending.length;
    $('photo-import-actions').hidden=!pending.length;
    $('photo-panel').classList.toggle('selecting',selecting&&!reviewing);
  }
  function cityOptions(select,emptyLabel){
    select.replaceChildren(new Option(emptyLabel,''));
    app.getStops().forEach((stop,i)=>select.add(new Option(`${String(i+1).padStart(2,'0')} · ${stop.name}${stop.country?', '+stop.country:''}`,stop.id)));
  }
  const clampRatio=value=>Math.min(2.4,Math.max(.5,value));
  function setRatio(tile,item){tile.style.setProperty('--ratio',(item.width&&item.height?clampRatio(item.width/item.height):4/3).toFixed(3));}
  function previewButton(item,open,{saved=false}={}){
    const button=document.createElement('button'),image=document.createElement('img');button.type='button';button.className='photo-image';
    image.src=item.thumbUrl||item.url;image.alt='';image.loading='lazy';image.decoding='async';image.draggable=false;
    image.addEventListener('load',()=>{
      button.classList.add('loaded');
      if(!item.width&&image.naturalWidth){item.width=image.naturalWidth;item.height=image.naturalHeight;const tile=button.closest('.photo-tile');if(tile)setRatio(tile,item);}
      if(saved&&!item.thumbUrl)backfillThumb(item,image);
    },{once:true});
    // Re-rendered tiles of already-decoded photos appear at once instead of fading in again.
    if(image.complete&&image.naturalWidth)button.classList.add('loaded');
    button.setAttribute('aria-label',item.city?.name?`Open photo in ${item.city.name}`:`Expand ${item.name||'photo'}`);button.append(image);button.addEventListener('click',open);return button;
  }
  function removeButton(label,remove){
    const button=document.createElement('button');button.type='button';button.className='remove-photo';button.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>';button.title=label;button.setAttribute('aria-label',label);button.disabled=busy;button.addEventListener('click',remove);return button;
  }
  function renderReview(){
    const container=$('photo-review');container.replaceChildren();const stops=app.getStops();
    pending.forEach((entry,index)=>{
      const row=document.createElement('div'),tools=document.createElement('div'),select=document.createElement('select'),pick=document.createElement('label'),checkbox=document.createElement('input'),mark=document.createElement('span');
      row.className='photo-tile review-photo';row.dataset.pendingId=entry.id;tools.className='photo-tile-tools';pick.className='photo-pick';checkbox.type='checkbox';checkbox.checked=entry.checked;checkbox.disabled=busy;checkbox.setAttribute('aria-label',`Select ${entry.name||`photo ${index+1}`}`);mark.className='photo-check';mark.innerHTML=icons.check;pick.append(checkbox,mark);
      checkbox.addEventListener('change',()=>{entry.checked=checkbox.checked;updateBulkSelection();});
      const image=previewButton(entry,()=>{
        const collection=pending.map(p=>({...p,city:p.selected==='match'?p.candidate:app.getStops().find(s=>s.id===p.selected)}));
        window.RedlinePostcards.open(collection.find(p=>p.id===entry.id),null,collection);
      });image.disabled=busy;
      cityOptions(select,'Choose city…');select.setAttribute('aria-label',`City for ${entry.name||`photo ${index+1}`}`);
      if(entry.candidate&&!entry.candidate.existing)select.add(new Option(`${entry.candidate.name} (from GPS, new stop)`,'match'));
      if(entry.selected!=='match'&&!stops.some(s=>s.id===entry.selected))entry.selected='';select.value=entry.selected;select.disabled=busy;row.classList.toggle('needs-city',!entry.selected);select.addEventListener('change',()=>{entry.selected=select.value;row.classList.toggle('needs-city',!entry.selected);updateUploadButton();});
      if(entry.candidate){const badge=document.createElement('span');badge.className='gps-badge';badge.innerHTML=icons.pin;badge.append(entry.candidate.existing?'Matched':'GPS');badge.title=`Location data suggests ${entry.candidate.name}`;tools.append(badge);}
      const remove=removeButton(`Remove ${entry.name||`photo ${index+1}`} from import`,()=>{
        URL.revokeObjectURL(entry.url);if(entry.thumbUrl)URL.revokeObjectURL(entry.thumbUrl);pending=pending.filter(p=>p.id!==entry.id);renderReview();
        (container.children[Math.min(index,pending.length-1)]?.querySelector('.remove-photo')||$('choose-photos')).focus({preventScroll:true});
      });tools.append(select);row.prepend(image,pick,remove);row.append(tools);container.append(row);
    });
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
    renderReview();$('bulk-photo-city').focus({preventScroll:true});
  });
  function updateUploadButton(){
    const ready=pending.filter(p=>p.selected).length,unassigned=pending.length-ready;
    $('upload-photos').hidden=!pending.length;$('upload-photos').disabled=busy||ready===0;
    $('upload-photos').textContent=ready?`Save ${photoLabel(ready)}`:'Save photos';
    $('photo-ready-count').textContent=unassigned?`${unassigned} need${unassigned===1?'s':''} a city`:'';
  }
  $('upload-photos').addEventListener('click',async()=>{
    if(busy)return;const ready=pending.filter(p=>p.selected);if(!ready.length)return;busy=true;photoPanelRequest++;photosRequested=false;update();renderReview();
    try{
      for(const entry of ready){if(entry.selected==='match'){const stop=app.addCity(entry.candidate);entry.selected=stop.id;}}
      if(dirty)await saveCurrent();
      for(let i=0;i<ready.length;i++){
        const entry=ready[i];message('photo-message',`Saving ${i+1} of ${ready.length}…`);setProgress(i,ready.length);
        const form=new FormData();form.append('photo',entry.blob,'photo.jpg');form.append('stopId',entry.selected);
        if(entry.thumb)form.append('thumb',entry.thumb,'thumb.jpg');if(entry.width&&entry.height){form.append('width',String(entry.width));form.append('height',String(entry.height));}
        const {photo}=await api(`/trips/${current.id}/photos`,{method:'POST',body:form});photos.push(photo);pending=pending.filter(p=>p.id!==entry.id);URL.revokeObjectURL(entry.url);if(entry.thumbUrl)URL.revokeObjectURL(entry.thumbUrl);
      }
      if(!pending.length)galleryFilter='';
      message('photo-message',pending.length?'Choose a city for the remaining photos.':`${photoLabel(ready.length)} saved.`);renderGallery();
    }catch(error){showError('photo-message',error);}finally{busy=false;setProgress(0,0);update();renderReview();renderGallery();if(!pending.length)$('choose-photos').focus({preventScroll:true});}
  });

  // Saved photos: browse, select, move between cities, and delete.
  const hasPostcard=photo=>Object.values(photo.postcard||{}).some(value=>typeof value==='string'&&value.trim());
  function viewerActions(){
    return {
      cities:()=>app.getStops(),
      move:async(photo,stopId)=>{await movePhotos([photo.id],stopId);return photos.find(p=>p.id===photo.id)||photo;},
      remove:photo=>deletePhotos([photo.id],{ask:false})
    };
  }
  function galleryGrid(items){
    const grid=document.createElement('div');grid.className='photo-grid';
    items.forEach(photo=>{
      const tile=document.createElement('div');tile.className='photo-tile';tile.dataset.photoId=photo.id;setRatio(tile,photo);
      const position=galleryItems.indexOf(photo)+1,place=photo.city?.name||'this trip';
      const button=previewButton(photo,()=>{if(selecting){toggleChosen(photo.id);return;}window.RedlinePostcards.open(photo,api,galleryItems,viewerActions());},{saved:true});
      button.setAttribute('aria-label',`${selecting?'Select':'Open'} photo ${position} in ${place}`);
      if(selecting){button.setAttribute('aria-pressed',String(chosen.has(photo.id)));const mark=document.createElement('span');mark.className='photo-check';mark.innerHTML=icons.check;tile.append(mark);}
      tile.classList.toggle('chosen',chosen.has(photo.id));
      if(hasPostcard(photo)){const card=document.createElement('span');card.className='postcard-badge';card.title='Postcard written';card.innerHTML=icons.postcard;tile.append(card);}
      tile.prepend(button);grid.append(tile);
    });
    return grid;
  }
  function photoGroups(){
    const groups=new Map(),stops=app.getStops(),order=new Map(stops.map((stop,index)=>[stop.id,index]));
    for(const photo of photos){const key=photo.stopId||'unplaced';if(!groups.has(key))groups.set(key,{id:key,name:photo.city?.name||'Other photos',country:photo.city?.country||'',stop:order.get(key),items:[]});groups.get(key).items.push(photo);}
    return [...groups.values()].sort((a,b)=>(a.stop??Infinity)-(b.stop??Infinity)||a.name.localeCompare(b.name));
  }
  function updatePhotoCounts(){const counts={};for(const photo of photos)if(photo.stopId)counts[photo.stopId]=(counts[photo.stopId]||0)+1;app.setPhotoCounts?.(counts);}
  function chip(id,label,count,stop){
    const button=document.createElement('button');button.type='button';button.className='gallery-chip';button.dataset.filter=id;button.setAttribute('aria-pressed',String(galleryFilter===id));button.disabled=busy;
    if(stop!==undefined){const number=document.createElement('span');number.className='chip-stop';number.textContent=String(stop+1).padStart(2,'0');button.append(number);}
    const name=document.createElement('span'),total=document.createElement('span');name.textContent=label;total.className='chip-count';total.textContent=String(count);button.append(name,total);
    button.addEventListener('click',()=>{galleryFilter=id;renderGallery();$('photo-scroll').scrollTop=0;[...$('gallery-filter').children].find(el=>el.dataset.filter===id)?.focus({preventScroll:true});});
    return button;
  }
  function renderGallery(){
    const container=$('photo-gallery');container.replaceChildren();
    const sorted=photoGroups();
    if(!sorted.some(group=>group.id===galleryFilter))galleryFilter='';
    const filter=$('gallery-filter');filter.replaceChildren(chip('','All',photos.length));
    for(const group of sorted)filter.append(chip(group.id,group.name,group.items.length,group.stop));
    filter.hidden=sorted.length<2;
    const visible=sorted.filter(group=>!galleryFilter||group.id===galleryFilter);galleryItems=visible.flatMap(group=>group.items);
    for(const id of [...chosen])if(!photos.some(photo=>photo.id===id))chosen.delete(id);
    $('gallery-count').textContent=photoLabel(galleryItems.length);
    if(!photos.length){
      const empty=document.createElement('div'),art=document.createElement('div'),label=document.createElement('p'),hint=document.createElement('p'),add=document.createElement('button');empty.className='photo-empty';
      art.innerHTML=icons.photos;art.className='photo-empty-art';label.textContent='No photos yet';hint.className='photo-empty-hint';hint.textContent='Drop photos here or add them from your device. Photos with location data are matched to the nearest city on your route.';
      add.type='button';add.className='small-button';add.textContent='Add photos';add.disabled=busy;add.addEventListener('click',()=>$('choose-photos').click());empty.append(art,label,hint,add);container.append(empty);
    }
    for(const group of visible){
      const section=document.createElement('section'),top=document.createElement('div'),place=document.createElement('div'),heading=document.createElement('h3'),count=document.createElement('span');
      section.className='gallery-city';section.dataset.stopId=group.id;top.className='gallery-city-heading';heading.textContent=group.name;count.className='gallery-city-count';count.textContent=photoLabel(group.items.length);
      if(group.stop!==undefined){const number=document.createElement('span');number.className='gallery-stop-number';number.textContent=String(group.stop+1).padStart(2,'0');top.append(number);}
      place.className='gallery-city-place';place.append(heading);
      if(group.country){const detail=document.createElement('p');detail.className='gallery-city-country';detail.textContent=group.country;place.append(detail);}
      top.append(place,count);
      if(group.stop!==undefined){
        const show=iconButton('gallery-map-button',`Show ${group.name} on the map`,icons.pin);
        show.addEventListener('click',()=>{if(document.body.classList.contains('dock-covered'))closePanel('photo-panel');app.focusStop?.(group.id);});top.append(show);
      }
      section.append(top,galleryGrid(group.items));container.append(section);
    }
    if(selecting)cityOptions($('move-photos'),'Move to…');
    updatePhotoCounts();updateChosen();renderPhotoMode();
  }
  function setSelecting(value){
    if(selecting===value)return;selecting=value;chosen.clear();
    $('select-photos').setAttribute('aria-pressed',String(value));
    if(!$('photo-panel').hidden)renderGallery();else renderPhotoMode();
  }
  function toggleChosen(id){if(chosen.has(id))chosen.delete(id);else chosen.add(id);updateChosen();}
  function updateChosen(){
    const count=chosen.size,visible=galleryItems.length;
    $('gallery-selection-count').textContent=count?`${count} selected`:'Tap photos to select';
    $('select-visible').textContent=count&&galleryItems.every(photo=>chosen.has(photo.id))?'Clear':'Select all';
    $('select-visible').disabled=busy||!visible;$('move-photos').disabled=busy||!count;$('delete-photos').disabled=busy||!count;
    document.querySelectorAll('#photo-gallery .photo-tile').forEach(tile=>{const on=chosen.has(tile.dataset.photoId);tile.classList.toggle('chosen',on);if(selecting)tile.querySelector('.photo-image')?.setAttribute('aria-pressed',String(on));});
  }
  $('select-photos').addEventListener('click',()=>setSelecting(!selecting));
  $('done-selecting').addEventListener('click',()=>{setSelecting(false);$('select-photos').focus({preventScroll:true});});
  $('select-visible').addEventListener('click',()=>{const all=galleryItems.every(photo=>chosen.has(photo.id));for(const photo of galleryItems)all?chosen.delete(photo.id):chosen.add(photo.id);updateChosen();});
  $('move-photos').addEventListener('change',()=>{const stopId=$('move-photos').value;$('move-photos').value='';if(stopId&&chosen.size)movePhotos([...chosen],stopId).catch(()=>{});});
  $('delete-photos').addEventListener('click',()=>{if(chosen.size)deletePhotos([...chosen]).catch(()=>{});});
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
      renderGallery();update();
    }catch(error){if(current!==cached)return;if(error.status===404){current=null;photos=[];remember();update();}else{openTrips();showError('trip-message',error);}}
    finally{suppress=false;}
  }
  function downloadBackup(blob,name){
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.hidden=true;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  async function exportTrips(all){
    if(busy)return;busy=true;update();
    try{
      if(dirty){if(!current)throw Error('Name and save this trip before exporting.');await saveCurrent();}
      if(pending.length)throw Error('Save the pending photos before exporting.');
      const blob=await window.RedlineStorage.exportArchive(all?null:current?.id);
      const name=all?'Redline-backup':(current?.title||'Redline-trip').replace(/[^a-zA-Z0-9_-]+/g,'-');
      downloadBackup(blob,`${name}.redline`);message('trip-message','Backup downloaded. Keep it somewhere private.');
    }catch(error){showError('trip-message',error);}finally{busy=false;update();}
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
