import { describe, it, expect } from 'vitest';
import { parseIntArg, parseArgs } from '../../src/render/preview-shared';

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
});