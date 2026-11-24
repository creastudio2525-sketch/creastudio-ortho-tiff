"use strict";

const byId = (id) => document.getElementById(id);
const maxBytes = 6_000_000_000;
const picker = byId("files");
const drop = byId("drop");
const pick = byId("pick");
const clear = byId("clear");
const run = byId("convert");
const download = byId("download");
const cancel = byId("cancel");
const list = byId("file-list");
const dialog = byId("processing-dialog");
const locale = new Intl.NumberFormat("ja-JP", {maximumFractionDigits: 1});
let files = [];
let result = null;
let active = false;
let worker = null;
let draftName = null;
let objectURL = null;
let dragDepth = 0;

function bytes(size) {
  if (size >= 1e9) return `${locale.format(size / 1e9)} GB`;
  if (size >= 1e6) return `${locale.format(size / 1e6)} MB`;
  if (size >= 1e3) return `${locale.format(size / 1e3)} KB`;
  return `${size} B`;
}

function message(id, text = "") {
  const el = byId(id);
  el.textContent = text;
  el.hidden = !text;
}

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#i-${name}`);
  el.append(use);
  return el;
}

function render() {
  const chosen = files;
  const total = chosen.reduce((sum, file) => sum + file.size, 0);
  byId("count").textContent = `${chosen.length}件`;
  byId("total").textContent = bytes(total);
  pick.disabled = active;
  drop.setAttribute("aria-disabled", String(active));
  clear.hidden = active || !chosen.length;
  list.hidden = !chosen.length;
  list.replaceChildren(...chosen.map((file, index) => {
    const row = document.createElement("li");
    row.className = "file-row";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;
    name.title = file.name;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = bytes(file.size);
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "text-button preview-file";
    preview.disabled = active;
    preview.textContent = "表示";
    preview.setAttribute("aria-label", `${file.name}を表示`);
    preview.addEventListener("click", () => window.openTiffViewer(file,file.name));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.disabled = active;
    remove.hidden = !files.length;
    remove.setAttribute("aria-label", `${file.name}を外す`);
    remove.append(icon("close"));
    remove.addEventListener("click", () => {
      files.splice(index, 1);
      selectionChanged();
      (list.querySelectorAll("button[data-remove]")[index] || pick).focus();
    });
    remove.dataset.remove = "";
    row.append(icon("file"), name, size, preview, remove);
    return row;
  }));
  run.hidden = active || Boolean(result);
  run.disabled = !files.length || total > maxBytes;
  download.hidden = !result;
  byId("viewer-result").hidden = !result;
  if (result) download.href = objectURL;
  else download.removeAttribute("href");
  if (active && !dialog.open) dialog.showModal();
  if (!active && dialog.open) dialog.close();
  byId("output-size").textContent = result ? bytes(result.bytes) : "1 GB以内";
  byId("resolution-row").hidden = !result;
  byId("crs-row").hidden = !result?.crs;
  byId("resolution").textContent = result ? `${result.width.toLocaleString("ja-JP")} × ${result.height.toLocaleString("ja-JP")} px` : "";
  byId("crs").textContent = result?.crs || "";
  const gsd = result?.pixel > 0 ? `（1画素 約${locale.format(result.pixel*1000)} mm）` : "";
  message("result-note", result
    ? (result.reduced ? `解像度を調整しました${gsd}。` : "元の解像度で作成しました。")
    : "");
}

function selectionChanged() {
  clearOutput();
  const total = files.reduce((sum, file) => sum + file.size, 0);
  message("selection-error", total > maxBytes ? "合計6 GBを超えています。ファイルを外してください。" : "");
  message("job-error");
  render();
}

function addFiles(items) {
  if (active) return;
  const incoming = [...items];
  const acceptable = incoming.filter((file) => /\.tiff?$/i.test(file.name) && file.size >= 8);
  const known = new Set(files.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  for (const file of acceptable) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!known.has(key)) {
      files.push(file);
      known.add(key);
    }
  }
  if (files.length > 1000) files = files.slice(0, 1000);
  selectionChanged();
  if (incoming.length !== acceptable.length && byId("selection-error").hidden) {
    message("selection-error", ".tif または .tiff の画像ファイルを選択してください。");
  }
}

function showProgress(percent, text) {
  byId("progress").value = percent;
  byId("percentage").textContent = `${percent}%`;
  if (byId("status").textContent !== text) byId("status").textContent = text;
}

async function removeDraft(name) {
  if (!name) return;
  for (let i=0; i<4; i++) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name);
      return;
    } catch (e) {
      if (e.name !== "NoModificationAllowedError" && e.name !== "InvalidStateError") return;
      await new Promise((resolve) => setTimeout(resolve, 150*(i+1)));
    }
  }
}

function clearOutput() {
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
  result = null;
  const name = draftName;
  draftName = null;
  removeDraft(name);
}

function finish(data) {
  worker?.terminate();
  worker = null;
  active = false;
  if (data.type === "done") {
    result = data.result;
    objectURL = URL.createObjectURL(result.blob);
    render();
    download.focus({preventScroll:true});
    return;
  }
  clearOutput();
  render();
  message("job-error", data.message);
  run.focus({preventScroll:true});
}

function start() {
  if (active || !files.length || run.disabled) return;
  message("job-error");
  clearOutput();
  if (!window.isSecureContext || typeof Worker !== "function") {
    message("job-error","HTTPSで開いたChromeまたはEdgeからご利用ください。");
    return;
  }
  draftName = `creastudio-ortho-${crypto.randomUUID()}.tiff`;
  active = true;
  showProgress(0,"TIFFを読み込んでいます");
  render();
  try {
    worker = new Worker(new URL("./convert-worker.js", document.baseURI));
    worker.onmessage = ({data}) => {
      if (data.type === "progress") showProgress(data.percent,data.message);
      else finish(data);
    };
    worker.onerror = () => finish({type:"error",message:"変換機能を起動できません。画面を再読み込みしてください。"});
    worker.postMessage({files,name:draftName});
  } catch {
    finish({type:"error",message:"変換機能を起動できません。画面を再読み込みしてください。"});
  }
}

async function removeExpiredDrafts() {
  try {
    const root = await navigator.storage.getDirectory();
    const expired = Date.now()-2*24*60*60*1000;
    for await (const [name, handle] of root.entries()) {
      if (/^creastudio-ortho-[a-f0-9-]+\.tiff$/.test(name) && handle.kind === "file"
        && (await handle.getFile()).lastModified < expired) await removeDraft(name);
    }
  } catch {}
}

pick.addEventListener("click", () => picker.click());
picker.addEventListener("change", () => { addFiles(picker.files); picker.value = ""; });
clear.addEventListener("click", () => { files = []; selectionChanged(); pick.focus(); });
run.addEventListener("click", start);
cancel.addEventListener("click", () => finish({type:"error",message:"TIFFの作成を中止しました。"}));
dialog.addEventListener("cancel", (event) => event.preventDefault());
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) {
    e.preventDefault();
    e.dataTransfer.dropEffect = !active && drop.contains(e.target) ? "copy" : "none";
  }
});
document.addEventListener("drop", (e) => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});
drop.addEventListener("dragenter", (e) => {
  if (!active && e.dataTransfer.types.includes("Files")) {
    dragDepth++;
    drop.classList.add("dragging");
  }
});
drop.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    drop.classList.remove("dragging");
  }
});
drop.addEventListener("drop", (e) => {
  dragDepth = 0;
  drop.classList.remove("dragging");
  addFiles(e.dataTransfer.files);
});
removeExpiredDrafts();
render();
byId("viewer-result").addEventListener("click", () => {
  if (result) window.openTiffViewer(result.blob,download.download,result.preview);
});
