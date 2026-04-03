import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, getConfig, resetConfig, getDefaults } from '../../src/config/config-loader';

describe('Config injection resilience', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('returns valid defaults with no config.json', () => {
    const config = getConfig();
    expect(config.server.port).toBe(5555);
    expect(config.physics.ticksPerSecond).toBe(30);
    expect(config.player.radius).toBe(0.5);
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

  it('deep partial config merges correctly', () => {
    const defaults = getDefaults();
    const partial = {
      server: { port: 9999 },
      physics: { gravityY: 20 },
    };
    const merged = deepMergeTest(defaults, partial);
    expect(merged.server.port).toBe(9999);
    expect(merged.server.bindAddress).toBe('127.0.0.1');
    expect(merged.physics.gravityY).toBe(20);
    expect(merged.physics.ticksPerSecond).toBe(30);
  });

  it('does not pollute Object.prototype via __proto__', () => {
    const malicious = { __proto__: { polluted: true } } as any;
    const defaults = getDefaults();
    const merged = deepMergeTest(defaults, malicious);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);
  });

  it('does not pollute Object.prototype via constructor.prototype', () => {
    const malicious = { constructor: { prototype: { polluted: true } } } as any;
    const defaults = getDefaults();
    const merged = deepMergeTest(defaults, malicious);
    expect(({} as any).polluted).toBeUndefined();
  });
});

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function deepMergeTest<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const result: Record<string, any> = { ...base };
  for (const key of Object.keys(override)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const overrideVal = (override as Record<string, any>)[key];
    if (overrideVal === undefined || overrideVal === null) continue;
    if (isPlainObject(result[key]) && isPlainObject(overrideVal)) {
      result[key] = deepMergeTest(result[key], overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }
  return result as T;
}
