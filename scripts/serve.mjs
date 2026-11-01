import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
await import('./build-static.mjs');
const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const root=resolve('dist'),port=Number(option('--port')||process.env.PORT)||4173,host=option('--host')||'127.0.0.1';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.txt':'text/plain'};
createServer(async (req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost'),path=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if (!path.startsWith(root+sep)) { res.writeHead(403).end();return; }
    const bytes=await readFile(path);res.writeHead(200,{'content-type':types[extname(path)]||'application/octet-stream','cache-control':'no-store'}).end(bytes);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port,host,()=>console.log(`Redline: http://${host}:${port}`));
