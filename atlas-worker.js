/* Paints atlas tiles off the main thread, so zooming and tracing never wait for ink. */
'use strict';
let scene=null,canvas=null,context=null,sources=null,reliefQuery='';
const load=async(url,convert,options)=>{const response=await fetch(url,options);if(!response.ok)throw Error(`Could not load ${url}`);return convert(response);};
const inflate=response=>new Response(response.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
const image=async response=>createImageBitmap(await response.blob());
async function start({painter,reliefIndex,reliefVersion,near,far,land,landSmall,sea}){
  importScripts(painter,reliefIndex);
  scene=RedlineAtlasPainter.createScene();scene.relief=new Map();scene.reliefCoverage=self.REDLINE_RELIEF;
  const [bundle,seaPlate,firstLand]=await Promise.all([load(near,inflate),load(sea,image),load(landSmall,image)]);
  RedlineAtlasPainter.addLayers(scene,RedlineAtlasPainter.decodeBundle(bundle));
  scene.plates.sea=seaPlate;scene.plates.land=firstLand;
  sources={far,land,firstLand};if(reliefVersion)reliefQuery=`?v=${reliefVersion}`;
  postMessage({type:'ready'});
}
// The finest coasts and the full land plate follow when the view can use them; the map works without them.
async function sharpen(){
  const {far,land,firstLand}=sources;
  const [detail,fullLand]=await Promise.all([load(far,inflate),load(land,image)]);
  RedlineAtlasPainter.addLayers(scene,RedlineAtlasPainter.decodeBundle(detail));
  firstLand.close?.();scene.plates.land=fullLand;
  postMessage({type:'detail'});
}
// Relief tiles load on first use; a few stay decoded for nearby tiles.
async function prepareRelief(tile){
  // In parallel and with a time limit: a tile painted without its relief beats a map that stops sharpening.
  const needed=RedlineAtlasPainter.reliefTiles(tile,scene.reliefCoverage),wanted=new Set(needed.map(({key})=>key));
  await Promise.all(needed.map(async({key})=>{
    const held=scene.relief.get(key);
    if(held){scene.relief.delete(key);scene.relief.set(key,held);return;}
    try{scene.relief.set(key,await load(`relief/${key}.webp${reliefQuery}`,image,{signal:AbortSignal.timeout(2500)}));}catch{}
  }));
  for(const [key,bitmap] of scene.relief){if(scene.relief.size<=10)break;if(wanted.has(key))continue;bitmap.close?.();scene.relief.delete(key);}
}
async function paint(tile){
  await prepareRelief(tile);
  if(!canvas||canvas.width!==tile.w||canvas.height!==tile.h){canvas=new OffscreenCanvas(tile.w,tile.h);context=canvas.getContext('2d',{alpha:false});}
  RedlineAtlasPainter.paintTile(context,scene,tile);
  const bitmap=canvas.transferToImageBitmap();
  postMessage({type:'tile',id:tile.id,bitmap},[bitmap]);
}
onmessage=({data})=>{
  if(data.type==='start')start(data).catch(error=>postMessage({type:'error',message:String(error)}));
  else if(data.type==='sharpen')sharpen().catch(error=>postMessage({type:'sharpen-error',message:String(error)}));
  else if(data.type==='tile')paint(data).catch(error=>postMessage({type:'tile-error',id:data.id,message:String(error)}));
};
