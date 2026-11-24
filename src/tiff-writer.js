import {encodeLzw} from "./lzw.js";

export const TILE = 256;
export const LIMIT = 1_000_000_000;

export function compress(pixels) {
  for (let y = 0; y < TILE; y++) {
    const first = y*TILE*4;
    for (let p = first+TILE*4-1; p >= first+4; p--) pixels[p] -= pixels[p-4];
  }
  return encodeLzw(pixels);
}

function tag(id, type, values) {
  const size = {2: 1, 3: 2, 4: 4, 7: 1, 12: 8}[type];
  const raw = typeof values === "string"
    ? new TextEncoder().encode(values.replace(/\0+$/, "")+"\0")
    : new Uint8Array(values.length*size);
  if (typeof values !== "string") {
    const view = new DataView(raw.buffer);
    const set = {3: "setUint16", 4: "setUint32", 12: "setFloat64"}[type];
    if (set) for (let i = 0; i < values.length; i++) view[set](i*size, values[i], true);
    else raw.set(values);
  }
  return {id, type, size, raw};
}

function directory(at, width, height, offsets, counts, geo, icc, reduced=false) {
  const tags = [
    tag(256,4,[width]), tag(257,4,[height]), tag(258,3,[8,8,8,8]), tag(259,3,[5]),
    tag(262,3,[2]), tag(274,3,[1]), tag(277,3,[4]), tag(284,3,[1]), tag(305,2,"CreaStudio Ortho TIFF"),
    tag(317,3,[2]), tag(322,4,[TILE]), tag(323,4,[TILE]), tag(324,4,offsets),
    tag(325,4,counts), tag(338,3,[2]), tag(339,3,[1,1,1,1]),
  ];
  if (reduced) tags.push(tag(254,4,[1]));
  if (geo.transform) {
    const [a,b,c,d,e,f] = geo.transform;
    const x = c + (geo.point ? (a+b)/2 : 0);
    const y = f + (geo.point ? (d+e)/2 : 0);
    if (!b && !d && a > 0 && e < 0) {
      tags.push(tag(33550,12,[a,-e,0]), tag(33922,12,[0,0,0,x,y,0]));
    } else {
      tags.push(tag(34264,12,[a,b,0,x,d,e,0,y,0,0,0,0,0,0,0,1]));
    }
  }
  if (geo.keys?.length) tags.push(tag(34735,3,geo.keys));
  if (geo.doubles?.length) tags.push(tag(34736,12,geo.doubles));
  if (geo.ascii?.length) tags.push(tag(34737,2,geo.ascii));
  if (icc?.length) tags.push(tag(34675,7,icc));
  tags.sort((a,b)=>a.id-b.id);
  let length = 6+tags.length*12;
  for (const t of tags) {
    if (t.raw.length <= 4) continue;
    length += (t.size-(at+length)%t.size)%t.size;
    t.offset = length;
    length += t.raw.length;
  }
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0,tags.length,true);
  for (const [i,t] of tags.entries()) {
    const p = 2+i*12;
    view.setUint16(p,t.id,true);
    view.setUint16(p+2,t.type,true);
    view.setUint32(p+4,t.raw.length/t.size,true);
    if (t.offset !== undefined) {
      view.setUint32(p+8,at+t.offset,true);
      bytes.set(t.raw,t.offset);
    } else bytes.set(t.raw,p+8);
  }
  return bytes;
}

function encodeOverview(preview) {
  const {width,height,pixels} = preview;
  const tiles = [];
  for (let y=0;y<height;y+=TILE) for (let x=0;x<width;x+=TILE) {
    const tile = new Uint8Array(TILE*TILE*4);
    for (let r=0;r<Math.min(TILE,height-y);r++) {
      const start = ((y+r)*width+x)*4;
      tile.set(pixels.subarray(start,start+Math.min(TILE,width-x)*4),r*TILE*4);
    }
    tiles.push(compress(tile));
  }
  return tiles;
}

export async function openOutput(name, width, height, geo, icc) {
  let file, access;
  try {
    const root = await navigator.storage.getDirectory();
    file = await root.getFileHandle(name, {create: true});
    access = await file.createSyncAccessHandle();
    access.truncate(0);
  } catch (e) {
    if (access) access.close();
    access = null;
    file = null;
    if (e.name === "QuotaExceededError") throw new Error("ブラウザの一時保存領域に空きがありません。");
  }
  let pieces = [], chunks = [], chunkSize = 0;
  const numTiles = Math.ceil(width/TILE)*Math.ceil(height/TILE);
  const offsets = new Uint32Array(numTiles);
  const counts = new Uint32Array(numTiles);
  let at = 8, cursor = 0, empty;
  const type = "image/tiff";
  function write(data, position) {
    if (access) {
      try {
        if (access.write(data,{at:position}) !== data.length) throw new Error();
      } catch {
        throw new Error("TIFFを一時保存できません。PCとブラウザの空き容量を確認してください。");
      }
    } else {
      chunks.push(data);
      chunkSize += data.length;
      if (chunkSize >= 8*1024*1024) {
        pieces.push(new Blob(chunks));
        chunks = [];
        chunkSize = 0;
      }
    }
  }
  return {
    add(pixels, blank) {
      if (blank && empty) {
        [offsets[cursor], counts[cursor]] = empty;
        cursor++;
        return true;
      }
      const data = compress(pixels);
      if (at+data.length+numTiles*8+65536 > LIMIT) return false;
      offsets[cursor] = at;
      counts[cursor++] = data.length;
      if (blank) empty = [at, data.length];
      write(data,at);
      at += data.length;
      return true;
    },
    async finish(preview) {
      if (cursor !== numTiles) throw new Error("TIFFの書き出しが途中で止まりました。");
      let overviewOffsets, overviewCounts;
      if (preview && Math.max(width,height)>Math.max(preview.width,preview.height)*1.5) {
        const tiles = encodeOverview(preview);
        const total = tiles.reduce((sum,data)=>sum+data.length,0);
        if (at+total+numTiles*8+65536<LIMIT) {
          overviewOffsets=[];
          overviewCounts=[];
          for (const data of tiles) {
            overviewOffsets.push(at);
            overviewCounts.push(data.length);
            write(data,at);
            at+=data.length;
          }
        }
      }
      const dirAt = at+(at%2);
      const footer = directory(dirAt,width,height,offsets,counts,geo,icc);
      const baseEnd = dirAt+footer.length;
      const overviewAt = baseEnd+(baseEnd%2);
      const overview = overviewOffsets
        ? directory(overviewAt,preview.width,preview.height,overviewOffsets,overviewCounts,{},null,true) : null;
      if ((overview ? overviewAt+overview.length : baseEnd)>LIMIT) return null;
      if (overview) new DataView(footer.buffer).setUint32(2+new DataView(footer.buffer).getUint16(0,true)*12,overviewAt,true);
      const header = new Uint8Array([73,73,42,0,0,0,0,0]);
      new DataView(header.buffer).setUint32(4,dirAt,true);
      const padding = new Uint8Array(dirAt-at);
      const tail = overview ? [footer,new Uint8Array(overviewAt-baseEnd),overview] : [footer];
      if (!access) return new Blob([header,...pieces,...chunks,padding,...tail],{type});
      write(header,0);
      write(footer,dirAt);
      if (overview) write(overview,overviewAt);
      access.flush();
      access.close();
      access = null;
      return await file.getFile();
    },
    close() {
      if (access) { access.close(); access = null; }
      chunks = [];
      pieces = [];
    },
    get bytes() { return at; }
  };
}
