/**
 * config-errors.test.ts — Error-path tests for config-loader
 *
 * These tests use getDefaults() and loadConfig() with isolated test directories
 * to avoid env var pollution from other test files.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, resetConfig, getDefaults } from '../../src/config/config-loader';

describe('config-loader error paths', () => {
  const testDir = path.join(__dirname, '..', 'fixtures', 'config-test');
  const configPath = path.join(testDir, 'config.json');

  beforeEach(() => {
    resetConfig();
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  });

  afterEach(() => {
    resetConfig();
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  });

  describe('missing config.json', () => {
    it('falls back to defaults when no config file exists', () => {
      const config = loadConfig(testDir);
      const defaults = getDefaults();
      expect(config.server.port).toBe(defaults.server.port);
      expect(config.physics.ticksPerSecond).toBe(defaults.physics.ticksPerSecond);
      expect(config.telemetry.enabled).toBe(defaults.telemetry.enabled);
    });
  });

  describe('malformed config.json', () => {
    it('falls back to defaults when JSON is unparseable', () => {
      fs.writeFileSync(configPath, '{ not valid json !!! }');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = loadConfig(testDir);
      warnSpy.mockRestore();
      const defaults = getDefaults();
      expect(config.server.port).toBe(defaults.server.port);
    });

    it('falls back to defaults when config is not an object', () => {
      fs.writeFileSync(configPath, '"just a string"');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = loadConfig(testDir);
      warnSpy.mockRestore();
      const defaults = getDefaults();
      expect(config.server.port).toBe(defaults.server.port);
    });
  });

  describe('empty config.json', () => {
    it('falls back to defaults when config is an empty object', () => {
      fs.writeFileSync(configPath, '{}');
      const config = loadConfig(testDir);
      const defaults = getDefaults();
      expect(config.server.port).toBe(defaults.server.port);
      expect(config.physics.ticksPerSecond).toBe(defaults.physics.ticksPerSecond);
    });
  });

  describe('partial config.json', () => {
    it('deep-merges with defaults', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        server: { port: 1111 },
        environment: { seed: 42 },
      }));
      const config = loadConfig(testDir);
      const defaults = getDefaults();
      expect(config.server.port).toBe(1111);
      expect(config.environment.seed).toBe(42);
      expect(config.physics.ticksPerSecond).toBe(defaults.physics.ticksPerSecond);
    });

    it('deep-merges nested objects without overwriting siblings', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        server: { port: 9999 },
      }));
      const config = loadConfig(testDir);
      const defaults = getDefaults();
      expect(config.server.port).toBe(9999);
      expect(config.server.bindAddress).toBe(defaults.server.bindAddress);
    });
  });

  describe('resetConfig', () => {
    it('clears the cached config', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        server: { port: 1111 },
      }));
      const first = loadConfig(testDir);
      expect(first.server.port).toBe(1111);
      resetConfig();
      const second = loadConfig(testDir);
      expect(second.server.port).toBe(1111);
    });

    it('reloads fresh after reset', () => {
      fs.writeFileSync(configPath, JSON.stringify({
        server: { port: 2222 },
      }));
      loadConfig(testDir);
      resetConfig();
      const config = loadConfig(testDir);
      expect(config.server.port).toBe(2222);
    });
  });
});
