import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../docs");
const port=Number(process.env.PORT || 13852);
const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",".png":"image/png",".txt":"text/plain; charset=utf-8"};
http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,"http://localhost");
    const pathname=decodeURIComponent(url.pathname);
    const relative=pathname.endsWith("/") ? pathname+"index.html" : pathname;
    const target=path.resolve(root,"."+relative);
    if(!target.startsWith(root+path.sep)) {res.writeHead(403).end();return;}
    const data=await fs.readFile(target);
    res.writeHead(200,{"Content-Type":types[path.extname(target)] || "application/octet-stream",
      "Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
    res.end(data);
  }catch {
    res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"}).end("Not found");
  }
}).listen(port,"127.0.0.1",()=>console.log("CreaStudio Ortho TIFF http://127.0.0.1:"+port+"/"));
