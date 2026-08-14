import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  parseIntArg,
  parsePositiveIntArg,
  parseArgs,
  listPreviewMaps,
  parseMapSelection,
  selectPreviewMap,
} from '../../src/render/preview-shared';

describe('render-preview CLI arg parsing', () => {
  it('parseArgs maps pairwise --key value pairs and strips the dashes', () => {
    expect(parseArgs(['--map', 'a.json', '--ticks', '60', '--port', '8080'])).toEqual({
      map: 'a.json',
      ticks: '60',
      port: '8080',
    });
  });

  it('parseIntArg falls back when absent and floors on floats', () => {
    expect(parseIntArg(undefined, 7, 'x')).toBe(7);
    expect(parseIntArg('', 7, 'x')).toBe(7);
    expect(parseIntArg('3.9', 7, 'x')).toBe(3);
  });

  it('parseIntArg rejects negative or non-numeric values', () => {
    expect(() => parseIntArg('-1', 7, 'ticks')).toThrow(/expected a non-negative number/);
    expect(() => parseIntArg('abc', 7, 'ticks')).toThrow(/expected a non-negative number/);
  });

  it('parsePositiveIntArg rejects zero after integer normalization', () => {
    expect(() => parsePositiveIntArg('0', 30, 'fps')).toThrow(/expected a positive number/);
    expect(() => parsePositiveIntArg('0.9', 30, 'fps')).toThrow(/expected a positive number/);
    expect(parsePositiveIntArg('30.9', 30, 'fps')).toBe(30);
  });
});

describe('render-preview map selection', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-maps-'));
  const mapDir = path.join(tmp, 'maps');
  fs.mkdirSync(mapDir);
  const explicit = path.join(mapDir, 'zeta_map.json');
  fs.writeFileSync(explicit, '{}');
  fs.writeFileSync(path.join(mapDir, 'Alpha_Map.JSON'), '{}');
  fs.writeFileSync(path.join(mapDir, 'notes.txt'), 'x');

  it('listPreviewMaps returns sorted json basenames only', () => {
    expect(listPreviewMaps(mapDir)).toEqual(['Alpha_Map.JSON', 'zeta_map.json']);
    expect(listPreviewMaps(path.join(tmp, 'nope'))).toEqual([]);
  });

  it('parseMapSelection validates the menu answer', () => {
    expect(parseMapSelection('', 3)).toBe(0);
    expect(parseMapSelection(' 2 ', 3)).toBe(1);
    expect(parseMapSelection('3', 3)).toBe(2);
    expect(parseMapSelection('0', 3)).toBe(-1);
    expect(parseMapSelection('4', 3)).toBe(-1);
    expect(parseMapSelection('abc', 3)).toBe(-1);
    expect(parseMapSelection('1.5', 3)).toBe(-1);
  });

  it('selectPreviewMap honors an explicit --map', async () => {
    await expect(selectPreviewMap(explicit, mapDir)).resolves.toBe(explicit);
  });

  it('selectPreviewMap falls back to a default map when not interactive', async () => {
    const resolved = await selectPreviewMap(undefined, mapDir, false);
    expect(fs.existsSync(resolved)).toBe(true);
    expect(resolved).toMatch(/\.json$/);
  });
});
