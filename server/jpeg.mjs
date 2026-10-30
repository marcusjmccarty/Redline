// Keep only JPEG image-coding segments. Drop every APP segment and comment,
// including EXIF, XMP, ICC and embedded previews, plus bytes after the end marker.
export function stripJpegMetadata(input) {
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)throw Error('Only processed JPEG images can be saved.');
  const chunks=[bytes.subarray(0,2)];let pos=2,seenScan=false;
  while(pos<bytes.length){
    const start=pos;
    if(bytes[pos++]!==255)throw Error('Invalid JPEG image.');
    while(bytes[pos]===255)pos++;
    const marker=bytes[pos++];
    if(marker===217){if(!seenScan)throw Error('JPEG has no image data.');chunks.push(new Uint8Array([255,217]));const size=chunks.reduce((n,c)=>n+c.length,0),out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}return out;}
    if(marker===0||marker===216||(marker>=208&&marker<=215))throw Error('Invalid JPEG structure.');
    if(pos+2>bytes.length)throw Error('Incomplete JPEG image.');
    const length=(bytes[pos]<<8)|bytes[pos+1];
    if(length<2||pos+length>bytes.length)throw Error('Incomplete JPEG image.');
    const end=pos+length;
    if(!((marker>=224&&marker<=239)||marker===254))chunks.push(bytes.subarray(start,end));
    pos=end;
    if(marker===218){
      seenScan=true;const entropyStart=pos;
      while(pos<bytes.length){
        if(bytes[pos]!==255){pos++;continue;}
        const next=bytes[pos+1];
        if(next===0||(next>=208&&next<=215)){pos+=2;continue;}
        if(next===255){pos++;continue;}
        break;
      }
      chunks.push(bytes.subarray(entropyStart,pos));
    }
  }
  throw Error('JPEG is missing its end marker.');
}
