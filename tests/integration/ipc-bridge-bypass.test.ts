/**
 * ipc-bridge-bypass.test.ts — Tests for IpcBridge bypass methods
 *
 * Tests the IpcBridge public API that bypasses ZMQ:
 * - initEnv(), resetEnv(), stepEnv(), close()
 * - getPort(), isClosed()
 * - Error handling for invalid inputs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IpcBridge } from '../../src/ipc/ipc-bridge';

describe('IpcBridge bypass API', () => {
  let bridge: IpcBridge;

  beforeEach(() => {
    bridge = new IpcBridge({ server: { port: 15560 } } as any);
  });

  afterEach(async () => {
    try { await bridge.close(); } catch { /* ignore */ }
  });

  describe('getPort and isClosed', () => {
    it('returns the configured port', () => {
      expect(bridge.getPort()).toBe(15560);
    });

    it('reports not closed initially', () => {
      expect(bridge.isClosed()).toBe(false);
    });

    it('reports closed after close', async () => {
      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
    });

    it('close is idempotent', async () => {
      await bridge.close();
      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
    });
  });

  describe('initEnv bypass', () => {
    it('initializes environments successfully', async () => {
      await bridge.initEnv(2, {}, false);
    });

    it('initializes with custom config', async () => {
      await bridge.initEnv(1, { seed: 42, maxTicks: 100 }, false);
    });

    it('initializes with shared memory when supported', async () => {
      if (IpcBridge.prototype.constructor.isSupported?.()) {
        await bridge.initEnv(2, {}, true);
      }
    });
  });

  describe('resetEnv bypass', () => {
    beforeEach(async () => {
      await bridge.initEnv(3, {}, false);
    });

    it('returns observations for all environments', async () => {
      const obs = await bridge.resetEnv([1, 2, 3]);
      expect(obs).toHaveLength(3);
    });

    it('each observation has required fields', async () => {
      const obs = await bridge.resetEnv([1, 2, 3]);
      for (const o of obs) {
        if (o !== null) {
          expect(o).toHaveProperty('playerX');
          expect(o).toHaveProperty('playerY');
          expect(o).toHaveProperty('playerVelX');
          expect(o).toHaveProperty('playerVelY');
          expect(o).toHaveProperty('playerAngle');
          expect(o).toHaveProperty('playerAngularVel');
          expect(o).toHaveProperty('playerIsHeavy');
          expect(o).toHaveProperty('opponents');
          expect(o).toHaveProperty('tick');
        }
      }
    });

    it('returns observations without seeds', async () => {
      const obs = await bridge.resetEnv();
      expect(obs).toHaveLength(3);
    });

    it('same seed produces same observation', async () => {
      const obs1 = await bridge.resetEnv([42, 42, 42]);
      const obs2 = await bridge.resetEnv([42, 42, 42]);
      expect(obs1).toEqual(obs2);
    });
  });

  describe('stepEnv bypass', () => {
    beforeEach(async () => {
      await bridge.initEnv(3, {}, false);
      await bridge.resetEnv([1, 2, 3]);
    });

    it('returns results for all environments', async () => {
      const results = await bridge.stepEnv([0, 0, 0]);
      expect(results).toHaveLength(3);
    });

    it('each result has required fields', async () => {
      const results = await bridge.stepEnv([0, 0, 0]);
      for (const r of results) {
        expect(r).toHaveProperty('observation');
        expect(r).toHaveProperty('reward');
        expect(r).toHaveProperty('done');
        expect(r).toHaveProperty('truncated');
        expect(r).toHaveProperty('info');
      }
    });

    it('rewards are finite numbers', async () => {
      const results = await bridge.stepEnv([0, 0, 0]);
      for (const r of results) {
        expect(Number.isFinite(r.reward)).toBe(true);
      }
    });

    it('done and truncated are booleans', async () => {
      const results = await bridge.stepEnv([0, 0, 0]);
      for (const r of results) {
        expect(typeof r.done).toBe('boolean');
        expect(typeof r.truncated).toBe('boolean');
      }
    });

    it('all valid actions (0-63) accepted', async () => {
      for (let action = 0; action <= 63; action++) {
        const results = await bridge.stepEnv([action, action, action]);
        expect(results).toHaveLength(3);
      }
    });

    it('multiple sequential steps work', async () => {
      for (let i = 0; i < 10; i++) {
        const results = await bridge.stepEnv([0, 0, 0]);
        expect(results).toHaveLength(3);
      }
    });

    it('reset between steps works', async () => {
      await bridge.stepEnv([0, 0, 0]);
      await bridge.resetEnv([1, 2, 3]);
      const results = await bridge.stepEnv([0, 0, 0]);
      expect(results).toHaveLength(3);
    });
  });

  describe('full lifecycle', () => {
    it('init -> reset -> step -> close works end-to-end', async () => {
      await bridge.initEnv(2, {}, false);
      const obs = await bridge.resetEnv([1, 2]);
      expect(obs).toHaveLength(2);
      const results = await bridge.stepEnv([0, 0]);
      expect(results).toHaveLength(2);
      await bridge.close();
      expect(bridge.isClosed()).toBe(true);
    });

    it('can reinitialize after close', async () => {
      await bridge.initEnv(2, {}, false);
      await bridge.close();
      bridge = new IpcBridge({ server: { port: 15561 } } as any);
      await bridge.initEnv(2, {}, false);
      await bridge.resetEnv([1, 2]);
      const results = await bridge.stepEnv([0, 0]);
      expect(results).toHaveLength(2);
      await bridge.close();
    });
  });
});
