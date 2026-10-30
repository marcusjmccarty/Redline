(() => {
  'use strict';
  const $=id=>document.getElementById(id),app=window.RedlineApp;
  let current=null,photos=[],pending=[],busy=false,dirty=false,suppress=false,resumePhotos=false,cityIndex=null,exifReady=null,photoPanelRequest=0,photosRequested=false;
  let galleryFilter='',galleryItems=[],importing=false,photoMode='',dragDepth=0;
  const photoLabel=count=>`${count} photo${count===1?'':'s'}`;
  const fingerprint=()=>JSON.stringify(app.getStops());
  const routeContent=route=>JSON.stringify(route.map(({name,country='',admin1='',latitude,longitude})=>({name,country,admin1,latitude,longitude})));
  try{current=JSON.parse(localStorage.getItem('redline-saved-trip')||'null');}catch{}
  if(current&&(!current.id||!Number.isInteger(current.revision)))current=null;
  function remember(){try{if(current)localStorage.setItem('redline-saved-trip',JSON.stringify(current));else localStorage.removeItem('redline-saved-trip');}catch{}}
  function update(){
    $('trip-title').textContent=current?.title||'';
    $('save-trip').classList.toggle('dirty',dirty);
    $('photo-count').textContent=photos.length?String(photos.length):'';
    $('save-trip').disabled=busy;$('new-trip').disabled=busy;$('choose-photos').disabled=busy;$('trips-button').disabled=busy;
    $('export-trip').disabled=busy||!current;$('backup-trips').disabled=busy;$('import-trips').disabled=busy;
    document.querySelectorAll('#photo-gallery select,#photo-gallery button,#photo-review button,#photo-review input,#photo-review select').forEach(el=>el.disabled=busy);
    $('cancel-photo-import').disabled=busy;$('gallery-city').disabled=busy;
    updateBulkSelection();updateUploadButton();renderPhotoMode();
  }
  function message(id,text,error=false){const el=$(id);el.replaceChildren();el.textContent=text||'';el.classList.toggle('error',error);}
  function showError(id,error){message(id,error.message||'Please try again.',true);}
  const api=(path,options={})=>window.RedlineStorage.api(path,options);
  function closePanel(id){$(id).hidden=true;if(id==='photo-panel'){photosRequested=false;photoPanelRequest++;dragDepth=0;$('photo-drop-hint').hidden=true;$('photos-button').setAttribute('aria-expanded','false');}}
  function openPanel(id){if(id!=='photo-panel')closePanel('photo-panel');$('trip-panel').hidden=id!=='trip-panel';$('photo-panel').hidden=id!=='photo-panel';$(id).hidden=false;if(id==='photo-panel'){$('photos-button').setAttribute('aria-expanded','true');$('photo-panel').querySelector('.close-panel').focus({preventScroll:true});}}
  function discardPending(){pending.forEach(p=>URL.revokeObjectURL(p.url));pending=[];renderReview();}
  function canSwitch(){return !(dirty||pending.length)||confirm('Discard unsaved changes and switch trips?');}
  async function listTrips(){
    try{
      const {trips}=await api('/trips');$('trip-list').replaceChildren();
      for(const trip of trips){const button=document.createElement('button'),name=document.createElement('strong'),detail=document.createElement('span');button.className='saved-trip';button.classList.toggle('active',trip.id===current?.id);name.textContent=trip.title;name.style.fontWeight='normal';detail.textContent=trip.photoCount?`${trip.photoCount} photos`:'';button.append(name,detail);button.addEventListener('click',()=>loadTrip(trip.id));$('trip-list').append(button);}
      if(!trips.length)message('trip-message','No saved trips yet.');
    }catch(error){showError('trip-message',error);}
  }
  async function loadTrip(id){
    if(busy||!canSwitch())return;
    busy=true;update();
    try{const data=await api(`/trips/${id}`);photoPanelRequest++;discardPending();galleryFilter='';suppress=true;app.setStops(data.trip.stops);suppress=false;current={id:data.trip.id,title:data.trip.title,revision:data.trip.revision,hash:fingerprint()};photos=data.photos;dirty=false;remember();renderGallery();closePanel('trip-panel');message('trip-message','');}
    catch(error){showError('trip-message',error);}finally{suppress=false;busy=false;update();}
  }
  async function saveCurrent(title){
    const route=app.getStops(),name=(title||current?.title||'').trim();if(!name)throw Error('Give this trip a name.');
    const data=await api(current?`/trips/${current.id}`:'/trips',{method:current?'PUT':'POST',body:JSON.stringify({title:name,stops:route,...(current?{revision:current.revision}:{})})});
    // Persist the canonical server route, but never replace edits made during the request.
    if(fingerprint()===JSON.stringify(route)&&JSON.stringify(data.trip.stops)!==JSON.stringify(route)){
      const sameRoute=routeContent(route)===routeContent(data.trip.stops)&&route.every((stop,i)=>stop.id===data.trip.stops[i].id);
      suppress=true;try{app.setStops(data.trip.stops,{preserveView:sameRoute});}finally{suppress=false;}
    }
    current={id:data.trip.id,title:data.trip.title,revision:data.trip.revision,hash:JSON.stringify(data.trip.stops)};dirty=fingerprint()!==current.hash;remember();update();return data.trip;
  }
  async function ensureSaved(){
    if(!current){resumePhotos=true;openPanel('trip-panel');$('trip-name').value='';$('trip-name').focus();message('trip-message','Name and save this trip to add photos.');listTrips();return false;}
    if(dirty)await saveCurrent();return true;
  }
  $('trips-button').addEventListener('click',()=>{if(!$('trip-panel').hidden){closePanel('trip-panel');return;}openPanel('trip-panel');$('trip-name').value=current?.title||'';message('trip-message','');listTrips();});
  $('save-trip').addEventListener('click',async()=>{
    if(!current){openPanel('trip-panel');$('trip-name').value='';$('trip-name').focus();message('trip-message','');listTrips();return;}
    busy=true;update();try{await saveCurrent();$('save-trip').textContent='Saved';setTimeout(()=>$('save-trip').textContent='Save',1300);}catch(error){openPanel('trip-panel');showError('trip-message',error);}finally{busy=false;update();}
  });
  $('trip-name-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;busy=true;update();
    try{await saveCurrent($('trip-name').value);message('trip-message','');closePanel('trip-panel');if(resumePhotos){resumePhotos=false;openPanel('photo-panel');renderGallery();}}
    catch(error){showError('trip-message',error);}finally{busy=false;update();}
  });
  $('new-trip').addEventListener('click',()=>{if(!canSwitch())return;discardPending();current=null;photos=[];galleryFilter='';suppress=true;app.setStops([]);suppress=false;dirty=false;remember();update();renderGallery();closePanel('trip-panel');$('destination').focus();});
  document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>{closePanel(button.dataset.close);$(button.dataset.close==='photo-panel'?'photos-button':'trips-button').focus({preventScroll:true});}));
  window.addEventListener('redline:routechange',()=>{if(suppress)return;dirty=current?fingerprint()!==current.hash:app.getStops().length>0;update();if(!$('photo-panel').hidden){renderReview();renderGallery();}});
  window.addEventListener('beforeunload',event=>{if(pending.length||dirty){event.preventDefault();event.returnValue='';}});
  $('photos-button').addEventListener('click',async()=>{
    if(photosRequested||!$('photo-panel').hidden){closePanel('photo-panel');return;}if(busy)return;
    photosRequested=true;const version=++photoPanelRequest;
    try{
      if(!await ensureSaved()||version!==photoPanelRequest)return;
      openPanel('photo-panel');renderGallery();renderReview();message('photo-message','');
      const tripId=current.id,data=await api(`/trips/${tripId}`);if(version!==photoPanelRequest||current?.id!==tripId)return;
      photos=data.photos;renderGallery();update();
    }catch(error){if(version===photoPanelRequest){openPanel('photo-panel');showError('photo-message',error);}}
    finally{if(version===photoPanelRequest)photosRequested=false;}
  });
  document.addEventListener('keydown',async event=>{
    if(event.key==='Escape'&&!document.querySelector('dialog[open]')&&!$('photo-panel').hidden){event.preventDefault();closePanel('photo-panel');$('photos-button').focus({preventScroll:true});return;}
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
  async function cleanImage(file){
    if(file.size>30*1024*1024)throw Error('Use a photo smaller than 30 MB.');
    let bitmap;
    try{bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});}catch{
      const url=URL.createObjectURL(file);try{bitmap=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(Error('This browser cannot read that photo. Export it as JPEG and try again.'));image.src=url;});}finally{URL.revokeObjectURL(url);}
    }
    try{
      const width=bitmap.width||bitmap.naturalWidth,height=bitmap.height||bitmap.naturalHeight;
      if(!width||!height||width*height>60000000)throw Error('Use a photo smaller than 60 megapixels.');
      const factor=Math.min(1,2400/Math.max(width,height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*factor));canvas.height=Math.max(1,Math.round(height*factor));
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Could not process this photo.')),'image/jpeg',.88));canvas.width=1;canvas.height=1;
      if(blob.type!=='image/jpeg'||blob.size>4*1024*1024)throw Error('Could not reduce this photo below 4 MB.');return blob;
    }finally{bitmap.close?.();}
  }
  $('choose-photos').addEventListener('click',()=>$('photo-files').click());
  $('photo-files').addEventListener('change',async event=>{
    const files=[...event.target.files];event.target.value='';await importPhotos(files);
  });
  async function importPhotos(files){
    if(!files.length||busy||!current)return;
    if(files.length+pending.length>30){message('photo-message','Choose up to 30 photos at a time.',true);return;}
    busy=true;importing=true;photoPanelRequest++;photosRequested=false;update();let failed=0,lastError='';
    try{
      await loadExif().catch(()=>{});
      for(let i=0;i<files.length;i++){
        message('photo-message',`Reading ${i+1} of ${files.length}…`);
        try{
          if(!/^image\//.test(files[i].type)&&!(/\.(jpe?g|png|webp|hei[cf]|avif)$/i.test(files[i].name)))throw Error('Choose image files only.');
          let gps=null;try{gps=await exifr.gps(files[i]);}catch{}
          const blob=await cleanImage(files[i]);let candidate=null;try{candidate=await matchCity(gps);}catch{}
          const entry={id:crypto.randomUUID(),name:files[i].name,blob,url:URL.createObjectURL(blob),candidate,selected:candidate?(candidate.existing?candidate.id:'match'):'',checked:true};
          pending.push(entry);renderReview();
        }catch(error){failed++;lastError=error.message;}
      }
      message('photo-message',failed?`${failed} photo${failed===1?'':'s'} could not be read. ${lastError}`:'',failed>0);renderReview();
    }catch(error){showError('photo-message',error);}finally{busy=false;importing=false;update();renderReview();}
  }
  const fileDrag=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
  $('photo-panel').addEventListener('dragenter',event=>{if(!fileDrag(event))return;event.preventDefault();dragDepth++;if(!busy)$('photo-drop-hint').hidden=false;});
  $('photo-panel').addEventListener('dragover',event=>{if(!fileDrag(event))return;event.preventDefault();event.dataTransfer.dropEffect=busy?'none':'copy';});
  $('photo-panel').addEventListener('dragleave',event=>{if(!fileDrag(event))return;dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('photo-drop-hint').hidden=true;});
  $('photo-panel').addEventListener('drop',event=>{if(!fileDrag(event))return;event.preventDefault();dragDepth=0;$('photo-drop-hint').hidden=true;importPhotos([...event.dataTransfer.files]);});
  // A missed drop must never replace the app with a local image.
  for(const type of ['dragover','drop'])document.addEventListener(type,event=>{
    if($('photo-panel').hidden||!fileDrag(event))return;
    event.preventDefault();if(type==='drop'){dragDepth=0;$('photo-drop-hint').hidden=true;}
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
    $('choose-photos').textContent=pending.length?'Add more':'Add photos';
    $('photo-gallery').hidden=reviewing;
    $('gallery-toolbar').hidden=reviewing||!photos.length;
    $('photo-review').hidden=!reviewing;
    $('photo-review').setAttribute('aria-busy',String(importing));
    $('photo-bulk').hidden=!pending.length;
    $('photo-import-actions').hidden=!pending.length;
  }
  function cityOptions(select,emptyLabel){
    select.replaceChildren(new Option(emptyLabel,''));
    for(const stop of app.getStops())select.add(new Option(`${stop.name}${stop.country?', '+stop.country:''}`,stop.id));
  }
  function previewButton(photo,open){
    const button=document.createElement('button'),image=document.createElement('img');button.type='button';button.className='photo-image';image.src=photo.url;image.alt='';image.loading='lazy';image.decoding='async';image.draggable=false;button.setAttribute('aria-label',photo.city?.name?`Open photo in ${photo.city.name}`:`Expand ${photo.name||'photo'}`);button.append(image);button.addEventListener('click',open);return button;
  }
  function removeButton(label,remove){
    const button=document.createElement('button');button.type='button';button.className='remove-photo';button.textContent='×';button.title=label;button.setAttribute('aria-label',label);button.disabled=busy;button.addEventListener('click',remove);return button;
  }
  function renderReview(){
    const container=$('photo-review');container.replaceChildren();const stops=app.getStops();
    pending.forEach((entry,index)=>{
      const row=document.createElement('div'),tools=document.createElement('div'),select=document.createElement('select'),pick=document.createElement('label'),checkbox=document.createElement('input');
      row.className='photo-tile review-photo';row.dataset.pendingId=entry.id;tools.className='photo-tile-tools';pick.className='photo-pick';checkbox.type='checkbox';checkbox.checked=entry.checked;checkbox.disabled=busy;checkbox.setAttribute('aria-label',`Select ${entry.name||`photo ${index+1}`}`);pick.append(checkbox);
      checkbox.addEventListener('change',()=>{entry.checked=checkbox.checked;updateBulkSelection();});
      const image=previewButton(entry,()=>{
        const collection=pending.map(p=>({...p,city:p.selected==='match'?p.candidate:app.getStops().find(s=>s.id===p.selected)}));
        window.RedlinePostcards.open(collection.find(p=>p.id===entry.id),null,collection);
      });image.disabled=busy;
      cityOptions(select,'Choose city…');select.setAttribute('aria-label',`City for ${entry.name||`photo ${index+1}`}`);
      if(entry.candidate&&!entry.candidate.existing)select.add(new Option(`${entry.candidate.name} (GPS)`,'match'));
      if(entry.selected!=='match'&&!stops.some(s=>s.id===entry.selected))entry.selected='';select.value=entry.selected;select.disabled=busy;row.classList.toggle('needs-city',!entry.selected);select.addEventListener('change',()=>{entry.selected=select.value;row.classList.toggle('needs-city',!entry.selected);updateUploadButton();});
      const remove=removeButton(`Remove ${entry.name||`photo ${index+1}`} from import`,()=>{
        URL.revokeObjectURL(entry.url);pending=pending.filter(p=>p.id!==entry.id);renderReview();
        (container.children[Math.min(index,pending.length-1)]?.querySelector('.remove-photo')||$('choose-photos')).focus({preventScroll:true});
      });tools.append(select);row.append(image,pick,remove,tools);container.append(row);
    });
    $('photo-bulk').hidden=!pending.length;
    cityOptions($('bulk-photo-city'),'Assign city…');
    const seen=new Set();for(const entry of pending){const city=entry.candidate;if(city&&!city.existing){const key=`${city.latitude},${city.longitude}`;if(!seen.has(key)){seen.add(key);$('bulk-photo-city').add(new Option(`${city.name} (GPS)`,`gps:${entry.id}`));}}}
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
        const entry=ready[i];message('photo-message',`Saving ${i+1} of ${ready.length}…`);
        const form=new FormData();form.append('photo',entry.blob,'photo.jpg');form.append('stopId',entry.selected);
        const {photo}=await api(`/trips/${current.id}/photos`,{method:'POST',body:form});photos.push(photo);pending=pending.filter(p=>p.id!==entry.id);URL.revokeObjectURL(entry.url);
      }
      if(!pending.length)galleryFilter='';
      message('photo-message',pending.length?'Choose a city for the remaining photos.':`${photoLabel(ready.length)} saved.`);renderGallery();
    }catch(error){showError('photo-message',error);}finally{busy=false;update();renderReview();renderGallery();if(!pending.length)$('choose-photos').focus({preventScroll:true});}
  });
  function galleryGrid(items){
    const grid=document.createElement('div');grid.className='photo-grid';
    for(const photo of items){
      const tile=document.createElement('div');tile.className='photo-tile';tile.dataset.photoId=photo.id;
      const button=previewButton(photo,()=>window.RedlinePostcards.open(photo,api,galleryItems));
      button.setAttribute('aria-label',`Open photo ${items.indexOf(photo)+1} in ${photo.city?.name||'this trip'}`);
      tile.append(button);grid.append(tile);
    }return grid;
  }
  function renderGallery(){
    const container=$('photo-gallery');container.replaceChildren();
    const groups=new Map();
    const stops=app.getStops(),order=new Map(stops.map((stop,index)=>[stop.id,index]));
    for(const photo of photos){const key=photo.stopId||'unplaced';if(!groups.has(key))groups.set(key,{id:key,name:photo.city?.name||'Other photos',country:photo.city?.country||'',items:[]});groups.get(key).items.push(photo);}
    const sorted=[...groups.values()].sort((a,b)=>(order.get(a.id)??Infinity)-(order.get(b.id)??Infinity)||a.name.localeCompare(b.name));
    if(!groups.has(galleryFilter))galleryFilter='';
    const filter=$('gallery-city');filter.replaceChildren(new Option('All cities',''));
    for(const group of sorted)filter.add(new Option(`${group.name} (${group.items.length})`,group.id));
    filter.value=galleryFilter;
    const visible=sorted.filter(group=>!galleryFilter||group.id===galleryFilter);galleryItems=visible.flatMap(group=>group.items);
    $('gallery-count').textContent=photoLabel(galleryItems.length);
    if(!photos.length){
      const empty=document.createElement('div'),label=document.createElement('p'),add=document.createElement('button');empty.className='photo-empty';
      empty.innerHTML='<svg viewBox="0 0 56 56" aria-hidden="true"><path d="M11 14 8 44l33 3 1-6M16 9h32v32H16zM16 32l9-10 7 7 5-5 11 12"/><circle cx="37" cy="18" r="3"/></svg>';
      label.textContent='No photos yet';add.type='button';add.className='text-button';add.textContent='Add photos';add.disabled=busy;add.addEventListener('click',()=>$('choose-photos').click());empty.append(label,add);container.append(empty);
    }
    for(const {name,country,items} of visible){
      const section=document.createElement('section'),top=document.createElement('div'),place=document.createElement('div'),heading=document.createElement('h3'),count=document.createElement('span');
      section.className='gallery-city';top.className='gallery-city-heading';heading.textContent=name;count.className='gallery-city-count';count.textContent=String(items.length);count.setAttribute('aria-label',photoLabel(items.length));place.append(heading);
      if(country){const detail=document.createElement('p');detail.className='gallery-city-country';detail.textContent=country;place.append(detail);}
      top.append(place,count);section.append(top,galleryGrid(items));container.append(section);
    }
    renderPhotoMode();
  }
  $('gallery-city').addEventListener('change',()=>{galleryFilter=$('gallery-city').value;renderGallery();$('photo-scroll').scrollTop=0;});
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
    }catch(error){if(current!==cached)return;if(error.status===404){current=null;photos=[];remember();update();}else{openPanel('trip-panel');showError('trip-message',error);}}
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
      downloadBackup(blob,`${name}.redline`);message('trip-message','Backup downloaded.');
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
