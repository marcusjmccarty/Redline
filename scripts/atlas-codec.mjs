/* Compact geometry for the atlas: zigzag-varint deltas at 1/50 of a map unit. public/atlas-painter.js decodes it. */
export const RESOLUTION=50;
export function encodeLayer(features){
  const bytes=[];
  const write=value=>{while(value>127){bytes.push(value&127|128);value=Math.floor(value/128);}bytes.push(value);};
  const zigzag=value=>value<0?-2*value-1:2*value;
  write(features.length);
  for(const {rank,points} of features){
    write(rank);write(points.length);
    let px=0,py=0;
    for(const [x,y] of points){const ix=Math.round(x*RESOLUTION),iy=Math.round(y*RESOLUTION);write(zigzag(ix-px));write(zigzag(iy-py));px=ix;py=iy;}
  }
  return Buffer.from(bytes);
}
