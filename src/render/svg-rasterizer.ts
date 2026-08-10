/**
 * M5 — SVG rasterizer for the milestone draw lists.
 *
 * Renders the M2 geometry commands and M3 sim commands to an SVG string. This
 * is one concrete `DetachedRenderTarget`; the same draw lists can feed Canvas
 * 2D or a PNG backend without changing the geometry/sim layers.
 */

import { DrawCommand } from './map-geometry';
import { SimCommand } from './sim-layer';
import { Camera } from './render-math';

const esc = (s: string): string => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const BG_INNER = '#3b536b';
const BG_OUTER = '#2c3e50';

export interface SvgRasterizerOptions {
  width: number;
  height: number;
  title?: string;
}

/**
 * Renderer that accumulates geometry+sim commands into an SVG string. Call
 * `begin()` once, then `geometry(...)` and `sim(...)`, then `end()`.
 */
export class SvgRasterizer {
  private parts: string[] = [];
  private readonly options: SvgRasterizerOptions;

  constructor(options: SvgRasterizerOptions) {
    this.options = options;
  }

  begin(): void {
    const { width, height } = this.options;
    this.parts = [];
    this.parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    this.parts.push(`<defs><radialGradient id="bg" cx="50%" cy="50%" r="74%">` +
      `<stop offset="0%" stop-color="${BG_INNER}"/><stop offset="100%" stop-color="${BG_OUTER}"/>` +
      `</radialGradient></defs>`);
    this.parts.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/>`);
    if (this.options.title) this.parts.push(`<title>${esc(this.options.title)}</title>`);
  }

  geometry(cmds: DrawCommand[]): void {
    // Render low-z first (background) -> produce in ascending z.
    const ordered = [...cmds].sort((a, b) => a.z - b.z);
    for (const c of ordered) {
      this.emitPrimitive(c.primitive);
    }
  }

  sim(cmds: SimCommand[]): void {
    const ordered = [...cmds].sort((a, b) => a.z - b.z);
    for (const c of ordered) this.emitSim(c.primitive);
  }

  end(): string {
    this.parts.push('</svg>');
    return this.parts.join('\n');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private emitPrimitive(p: any): void {
    if (p.kind === 'circle') {
      this.parts.push(`<circle cx="${p.sx.toFixed(2)}" cy="${p.sy.toFixed(2)}" r="${p.r.toFixed(2)}"` +
        this.attr(p) + `/>`);
    } else if (p.kind === 'poly') {
      const pts = p.points.map(([x, y]: number[]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
      this.parts.push(`<polygon points="${pts}"` + this.attr(p) + `/>`);
    } else if (p.kind === 'rect') {
      this.parts.push(`<rect x="${p.sx.toFixed(2)}" y="${p.sy.toFixed(2)}" width="${p.w.toFixed(2)}" height="${p.h.toFixed(2)}"` +
        this.attr(p) + `/>`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private attr(p: any): string {
    let a = '';
    if (p.fill) a += ` fill="${p.fill}"`;
    if (p.stroke) a += ` stroke="${p.stroke}"`;
    if (p.lineWidth && p.lineWidth !== 1) a += ` stroke-width="${p.lineWidth.toFixed(2)}"`;
    return a;
  }

  private emitSim(p: any): void {
    if (p.kind === 'disc') {
      this.parts.push(`<circle cx="${p.sx.toFixed(2)}" cy="${p.sy.toFixed(2)}" r="${p.r.toFixed(2)}"` +
        ` fill="${p.fill}" stroke="${p.stroke || 'none'}" stroke-width="2"/>`);
      // Rotation indicator for discs (small notch) so rotation is visible.
      const nx = p.sx + Math.cos(p.angle) * p.r * 0.7;
      const ny = p.sy + Math.sin(p.angle) * p.r * 0.7;
      this.parts.push(`<circle cx="${nx.toFixed(2)}" cy="${ny.toFixed(2)}" r="${(p.r * 0.15).toFixed(2)}" fill="#ffffff" opacity="0.9"/>`);
      if (p.heavy) {
        this.parts.push(`<circle cx="${p.sx.toFixed(2)}" cy="${p.sy.toFixed(2)}" r="${(p.r * 1.15).toFixed(2)}" fill="none" stroke="#ffd700" stroke-width="2"/>`);
      }
    } else if (p.kind === 'deathCircle') {
      this.parts.push(`<circle cx="${p.sx.toFixed(2)}" cy="${p.sy.toFixed(2)}" r="${p.r.toFixed(2)}"` +
        ` fill="none" stroke="rgba(255,0,0,0.5)" stroke-width="2" stroke-dasharray="8 6"/>`);
    } else if (p.kind === 'grapple') {
      this.parts.push(`<line x1="${p.x1.toFixed(2)}" y1="${p.y1.toFixed(2)}" x2="${p.x2.toFixed(2)}" y2="${p.y2.toFixed(2)}" stroke="#cccccc" stroke-width="2"/>`);
    }
  }
}

/**
 * One-shot: render a full (geometry + one sim snapshot) frame to SVG. Useful
 * for tests and the CLI preview.
 */
export function renderFrameSvg(geometryCmds: DrawCommand[], simCmds: SimCommand[], opts: SvgRasterizerOptions): string {
  const r = new SvgRasterizer(opts);
  r.begin();
  r.geometry(geometryCmds);
  r.sim(simCmds);
  return r.end();
}

export { Camera };