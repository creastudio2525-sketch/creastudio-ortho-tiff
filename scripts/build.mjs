import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
let esbuild;
try { esbuild=await import("esbuild"); }
catch {
  // This optional argument lets an existing local dependency installation build
  // a fresh checkout. Normal use resolves the checkout's own node_modules.
  if(!process.argv[2]) throw new Error("npm ci を先に実行してください。");
  esbuild=await import(pathToFileURL(path.join(path.resolve(process.argv[2]),"esbuild/lib/main.js")).href);
}
const modules=process.argv[2] ? path.resolve(process.argv[2]) : path.join(root,"node_modules");
const files=new Map();
async function collect(folder,prefix="") {
  for(const entry of await fs.readdir(folder,{withFileTypes:true})) {
    const name=prefix+entry.name;
    const target=path.join(folder,entry.name);
    if(entry.isDirectory()) await collect(target,name+"/");
    else files.set(name,await fs.readFile(target));
  }
}
await collect(path.join(root,"web"));
const bundle=await esbuild.build({
  entryPoints:[path.join(root,"src/convert-worker.js")],
  bundle:true,format:"iife",platform:"browser",
  target:["chrome110","firefox120","safari17"],
  minify:true,legalComments:"eof",write:false,nodePaths:[modules]
});
files.set("convert-worker.js",Buffer.from(bundle.outputFiles[0].contents));
const versions=new Map();
function version(name,data) {
  const ext=path.posix.extname(name);
  const stem=name.slice(0,-ext.length);
  const hash=createHash("sha256").update(data).digest("hex").slice(0,12);
  const target=stem+"."+hash+ext;
  files.delete(name);
  files.set(target,data);
  versions.set(name,target);
}
for(const [name,data] of [...files]) {
  if(name.endsWith(".css") || name==="convert-worker.js") version(name,data);
}
for(const name of ["app.js","viewer.js"]) {
  const data=files.get(name).toString("utf8");
  if(data.split("./convert-worker.js").length!==2) throw new Error("Unexpected worker reference in "+name);
  version(name,Buffer.from(data.replace("./convert-worker.js","./"+versions.get("convert-worker.js"))));
}
let html=files.get("index.html").toString("utf8");
for(const [name,target] of versions) {
  if(name==="convert-worker.js") continue;
  const reference='="./'+name+'"';
  if(html.split(reference).length!==2) throw new Error("Unexpected asset reference "+name);
  html=html.replace(reference,'="./'+target+'"');
}
files.set("index.html",Buffer.from(html));
const notices=[];
for(const name of ["geotiff","fflate","@petamoriken/float16","lerc","pako","parse-headers",
  "quick-lru","web-worker","xml-utils","zstddec"]) {
  const folder=path.join(modules,name);
  const metadata=JSON.parse(await fs.readFile(path.join(folder,"package.json"),"utf8"));
  const texts=[];
  for(const entry of await fs.readdir(folder,{withFileTypes:true})) {
    if(entry.isFile() && /^(license|licence|copying|notice)(\.[a-z]+)?$/i.test(entry.name)) {
      texts.push(await fs.readFile(path.join(folder,entry.name),"utf8"));
    }
  }
  notices.push(name+" "+metadata.version+" ("+(metadata.license || "see package")+")\n"+texts.join("\n\n"));
}
files.set("third-party-notices.txt",Buffer.from(notices.join("\n\n")));
files.set(".nojekyll",Buffer.alloc(0));
const output=path.join(root,"docs");
if(output!==path.resolve(root,"docs")) throw new Error("Invalid output folder");
await fs.rm(output,{recursive:true,force:true});
for(const [name,data] of files) {
  const target=path.join(output,name);
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,data);
}
console.log("Built "+files.size+" files into docs/");
