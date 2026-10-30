/* A portable image of both sides, without a private photo URL or metadata. */
(() => {
  function wrap(context,text,width){
    const lines=[];
    for(const paragraph of text.replace(/\r/g,'').split('\n')){
      let line='';
      for(const word of paragraph.split(/\s+/)){
        const next=line?line+' '+word:word;
        if(context.measureText(next).width<=width){line=next;continue;}
        if(line){lines.push(line);line='';}
        for(const letter of Array.from(word)){
          if(line&&context.measureText(line+letter).width>width){lines.push(line);line='';}
          line+=letter;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  function write(context,text,{x,y,width,height,size=44,min=20,color='#564a38'}){
    if(!text)return;
    let lines;
    do{context.font=`${size}px Georgia,serif`;lines=wrap(context,text,width);if(lines.length*size*1.5<=height)break;size-=1;}while(size>=min);
    if(size<min)throw Error('Shorten the text to fit this postcard.');
    context.fillStyle=color;context.textBaseline='top';
    lines.forEach((line,i)=>context.fillText(line,x,y+i*size*1.5));
  }
  function render(image,place,value){
    const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=2432;
    const context=canvas.getContext('2d');if(!context)throw Error('This browser cannot create a postcard image.');
    context.fillStyle='#eee4d1';context.fillRect(0,0,canvas.width,canvas.height);
    const scale=Math.min(1800/image.naturalWidth,1200/image.naturalHeight),w=image.naturalWidth*scale,h=image.naturalHeight*scale;
    context.drawImage(image,(1800-w)/2,(1200-h)/2,w,h);
    context.fillStyle='#d5c7b0';context.fillRect(0,1200,1800,32);
    const top=1232;
    write(context,place,{x:75,y:top+75,width:1400,height:150,size:48});
    context.strokeStyle='#ad9a7b';context.lineWidth=3;context.setLineDash([10,8]);context.strokeRect(1590,top+75,135,156);context.setLineDash([]);
    context.strokeStyle='#b6a58b';context.beginPath();context.moveTo(945,top+250);context.lineTo(945,top+1125);context.stroke();
    context.lineWidth=1;context.strokeStyle='#c6b9a1';
    for(let y=top+495;y<top+940;y+=66){context.beginPath();context.moveTo(1020,y);context.lineTo(1725,y);context.stroke();}
    write(context,value.message,{x:75,y:top+255,width:795,height:870});
    write(context,value.recipient,{x:1020,y:top+255,width:705,height:150});
    write(context,value.address,{x:1020,y:top+430,width:705,height:520});
    write(context,value.sender,{x:1020,y:top+1000,width:705,height:125});
    return canvas;
  }
  globalThis.RedlinePostcardExport=Object.freeze({render});
})();
