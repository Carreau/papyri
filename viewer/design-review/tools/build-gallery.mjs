// Usage: node build-gallery.mjs <prototypes-dir> <out.html>
// Build a single-file prototype gallery: direction picker × page tabs × viewport
// presets, each prototype page loaded into an <iframe srcdoc>. Relative
// page-to-page links inside a prototype are rewritten (via an injected
// script) into postMessage calls so navigation between tabs keeps working.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2];
const OUT = process.argv[3];

const DIRECTIONS = [
  { id: "0-evolve", label: "0 · Evolve", short: "Evolve", blurb: "Keep today's markup; apply the token set, type scale and every quick win." },
  { id: "A-reference", label: "A · Reference", short: "Reference", blurb: "docs.rs / pkg.go.dev-style dense reference with a per-page rail." },
  { id: "B-reading", label: "B · Reading-first", short: "Reading", blurb: "pydata / Furo-style three columns, contextual sidebar, section tabs." },
  { id: "C-shell", label: "C · App shell", short: "Shell", blurb: "DevDocs-style persistent package tree + scoped search palette." },
];
const PAGES = [
  ["class", "Class"],
  ["function", "Method"],
  ["doc", "Guide page"],
  ["overview", "Package overview"],
  ["home", "Home"],
  ["prefs", "Preferences"],
];

const BRIDGE = `<script>(function(){
  document.addEventListener("click",function(e){
    var a=e.target.closest&&e.target.closest("a[href]"); if(!a) return;
    var h=a.getAttribute("href"); if(!h) return;
    var m=h.match(/^([a-z0-9-]+)\\.html(#.*)?$/i);
    if(m){ e.preventDefault(); parent.postMessage({papyriProto:true,page:m[1],hash:m[2]||""},"*"); }
  },true);
  window.addEventListener("message",function(e){
    if(e.data&&e.data.papyriTheme){ document.documentElement.setAttribute("data-theme",e.data.papyriTheme); }
  });
})();</script>`;

function md(src) {
  // Minimal markdown → HTML: headings, paragraphs, lists, tables, code spans, bold, links.
  const lines = src.split("\n");
  let out = [], i = 0;
  const inline = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*$/.test(l)) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); i++; continue; }
    if (l.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\|\s*-{2,}/.test(r));
      const [head, ...rest] = body;
      out.push('<div class="tbl"><table><thead><tr>' + cells(head).map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
        rest.map((r) => "<tr>" + cells(r).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table></div>");
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (/^\s*[-*]\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      out.push("<ul>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ul>");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items = [];
      while (i < lines.length && (/^\s*\d+\.\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (/^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      out.push("<ol>" + items.map((t) => `<li>${inline(t)}</li>`).join("") + "</ol>");
      continue;
    }
    if (l.startsWith("```")) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push("<pre>" + buf.join("\n").replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>");
      continue;
    }
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#|\||```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

const dirs = [];
for (const d of DIRECTIONS) {
  const base = join(ROOT, d.id);
  if (!existsSync(base)) continue;
  const pages = {};
  for (const [id] of PAGES) {
    const f = join(base, `${id}.html`);
    if (!existsSync(f)) continue;
    let html = readFileSync(f, "utf8");
    html = html.replace(/<\/body>/i, BRIDGE + "</body>");
    if (!/<\/body>/i.test(html)) html += BRIDGE;
    pages[id] = html;
  }
  const readme = existsSync(join(base, "README.md")) ? md(readFileSync(join(base, "README.md"), "utf8")) : "";
  dirs.push({ ...d, pages, readme });
}

const esc = (s) => s.replace(/<\/script/gi, "<\\/script");

let html = `<title>Papyri Viewer Prototypes</title>
<style>
:root{--bg:#f3f4f6;--panel:#ffffff;--fg:#1a1d21;--muted:#5b6470;--line:#d9dde3;--line-strong:#b9c0c9;--accent:#2b6cb0;--accent-fg:#fff;--chip:#e8edf3;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1419;--panel:#1a1f26;--fg:#e6e6e6;--muted:#9aa0a6;--line:#2b333c;--line-strong:#4b5563;--accent:#5ea2eb;--chip:#242b33}}
:root[data-theme="dark"]{--bg:#0f1419;--panel:#1a1f26;--fg:#e6e6e6;--muted:#9aa0a6;--line:#2b333c;--line-strong:#4b5563;--accent:#5ea2eb;--chip:#242b33}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 var(--sans);height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:1rem;padding:.5rem .9rem;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap}
h1{font-size:1rem;margin:0;font-weight:650;letter-spacing:-.01em;white-space:nowrap}
h1 span{color:var(--muted);font-weight:400}
.seg{display:inline-flex;border:1px solid var(--line-strong);border-radius:6px;overflow:hidden}
.seg button{border:0;background:transparent;color:var(--fg);font:inherit;padding:.35rem .7rem;cursor:pointer;border-right:1px solid var(--line)}
.seg button:last-child{border-right:0}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--accent-fg)}
.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.tabs{display:flex;gap:.15rem;flex-wrap:wrap}
.tabs button{border:0;background:transparent;color:var(--muted);font:inherit;padding:.35rem .6rem;border-radius:5px;cursor:pointer}
.tabs button[aria-selected="true"]{background:var(--chip);color:var(--fg);font-weight:600}
.tabs button:disabled{opacity:.35;cursor:default}
.tabs button:focus-visible{outline:2px solid var(--accent)}
.spacer{flex:1}
.ghost{border:1px solid var(--line-strong);background:var(--panel);color:var(--fg);font:inherit;padding:.3rem .6rem;border-radius:5px;cursor:pointer}
.ghost[aria-pressed="true"]{background:var(--chip)}
.ghost:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.blurb{font-size:.8rem;color:var(--muted);padding:0 .9rem .4rem;background:var(--panel);border-bottom:1px solid var(--line)}
main{flex:1;min-height:0;display:grid;grid-template-columns:1fr;position:relative}
main.notes-open{grid-template-columns:1fr 24rem}
.stage{overflow:auto;display:flex;justify-content:center;align-items:flex-start;padding:1rem;background:
 repeating-linear-gradient(45deg,transparent 0 12px,rgb(127 127 127/.045) 12px 13px)}
.frame{background:#fff;border:1px solid var(--line-strong);box-shadow:0 8px 32px rgb(0 0 0/.18);height:calc(100vh - 8.2rem);width:100%;max-width:100%;transition:width .15s}
.frame[data-w="390"]{width:390px}.frame[data-w="768"]{width:768px}.frame[data-w="1024"]{width:1024px}.frame[data-w="1440"]{width:1440px}
iframe{border:0;width:100%;height:100%;display:block;background:#fff}
aside{border-left:1px solid var(--line);background:var(--panel);overflow:auto;padding:1rem 1.1rem;font-size:.86rem}
aside h2{font-size:1rem;margin:0 0 .5rem}aside h3{font-size:.9rem;margin:1.1rem 0 .35rem}aside h4{font-size:.8rem;margin:.9rem 0 .3rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
aside p,aside li{color:var(--fg)}aside code{font:.85em var(--mono);background:var(--chip);padding:.05em .3em;border-radius:3px}
aside .tbl{overflow-x:auto}aside table{border-collapse:collapse;font-size:.8rem;min-width:100%}aside th,aside td{border:1px solid var(--line);padding:.3rem .45rem;vertical-align:top;text-align:left}
aside pre{font:.78rem/1.4 var(--mono);background:var(--chip);padding:.6rem;border-radius:5px;overflow:auto}
aside ul,aside ol{padding-left:1.2rem}
.kbd{font:.75rem var(--mono);border:1px solid var(--line-strong);border-radius:4px;padding:0 .3em;color:var(--muted)}
@media (max-width:900px){main.notes-open{grid-template-columns:1fr}aside{display:none}.frame{height:calc(100vh - 9.5rem)}}
@media (prefers-reduced-motion:reduce){.frame{transition:none}}
</style>
<header>
  <h1>Papyri viewer prototypes <span>· 4 directions × ${PAGES.length - 1} pages</span></h1>
  <div class="seg" role="group" aria-label="Direction" id="dirs">${dirs.map((d, i) => `<button type="button" data-dir="${d.id}" aria-pressed="${i === 0}">${d.label}</button>`).join("")}</div>
  <div class="tabs" role="tablist" aria-label="Page" id="pages">${PAGES.map(([id, label], i) => `<button type="button" role="tab" data-page="${id}" aria-selected="${i === 0}">${label}</button>`).join("")}</div>
  <div class="spacer"></div>
  <div class="seg" role="group" aria-label="Viewport width" id="widths">
    <button type="button" data-w="390">390</button><button type="button" data-w="768">768</button><button type="button" data-w="1024">1024</button><button type="button" data-w="1440">1440</button><button type="button" data-w="fit" aria-pressed="true">Fit</button>
  </div>
  <button type="button" class="ghost" id="theme" aria-pressed="false" title="Toggle dark theme inside the prototype">Dark</button>
  <button type="button" class="ghost" id="notes" aria-pressed="false" aria-controls="notes-panel">Proposal notes</button>
</header>
<div class="blurb" id="blurb"></div>
<main id="main">
  <div class="stage"><div class="frame" id="frame" data-w="fit"><iframe id="view" title="Prototype page"></iframe></div></div>
  <aside id="notes-panel" hidden></aside>
</main>
${dirs.map((d) => Object.entries(d.pages).map(([p, src]) => `<script type="text/plain" data-dir="${d.id}" data-page="${p}">${esc(src)}</script>`).join("\n")).join("\n")}
${dirs.map((d) => `<script type="text/plain" data-notes="${d.id}">${esc(d.readme)}</script>`).join("\n")}
<script>
(function(){
  var dirs=${JSON.stringify(dirs.map((d) => ({ id: d.id, blurb: d.blurb, pages: Object.keys(d.pages) })))};
  var state={dir:dirs[0].id,page:"class",w:"fit",dark:false};
  var view=document.getElementById("view"),frame=document.getElementById("frame"),blurb=document.getElementById("blurb");
  var notesBtn=document.getElementById("notes"),notes=document.getElementById("notes-panel"),main=document.getElementById("main");
  function src(dir,page){var el=document.querySelector('script[type="text/plain"][data-dir="'+dir+'"][data-page="'+page+'"]');return el?el.textContent:null;}
  function render(hash){
    var d=dirs.find(function(x){return x.id===state.dir});
    if(d.pages.indexOf(state.page)<0) state.page=d.pages[0];
    document.querySelectorAll("#dirs button").forEach(function(b){b.setAttribute("aria-pressed",String(b.dataset.dir===state.dir))});
    document.querySelectorAll("#pages button").forEach(function(b){b.setAttribute("aria-selected",String(b.dataset.page===state.page));b.disabled=d.pages.indexOf(b.dataset.page)<0;});
    document.querySelectorAll("#widths button").forEach(function(b){b.setAttribute("aria-pressed",String(b.dataset.w===state.w))});
    frame.dataset.w=state.w; blurb.textContent=d.blurb;
    var html=src(state.dir,state.page)||"<p style='font-family:sans-serif;padding:2rem'>No prototype for this page in this direction.</p>";
    if(state.dark) html=html.replace(/<html([^>]*)>/i,'<html$1 data-theme="dark">');
    view.srcdoc=html;
    if(hash){view.addEventListener("load",function once(){view.removeEventListener("load",once);try{view.contentWindow.location.hash=hash;}catch(e){}});}
    var n=document.querySelector('script[data-notes="'+state.dir+'"]'); notes.innerHTML=n?n.textContent:"";
    try{history.replaceState(null,"","#"+state.dir+"/"+state.page+"/"+state.w);}catch(e){}
  }
  document.getElementById("dirs").addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;state.dir=b.dataset.dir;render();});
  document.getElementById("pages").addEventListener("click",function(e){var b=e.target.closest("button");if(!b||b.disabled)return;state.page=b.dataset.page;render();});
  document.getElementById("widths").addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;state.w=b.dataset.w;render();});
  document.getElementById("theme").addEventListener("click",function(){state.dark=!state.dark;this.setAttribute("aria-pressed",String(state.dark));this.textContent=state.dark?"Light":"Dark";render();});
  notesBtn.addEventListener("click",function(){var open=notes.hidden;notes.hidden=!open;main.classList.toggle("notes-open",open);notesBtn.setAttribute("aria-pressed",String(open));});
  window.addEventListener("message",function(e){if(e.data&&e.data.papyriProto){state.page=e.data.page;render(e.data.hash);}});
  var h=location.hash.replace(/^#/,"").split("/");
  if(h.length>=2&&dirs.some(function(d){return d.id===h[0]})){state.dir=h[0];state.page=h[1];if(h[2])state.w=h[2];}
  render();
})();
</script>
`;
writeFileSync(OUT, html);
console.log("wrote", OUT, (html.length / 1024).toFixed(0), "KB", dirs.map((d) => d.id + ":" + Object.keys(d.pages).length).join(" "));
