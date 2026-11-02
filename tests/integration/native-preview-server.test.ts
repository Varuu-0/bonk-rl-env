import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { loadNativeMapForRender } from '../../src/render/native-map-geometry';
import { nativePreviewHtml, nativePreviewPayload } from '../../src/render/native-preview-server';
import { parsePairArgs } from '../../src/render/preview-shared';

const MAP = path.join(process.cwd(), 'maps/native-render-fixture.json');

describe('native interactive preview', () => {
  it('serves native data and clickable fixture selectors', () => {
    const payload = nativePreviewPayload(MAP, loadNativeMapForRender(MAP));
    expect(payload.filename).toBe('native-render-fixture.json');
    expect(payload.bodies.filter(Boolean)).toHaveLength(4);
    expect(payload.fixtures.filter(Boolean)).toHaveLength(5);
    expect(payload.joints).toHaveLength(1);
    expect(payload.svg).toContain('data-fixture="1"');
    expect(payload.svg).toContain('data-body="1"');
  });

  it('builds a self-contained interactive page without remote dependencies', () => {
    const html = nativePreviewHtml(nativePreviewPayload(MAP, loadNativeMapForRender(MAP)));
    expect(html).toContain('Native map inspector');
    expect(html).toContain("viewport.addEventListener('wheel'");
    expect(html).toContain("svg.addEventListener('pointerdown'");
    expect(html).toContain('data-layer="spawns"');
    expect(html).toContain('data-layer="capture-zones"');
    expect(html).toContain('data-layer="joints"');
    expect(html).not.toMatch(/(?:src|href)="https?:/);
  });

  it('accepts both pairwise and equals-form CLI options', () => {
    expect(parsePairArgs(['--map', 'a b.json', '--port', '8081'])).toEqual({ map: 'a b.json', port: '8081' });
    expect(parsePairArgs(['--map=a b.json', '--port=8081'])).toEqual({ map: 'a b.json', port: '8081' });
  });

  it('escapes map data that could close the embedded script', () => {
    const payload = nativePreviewPayload(MAP, loadNativeMapForRender(MAP));
    payload.fixtures[0] = { index: 0, n: '</script><script>alert(1)</script>' };
    const html = nativePreviewHtml(payload);
    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).toContain('\\u003c/script>');
  });
});
