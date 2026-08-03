import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, getConfig, resetConfig, getDefaults, deepMerge } from '../../src/config/config-loader';

describe('Config injection resilience', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('returns valid defaults with no config.json', () => {
    const config = getConfig();
    expect(config.server.port).toBe(5555);
    expect(config.physics.ticksPerSecond).toBe(30);
    expect(config.player.radius).toBe(0.4);
    expect(config.telemetry.enabled).toBe(false);
  });

  it('resetConfig returns fresh defaults', () => {
    const first = getConfig();
    const port = first.server.port;
    resetConfig();
    const second = getConfig();
    expect(second.server.port).toBe(port);
    expect(second).toEqual(first);
  });

  it('deep partial config merges correctly via production deepMerge', () => {
    const defaults = getDefaults();
    const partial = {
      server: { port: 9999 },
      physics: { gravityY: 20 },
    };
    const merged = deepMerge(defaults, partial);
    expect(merged.server.port).toBe(9999);
    expect(merged.server.bindAddress).toBe('127.0.0.1');
    expect(merged.physics.gravityY).toBe(20);
    expect(merged.physics.ticksPerSecond).toBe(30);
  });

  it('does not pollute Object.prototype via __proto__', () => {
    const malicious = { __proto__: { polluted: true } } as any;
    const defaults = getDefaults();
    const merged = deepMerge(defaults, malicious);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);
    // The dangerous key is dropped, not merged into the result.
    expect(merged).not.toHaveProperty('__proto__');
  });

  it('does not pollute Object.prototype via constructor.prototype', () => {
    const malicious = { constructor: { prototype: { polluted: true } } } as any;
    const defaults = getDefaults();
    const merged = deepMerge(defaults, malicious);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);
    expect(merged).not.toHaveProperty('constructor');
  });

  it('does not pollute via a top-level prototype key', () => {
    const malicious = { prototype: { polluted: true } } as any;
    const defaults = getDefaults();
    const merged = deepMerge(defaults, malicious);
    expect(({} as any).polluted).toBeUndefined();
    expect(merged).not.toHaveProperty('prototype');
  });

  it('nested __proto__ in a sub-object is also stripped', () => {
    const malicious = {
      server: { __proto__: { nested: true } },
    } as any;
    const defaults = getDefaults();
    const merged = deepMerge(defaults, malicious);
    expect(({} as any).nested).toBeUndefined();
    expect(merged.server).not.toHaveProperty('__proto__');
  });

  it('deepMerge preserves real nested overrides while stripping dangerous keys', () => {
    const defaults = getDefaults();
    const override = {
      server: { port: 1234, __proto__: { bad: true } },
    } as any;
    const merged = deepMerge(defaults, override);
    expect(merged.server.port).toBe(1234);
    expect(({} as any).bad).toBeUndefined();
  });
});
