/* Authoring step, not part of `npm run build`: paints the whole sheet with the real painter in one headless Chrome, and bakes it to
   public/atlas/sheet.webp and sheet-small.webp, the map's first picture and its underlay. scripts/atlas-sheet.json records what they were painted from.
   node scripts/build-atlas-sheet.mjs
   Set CHROME to the browser's path if it is not in the usual Mac place. */
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {extname,join,resolve,sep} from 'node:path';
import {sheetHash,sheets} from './atlas-sheet.mjs';

const root=resolve(new URL('../public/',import.meta.url).pathname),out=new URL('../public/atlas/',import.meta.url);
const chrome=process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const types={'.js':'text/javascript','.jpg':'image/jpeg','.bin':'application/octet-stream'};
const page=`<!doctype html><meta charset="utf-8"><script src="/atlas-painter.js"></script><script>
const report=(path,body)=>fetch(path,{method:'POST',body});
const load=async(url,convert)=>{const response=await fetch(url);if(!response.ok)throw Error(url);return convert(response);};
const inflate=response=>new Response(response.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
const image=async response=>createImageBitmap(await response.blob());
(async()=>{try{
  const painter=RedlineAtlasPainter,[near,far,sea,land]=await Promise.all([load('/atlas/geo0.bin',inflate),load('/atlas/geo1.bin',inflate),load('/atlas/sea.jpg',image),load('/atlas/land.jpg',image)]);
  const scene=painter.createScene();painter.addLayers(scene,painter.decodeBundle(near));painter.addLayers(scene,painter.decodeBundle(far));scene.plates.sea=sea;scene.plates.land=land;painter.prepare(scene);
  for(const {name,width,height,dpr,limit} of ${JSON.stringify(sheets)}){
    const canvas=new OffscreenCanvas(width,height);
    painter.paintTile(canvas.getContext('2d',{alpha:false}),scene,{sx:width/1440,sy:height/720,x0:0,y0:0,w:width,h:height,dpr,level:-1});
    // As fine as the size limit allows.
    let blob=null,quality=.92;
    for(;quality>=.2;quality-=.04){blob=await canvas.convertToBlob({type:'image/webp',quality});if(blob.size<=limit)break;}
    if(blob.size>limit)throw Error(name+' will not fit in '+limit+' bytes');
    await report('/sheet/'+name+'?quality='+quality.toFixed(2),blob);
  }
  await report('/finished','');
}catch(error){await report('/failed',String(error.stack||error));}})();
</script>`;

let finish,fail;const finished=new Promise((yes,no)=>{finish=yes;fail=no;}),written=[];
const server=createServer(async(request,response)=>{
  const url=new URL(request.url,'http://localhost');
  if(request.method==='POST'){
    const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=Buffer.concat(chunks);
    if(url.pathname==='/finished')finish();
    else if(url.pathname==='/failed')fail(Error(String(body)));
    else{const name=url.pathname.slice(7);await writeFile(new URL(name,out),body);written.push({name,bytes:body.length,quality:Number(url.searchParams.get('quality'))});}
    response.writeHead(204).end();
    return;
  }
  if(url.pathname==='/'){response.writeHead(200,{'content-type':'text/html'}).end(page);return;}
  try{
    const path=resolve(root,'.'+decodeURIComponent(url.pathname));if(!path.startsWith(root+sep))throw Error();
    const bytes=await readFile(path);response.writeHead(200,{'content-type':types[extname(path)]||'application/octet-stream'}).end(bytes);
  }catch{response.writeHead(404).end();}
});
await new Promise(ready=>server.listen(0,'127.0.0.1',ready));

const profile=await mkdtemp(join(tmpdir(),'redline-sheet-'));
const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--mute-audio',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}/`],{stdio:'ignore'});
const closed=new Promise(done=>browser.once('exit',done));
browser.once('error',fail);
const limit=setTimeout(()=>fail(Error('Chrome took more than three minutes.')),180000);
try{
  await finished;
  await writeFile(new URL('../scripts/atlas-sheet.json',import.meta.url),`${JSON.stringify({hash:sheetHash(),sheets:written})}\n`);
  for(const {name,bytes,quality} of written)console.log(`${name}: ${Math.round(bytes/1024)} KB at quality ${quality}`);
}finally{
  clearTimeout(limit);browser.kill();await closed;server.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
