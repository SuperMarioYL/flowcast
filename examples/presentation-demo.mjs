import { createServer } from 'node:http';
import { once } from 'node:events';
import { replayAsset } from '../dist/replay.js';
import { FlowAssetSchema } from '../dist/asset.js';
const html = `<!doctype html><label>Name<input id="name"></label><button onclick="document.querySelector('#result').textContent='Hello, '+document.querySelector('#name').value">Greet</button><p id="result"></p>`;
const server = createServer((req,res) => { res.setHeader('Content-Type','text/html'); res.end(html); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const asset = FlowAssetSchema.parse({version:'1',name:'local-greeting',recordedAt:'2026-09-08T00:00:00Z',params:[{key:'name',default:'Ada'}],steps:[{id:'open',action:'goto',url:`http://127.0.0.1:${server.address().port}`},{id:'name',action:'fill',target:{css:'#name'},value:'{{name}}'},{id:'greet',action:'click',target:{role:'button',name:'Greet'}},{id:'result',action:'extract',target:{css:'#result'}}]});
  const result = await replayAsset(asset,{params:{name:'Lin'},log:()=>{}});
  console.log(JSON.stringify(result,null,2));
} finally { server.close(); }
