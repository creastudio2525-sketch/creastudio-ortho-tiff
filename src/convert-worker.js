import {fromBlob, getDecoder} from "geotiff";
import {compress, openOutput, TILE, LIMIT} from "./tiff-writer.js";
import {decodeLzw} from "./lzw.js";

const INPUT_LIMIT = 6_000_000_000;
const CACHE_LIMIT = 96*1024*1024;
const MAX_TILES = 500_000;
const cache = new Map();
let cachedBytes = 0;
const report = (percent,message) => self.postMessage({type:"progress",percent,message});
const fail = (message) => { throw new Error(message); };
const compare = (a,b) => JSON.stringify(a) === JSON.stringify(b);

async function readSource(file, index, image) {
  image ??= await (await fromBlob(file)).getImage();
  const fd = image.getFileDirectory();
  const width = image.getWidth(), height = image.getHeight();
  const blockW = image.getTileWidth(), blockH = image.getTileHeight();
  const channels = image.getSamplesPerPixel();
  const planar = fd.getValue("PlanarConfiguration") || 1;
  const photo = fd.getValue("PhotometricInterpretation") ?? 1;
  const compression = fd.getValue("Compression") || 1;
  const bits = Array.from(fd.getValue("BitsPerSample") || []);
  const sampleFormat = Array.from(fd.getValue("SampleFormat") || []);
  const alphaType = fd.getValue("ExtraSamples")?.[0] || 0;
  const predictor = fd.getValue("Predictor") || 1;
  const orientation = fd.getValue("Orientation") || 1;
  const allowed = photo === 2 && [3,4].includes(channels) ||
    [0,1].includes(photo) && [1,2].includes(channels) ||
    photo === 3 && channels === 1;
  if (!allowed || bits.length !== channels || bits.some(x=>x!==8) || sampleFormat.some(x=>x!==1)) {
    fail(`${file.name} は対応する8ビットのRGB・RGBA・グレースケール・パレットTIFFに変換してください。`);
  }
  if (orientation !== 1 || !width || !height || !blockW || !blockH) {
    fail(`${file.name} の画像の向きやサイズを確認してください。`);
  }
  if (blockW*Math.min(blockH,height)*channels > 128*1024*1024) {
    fail(`${file.name} は1つの画像ブロックが大きすぎます。タイル形式のTIFFを使用してください。`);
  }
  const keys = Array.from(fd.getValue("GeoKeyDirectory") || []);
  const doubles = Array.from(fd.getValue("GeoDoubleParams") || []);
  const ascii = fd.getValue("GeoAsciiParams") || "";
  const parsed = image.getGeoKeys() || {};
  const point = parsed.GTRasterTypeGeoKey === 2;
  const matrix = fd.getValue("ModelTransformation");
  const scale = fd.getValue("ModelPixelScale");
  const tie = fd.getValue("ModelTiepoint");
  let transform = null;
  if (matrix?.length === 16) {
    if (matrix[12] || matrix[13] || matrix[15] !== 1) fail(`${file.name} の座標変換には対応していません。`);
    transform = [matrix[0],matrix[1],matrix[3],matrix[4],matrix[5],matrix[7]];
  } else if (scale?.length >= 2 && tie?.length >= 6) {
    transform = [scale[0],0,tie[3]-scale[0]*tie[0],0,-scale[1],tie[4]+scale[1]*tie[1]];
  } else if (tie?.length) fail(`${file.name} は画素位置を一意に決められるGeoTIFFに変換してください。`);
  if (transform) {
    const [a,b,,d,e] = transform;
    if (point) {
      transform[2] -= (a+b)/2;
      transform[5] -= (d+e)/2;
    }
    if (!transform.every(Number.isFinite) || a*e===b*d) fail(`${file.name} の座標情報が無効です。`);
  }
  const metadata = {keys,doubles,ascii,point,transform,parsed};
  const getBytes = (raw) => raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw ? Uint8Array.from(raw) : null;
  const icc = photo === 2 ? getBytes(await fd.loadValue("ICCProfile")) : null;
  const colorMap = photo === 3 ? await fd.loadValue("ColorMap") : null;
  const params = {tileWidth:blockW,tileHeight:blockH,planarConfiguration:planar,bitsPerSample:bits,predictor};
  if (compression === 7) params.JPEGTables = await fd.loadValue("JPEGTables");
  let decoder;
  try {
    if (![1,5,7,8,32946,32773,50000].includes(compression)) throw new Error();
    decoder = await getDecoder(compression,params);
    if (compression===5 && (fd.getValue("FillOrder") || 1)===1 && [1,2].includes(predictor)) {
      const fallback = decoder;
      const stride = planar===2 ? 1 : channels;
      const rowBytes = blockW*stride;
      decoder = {async decode(buffer) {
        let pixels;
        try { pixels=decodeLzw(buffer,rowBytes*blockH); }
        catch { return fallback.decode(buffer); }
        if (!pixels.length || pixels.length%rowBytes) return fallback.decode(buffer);
        if (predictor===2) {
          for (let y=0;y<pixels.length;y+=rowBytes) {
            const end=y+rowBytes;
            for (let p=y+stride;p<end;p++) pixels[p]+=pixels[p-stride];
          }
        }
        return pixels.buffer;
      }};
    }
  } catch {
    fail(`${file.name} の圧縮方式には対応していません。LZW、DEFLATEまたは無圧縮のTIFFを使用してください。`);
  }
  return {file,index,image,decoder,width,height,blockW,blockH,channels,planar,photo,alphaType,
    nodata:image.getGDALNoData(),metadata,icc,colorMap,col:0,row:0};
}

function arrange(sources) {
  const base = sources[0];
  const geo = base.metadata;
  if (sources.length === 1) return {width:base.width,height:base.height,geo};
  if (!geo.transform || !geo.parsed.GTModelTypeGeoKey) {
    fail("複数枚の統合には、画像内に座標情報が入ったGeoTIFFが必要です。");
  }
  const [dx,b,,d,dy] = geo.transform;
  if (dx<=0 || dy>=0 || b || d) fail("複数枚の統合には、北を上にしたGeoTIFFが必要です。");
  for (const src of sources) {
    const other = src.metadata;
    if (!other.transform || !compare(other.parsed,geo.parsed)) {
      fail(`${src.file.name} の座標系が最初の画像と一致しません。`);
    }
    if (!compare(src.icc,base.icc)) fail(`${src.file.name} の色プロファイルが最初の画像と一致しません。`);
  }
  const x = sources.reduce((best,src)=>Math.min(best,src.metadata.transform[2]),Infinity);
  const y = sources.reduce((best,src)=>Math.max(best,src.metadata.transform[5]),-Infinity);
  const tolerance = Math.min(dx,-dy)*1e-4;
  let width=0, height=0;
  for (const src of sources) {
    const [a,s,c,t,e,f] = src.metadata.transform;
    src.col = Math.round((c-x)/dx);
    src.row = Math.round((f-y)/dy);
    const xError = c-(x+src.col*dx);
    const yError = f-(y+src.row*dy);
    if (a<=0 || e>=0 || s || t || Math.max(Math.abs(xError),Math.abs(yError),
      Math.abs(xError+(a-dx)*src.width),Math.abs(yError+(e-dy)*src.height)) > tolerance) {
      fail(`${src.file.name} の解像度または画素位置が他の画像と一致しません。`);
    }
    width = Math.max(width,src.col+src.width);
    height = Math.max(height,src.row+src.height);
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Math.max(width,height)>2_147_483_647) {
    fail("統合範囲が大きすぎます。画像の座標を確認してください。");
  }
  return {width,height,geo:{...geo,transform:[dx,0,x,0,dy,y]}};
}

async function getBlock(src,x,y) {
  const key = `${src.index}:${x}:${y}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key,hit);
    return hit.planes;
  }
  const planes = [];
  let bytes = 0;
  for (let i=0; i<(src.planar===2 ? src.channels : 1); i++) {
    const result = await src.image.getTileOrStrip(x,y,i,src.decoder);
    const raw = new Uint8Array(result.data);
    planes.push(raw);
    bytes += raw.length;
  }
  while (cachedBytes+bytes>CACHE_LIMIT && cache.size) {
    const oldest = cache.keys().next().value;
    cachedBytes -= cache.get(oldest).bytes;
    cache.delete(oldest);
  }
  if (bytes <= CACHE_LIMIT) {
    cache.set(key,{planes,bytes});
    cachedBytes += bytes;
  }
  return planes;
}

function groups(values, offset, size, tileSize) {
  const result = [];
  let last;
  for (let i=0; i<values.length; i++) {
    const p = values[i]-offset;
    if (p<0) continue;
    if (p>=size) break;
    const tile = Math.floor(p/tileSize);
    if (!last || last.tile!==tile) {
      last = {tile,start:i,pixels:[]};
      result.push(last);
    }
    last.pixels.push(p-tile*tileSize);
  }
  return result;
}

function paint(output, src, planes, gx, gy, stride=TILE) {
  const rgb = src.photo === 2;
  const hasAlpha = rgb ? src.channels===4 : src.channels===2;
  const main = planes[0];
  const n = src.channels;
  const bw = src.blockW;
  const separate = src.planar === 2;
  const nodata = src.nodata;
  const cmap = src.colorMap;
  for (let j=0; j<gy.pixels.length; j++) {
    const fromRow = gy.pixels[j]*bw;
    const toRow = ((gy.start+j)*stride+gx.start)*4;
    for (let i=0; i<gx.pixels.length; i++) {
      const pix = fromRow+gx.pixels[i];
      const p = separate ? pix : pix*n;
      const q = toRow+i*4;
      let r = main[p], g = rgb ? (separate ? planes[1][p] : main[p+1]) : r;
      let b = rgb ? (separate ? planes[2][p] : main[p+2]) : r;
      const alpha = hasAlpha ? (separate ? planes[n-1][p] : main[p+n-1])
        : nodata != null && r===nodata && g===nodata && b===nodata ? 0 : 255;
      if (!alpha && output[q+3]) continue;
      if (cmap) {
        g = Math.round(cmap[r+256]/257);
        b = Math.round(cmap[r+512]/257);
        r = Math.round(cmap[r]/257);
      } else if (src.photo===0) {
        r = g = b = 255-r;
      } else if (src.alphaType===1 && alpha>0 && alpha<255) {
        r = Math.min(255,Math.round(r*255/alpha));
        g = Math.min(255,Math.round(g*255/alpha));
        b = Math.min(255,Math.round(b*255/alpha));
      }
      output[q]=r; output[q+1]=g; output[q+2]=b; output[q+3]=alpha;
    }
  }
}

function paintView(output,source,planes,gx,gy,stride) {
  if (source.photo!==2 || source.channels!==4 || source.planar!==1 || source.alphaType===1) {
    paint(output,source,planes,gx,gy,stride);
    return;
  }
  const input=new Uint32Array(planes[0].buffer,planes[0].byteOffset,Math.floor(planes[0].byteLength/4));
  const pixels=new Uint32Array(output.buffer);
  for (let j=0;j<gy.pixels.length;j++) {
    const sourceRow=gy.pixels[j]*source.blockW;
    const targetRow=(gy.start+j)*stride+gx.start;
    for (let i=0;i<gx.pixels.length;i++) pixels[targetRow+i]=input[sourceRow+gx.pixels[i]];
  }
}

function samples(start,count,native,scaled) {
  return Array.from({length:count},(_,i)=>Math.floor((start+i+.5)*native/scaled));
}

async function getPixels(sources, width, height, native, x, y) {
  const xs = samples(x,Math.min(TILE,width-x),native.width,width);
  const ys = samples(y,Math.min(TILE,height-y),native.height,height);
  const output = new Uint8Array(TILE*TILE*4);
  let blank = true;
  for (const src of sources) {
    if (xs[0]>=src.col+src.width || xs.at(-1)<src.col || ys[0]>=src.row+src.height || ys.at(-1)<src.row) continue;
    const gx = groups(xs,src.col,src.width,src.blockW);
    const gy = groups(ys,src.row,src.height,src.blockH);
    for (const row of gy) for (const col of gx) {
      const planes = await getBlock(src,col.tile,row.tile);
      paint(output,src,planes,col,row);
      blank = false;
    }
  }
  return {output,blank};
}

async function estimate(sources,native,width,height,strata=8) {
  const cols = Math.ceil(width/TILE), rows = Math.ceil(height/TILE);
  const colsUsed = Math.min(cols,strata), rowsUsed = Math.min(rows,strata);
  let bytes = 0, seed = 61;
  const random = () => ((seed = (Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
  for (let r=0; r<rowsUsed; r++) for (let c=0; c<colsUsed; c++) {
    const x = Math.floor((c+random())*cols/colsUsed)*TILE;
    const y = Math.floor((r+random())*rows/rowsUsed)*TILE;
    const {output} = await getPixels(sources,width,height,native,x,y);
    bytes += compress(output).length;
  }
  return bytes*cols*rows/(colsUsed*rowsUsed);
}

function scaledGeo(geo,native,width,height) {
  if (!geo.transform) return geo;
  const [a,b,c,d,e,f] = geo.transform;
  return {...geo,transform:[a*native.width/width,b*native.height/height,c,
    d*native.width/width,e*native.height/height,f]};
}

function makePreview(width,height) {
  const scale = Math.min(1,1024/Math.max(width,height));
  const w = Math.max(1,Math.round(width*scale)), h = Math.max(1,Math.round(height*scale));
  const xs = new Map(groups(samples(0,w,width,w),0,width,TILE).map(g=>[g.tile,g]));
  const ys = new Map(groups(samples(0,h,height,h),0,height,TILE).map(g=>[g.tile,g]));
  const pixels = new Uint8ClampedArray(w*h*4);
  return {data:{width:w,height:h,pixels},copy(tile,x,y) {
    const gx = xs.get(x/TILE), gy = ys.get(y/TILE);
    if (!gx || !gy) return;
    for (const [row,sy] of gy.pixels.entries()) for (const [col,sx] of gx.pixels.entries()) {
      const offset = (sy*TILE+sx)*4;
      pixels.set(tile.subarray(offset,offset+4),((gy.start+row)*w+gx.start+col)*4);
    }
  }};
}

async function processFiles(files,name) {
  if (!files.length || files.reduce((sum,file)=>sum+file.size,0)>INPUT_LIMIT) {
    fail("合計6 GB以内のTIFFファイルを選択してください。");
  }
  report(1,"TIFFの座標と形式を確認しています");
  const sources = [];
  for (const [i,file] of files.entries()) {
    try { sources.push(await readSource(file,i)); }
    catch(e) {
      if (e.message?.startsWith(file.name)) throw e;
      fail(`${file.name} を読み込めません。TIFFの形式を確認してください。`);
    }
  }
  const native = arrange(sources);
  report(5,"容量と解像度を見積もっています");
  const bytes = await estimate(sources,native,native.width,native.height);
  let scale = bytes<LIMIT*1.05 ? 1 : Math.sqrt(LIMIT*.83/bytes);
  scale = Math.min(scale,Math.sqrt(MAX_TILES*TILE*TILE/(native.width*native.height)),
    MAX_TILES*TILE/Math.max(native.width,native.height));
  // A smaller pixel grid often compresses differently. Sample it before writing
  // the whole image so large jobs are less likely to need a second pass.
  if (scale < 1) {
    const width = Math.max(1,Math.round(native.width*scale));
    const height = Math.max(1,Math.round(native.height*scale));
    const prediction = await estimate(sources,native,width,height,12);
    if (prediction>LIMIT*.88) scale *= Math.sqrt(LIMIT*.86/prediction);
  }
  for (let attempt=0; attempt<12; attempt++) {
    const width = Math.max(1,Math.round(native.width*scale));
    const height = Math.max(1,Math.round(native.height*scale));
    const geo = scaledGeo(native.geo,native,width,height);
    const count = Math.ceil(width/TILE)*Math.ceil(height/TILE);
    if (count>MAX_TILES) { scale *= .97; continue; }
    const writer = await openOutput(name,width,height,geo,sources[0].icc);
    const preview = makePreview(width,height);
    let written = 0;
    try {
      outer: for (let y=0; y<height; y+=TILE) for (let x=0; x<width; x+=TILE) {
        const {output,blank} = await getPixels(sources,width,height,native,x,y);
        if (!blank) preview.copy(output,x,y);
        if (!writer.add(output,blank)) break outer;
        if (++written%32===0 || written===count) report(8+Math.floor(87*written/count),"TIFFを書き出しています");
      }
      if (written===count) {
        report(97,"出力サイズを確認しています");
        const blob = await writer.finish(preview.data);
        if (blob && blob.size<=LIMIT) {
          const epsg = geo.parsed.ProjectedCSTypeGeoKey || geo.parsed.GeographicTypeGeoKey;
          const crs = epsg && epsg!==32767 ? `EPSG:${epsg}` : geo.transform ? "入力画像の座標系" : null;
          const pixel = geo.transform && geo.parsed.ProjLinearUnitsGeoKey===9001 ? geo.transform[0] : null;
          return {blob, preview:preview.data, bytes:blob.size,width,height,crs,pixel,reduced:width!==native.width||height!==native.height};
        }
      }
      const projected = writer.bytes*count/Math.max(1,written);
      scale *= Math.min(.95,Math.sqrt(LIMIT*.85/projected));
      report(6,"1 GB以内に収まるよう解像度を調整しています");
    } finally {
      writer.close();
    }
  }
  fail("1 GB以内に変換できませんでした。入力画像のサイズと座標を確認してください。");
}

let viewSources = [];
let viewRequest;
let rendering = false;

async function openViewer(file) {
  const tiff = await fromBlob(file);
  const base = await readSource(file,0,await tiff.getImage());
  const sources = [base];
  for (let i=1;i<=16;i++) {
    try {
      const image = await tiff.getImage(i);
      const dir = image.getFileDirectory();
      if (!(dir.getValue("NewSubfileType") & 1) || dir.getValue("NewSubfileType") & 4) continue;
      if (Math.abs(image.getWidth()/base.width-image.getHeight()/base.height) > .015) continue;
      sources.push(await readSource(file,i,image));
    } catch { break; }
  }
  viewSources = sources.sort((a,b)=>b.width-a.width);
  self.postMessage({type:"viewer-ready",width:base.width,height:base.height});
}

async function renderViewer(request) {
  const {id,left,top,right,bottom,x,y,scale} = request;
  const base = viewSources[0];
  if (!base) return;
  const source = viewSources.findLast(src=>src.width/base.width >= scale*.8) || base;
  const rx = source.width/base.width, ry = source.height/base.height;
  const step = 128;
  const locations = (start,n,origin,ratio,max) => Array.from({length:n},(_,i)=>
    Math.min(max-1,Math.max(0,Math.floor((start+i+.5-origin)/scale*ratio))));
  function segments(first,last,origin,ratio,size,block) {
    const parts=[];
    for (let start=first;start<last;start+=step) {
      const count=Math.min(step,last-start);
      parts.push({start,count,blocks:groups(locations(start,count,origin,ratio,size),0,size,block)});
    }
    return parts;
  }
  const cols=segments(left,right,x,rx,source.width,source.blockW);
  const rows=segments(top,bottom,y,ry,source.height,source.blockH);
  const patchCount=cols.length*rows.length;
  let painted=0;
  for (const row of rows) for (const col of cols) {
    if (viewRequest !== request) return;
    const width=col.count, height=row.count;
    const pixels = new Uint8ClampedArray(width*height*4);
    for (const gy of row.blocks) for (const gx of col.blocks) {
      const planes = await getBlock(source,gx.tile,gy.tile);
      if (viewRequest !== request) return;
      paintView(pixels,source,planes,gx,gy,width);
    }
    const percent=Math.floor(100*++painted/patchCount);
    self.postMessage({type:"viewer-patch",id,x:col.start,y:row.start,width,height,pixels,percent},[pixels.buffer]);
    // Yield even on cache hits so new zoom and pan requests can interrupt.
    if (painted%6===0) await new Promise(resolve=>setTimeout(resolve,0));
  }
  if (viewRequest === request) self.postMessage({type:"viewer-done",id});
}

async function queueView(request) {
  viewRequest = request;
  if (rendering) return;
  rendering = true;
  try {
    while (viewRequest) {
      const current = viewRequest;
      await renderViewer(current);
      if (viewRequest===current) viewRequest=null;
    }
  } catch {
    viewRequest=null;
    self.postMessage({type:"viewer-error",message:"この範囲を読み込めませんでした。"});
  } finally { rendering=false; }
}

self.onmessage = async ({data}) => {
  if (data.type === "viewer-open") {
    try { await openViewer(data.file); }
    catch (e) { self.postMessage({type:"viewer-error",message:e.message || "TIFFを読み込めませんでした。"}); }
    return;
  }
  if (data.type === "viewer-render") { await queueView(data); return; }
  if (data.type === "viewer-interrupt") { viewRequest=null; return; }
  const {files,name} = data;
  try {
    const result = await processFiles(files,name);
    self.postMessage({type:"done",result},[result.preview.pixels.buffer]);
  } catch (e) {
    self.postMessage({type:"error",message:e.message || "TIFFの変換中に問題が発生しました。"});
  } finally {
    cache.clear();
    cachedBytes = 0;
  }
};
