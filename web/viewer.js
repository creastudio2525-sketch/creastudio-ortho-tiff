"use strict";

(() => {
  const el = id => document.getElementById(id);
  const dialog = el("tiff-viewer");
  const canvas = el("viewer-canvas");
  const ctx = canvas.getContext("2d");
  const input = el("viewer-input");
  const placeholder = el("viewer-placeholder");
  const loader = el("viewer-loading");
  const progress = el("viewer-progress");
  const progressValue = el("viewer-progress-value");
  const status = el("viewer-status");
  const info = new Intl.NumberFormat("ja-JP");
  let reader, image, thumbnail, view, timer, pointer, lastFrame, animation;
  let readerBusy=false;
  let dragDepth=0;
  let requestId=0, viewport;

  function updateProgress(percent) {
    const determinate=Number.isFinite(percent);
    if (determinate) progress.value=percent;
    else progress.removeAttribute("value");
    progressValue.textContent=determinate ? `${percent}%` : "";
  }

  function dimensions() {
    return `${info.format(image.width)} × ${info.format(image.height)} px`;
  }

  function updateCanvas() {
    const w = Math.max(1,canvas.clientWidth), h = Math.max(1,canvas.clientHeight);
    if (canvas.width===w && canvas.height===h) return false;
    canvas.width=w;
    canvas.height=h;
    return true;
  }

  function clearView() {
    clearTimeout(timer);
    cancelAnimationFrame(animation);
    animation=0;
    reader?.terminate();
    reader=null;
    image=thumbnail=view=pointer=viewport=null;
    lastFrame=null;
    readerBusy=false;
    clearDrag();
    requestId++;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    el("viewer-zoom-tools").hidden=true;
    loader.hidden=true;
    updateProgress();
    placeholder.hidden=false;
    placeholder.replaceChildren("TIFFファイルをここにドロップ",document.createElement("br"),"または「TIFFを開く」から選択");
    el("viewer-file-label").textContent="";
    status.textContent="";
  }

  function fitScale() {
    return Math.max(Number.EPSILON, Math.min((canvas.width-16)/image.width,(canvas.height-16)/image.height,1));
  }

  function fit() {
    if (!image) return;
    updateCanvas();
    const scale = fitScale();
    view={x:(canvas.width-image.width*scale)/2,y:(canvas.height-image.height*scale)/2,scale};
    refresh();
  }

  function constrain() {
    const w=image.width*view.scale, h=image.height*view.scale;
    const clamp=(position,size,extent) => size<=extent ? (extent-size)/2 : Math.max(extent-size,Math.min(0,position));
    view.x=clamp(view.x,w,canvas.width);
    view.y=clamp(view.y,h,canvas.height);
  }

  function drawCached() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.imageSmoothingEnabled=true;
    if (thumbnail) {
      ctx.drawImage(thumbnail,view.x,view.y,image.width*view.scale,image.height*view.scale);
    }
    if (lastFrame) {
      const ratio=view.scale/lastFrame.scale;
      const x=view.x+(lastFrame.left-lastFrame.x)*ratio;
      const y=view.y+(lastFrame.top-lastFrame.y)*ratio;
      const w=lastFrame.canvas.width*ratio;
      const h=lastFrame.canvas.height*ratio;
      ctx.clearRect(x,y,w,h);
      ctx.drawImage(lastFrame.canvas,x,y,w,h);
    }
  }

  function refresh() {
    if (!image || !view) return;
    requestId++;
    clearTimeout(timer);
    if (readerBusy) reader?.postMessage({type:"viewer-interrupt"});
    readerBusy=false;
    if (!animation) animation=requestAnimationFrame(()=>{
      animation=0;
      if (view) drawCached();
    });
    el("viewer-zoom").textContent=`${info.format(Math.round(view.scale*1000)/10)}%`;
    if (!pointer) timer=setTimeout(request,65);
  }

  function request() {
    if (!reader || !image || !view) return;
    if (animation) {
      cancelAnimationFrame(animation);
      animation=0;
      drawCached();
    }
    const {x,y,scale}=view;
    if (thumbnail && image.width*scale<=thumbnail.width+.5 && image.height*scale<=thumbnail.height+.5) {
      loader.hidden=true;
      status.textContent=`${dimensions()}　ホイールで拡大・縮小、ドラッグで移動`;
      return;
    }
    viewport={left:Math.max(0,Math.ceil(x-.5)),top:Math.max(0,Math.ceil(y-.5)),
      right:Math.min(canvas.width,Math.ceil(x+image.width*scale-.5)),
      bottom:Math.min(canvas.height,Math.ceil(y+image.height*scale-.5))};
    status.textContent=`${dimensions()}　画像を読み込み中…`;
    if (!loader.hidden) updateProgress(0);
    readerBusy=true;
    reader.postMessage({type:"viewer-render",id:requestId,...viewport,x,y,scale});
  }

  function zoom(factor,x=canvas.width/2,y=canvas.height/2) {
    if (!view) return;
    const scale=Math.max(fitScale()*.5,Math.min(8,view.scale*factor));
    view={x:x-(x-view.x)*scale/view.scale,y:y-(y-view.y)*scale/view.scale,scale};
    constrain();
    refresh();
  }

  function open(file,name,preview) {
    if (!dialog.open) dialog.showModal();
    clearView();
    if (!file) return;
    el("viewer-file-label").textContent=name;
    placeholder.hidden=true;
    loader.hidden=false;
    status.textContent="TIFFを読み込んでいます…";
    if (preview) {
      thumbnail=document.createElement("canvas");
      thumbnail.width=preview.width;
      thumbnail.height=preview.height;
      thumbnail.getContext("2d").putImageData(new ImageData(preview.pixels,preview.width,preview.height),0,0);
    }
    try {
      const instance=new Worker(new URL("./convert-worker.js",document.baseURI));
      reader=instance;
      instance.onmessage=({data})=>{
        if (reader!==instance) return;
        if (data.type==="viewer-ready") {
          image={width:data.width,height:data.height};
          el("viewer-zoom-tools").hidden=false;
          placeholder.hidden=true;
          fit();
        } else if (data.type==="viewer-error") {
          readerBusy=false;
          loader.hidden=true;
          status.textContent=data.message;
          if (!image) {
            placeholder.textContent="このTIFFを表示できませんでした。";
            placeholder.hidden=false;
          }
        } else if (data.id===requestId && data.type==="viewer-patch") {
          ctx.putImageData(new ImageData(data.pixels,data.width,data.height),data.x,data.y);
          if (!loader.hidden) updateProgress(data.percent);
        } else if (data.id===requestId && data.type==="viewer-done") {
          readerBusy=false;
          loader.hidden=true;
          status.textContent=`${dimensions()}　ホイールで拡大・縮小、ドラッグで移動`;
          if (viewport && viewport.right>viewport.left && viewport.bottom>viewport.top) {
            const snapshot=lastFrame && lastFrame.canvas!==thumbnail ? lastFrame.canvas : document.createElement("canvas");
            snapshot.width=viewport.right-viewport.left;
            snapshot.height=viewport.bottom-viewport.top;
            snapshot.getContext("2d").drawImage(canvas,viewport.left,viewport.top,
              snapshot.width,snapshot.height,0,0,snapshot.width,snapshot.height);
            lastFrame={canvas:snapshot,...view,left:viewport.left,top:viewport.top};
            if (!thumbnail && viewport.left>0 && viewport.top>0 &&
              viewport.right<canvas.width && viewport.bottom<canvas.height) thumbnail=snapshot;
          }
        }
      };
      instance.onerror=()=>{
        if (reader!==instance) return;
        loader.hidden=true;
        placeholder.textContent="ビューアを起動できませんでした。";
        placeholder.hidden=false;
        status.textContent="ページを再読み込みしてからお試しください。";
      };
      instance.postMessage({type:"viewer-open",file});
    } catch {
      loader.hidden=true;
      placeholder.textContent="ビューアを起動できませんでした。";
      placeholder.hidden=false;
      status.textContent="ページを再読み込みしてからお試しください。";
    }
  }

  window.openTiffViewer=open;
  function clearDrag() {
    dragDepth=0;
    dialog.classList.remove("dragging");
  }

  function hasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes("Files");
  }

  dialog.addEventListener("dragenter",event=>{
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    dialog.classList.add("dragging");
  });
  dialog.addEventListener("dragover",event=>{
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect="copy";
  });
  dialog.addEventListener("dragleave",event=>{
    if (hasFiles(event) && --dragDepth<=0) clearDrag();
  });
  dialog.addEventListener("drop",event=>{
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    clearDrag();
    const files=event.dataTransfer.files;
    if (files.length!==1 || !/\.tiff?$/i.test(files[0].name)) {
      status.textContent="TIFFファイル（.tif / .tiff）を1枚ドロップしてください。";
      return;
    }
    open(files[0],files[0].name);
  });
  el("viewer-open").addEventListener("click",()=>open());
  el("viewer-close").addEventListener("click",()=>dialog.close());
  dialog.addEventListener("close",()=>{if (!dialog.open) clearView();});
  el("viewer-pick").addEventListener("click",()=>input.click());
  input.addEventListener("change",()=>{
    const file=input.files[0];
    if (file) open(file,file.name);
    input.value="";
  });
  el("viewer-plus").addEventListener("click",()=>zoom(1.5));
  el("viewer-minus").addEventListener("click",()=>zoom(1/1.5));
  el("viewer-fit").addEventListener("click",fit);
  canvas.addEventListener("wheel",event=>{
    if (!view) return;
    event.preventDefault();
    const rect=canvas.getBoundingClientRect();
    zoom(event.deltaY<0?1.2:1/1.2,event.clientX-rect.left,event.clientY-rect.top);
  },{passive:false});
  canvas.addEventListener("pointerdown",event=>{
    if (!view || pointer || event.button!==0) return;
    pointer={id:event.pointerId,x:event.clientX,y:event.clientY};
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove",event=>{
    if (!pointer || pointer.id!==event.pointerId) return;
    view.x+=event.clientX-pointer.x;
    view.y+=event.clientY-pointer.y;
    pointer.x=event.clientX;
    pointer.y=event.clientY;
    constrain();
    refresh();
  });
  for (const type of ["pointerup","pointercancel","lostpointercapture"]) {
    canvas.addEventListener(type,event=>{
      if (pointer?.id!==event.pointerId) return;
      pointer=null;
      clearTimeout(timer);
      timer=setTimeout(request,0);
    });
  }
  canvas.addEventListener("keydown",event=>{
    if (!view) return;
    const direction={ArrowUp:[0,40],ArrowDown:[0,-40],ArrowLeft:[40,0],ArrowRight:[-40,0]}[event.key];
    if (direction) {
      view.x+=direction[0];
      view.y+=direction[1];
      constrain();
      refresh();
    } else if (event.key==="+" || event.key==="=") zoom(1.5);
    else if (event.key==="-") zoom(1/1.5);
    else if (event.key==="0") fit();
    else return;
    event.preventDefault();
  });
  new ResizeObserver(()=>{
    if (dialog.open && updateCanvas() && image) fit();
  }).observe(canvas);
})();
