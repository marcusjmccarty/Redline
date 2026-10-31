(() => {
  'use strict';
  const $=id=>document.getElementById(id),fields=['message','recipient','address','sender'],states=new Map();
  let active=null,request=null,timer=null,closing=false,printing=false,restoreAfterPrint=false;
  let shareFile=null,shareGeneration=0,shareTimer=null,sharing=false;
  let sequence=[],navigating=false,navigationVersion=0,returnFocus=null,swipe=null,suppressClickUntil=0,actions=null,changing=false,arrowTimer=null;
  function wakeArrows(pointer='mouse'){
    const frame=$('full-photo').parentElement;clearTimeout(arrowTimer);frame.classList.remove('arrows-idle');
    if(pointer==='touch')return;
    arrowTimer=setTimeout(()=>{if($('photo-viewer').open)frame.classList.add('arrows-idle');},700);
  }
  const empty=()=>Object.fromEntries(fields.map(key=>[key,'']));
  const motion=el=>typeof el?.animate==='function'&&'finished' in (window.Animation?.prototype||{})&&!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const settle=animation=>animation?.finished?.catch(()=>{});
  const decode=url=>{const image=new Image();image.decoding='async';image.src=url;return image.decode?image.decode().catch(()=>{}):Promise.resolve();};
  const cardDirty=state=>JSON.stringify(state.value)!==state.saved;
  const captionDirty=state=>state.caption.trim()!==state.savedCaption;
  const dirty=state=>cardDirty(state)||captionDirty(state);
  function status(){if(!active)return;$('postcard-save-status').textContent=active.promise?'Saving…':'';$('postcard-saved').textContent=active.promise?'Saving…':cardDirty(active)?'':active.saved!==JSON.stringify(empty())?'Saved':'';$('save-postcard').disabled=active.preview||!!active.promise;$('save-postcard').textContent=active.promise?'Saving…':'Save';}
  async function savePostcard(state){
    if(!state||state.preview)return;
    if(state.promise){await state.promise;return savePostcard(state);}
    if(!cardDirty(state))return;
    const snapshot=JSON.stringify(state.value);
    state.promise=(async()=>{
      const result=await request(`/photos/${state.photo.id}/postcard`,{method:'PUT',body:JSON.stringify({postcard:JSON.parse(snapshot),revision:state.revision})});
      state.revision=result.revision;state.photo.postcardRevision=result.revision;state.saved=snapshot;
    })();status();
    try{await state.promise;if(active===state)$('postcard-error').textContent='';}
    catch(error){if(active===state)$('postcard-error').textContent=error.message;throw error;}
    finally{state.promise=null;status();}
    if(cardDirty(state))return savePostcard(state);
  }
  function captionStatus(){
    if(!active)return;
    $('save-caption').disabled=!!active.captionPromise;
    $('save-caption').textContent=active.captionPromise?'Saving…':'Save';
  }
  function captionEditor(open){
    if(open&&$('caption-form').hidden){const viewer=$('photo-viewer'),top=viewer.getBoundingClientRect().top;viewer.style.top=`${top}px`;viewer.style.bottom='auto';viewer.style.marginBlock='0';}
    $('caption-form').hidden=!open;
    $('edit-caption').setAttribute('aria-expanded',String(open));
    $('postcard-front').classList.toggle('caption-editing',open);
    if(open){$('caption-input').value=active.caption;$('caption-input').focus();captionStatus();}
    $('photo-caption').textContent=$('photo-caption').title=active.photo.city?.name||'';
    $('photo-note').textContent=$('photo-note').title=active.caption.trim();$('photo-note').hidden=open||!active.caption.trim();
  }
  async function saveCaption(state){
    if(!state||state.preview)return;
    if(state.captionPromise){await state.captionPromise;return saveCaption(state);}
    if(!captionDirty(state))return;
    const text=state.caption.trim();
    state.captionPromise=(async()=>{
      const result=await request(`/photos/${state.photo.id}/caption`,{method:'PUT',body:JSON.stringify({caption:text,revision:state.captionRevision})});
      state.savedCaption=result.caption;state.captionRevision=result.revision;
      state.photo.caption=result.caption;state.photo.captionRevision=result.revision;
      window.dispatchEvent(new CustomEvent('redline:captionchange',{detail:{id:state.photo.id,caption:result.caption,revision:result.revision}}));
    })();captionStatus();
    try{await state.captionPromise;if(active===state)$('postcard-error').textContent='';}
    catch(error){if(active===state)$('postcard-error').textContent=error.message;throw error;}
    finally{state.captionPromise=null;captionStatus();}
    if(captionDirty(state))return saveCaption(state);
  }
  async function save(state){await savePostcard(state);await saveCaption(state);}
  async function finishCaption(){
    const state=active;if(!state)return;clearTimeout(timer);
    try{await saveCaption(state);if(active===state){captionEditor(false);$('edit-caption').focus({preventScroll:true});$('postcard-save-status').textContent='Caption saved.';}}catch{}
  }
  $('edit-caption').addEventListener('click',()=>{if($('caption-form').hidden)captionEditor(true);else finishCaption();});
  $('caption-form').addEventListener('submit',event=>{event.preventDefault();finishCaption();});
  $('caption-input').addEventListener('input',()=>{
    if(!active)return;active.caption=$('caption-input').value;captionStatus();clearTimeout(timer);
    const state=active;timer=setTimeout(()=>saveCaption(state).catch(()=>{}),600);
  });
  $('caption-input').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finishCaption();}});
  function flip(){
    if(active?.preview)return;
    const back=!$('photo-viewer').classList.contains('flipped'),viewer=$('photo-viewer');if(back)captionEditor(false);wakeArrows();
    // The card lifts slightly off the table while it turns over.
    if(motion(viewer)){viewer.classList.remove('flip-motion');void viewer.offsetWidth;viewer.classList.add('flip-motion');clearTimeout(flip.timer);flip.timer=setTimeout(()=>viewer.classList.remove('flip-motion'),950);}
    $('photo-viewer').classList.toggle('flipped',back);
    if(back&&!shareFile)queueShare();
    else if(!back){clearTimeout(shareTimer);shareGeneration++;}
    $('postcard-front').inert=back;$('postcard-front').setAttribute('aria-hidden',String(back));
    $('postcard-back').inert=!back;$('postcard-back').setAttribute('aria-hidden',String(!back));
    if(document.activeElement!==document.body)closer().focus({preventScroll:true});
  }
  // Focus stays on the visible paper, leaving the image toolbar uncluttered.
  const closer=()=>$('photo-viewer').classList.contains('flipped')?$('unflip-postcard'):$('postcard-front');
  function updateNavigation(){
    const index=sequence.findIndex(photo=>photo.id===active?.photo.id),previous=$('viewer-previous'),next=$('viewer-next');
    $('photo-position').hidden=sequence.length<2;
    $('photo-position').textContent=`${index+1} / ${sequence.length}`;
    // The photo's own edges browse; they disappear at either end of the city, handing focus to the other edge or the photo.
    previous.hidden=index<=0;next.hidden=index<0||index>=sequence.length-1;
    if([previous,next].some(edge=>edge.hidden&&edge===document.activeElement))[previous,next,$('postcard-front')].find(el=>!el.hidden).focus({preventScroll:true});
    // Warm the neighbours so browsing feels instant.
    for(const near of [sequence[index-1],sequence[index+1]])if(near?.url){const image=new Image();image.decoding='async';image.src=near.url;}
  }
  function renderCity(){$('delete-photo').hidden=!actions;}
  async function removeCurrent(){
    const state=active;if(!actions||!state||changing||navigating)return;
    if(!confirm('Delete this photo and its postcard? This can’t be undone.'))return;
    changing=true;clearTimeout(timer);
    try{
      const index=sequence.findIndex(photo=>photo.id===state.photo.id);
      await actions.remove(state.photo);
      sequence=sequence.filter(photo=>photo.id!==state.photo.id);
      // Closing the viewer during the delete keeps it closed.
      if(!$('photo-viewer').open)return;
      const next=sequence[Math.min(index,sequence.length-1)];
      if(next){await decode(next.url);if(!$('photo-viewer').open||closing)return;const glide=prepareGlide(1);open(next,request,sequence,actions);glide();}else {active=null;await dismiss(state.photo.id);restoreFocus(state.photo.id);}
    }catch(error){if(active===state)$('postcard-error').textContent=error.message;}
    finally{changing=false;updateNavigation();}
  }
  // The album re-renders after moves and deletes, so fall back to the photo's new print or the album.
  function shownPhoto(photoId){return [...document.querySelectorAll('[data-photo-id]')].find(el=>el.dataset.photoId===photoId&&el.getClientRects().length)?.querySelector('.photo-image');}
  function restoreFocus(photoId){
    const back=returnFocus?.isConnected&&returnFocus!==document.body?returnFocus:null;
    const target=shownPhoto(photoId)||back||($('photo-panel')?.open?$('photo-panel'):null);
    target?.focus({preventScroll:true});
  }
  // The viewer grows out of the print that was clicked, and shrinks back into it.
  function zoomFrom(origin){
    const viewer=$('photo-viewer'),image=$('full-photo');
    if(!origin?.isConnected||!motion(viewer))return;
    const from=origin.getBoundingClientRect(),to=image.getBoundingClientRect(),box=viewer.getBoundingClientRect();
    if(!from.width||!to.width)return;
    const pivot=`${to.left+to.width/2-box.left}px ${to.top+to.height/2-box.top}px`,scale=from.width/to.width;
    const shift=`translate(${from.left+from.width/2-(to.left+to.width/2)}px,${from.top+from.height/2-(to.top+to.height/2)}px) scale(${scale})`;
    viewer.animate([{transformOrigin:pivot,transform:`perspective(1600px) ${shift} rotateY(0deg)`,opacity:.25},{transformOrigin:pivot,transform:'perspective(1600px) translate(0px,0px) scale(1) rotateY(0deg)',opacity:1}],{duration:480,easing:'cubic-bezier(.2,.85,.25,1)'});
  }
  async function zoomOut(photoId){
    const viewer=$('photo-viewer'),image=$('full-photo');if(!motion(viewer))return;
    const flipped=viewer.classList.contains('flipped'),turn=flipped?'rotateY(180deg)':'rotateY(0deg)',target=flipped?null:shownPhoto(photoId);
    const to=image.getBoundingClientRect(),box=viewer.getBoundingClientRect(),pivot=`${to.left+to.width/2-box.left}px ${to.top+to.height/2-box.top}px`;
    let end=`perspective(1600px) translate(0px,12px) scale(.94) ${turn}`;
    if(target&&to.width){const from=target.getBoundingClientRect();if(from.width)end=`perspective(1600px) translate(${from.left+from.width/2-(to.left+to.width/2)}px,${from.top+from.height/2-(to.top+to.height/2)}px) scale(${from.width/to.width}) ${turn}`;}
    const fade={duration:300,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'};
    try{viewer.animate([{opacity:1},{opacity:0}],{...fade,pseudoElement:'::backdrop'});}catch{}
    await settle(viewer.animate([{transformOrigin:pivot,transform:`perspective(1600px) translate(0px,0px) scale(1) ${turn}`,opacity:1},{transformOrigin:pivot,transform:end,opacity:target?.3:0}],fade));
  }
  function dismiss(photoId){
    const viewer=$('photo-viewer');
    return zoomOut(photoId).then(()=>{if(viewer.open)viewer.close();viewer.getAnimations?.().forEach(animation=>animation.cancel());});
  }
  // Browsing glides between photos of different shapes instead of jumping.
  function prepareGlide(direction){
    const viewer=$('photo-viewer'),image=$('full-photo');
    if(!motion(viewer)||viewer.classList.contains('flipped'))return ()=>{};
    const before=image.getBoundingClientRect();if(!before.width)return ()=>{};
    const ghost=image.cloneNode();ghost.removeAttribute('id');ghost.className='viewer-ghost';ghost.alt='';ghost.setAttribute('aria-hidden','true');
    return ()=>{
      const after=image.getBoundingClientRect(),timing={duration:360,easing:'cubic-bezier(.25,.8,.25,1)'};
      image.parentElement.append(ghost);
      image.animate([{width:`${before.width}px`,height:`${before.height}px`},{width:`${after.width}px`,height:`${after.height}px`}],timing);
      image.animate([{opacity:0,transform:`translateX(${direction*28}px)`},{opacity:1,transform:'translateX(0px)'}],timing);
      $('photo-caption').animate([{opacity:0},{opacity:1}],timing);
      $('photo-note').animate([{opacity:0},{opacity:1}],timing);
      settle(ghost.animate([{opacity:1,transform:'translateX(0px)'},{opacity:0,transform:`translateX(${-direction*28}px)`}],{duration:280,easing:'ease-in',fill:'forwards'})).then(()=>ghost.remove());
    };
  }
  function open(photo,api,collection=[photo],viewerActions=null,origin=null){
    const wasOpen=$('photo-viewer').open,onBack=$('postcard-back').contains(document.activeElement);
    for(const property of ['top','bottom','margin-block'])$('photo-viewer').style.removeProperty(property);
    if(!wasOpen)returnFocus=origin||document.activeElement;
    sequence=collection;actions=api?viewerActions:null;
    shareGeneration++;shareFile=null;clearTimeout(shareTimer);$('share-postcard').disabled=true;
    request=api;clearTimeout(timer);
    const previous=api?states.get(photo.id):null;
    if(previous&&(dirty(previous)||previous.promise||previous.captionPromise))active=previous;
    else {const value={...empty(),...photo.postcard};active={photo,value,saved:JSON.stringify(value),revision:photo.postcardRevision||1,promise:null,preview:!api,caption:photo.caption||'',savedCaption:photo.caption||'',captionRevision:photo.captionRevision||1,captionPromise:null};if(api)states.set(photo.id,active);}
    const place=photo.city?.name||'';
    $('postcard-error').textContent='';$('full-photo').src=photo.url;$('full-photo').alt=place?`Photo in ${place}`:'Trip photo';
    captionEditor(false);$('edit-caption').hidden=active.preview;$('postcard-place').textContent=place;
    for(const key of fields)$(`postcard-${key}`).value=active.value[key];
    // A new photo starts face up, without playing the previous postcard's reverse flip.
    $('photo-viewer').classList.add('changing-photo');
    $('photo-viewer').classList.remove('flipped');
    requestAnimationFrame(()=>requestAnimationFrame(()=>$('photo-viewer').classList.remove('changing-photo')));
    $('postcard-front').inert=false;$('postcard-front').setAttribute('aria-hidden','false');$('postcard-back').inert=true;$('postcard-back').setAttribute('aria-hidden','true');
    $('print-postcard').disabled=active.preview;$('flip-postcard').hidden=active.preview;
    $('photo-viewer').classList.toggle('preview',active.preview);
    status();updateOrientation();updateNavigation();renderCity();wakeArrows(window.matchMedia?.('(hover: none)').matches?'touch':'mouse');
    if(!wasOpen){
      const viewer=$('photo-viewer');viewer.getAnimations?.().forEach(animation=>animation.cancel());viewer.showModal();
      if(motion(viewer)&&origin){viewer.style.opacity='0';decode(photo.url).then(()=>{viewer.style.opacity='';if(active?.photo===photo)zoomFrom(origin);});}
    }
    // A new photo always shows its front, so focus on the back moves to the front's paper.
    if(!wasOpen||onBack)$('postcard-front').focus({preventScroll:true});
  }
  async function navigate(direction){
    if(navigating||changing||closing||printing||!$('photo-viewer').open)return;
    const index=sequence.findIndex(photo=>photo.id===active?.photo.id),photo=sequence[index+direction];
    if(!photo)return;
    const version=++navigationVersion; navigating=true;clearTimeout(timer);
    try{
      await save(active);
      if(version!==navigationVersion||!$('photo-viewer').open)return;
      await decode(photo.url);
      if(version!==navigationVersion||!$('photo-viewer').open)return;
      const glide=prepareGlide(direction);open(photo,request,sequence,actions);glide();
    }catch{}finally{navigating=false;updateNavigation();}
  }
  async function close(){
    if(closing)return;closing=true;navigationVersion++;clearTimeout(timer);clearTimeout(arrowTimer);
    const photoId=active?.photo.id;
    try{
      let leave=true;try{await save(active);}catch{leave=confirm('Close without saving? Your draft will stay in this tab.');}
      if(leave){try{await dismiss(photoId);}catch{if($('photo-viewer').open)$('photo-viewer').close();}}
    }finally{closing=false;if(!$('photo-viewer').open)restoreFocus(photoId);}
  }
  fields.forEach(key=>$(`postcard-${key}`).addEventListener('input',()=>{
    if(!active)return;active.value[key]=$(`postcard-${key}`).value;active.photo.postcard={...active.value};
    status();clearTimeout(timer);const state=active;timer=setTimeout(()=>save(state).catch(()=>{}),600);
    shareGeneration++;shareFile=null;$('share-postcard').disabled=true;clearTimeout(shareTimer);shareTimer=setTimeout(prepareShare,350);
  }));
  function updateOrientation(){
    const photo=$('full-photo');
    $('postcard-stage').classList.toggle('portrait',photo.naturalHeight>photo.naturalWidth);
  }
  $('full-photo').draggable=false;
  $('full-photo').addEventListener('load',()=>{updateOrientation();if($('photo-viewer').classList.contains('flipped'))queueShare();});
  $('viewer-previous').addEventListener('click',()=>navigate(-1));
  $('viewer-next').addEventListener('click',()=>navigate(1));
  // A held Return on an edge would keep clicking it, and focus hands over to the other edge at the end of the port.
  for(const edge of [$('viewer-previous'),$('viewer-next')])edge.addEventListener('keydown',event=>{if(event.repeat&&event.key==='Enter')event.preventDefault();});
  $('flip-postcard').addEventListener('click',flip);
  $('unflip-postcard').addEventListener('click',flip);
  $('save-postcard').addEventListener('click',async()=>{
    const state=active;if(!state||state.preview)return;clearTimeout(timer);
    try{await save(state);if(active===state){$('postcard-saved').textContent='Saved';$('postcard-save-status').textContent='Postcard saved.';}}catch{}
  });
  $('delete-photo').addEventListener('click',removeCurrent);
  $('photo-viewer').addEventListener('cancel',event=>{event.preventDefault();close();});
  $('photo-viewer').addEventListener('click',event=>{
    if(Date.now()<suppressClickUntil)return;
    if(event.target===$('photo-viewer')){
      const box=$('photo-viewer').getBoundingClientRect();
      if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom){close();return;}
    }
    // The photo and the postcard paper turn the card; the toolbar and fields never do.
    if(event.detail>1||event.target.closest('input,textarea,button,a,label,select,.photo-viewer-footer,.postcard-actions'))return;
    flip();
  });
  // A swipe can start anywhere on the photo, its edge arrows included.
  const frame=$('full-photo').parentElement;
  for(const type of ['pointerenter','pointermove','pointerdown'])frame.addEventListener(type,event=>wakeArrows(event.pointerType||'mouse'));
  frame.addEventListener('focusin',()=>wakeArrows());
  frame.addEventListener('pointerdown',event=>{
    swipe=event.pointerType==='touch'&&!$('photo-viewer').classList.contains('flipped')?{x:event.clientX,y:event.clientY,id:event.pointerId}:null;
  });
  frame.addEventListener('pointerup',event=>{
    if(!swipe||swipe.id!==event.pointerId)return;
    const dx=event.clientX-swipe.x,dy=event.clientY-swipe.y;swipe=null;
    if(Math.abs(dx)<55||Math.abs(dx)<Math.abs(dy)*1.5)return;
    suppressClickUntil=Date.now()+500;navigate(dx<0?1:-1);
  });
  frame.addEventListener('pointercancel',()=>swipe=null);
  document.addEventListener('keydown',event=>{
    if(!$('photo-viewer').open||event.defaultPrevented||event.altKey||event.metaKey||event.ctrlKey||event.isComposing||event.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    if(event.key.toLowerCase()==='f'&&!active?.preview){event.preventDefault();if(!event.repeat)flip();return;}
    if((event.key==='Delete'||event.key==='Backspace')&&actions&&!$('photo-viewer').classList.contains('flipped')){event.preventDefault();if(!event.repeat)removeCurrent();return;}
    if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();if(!event.repeat)navigate(event.key==='ArrowLeft'?-1:1);
  });
  // The 4.4-megapixel share export is only needed on the back. Browsing photos
  // should not rebuild it, and typing waits for a pause before drawing again.
  function queueShare(){clearTimeout(shareTimer);shareTimer=setTimeout(prepareShare,250);}
  async function prepareShare(){
    if(closing||!$('photo-viewer').open||!$('photo-viewer').classList.contains('flipped'))return;
    const generation=++shareGeneration,state=active;
    shareFile=null;$('share-postcard').disabled=true;
    if(!state||state.preview)return;
    try{
      const image=$('full-photo');await image.decode();
      if(generation!==shareGeneration||active!==state)return;
      const canvas=RedlinePostcardExport.render(image,state.photo.city?.name||'',state.value);
      const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('Could not create the postcard image.')),'image/jpeg',.94));
      if(generation!==shareGeneration||active!==state)return;
      const name=(state.photo.city?.name||'Travel').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')||'Travel';
      shareFile=new File([blob],`${name}-postcard.jpg`,{type:'image/jpeg'});$('share-postcard').disabled=sharing;
    }catch(error){if(generation===shareGeneration&&$('full-photo').naturalWidth)$('postcard-error').textContent=error.message;}
  }
  function downloadPostcard(file){
    const url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=file.name;link.hidden=true;($('photo-viewer').open?$('photo-viewer'):document.body).append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    $('postcard-save-status').textContent='Postcard downloaded.';
  }
  async function sharePostcard(){
    if(!shareFile||sharing)return;
    const file=shareFile;sharing=true;$('share-postcard').disabled=true;
    try{
      // The file is ready before the click, preserving native share activation.
      if(navigator.share&&navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:active.photo.city?.name?`Postcard from ${active.photo.city.name}`:'Postcard'});
      else downloadPostcard(file);
    }catch(error){if(error.name!=='AbortError')downloadPostcard(file);}
    finally{sharing=false;$('share-postcard').disabled=!shareFile;}
  }
  $('share-postcard').addEventListener('click',sharePostcard);
  $('print-postcard').addEventListener('click',printPostcard);
  function printPage(className){const page=document.createElement('section');page.className=`postcard-print-page ${className}`;return page;}
  async function printPostcard(){
    if(!active||active.preview||printing)return;printing=true;
    const state=active;clearTimeout(timer);
    try{
      await save(state).catch(()=>{});
      try{await $('full-photo').decode();}catch{if(!$('full-photo').naturalWidth)throw Error('The photo is still loading. Try printing again.');}
      $('postcard-print-root')?.remove();
      const root=document.createElement('div');root.id='postcard-print-root';root.setAttribute('aria-hidden','true');
      const front=printPage('print-front'),image=document.createElement('img');image.src=state.photo.url;image.alt='';front.append(image);
      const back=printPage('print-back'),heading=document.createElement('div'),place=document.createElement('span'),stamp=document.createElement('span');heading.className='postcard-heading';place.textContent=state.photo.city?.name||'';stamp.className='postcard-stamp';heading.append(place,stamp);
      const columns=document.createElement('div'),message=document.createElement('div'),address=document.createElement('div');columns.className='postcard-columns';message.className='print-message';message.textContent=state.value.message;address.className='postcard-address';
      for(const key of ['recipient','address','sender']){const text=document.createElement('div');text.className=`print-${key}`;text.textContent=state.value[key];address.append(text);}
      columns.append(message,address);back.append(heading,columns);root.append(front,back);const pageStyle=document.createElement('style');pageStyle.textContent='@media print{@page{size:6in 4in;margin:0}}';root.append(pageStyle);document.body.append(root);
      await image.decode();
      for(const block of [message,address]){let size=10;while((block.scrollHeight>block.clientHeight+1||block.scrollWidth>block.clientWidth+1)&&size>6){size-=.25;block.style.fontSize=`${size}pt`;}if(block.scrollHeight>block.clientHeight+1||block.scrollWidth>block.clientWidth+1)throw Error('Shorten the text to fit this postcard.');}
      restoreAfterPrint=$('photo-viewer').open;$('photo-viewer').close();document.body.classList.add('printing-postcard');window.print();
    }catch(error){$('postcard-print-root')?.remove();document.body.classList.remove('printing-postcard');reopen();$('postcard-error').textContent=error.message;}finally{printing=false;}
  }
  function reopen(){if(restoreAfterPrint&&!$('photo-viewer').open){$('photo-viewer').showModal();closer().focus({preventScroll:true});}restoreAfterPrint=false;}
  document.addEventListener('keydown',event=>{
    if(!$('photo-viewer').open||!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='p')return;
    event.preventDefault();if(!event.repeat)printPostcard();
  });
  window.addEventListener('afterprint',()=>{document.body.classList.remove('printing-postcard');$('postcard-print-root')?.remove();reopen();});
  window.addEventListener('beforeunload',event=>{if([...states.values()].some(s=>dirty(s)||s.promise)){event.preventDefault();event.returnValue='';}});
  window.RedlinePostcards={open,close,forget:id=>{states.delete(id);if(active?.photo.id===id){clearTimeout(timer);active=null;}}};
})();
