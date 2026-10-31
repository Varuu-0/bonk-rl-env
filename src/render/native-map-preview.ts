/** Self-contained, static SVG preview for a strictly loaded native map. */
import * as path from 'path';
import { buildGeometry } from './map-geometry';
import {
  fitNativeCamera,
  MapBounds,
  NativeMapRenderData,
  nativeGeometryBounds,
  nativePointToScreen,
} from './native-map-geometry';

export interface NativePreviewOptions {
  width?: number;
  height?: number;
  margin?: number;
  filename?: string;
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fixed = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : '0.00');

/** Render initial native gameplay geometry without constructing a simulation. */
export function renderNativeMapSvg(data: NativeMapRenderData, options: NativePreviewOptions = {}): string {
  const width = options.width ?? 1000;
  const height = options.height ?? 700;
  const bounds = nativeGeometryBounds(data);
  const camera = fitNativeCamera(bounds, width, height, options.margin);
  const commands = buildGeometry(data.input, camera).sort((a, b) => a.z - b.z);
  const counts = {
    bodies: data.physics.bodies.filter(Boolean).length,
    fixtures: data.physics.fixtures.filter(Boolean).length,
    spawns: data.spawns.length,
    zones: data.map.capZones.length,
    joints: data.joints.length,
  };
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>Native map preview: ${esc(options.filename ?? 'native map')}</title>`,
    `<rect width="${width}" height="${height}" fill="#20262d"/>`,
    `<g id="map-geometry" stroke-linejoin="round">`,
  ];
  // The body's source index is encoded only in the paint command's z indirectly;
  // use native bodyRenderOrder to recover the corresponding visual body type.
  const bodyForZ = new Map<number, number>();
  const order = data.input.bodyRenderOrder?.length
    ? [...data.input.bodyRenderOrder].reverse()
    : (data.input.bodies ?? []).map((body) => body.index);
  order.forEach((bodyIndex, z) => bodyForZ.set(z, bodyIndex));
  for (const command of commands) {
    const p = command.primitive;
    const bodyType = data.bodyTypes[bodyForZ.get(command.z) ?? -1] ?? 'static';
    const stroke = p.stroke ?? (bodyType === 'dynamic' ? '#4a90d9' : bodyType === 'kinematic' ? '#b47ad6' : '#161b20');
    const dash = bodyType === 'dynamic' ? '8 4' : bodyType === 'kinematic' ? '3 4' : undefined;
    const opacity = command.isSensor ? 0.4 : 1;
    const attributes = `fill="${p.fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="${fixed(Math.max(1.5, p.lineWidth))}"${dash ? ` stroke-dasharray="${dash}"` : ''}`;
    if (p.kind === 'circle') {
      lines.push(`<circle cx="${fixed(p.sx)}" cy="${fixed(p.sy)}" r="${fixed(p.r)}" ${attributes}/>`);
    } else if (p.kind === 'poly') {
      lines.push(`<polygon points="${p.points.map(([x, y]) => `${fixed(x)},${fixed(y)}`).join(' ')}" ${attributes}/>`);
    } else {
      lines.push(
        `<rect x="${fixed(p.sx)}" y="${fixed(p.sy)}" width="${fixed(p.w)}" height="${fixed(p.h)}" ${attributes}/>`,
      );
    }
  }
  lines.push('</g>');
  lines.push('<g id="capture-zones" fill="none" stroke="#f1c40f" stroke-width="2" stroke-dasharray="6 4">');
  data.frameCapZones.forEach((index) => {
    const inset = 16 + index * 6;
    lines.push(`<rect x="${inset}" y="${inset}" width="${width - inset * 2}" height="${height - inset * 2}"/>`);
    lines.push(
      `<text x="${inset + 5}" y="${inset + 15}" fill="#f1c40f" stroke="none" font-family="monospace" font-size="11">${esc(data.map.capZones[index].n || `zone ${index}`)}</text>`,
    );
  });
  lines.push('</g>');
  lines.push('<g id="joints" stroke="#e8e8e8" fill="#20262d" stroke-width="1.5" opacity="0.9">');
  data.joints.forEach((joint) => {
    const a = nativePointToScreen(joint.a, camera),
      b = nativePointToScreen(joint.b, camera);
    lines.push(
      `<line x1="${fixed(a[0])}" y1="${fixed(a[1])}" x2="${fixed(b[0])}" y2="${fixed(b[1])}" stroke-dasharray="4 3"/>`,
    );
    [a, b].forEach((point) => lines.push(`<circle cx="${fixed(point[0])}" cy="${fixed(point[1])}" r="3"/>`));
  });
  lines.push('</g>');
  lines.push('<g id="spawns" font-family="monospace" font-size="10">');
  data.spawns.forEach((spawn) => {
    const [x, y] = nativePointToScreen([spawn.x, spawn.y], camera);
    const color = spawn.teams.includes('red')
      ? '#e66767'
      : spawn.teams.includes('blue')
        ? '#6aa9e9'
        : spawn.teams.includes('green')
          ? '#62c98b'
          : spawn.teams.includes('yellow')
            ? '#f1c40f'
            : '#ffffff';
    lines.push(
      `<circle cx="${fixed(x)}" cy="${fixed(y)}" r="8" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2"/>`,
    );
    lines.push(`<circle cx="${fixed(x)}" cy="${fixed(y)}" r="2" fill="${color}"/>`);
    if (spawn.xv !== 0 || spawn.yv !== 0) {
      lines.push(
        `<line x1="${fixed(x)}" y1="${fixed(y)}" x2="${fixed(x + spawn.xv * camera.scale * 0.2)}" y2="${fixed(y + spawn.yv * camera.scale * 0.2)}" stroke="${color}" stroke-width="1.5"/>`,
      );
    }
    const label = `${spawn.name || `spawn ${spawn.index}`} [${spawn.teams.join('/') || 'none'}] p${spawn.priority}`;
    const labelOnLeft = x > width * 0.75;
    lines.push(
      `<text x="${fixed(labelOnLeft ? x - 11 : x + 11)}" y="${fixed(y - 9)}"${labelOnLeft ? ' text-anchor="end"' : ''} fill="${color}">${esc(label)}</text>`,
    );
  });
  lines.push('</g>');
  const metadata = `${options.filename ?? 'native map'}  |  native v${data.map.v}  |  ppm ${data.physics.ppm}  |  ${counts.bodies} bodies, ${counts.fixtures} fixtures, ${counts.spawns} spawns, ${counts.zones} zones, ${counts.joints} joints`;
  lines.push(
    `<g id="metadata" font-family="monospace" font-size="12" fill="#e8edf2"><rect x="0" y="0" width="${width}" height="27" fill="#11161b" fill-opacity="0.94"/><text x="12" y="18">${esc(metadata)}</text></g>`,
  );
  const legend = [
    ['#9aa4ad', '', 'static body'],
    ['#9aa4ad', '#4a90d9', 'dynamic body'],
    ['#9aa4ad', '#b47ad6', 'kinematic body'],
    ['#9aa4ad', '#ff0000', 'lethal fixture'],
    ['#9aa4ad', '#161b20', 'nonphysical: translucent'],
    ['none', '#f1c40f', 'capture zone'],
  ];
  lines.push('<g id="legend" font-family="monospace" font-size="11" fill="#e8edf2">');
  lines.push(
    `<rect x="10" y="${height - 31 - legend.length * 17}" width="205" height="${legend.length * 17 + 20}" rx="4" fill="#11161b" fill-opacity="0.92"/>`,
  );
  lines.push(`<text x="20" y="${height - 16 - legend.length * 17}" font-weight="bold">Legend</text>`);
  legend.forEach(([fill, stroke, label], index) => {
    const y = height - 24 - (legend.length - 1 - index) * 17;
    lines.push(
      `<rect x="20" y="${y - 9}" width="18" height="11" fill="${fill}" fill-opacity="${label.startsWith('nonphysical') ? 0.4 : 1}" stroke="${stroke || '#161b20'}" stroke-width="2"/>`,
    );
    lines.push(`<text x="46" y="${y}">${label}</text>`);
  });
  lines.push('</g>');
  if (data.limitations.length > 0) {
    lines.push(
      `<g id="render-limitations" font-family="monospace" font-size="11" fill="#f1c40f"><text x="${width - 12}" y="${height - 12}" text-anchor="end">${esc(data.limitations.join(' '))}</text></g>`,
    );
  }
  lines.push('</svg>');
  return lines.join('\n');
}

/** Convenience entry point for tests and other detached consumers. */
export function nativePreviewCamera(data: NativeMapRenderData, width = 1000, height = 700) {
  return fitNativeCamera(nativeGeometryBounds(data), width, height);
}

export function nativePreviewBounds(data: NativeMapRenderData): MapBounds {
  return nativeGeometryBounds(data);
}

export function nativePreviewName(mapPath: string): string {
  return path.basename(mapPath);
}
