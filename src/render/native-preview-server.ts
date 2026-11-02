/**
 * Native-map interactive browser preview.
 *
 * Static geometry is decoded once and inspected entirely in the browser: no
 * simulation, SSE, worker pool, framework, or remote asset is involved.
 * Usage: npx tsx src/render/native-preview-server.ts --map maps/example.json
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { isNativeMapJson } from '../core/native-map-codec';
import { parseIntArg, parsePairArgs, resolvePreviewMap } from './preview-shared';
import { loadNativeMapForRender, NativeMapRenderData } from './native-map-geometry';
import { renderNativeMapSvg } from './native-map-preview';

interface NativePreviewPayload {
  filename: string;
  svg: string;
  bodies: unknown[];
  fixtures: unknown[];
  spawns: unknown[];
  joints: unknown[];
}

export function nativePreviewPayload(mapPath: string, data: NativeMapRenderData): NativePreviewPayload {
  return {
    filename: path.basename(mapPath),
    svg: renderNativeMapSvg(data, { filename: path.basename(mapPath) }),
    bodies: data.physics.bodies.map((body, index) => body && { index, type: data.bodyTypes[index], ...body }),
    fixtures: data.physics.fixtures.map((fixture, index) => fixture && { index, ...fixture }),
    spawns: data.spawns,
    joints: data.joints,
  };
}

export function nativePreviewHtml(payload: NativePreviewPayload): string {
  // JSON is embedded as data, not executable source; escaping '<' prevents a
  // map label from closing the script element. The page itself uses textContent
  // for map-provided values and innerHTML only for our generated SVG.
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Native map inspector</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#151a20;color:#dbe2e9;font:13px ui-monospace,Consolas,monospace}header{padding:12px 16px;border-bottom:1px solid #35404b}header strong{color:#fff}header span{color:#91a4b7;margin-left:16px}main{display:grid;grid-template-columns:minmax(0,1fr) 310px;height:calc(100vh - 49px)}#viewport{overflow:hidden;position:relative;background:#20262d}#viewport svg{display:block;transform-origin:0 0;cursor:grab;max-width:none}#viewport.dragging svg{cursor:grabbing}aside{overflow:auto;padding:12px;border-left:1px solid #35404b;background:#11171d}button,select{background:#25313d;color:#e5edf4;border:1px solid #465768;border-radius:3px;padding:5px 8px;margin:2px;cursor:pointer}button:hover{background:#344659}.toolbar{position:absolute;z-index:2;top:10px;left:10px;background:#11171de8;padding:6px;border-radius:4px}.layers label{display:block;margin:5px 0}#info{white-space:pre-wrap;color:#b8c8d8;border-top:1px solid #35404b;margin-top:10px;padding-top:10px}h2{font-size:13px;color:#fff;margin:12px 0 6px}.hint{color:#8294a7;line-height:1.5}.badge{color:#f1c40f}
</style></head><body>
<header><strong>Native map inspector</strong><span id="filename"></span></header>
<main><div id="viewport"><div class="toolbar"><button id="zoomIn" title="Zoom in">+</button><button id="zoomOut" title="Zoom out">−</button><button id="fit" title="Fit map">Fit</button><button id="download" title="Download SVG">SVG</button><span id="zoom"></span></div></div>
<aside><h2>Layers</h2><div class="layers">
<label><input type="checkbox" data-layer="map-geometry" checked> Geometry</label>
<label><input type="checkbox" data-layer="spawns" checked> Spawns</label>
<label><input type="checkbox" data-layer="capture-zones" checked> Capture zones</label>
<label><input type="checkbox" data-layer="joints" checked> Joints</label>
<label><input type="checkbox" data-layer="metadata" checked> Metadata</label>
<label><input type="checkbox" data-layer="legend" checked> Legend</label>
</div><h2>Inspect</h2><select id="object"><option value="">Click geometry or choose…</option></select>
<div id="info">Wheel: zoom\nDrag: pan\nClick: inspect fixture\nDouble-click: fit</div>
<h2>Map</h2><div class="hint" id="summary"></div></aside></main>
<script>
const data=${data};
const viewport=document.getElementById('viewport');
const svgHost=document.createElement('div');
svgHost.innerHTML=data.svg;
const svg=svgHost.firstElementChild;
viewport.appendChild(svg);
const baseW=Number(svg.getAttribute('width')),baseH=Number(svg.getAttribute('height'));
let scale=1,panX=0,panY=0,selected=null;
function apply(){svg.style.transform='translate('+panX+'px,'+panY+'px) scale('+scale+')';document.getElementById('zoom').textContent=Math.round(scale*100)+'%';}
function fit(){const r=viewport.getBoundingClientRect();scale=Math.min(r.width/baseW,r.height/baseH)*0.96;panX=(r.width-baseW*scale)/2;panY=(r.height-baseH*scale)/2;apply();}
function zoom(f,cx,cy){const old=scale;scale=Math.max(0.1,Math.min(40,scale*f));panX=cx-(cx-panX)*(scale/old);panY=cy-(cy-panY)*(scale/old);apply();}
document.getElementById('filename').textContent=data.filename;
document.getElementById('summary').textContent=data.bodies.filter(Boolean).length+' bodies · '+data.fixtures.filter(Boolean).length+' fixtures · '+data.spawns.length+' spawns · '+data.joints.length+' joints';
const select=document.getElementById('object');
for(const f of data.fixtures)if(f){const o=document.createElement('option');o.value='fixture:'+f.index;o.textContent='Fixture '+f.index+' · '+(f.n||'unnamed');select.appendChild(o);}
for(const b of data.bodies)if(b){const o=document.createElement('option');o.value='body:'+b.index;o.textContent='Body '+b.index+' · '+b.type;select.appendChild(o);}
for(const j of data.joints){const o=document.createElement('option');o.value='joint:'+j.index;o.textContent='Joint '+j.index+' · '+j.type;select.appendChild(o);}
function inspect(key){const [kind,id]=key.split(':');let value;if(kind==='fixture')value=data.fixtures[Number(id)];else if(kind==='body')value=data.bodies[Number(id)];else value=data.joints.find(j=>j.index===Number(id));document.getElementById('info').textContent=value?JSON.stringify(value,null,2):'Select an object';select.value=key;if(selected)selected.removeAttribute('data-selected');if(kind==='fixture'){selected=svg.querySelector('[data-fixture="'+id+'"]');if(selected){selected.dataset.previousStroke=selected.getAttribute('stroke')||'';selected.setAttribute('stroke','#ffffff');selected.setAttribute('stroke-width','4');}}}
select.addEventListener('change',()=>inspect(select.value));
svg.addEventListener('click',e=>{const el=e.target.closest('[data-fixture]');if(el)inspect('fixture:'+el.dataset.fixture);});
document.querySelectorAll('[data-layer]').forEach(box=>box.addEventListener('change',()=>{const g=svg.querySelector('#'+box.dataset.layer);if(g)g.style.display=box.checked?'':'none';}));
viewport.addEventListener('wheel',e=>{e.preventDefault();const r=viewport.getBoundingClientRect();zoom(e.deltaY<0?1.15:1/1.15,e.clientX-r.left,e.clientY-r.top);},{passive:false});
let drag=null;
svg.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,px:panX,py:panY,moved:false};viewport.classList.add('dragging');svg.setPointerCapture(e.pointerId);});
svg.addEventListener('pointermove',e=>{if(!drag)return;panX=drag.px+e.clientX-drag.x;panY=drag.py+e.clientY-drag.y;drag.moved=true;apply();});
svg.addEventListener('pointerup',()=>{drag=null;viewport.classList.remove('dragging');});
viewport.addEventListener('dblclick',fit);
document.getElementById('zoomIn').onclick=()=>zoom(1.25,viewport.clientWidth/2,viewport.clientHeight/2);
document.getElementById('zoomOut').onclick=()=>zoom(0.8,viewport.clientWidth/2,viewport.clientHeight/2);
document.getElementById('fit').onclick=fit;
document.getElementById('download').onclick=()=>{const blob=new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=data.filename+'.svg';a.click();URL.revokeObjectURL(a.href);};
window.addEventListener('resize',fit);fit();
</script></body></html>`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parsePairArgs(argv);
  // npm consumes unknown flags as config and may forward only their values.
  // Accept those two positional values; explicit direct CLI flags still win.
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const map = resolvePreviewMap(args.map ?? process.env.npm_config_map ?? positional[0]);
  const portValue =
    args.port ??
    (process.env.npm_config_port && process.env.npm_config_port !== 'true'
      ? process.env.npm_config_port
      : positional[1]);
  const port = parseIntArg(portValue, 8081, 'port');
  const parsed: unknown = JSON.parse(fs.readFileSync(map, 'utf8'));
  if (!isNativeMapJson(parsed)) throw new Error(`Interactive native preview requires native map JSON: ${map}`);
  const html = nativePreviewHtml(nativePreviewPayload(map, loadNativeMapForRender(map)));
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } else if (req.url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found\n');
    }
  });
  server.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(port, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Native map inspector → http://localhost:${boundPort}  (map=${map})`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
