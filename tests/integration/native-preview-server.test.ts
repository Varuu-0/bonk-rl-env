import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as http from 'http';
import { loadNativeMapForRender } from '../../src/render/native-map-geometry';
import {
  createNativePreviewServer,
  listNativePreviewMaps,
  nativePreviewHtml,
  nativePreviewPayload,
  resolveLibraryMap,
} from '../../src/render/native-preview-server';
import { parsePairArgs } from '../../src/render/preview-shared';

const MAP = path.join(process.cwd(), 'maps/native-render-fixture.json');
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

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
    expect(html).toContain("viewport.addEventListener('pointerdown'");
    expect(html).toContain('id="mapSelector"');
    expect(html).toContain("fetch('/api/maps')");
    expect(html).toContain('data-layer="spawns"');
    expect(html).toContain('data-layer="capture-zones"');
    expect(html).toContain('data-layer="joints"');
    expect(html).not.toMatch(/(?:src|href)="https?:/);
  });

  it('discovers maps and rejects paths outside the library', () => {
    const library = fs.mkdtempSync(path.join(os.tmpdir(), 'native-map-library-'));
    fs.copyFileSync(MAP, path.join(library, 'z map.json'));
    fs.copyFileSync(MAP, path.join(library, 'a.json'));
    fs.writeFileSync(path.join(library, 'ignored.txt'), 'not a map');
    expect(listNativePreviewMaps(library)).toEqual(['a.json', 'z map.json']);
    expect(resolveLibraryMap('z map.json', library)).toBe(path.join(library, 'z map.json'));
    for (const invalid of ['', '../secret.json', '/absolute.json', 'nested/map.json', 'map.txt'])
      expect(() => resolveLibraryMap(invalid, library)).toThrow();
    fs.rmSync(library, { recursive: true, force: true });
  });

  it('serves map selection, changed payloads, and explicit errors', async () => {
    const library = fs.mkdtempSync(path.join(os.tmpdir(), 'native-map-library-'));
    fs.copyFileSync(MAP, path.join(library, 'fixture.json'));
    const second = JSON.parse(fs.readFileSync(MAP, 'utf8'));
    second.m.a = 'Second map';
    fs.writeFileSync(path.join(library, 'second.json'), JSON.stringify(second));
    fs.writeFileSync(path.join(library, 'bad.json'), '{"not":"native"}');
    const server = createNativePreviewServer(MAP, library);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    expect(await (await fetch(`${base}/api/maps`)).json()).toEqual(['bad.json', 'fixture.json', 'second.json']);
    const changed = await (await fetch(`${base}/api/map?name=${encodeURIComponent('second.json')}`)).json();
    expect(changed.filename).toBe('second.json');
    expect(changed.svg).not.toBe(nativePreviewPayload(MAP, loadNativeMapForRender(MAP)).svg);
    expect((await fetch(`${base}/api/map?name=bad.json`)).status).toBe(400);
    expect((await fetch(`${base}/api/map?name=missing.json`)).status).toBe(404);
    const traversal = await fetch(`${base}/api/map?name=${encodeURIComponent('../secret.json')}`);
    expect(traversal.status).toBe(400);
    expect((await traversal.json()).error).toContain('filename');
    fs.rmSync(library, { recursive: true, force: true });
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
