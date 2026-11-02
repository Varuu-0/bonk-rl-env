/**
 * Native-map interactive browser preview.
 *
 * The initial map is embedded; selections are decoded on demand: no
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

export const DEFAULT_MAP_LIBRARY = path.resolve('maps/library');

/** Return sorted library entries without opening or validating every map. */
export function listNativePreviewMaps(library = DEFAULT_MAP_LIBRARY): string[] {
  if (!fs.existsSync(library)) return [];
  return fs
    .readdirSync(library, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Resolve a single path segment; absolute paths and traversal are rejected. */
export function resolveLibraryMap(name: string, library = DEFAULT_MAP_LIBRARY): string {
  if (!name || name !== path.basename(name) || !name.toLowerCase().endsWith('.json')) {
    throw new Error('Map selection must be a JSON filename from maps/library');
  }
  const root = path.resolve(library);
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root) throw new Error('Map selection escapes the map library');
  return resolved;
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
<header><strong>Native map inspector</strong><select id="mapSelector" aria-label="Map" title="Select a map"><option>Loading maps…</option></select><span id="filename"></span><span id="loadStatus" role="status"></span></header>
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
let current=data;
const viewport=document.getElementById('viewport');
let svg,baseW=1,baseH=1;
let scale=1,panX=0,panY=0,selected=null;
const select=document.getElementById('object');
function applyMap(){
 if(selected)selected.removeAttribute('data-selected');selected=null;
 viewport.querySelector('svg')?.remove();
 current=current||data;
 const host=document.createElement('div');host.innerHTML=current.svg;
 svg=host.firstElementChild;viewport.appendChild(svg);
 baseW=Number(svg.getAttribute('width'));baseH=Number(svg.getAttribute('height'));
 document.getElementById('filename').textContent=current.filename;
 document.getElementById('summary').textContent=current.bodies.filter(Boolean).length+' bodies · '+current.fixtures.filter(Boolean).length+' fixtures · '+current.spawns.length+' spawns · '+current.joints.length+' joints';
 select.replaceChildren(new Option('Click geometry or choose…',''));
 for(const f of current.fixtures)if(f)select.add(new Option('Fixture '+f.index+' · '+(f.n||'unnamed'),'fixture:'+f.index));
 for(const b of current.bodies)if(b)select.add(new Option('Body '+b.index+' · '+b.type,'body:'+b.index));
 for(const j of current.joints)select.add(new Option('Joint '+j.index+' · '+j.type,'joint:'+j.index));
 document.getElementById('info').textContent='Wheel: zoom\nDrag: pan\nClick: inspect fixture\nDouble-click: fit';
 document.querySelectorAll('[data-layer]').forEach(box=>{const g=svg.querySelector('#'+box.dataset.layer);if(g)g.style.display=box.checked?'':'none';});
 fit();
}
function inspect(key){const [kind,id]=key.split(':');let value;if(kind==='fixture')value=current.fixtures[Number(id)];else if(kind==='body')value=current.bodies[Number(id)];else value=current.joints.find(j=>j.index===Number(id));document.getElementById('info').textContent=value?JSON.stringify(value,null,2):'Select an object';select.value=key;if(selected)selected.removeAttribute('data-selected');if(kind==='fixture'){selected=svg.querySelector('[data-fixture="'+id+'"]');if(selected){selected.dataset.previousStroke=selected.getAttribute('stroke')||'';selected.setAttribute('stroke','#ffffff');selected.setAttribute('stroke-width','4');}}}
select.addEventListener('change',()=>inspect(select.value));
viewport.addEventListener('click',e=>{const el=e.target.closest('[data-fixture]');if(el)inspect('fixture:'+el.dataset.fixture);});
document.querySelectorAll('[data-layer]').forEach(box=>box.addEventListener('change',()=>{const g=svg.querySelector('#'+box.dataset.layer);if(g)g.style.display=box.checked?'':'none';}));
function apply(){svg.style.transform='translate('+panX+'px,'+panY+'px) scale('+scale+')';document.getElementById('zoom').textContent=Math.round(scale*100)+'%';}
function fit(){const r=viewport.getBoundingClientRect();scale=Math.min(r.width/baseW,r.height/baseH)*0.96;panX=(r.width-baseW*scale)/2;panY=(r.height-baseH*scale)/2;apply();}
function zoom(f,cx,cy){const old=scale;scale=Math.max(0.1,Math.min(40,scale*f));panX=cx-(cx-panX)*(scale/old);panY=cy-(cy-panY)*(scale/old);apply();}
viewport.addEventListener('wheel',e=>{e.preventDefault();const r=viewport.getBoundingClientRect();zoom(e.deltaY<0?1.15:1/1.15,e.clientX-r.left,e.clientY-r.top);},{passive:false});
let drag=null;
viewport.addEventListener('pointerdown',e=>{if(e.target.closest('.toolbar'))return;drag={x:e.clientX,y:e.clientY,px:panX,py:panY,moved:false};viewport.classList.add('dragging');svg.setPointerCapture(e.pointerId);});
viewport.addEventListener('pointermove',e=>{if(!drag)return;panX=drag.px+e.clientX-drag.x;panY=drag.py+e.clientY-drag.y;drag.moved=true;apply();});
viewport.addEventListener('pointerup',()=>{drag=null;viewport.classList.remove('dragging');});
viewport.addEventListener('dblclick',fit);
document.getElementById('zoomIn').onclick=()=>zoom(1.25,viewport.clientWidth/2,viewport.clientHeight/2);
document.getElementById('zoomOut').onclick=()=>zoom(0.8,viewport.clientWidth/2,viewport.clientHeight/2);
document.getElementById('fit').onclick=fit;
document.getElementById('download').onclick=()=>{const blob=new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=current.filename+'.svg';a.click();URL.revokeObjectURL(a.href);};
const mapSelect=document.getElementById('mapSelector'),status=document.getElementById('loadStatus');
let loadVersion=0;
async function loadMap(name,updateUrl=true){
 const version=++loadVersion;mapSelect.disabled=true;status.textContent='Loading…';status.className='';
 try{
  const response=await fetch('/api/map?name='+encodeURIComponent(name));
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'Unable to load map');
  if(version!==loadVersion)return;
  current=result;applyMap();mapSelect.value=name;status.textContent='';
  if(updateUrl){const url=new URL(location.href);url.searchParams.set('map',name);history.replaceState(null,'',url);}
 }catch(error){if(version===loadVersion){status.textContent=error.message;status.className='badge';mapSelect.value=current.filename;}}
 finally{if(version===loadVersion)mapSelect.disabled=false;}
}
mapSelect.addEventListener('change',()=>loadMap(mapSelect.value));
async function initMaps(){
 applyMap();
 try{
  const response=await fetch('/api/maps');const maps=await response.json();
  mapSelect.replaceChildren();for(const name of maps)mapSelect.add(new Option(name,name));
  if(!maps.includes(current.filename))mapSelect.add(new Option(current.filename,current.filename));
  const requested=new URL(location.href).searchParams.get('map');
  mapSelect.value=current.filename;
  if(requested&&requested!==current.filename)await loadMap(requested,false);
 }catch(error){status.textContent=error.message;status.className='badge';}
}
initMaps();
</script></body></html>`;
}

function loadPayload(mapPath: string): NativePreviewPayload {
  const parsed: unknown = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  if (!isNativeMapJson(parsed)) throw new Error(`Interactive native preview requires native map JSON: ${mapPath}`);
  return nativePreviewPayload(mapPath, loadNativeMapForRender(mapPath));
}

export function createNativePreviewServer(initialMap: string, library = DEFAULT_MAP_LIBRARY): http.Server {
  const initialPayload = loadPayload(initialMap);
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(nativePreviewHtml(initialPayload));
    } else if (url.pathname === '/api/maps') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(listNativePreviewMaps(library)));
    } else if (url.pathname === '/api/map') {
      try {
        const name = url.searchParams.get('name') ?? '';
        const mapPath = resolveLibraryMap(name, library);
        if (!fs.existsSync(mapPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `Map not found: ${name}` }));
          return;
        }
        const payload = JSON.stringify(loadPayload(mapPath));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(payload);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    } else if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found\n');
    }
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parsePairArgs(argv);
  // npm consumes unknown flags as config and may forward only their values.
  // Accept those two positional values; explicit direct CLI flags still win.
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const requestedMap = args.map ?? process.env.npm_config_map ?? positional[0];
  const portValue =
    args.port ??
    (process.env.npm_config_port && process.env.npm_config_port !== 'true'
      ? process.env.npm_config_port
      : positional[1]);
  const port = parseIntArg(portValue, 8081, 'port');
  let map: string;
  if (requestedMap) map = resolvePreviewMap(requestedMap);
  else {
    const candidates = listNativePreviewMaps();
    map =
      candidates
        .map((name) => resolveLibraryMap(name))
        .find((candidate) => {
          try {
            loadPayload(candidate);
            return true;
          } catch {
            return false;
          }
        }) ?? '';
    if (!map) throw new Error('No valid native maps found in maps/library; pass --map <native-map.json>');
  }
  const server = createNativePreviewServer(map);
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
