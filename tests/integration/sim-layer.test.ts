import { describe, it, expect } from 'vitest';
import { buildSim, SimSnapshot } from '../../src/render/sim-layer';
import { computeCamera, OUT_OF_BOUNDS_RADIUS } from '../../src/render/render-math';

function snap(discs: Array<Partial<any>>, tick = 10): SimSnapshot {
  return {
    tick,
    discs: discs.map((d, i) => ({
      id: d.id ?? i,
      x: d.x ?? 0,
      y: d.y ?? 0,
      angle: d.angle ?? 0,
      isHeavy: d.isHeavy ?? false,
      alive: d.alive ?? true,
      color: d.color,
    })),
    deathCenter: { x: 0, y: 0 },
  };
}

describe('sim-layer (M3)', () => {
  const cam = computeCamera(730, 500, 12); // scale 0.4, offset 365/250

  it('renders a death circle around the map origin at 850 units', () => {
    const cmds = buildSim(snap([{ alive: true }]), cam);
    const dc = cmds.find(c => c.primitive.kind === 'deathCircle')!;
    const p = dc.primitive as any;
    expect(p.sx).toBeCloseTo(365);
    expect(p.sy).toBeCloseTo(250);
    expect(p.r).toBeCloseTo(OUT_OF_BOUNDS_RADIUS * 0.4);
  });

  it('maps an alive disc to its screen position with ppm radius', () => {
    const cmds = buildSim(snap([{ x: 30, y: 0 }]), cam);
    const disc = cmds.find(c => c.primitive.kind === 'disc') as any;
    expect(disc).toBeDefined();
    expect(disc.primitive.sx).toBeCloseTo(365 + 30 * 0.4);
    expect(disc.primitive.sy).toBeCloseTo(250);
    expect(disc.primitive.r).toBeCloseTo(12 * 0.4); // ppm 12 * scale
  });

  it('skips dead discs but still emits the death circle', () => {
    const cmds = buildSim(snap([{ alive: false }]), cam);
    const discs = cmds.filter(c => c.primitive.kind === 'disc');
    expect(discs).toHaveLength(0);
    expect(cmds.some(c => c.primitive.kind === 'deathCircle')).toBe(true);
  });

  it('marks heavy discs with a gold stroke', () => {
    const cmds = buildSim(snap([{ isHeavy: true }]), cam);
    const disc = cmds.find(c => c.primitive.kind === 'disc') as any;
    expect(disc.primitive.stroke).toBe('#ffd700');
  });

  it('applies per-id palette colors', () => {
    const cmds = buildSim(snap([{ id: 0 }, { id: 1 }]), cam);
    const discs = cmds.filter(c => c.primitive.kind === 'disc') as any[];
    expect(discs[0].primitive.fill).not.toBe(discs[1].primitive.fill);
  });

  it('death circle follows a non-origin map center', () => {
    const cmds = buildSim({ tick: 1, discs: [], deathCenter: { x: 100, y: 50 } }, cam);
    const dc = cmds.find(c => c.primitive.kind === 'deathCircle') as any;
    expect(dc.primitive.sx).toBeCloseTo(365 + 100 * 0.4);
    expect(dc.primitive.sy).toBeCloseTo(250 + 50 * 0.4);
  });
});