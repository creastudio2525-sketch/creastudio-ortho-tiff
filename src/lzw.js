// TIFF 6.0 LZW: MSB-first codes and the TIFF code-width transition.
const CLEAR = 256, END = 257, FIRST = 258;
const HASH_SIZE = 8192;
const keys = new Uint32Array(HASH_SIZE);
const codes = new Uint16Array(HASH_SIZE);

export function encodeLzw(bytes) {
  const output = new Uint8Array(bytes.length*2+16);
  let width=9, next=FIRST, pending=0, bits=0, position=0;
  function put(code) {
    pending=(pending<<width)|code;
    bits+=width;
    while (bits>=8) {
      bits-=8;
      output[position++]=pending>>>bits;
    }
  }
  codes.fill(0);
  put(CLEAR);
  let prefix=bytes[0];
  for (let i=1;i<bytes.length;i++) {
    const byte=bytes[i];
    const key=(prefix<<8)|byte;
    let slot=Math.imul(key,0x9e3779b1)>>>19;
    while (codes[slot] && keys[slot]!==key) slot=(slot+1)&(HASH_SIZE-1);
    if (codes[slot]) {
      prefix=codes[slot];
      continue;
    }
    put(prefix);
    keys[slot]=key;
    codes[slot]=next++;
    if (width<12 && next===(1<<width)) width++;
    if (next===4095) {
      put(CLEAR);
      codes.fill(0);
      next=FIRST;
      width=9;
    }
    prefix=byte;
  }
  put(prefix);
  if (width<12 && next===(1<<width)-1) width++;
  put(END);
  if (bits) output[position++]=pending<<(8-bits);
  return output.slice(0,position);
}

export function decodeLzw(buffer, capacity) {
  const data=new Uint8Array(buffer), output=new Uint8Array(capacity);
  const prefixes=new Uint16Array(4096), suffixes=new Uint8Array(4096), stack=new Uint8Array(4096);
  let width=9, next=FIRST, old=-1, first=0;
  let input=0, length=0, pending=0, bits=0;
  while (true) {
    while (bits<width) {
      if (input>=data.length) throw new Error("Incomplete TIFF LZW block");
      pending=(pending<<8)|data[input++];
      bits+=8;
    }
    bits-=width;
    const code=(pending>>>bits)&((1<<width)-1);
    if (code===CLEAR) {
      width=9; next=FIRST; old=-1;
      continue;
    }
    if (code===END) return output.subarray(0,length);
    if (code>next || (old<0 && code>=256) || (code===next && next>=4096)) {
      throw new Error("Invalid TIFF LZW dictionary code");
    }
    let current=code, count=0;
    if (current===next) {
      stack[count++]=first;
      current=old;
    }
    while (current>=FIRST) {
      stack[count++]=suffixes[current];
      current=prefixes[current];
    }
    first=current;
    if (length+count+1>output.length) throw new Error("TIFF block is larger than expected");
    output[length++]=first;
    while (count) output[length++]=stack[--count];
    if (old>=0 && next<4096) {
      prefixes[next]=old;
      suffixes[next++]=first;
      if (width<12 && next===(1<<width)-1) width++;
    }
    old=code;
  }
}
