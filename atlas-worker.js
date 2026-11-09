/* Paints atlas tiles off the main thread, so zooming and tracing never wait for ink. */
'use strict';
let scene=null,canvas=null,context=null,sources=null,reliefQuery='',tileOptions={alpha:false};
const load=async(url,convert,options={})=>{const response=await fetch(url,{signal:AbortSignal.timeout(8000),...options});if(!response.ok)throw Error(`Could not load ${url}`);return convert(response);};
const reliefFailures=new Map();
let sharpening=null;
const inflate=response=>new Response(response.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
const image=async response=>createImageBitmap(await response.blob());
async function start({painter,reliefIndex,reliefVersion,near,far,land,landSmall,sea,sheet,software=false}){
  // The baked sheet comes first and alone: it is the map's first picture, and nothing here should delay it. Without it the page asks for a painted one.
  if(sheet){const bitmap=await load(sheet,image,{signal:AbortSignal.timeout(8000)}).catch(()=>null);postMessage({type:'sheet',bitmap},bitmap?[bitmap]:[]);}
  importScripts(painter,reliefIndex);
  if(software)tileOptions={alpha:false,willReadFrequently:true};
  scene=RedlineAtlasPainter.createScene({software});scene.relief=new Map();scene.reliefCoverage=self.REDLINE_RELIEF;
  RedlineAtlasPainter.prepare(scene);
  const [bundle,seaPlate,firstLand]=await Promise.all([load(near,inflate),load(sea,image),load(landSmall,image)]);
  RedlineAtlasPainter.addLayers(scene,RedlineAtlasPainter.decodeBundle(bundle));
  scene.plates.sea=seaPlate;scene.plates.land=firstLand;
  sources={far,land,firstLand};if(reliefVersion)reliefQuery=`?v=${reliefVersion}`;
  postMessage({type:'ready'});
}
// The finest coasts and the full land plate follow when the view can use them; the map works without them.
function sharpen(){
  // Ready/retry messages can overlap; never decode the same full plate twice.
  return sharpening??=loadDetail().catch(error=>{sharpening=null;throw error;});
}
async function loadDetail(){
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
    if((reliefFailures.get(key)||0)>Date.now())return;
    try{scene.relief.set(key,await load(`relief/${key}.webp${reliefQuery}`,image,{signal:AbortSignal.timeout(2500)}));reliefFailures.delete(key);}catch{reliefFailures.set(key,Date.now()+30000);}
  }));
  for(const [key,bitmap] of scene.relief){if(scene.relief.size<=10)break;if(wanted.has(key))continue;bitmap.close?.();scene.relief.delete(key);}
  return needed.some(({key})=>!scene.relief.has(key))?30000:0;
}
async function paint(tile){
  const retryAfter=await prepareRelief(tile);
  if(!canvas||canvas.width!==tile.w||canvas.height!==tile.h){canvas=new OffscreenCanvas(tile.w,tile.h);context=canvas.getContext('2d',tileOptions);}
  RedlineAtlasPainter.paintTile(context,scene,tile);
  const bitmap=canvas.transferToImageBitmap();
  postMessage({type:'tile',id:tile.id,bitmap,retryAfter},[bitmap]);
}
onmessage=({data})=>{
  if(data.type==='start')start(data).catch(error=>postMessage({type:'error',message:String(error)}));
  else if(data.type==='sharpen')sharpen().catch(error=>postMessage({type:'sharpen-error',message:String(error)}));
  else if(data.type==='tile')paint(data).catch(error=>postMessage({type:'tile-error',id:data.id,message:String(error)}));
};
