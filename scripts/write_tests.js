const fs = require('fs');
const path = 'C:/Users/varun/Desktop/Projects/bonk-rl-env/tests/unit/profiler.test.ts';

const content = `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  globalProfiler,
  wrap,
  TelemetryIndices,
  TelemetryBuffer,
  Profiler,
  setLatestWorkerTelemetry,
  startCollection,
  stopCollection,
} from '../../src/telemetry/profiler';

describe('Profiler', () => {
  beforeEach(() => {
    for (let i = 0; i < TelemetryBuffer.length; i++) {
      TelemetryBuffer[i] = BigInt(0);
    }
    globalProfiler.reset();
    setLatestWorkerTelemetry(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('TelemetryIndices', () => {
    it('has expected slots', () => {
      expect(TelemetryIndices.PHYSICS_TICK).toBe(0);
      expect(TelemetryIndices.RAYCAST_CALL).toBe(1);
      expect(TelemetryIndices.COLLISION_RESOLVE).toBe(2);
      expect(TelemetryIndices.ZMQ_SEND).toBe(3);
      expect(TelemetryIndices.JSON_PARSE).toBe(4);
    });
  });

  describe('TelemetryBuffer', () => {
    it('is a BigUint64Array of correct length', () => {
      expect(TelemetryBuffer).toBeInstanceOf(BigUint64Array);
      expect(TelemetryBuffer.length).toBe(5);
    });

    it('supports bigint writes', () => {
      TelemetryBuffer[0] = BigInt(12345);
      expect(TelemetryBuffer[0]).toBe(BigInt(12345));
    });
  });

  describe('wrap function', () => {
    it('records timing for sync function', () => {
      const fn = () => { let s = 0; for (let i = 0; i < 100; i++) s += i; return s; };
      const wrapped = wrap(TelemetryIndices.PHYSICS_TICK, fn);
      const result = wrapped();
      expect(result).toBe(4950);
      expect(TelemetryBuffer[TelemetryIndices.PHYSICS_TICK]).toBeGreaterThan(BigInt(0));
    });

    it('records timing even when sync function throws', () => {
      const fn = () => { throw new Error('boom'); };
      const wrapped = wrap(TelemetryIndices.PHYSICS_TICK, fn);
      expect(() => wrapped()).toThrow('boom');
      expect(TelemetryBuffer[TelemetryIndices.PHYSICS_TICK]).toBeGreaterThan(BigInt(0));
    });

    it('records timing for async function', async () => {
      const fn = async () => { await new Promise(r => setTimeout(r, 1)); return 'done'; };
      const wrapped = wrap(TelemetryIndices.ZMQ_SEND, fn);
      const result = await wrapped();
      expect(result).toBe('done');
      expect(TelemetryBuffer[TelemetryIndices.ZMQ_SEND]).toBeGreaterThan(BigInt(0));
    });

    it('records timing even when async function rejects', async () => {
      const fn = async () => { throw new Error('async boom'); };
      const wrapped = wrap(TelemetryIndices.ZMQ_SEND, fn);
      await expect(wrapped()).rejects.toThrow('async boom');
      expect(TelemetryBuffer[TelemetryIndices.ZMQ_SEND]).toBeGreaterThan(BigInt(0));
    });

    it('throws on unknown string label', () => {
      expect(() => wrap('NONEXISTENT' as any, () => {})).toThrow('Unknown telemetry label: NONEXISTENT');
    });

    it('accepts string label that exists', () => {
      const fn = () => 42;
      const wrapped = wrap('PHYSICS_TICK', fn);
      const result = wrapped();
      expect(result).toBe(42);
      expect(TelemetryBuffer[TelemetryIndices.PHYSICS_TICK]).toBeGreaterThan(BigInt(0));
    });

    it('accumulates timing across multiple calls', () => {
      const fn = () => { for (let i = 0; i < 50; i++) {} };
      const wrapped = wrap(TelemetryIndices.COLLISION_RESOLVE, fn);
      const before = TelemetryBuffer[TelemetryIndices.COLLISION_RESOLVE];
      wrapped();
      wrapped();
      const after = TelemetryBuffer[TelemetryIndices.COLLISION_RESOLVE];
      expect(after - before).toBeGreaterThan(BigInt(0));
    });

    it('preserves this context', () => {
      const obj = { value: 42, getValue() { return this.value; } };
      const wrapped = wrap(TelemetryIndices.PHYSICS_TICK, obj.getValue);
      expect(wrapped.call(obj)).toBe(42);
    });

    it('passes arguments through', () => {
      const fn = (a: number, b: number) => a + b;
      const wrapped = wrap(TelemetryIndices.PHYSICS_TICK, fn);
      expect(wrapped(3, 4)).toBe(7);
    });

    it('passes arguments through for async functions', async () => {
      const fn = async (a: number, b: number) => a * b;
      const wrapped = wrap(TelemetryIndices.ZMQ_SEND, fn);
      const result = await wrapped(3, 4);
      expect(result).toBe(12);
    });
  });

  describe('globalProfiler', () => {
    describe('tick', () => {
      it('increments currentTick', () => {
        const before = (globalProfiler as any).currentTick;
        globalProfiler.tick();
        expect((globalProfiler as any).currentTick).toBe(before + 1);
      });
    });

    describe('start / end', () => {
      it('records timing for a labeled block', () => {
        globalProfiler.start('my-operation');
        globalProfiler.end('my-operation');
        const metric = (globalProfiler as any).timeMetrics.get('my-operation');
        expect(metric).toBeDefined();
        expect(metric.totalNs).toBeGreaterThan(BigInt(0));
        expect(metric.count).toBe(1);
      });

      it('accumulates multiple start/end calls', () => {
        globalProfiler.start('loop');
        globalProfiler.end('loop');
        globalProfiler.start('loop');
        globalProfiler.end('loop');
        const metric = (globalProfiler as any).timeMetrics.get('loop');
        expect(metric.count).toBe(2);
      });

      it('silently ignores end without start', () => {
        expect(() => globalProfiler.end('nonexistent')).not.toThrow();
      });
    });

    describe('increment', () => {
      it('increments counter by 1 by default', () => {
        globalProfiler.increment('hits');
        expect((globalProfiler as any).counters.get('hits')).toBe(1);
      });

      it('increments counter by specified amount', () => {
        globalProfiler.increment('hits', 5);
        expect((globalProfiler as any).counters.get('hits')).toBe(5);
      });

      it('accumulates across calls', () => {
        globalProfiler.increment('hits', 3);
        globalProfiler.increment('hits', 2);
        expect((globalProfiler as any).counters.get('hits')).toBe(5);
      });
    });

    describe('gauge', () => {
      it('sets a gauge value', () => {
        globalProfiler.gauge('temperature', 72.5);
        expect((globalProfiler as any).gauges.get('temperature')).toBe(72.5);
      });

      it('overwrites previous value', () => {
        globalProfiler.gauge('temperature', 72);
        globalProfiler.gauge('temperature', 85);
        expect((globalProfiler as any).gauges.get('temperature')).toBe(85);
      });
    });

    describe('recordMemory', () => {
      it('records heapUsed and rss gauges', () => {
        globalProfiler.recordMemory();
        expect((globalProfiler as any).gauges.has('Memory (Heap Used MB)')).toBe(true);
        expect((globalProfiler as any).gauges.has('Memory (RSS MB)')).toBe(true);
      });

      it('records positive values', () => {
        globalProfiler.recordMemory();
        const heapUsed = (globalProfiler as any).gauges.get('Memory (Heap Used MB)');
        const rss = (globalProfiler as any).gauges.get('Memory (RSS MB)');
        expect(heapUsed).toBeGreaterThan(0);
        expect(rss).toBeGreaterThan(0);
      });
    });

    describe('getSnapshot', () => {
      it('returns a snapshot with all metric types', () => {
        globalProfiler.increment('hits', 5);
        globalProfiler.gauge('temp', 72);
        globalProfiler.start('op');
        globalProfiler.end('op');
        TelemetryBuffer[0] = BigInt(123);
        globalProfiler.tick();
        const snapshot = globalProfiler.getSnapshot();
        expect(snapshot.counters.get('hits')).toBe(5);
        expect(snapshot.gauges.get('temp')).toBe(72);
        expect(snapshot.timeMetrics.has('op')).toBe(true);
        expect(snapshot.telemetryBuffer[0]).toBe(BigInt(123));
        expect(snapshot.currentTick).toBeGreaterThanOrEqual(1);
      });

      it('returns a copy of telemetryBuffer', () => {
        TelemetryBuffer[0] = BigInt(456);
        const snapshot = globalProfiler.getSnapshot();
        expect(snapshot.telemetryBuffer[0]).toBe(BigInt(456));
        snapshot.telemetryBuffer[0] = BigInt(0);
        expect(TelemetryBuffer[0]).toBe(BigInt(456));
      });

      it('returns copies of maps that are independent', () => {
        globalProfiler.increment('x', 1);
        const snapshot = globalProfiler.getSnapshot();
        snapshot.counters.delete('x');
        expect((globalProfiler as any).counters.has('x')).toBe(true);
      });
    });

    describe('formatReport', () => {
      it('returns a string with telemetry labels', () => {
        TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(1_000_000);
        const report = globalProfiler.formatReport();
        expect(report).toContain('PHYSICS_TICK');
        expect(report).toContain('1.000');
      });

      it('includes multiple non-zero entries', () => {
        TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(1_000_000);
        TelemetryBuffer[TelemetryIndices.COLLISION_RESOLVE] = BigInt(500_000);
        const report = globalProfiler.formatReport();
        expect(report).toContain('PHYSICS_TICK');
        expect(report).toContain('COLLISION_RESOLVE');
      });

      it('includes counters section', () => {
        globalProfiler.increment('events', 42);
        const report = globalProfiler.formatReport();
        expect(report).toContain('Counters');
        expect(report).toContain('events');
        expect(report).toContain('42');
      });

      it('includes gauges section', () => {
        globalProfiler.gauge('fps', 60);
        const report = globalProfiler.formatReport();
        expect(report).toContain('Gauges');
        expect(report).toContain('fps');
      });

      it('handles all zeros gracefully', () => {
        globalProfiler.reset();
        const report = globalProfiler.formatReport();
        expect(typeof report).toBe('string');
        expect(report).toContain('Telemetry Report');
      });
    });

    describe('startCollection / stopCollection', () => {
      it('starts and stops collection without error', () => {
        vi.useFakeTimers();
        startCollection(50);
        vi.advanceTimersByTime(100);
        stopCollection();
        vi.useRealTimers();
      });

      it('records memory during collection', () => {
        vi.useFakeTimers();
        globalProfiler.reset();
        startCollection(50);
        vi.advanceTimersByTime(100);
        stopCollection();
        expect((globalProfiler as any).gauges.has('Memory (Heap Used MB)')).toBe(true);
        vi.useRealTimers();
      });

      it('stopCollection is safe when not collecting', () => {
        expect(() => stopCollection()).not.toThrow();
      });

      it('can be restarted after stopping', () => {
        vi.useFakeTimers();
        globalProfiler.reset();
        startCollection(50);
        vi.advanceTimersByTime(100);
        stopCollection();
        startCollection(50);
        vi.advanceTimersByTime(100);
        stopCollection();
        vi.useRealTimers();
      });
    });

    describe('getAndResetMetrics', () => {
      it('returns metrics and resets internal state', () => {
        globalProfiler.reset();
        globalProfiler.increment('events', 10);
        globalProfiler.gauge('fps', 60);
        globalProfiler.start('op');
        globalProfiler.end('op');
        const metrics = globalProfiler.getAndResetMetrics();
        expect(metrics.counters.length).toBeGreaterThanOrEqual(1);
        expect(metrics.gauges.length).toBeGreaterThanOrEqual(1);
        expect(metrics.timeMetrics.length).toBeGreaterThanOrEqual(1);
        const snapshot2 = globalProfiler.getAndResetMetrics();
        expect(snapshot2.counters.length).toBe(0);
        expect(snapshot2.gauges.length).toBe(0);
        expect(snapshot2.timeMetrics.length).toBe(0);
      });

      it('resets TelemetryBuffer as well', () => {
        TelemetryBuffer[0] = BigInt(999);
        globalProfiler.getAndResetMetrics();
        expect(TelemetryBuffer[0]).toBe(BigInt(0));
      });
    });

    describe('reset', () => {
      it('zeros the TelemetryBuffer', () => {
        TelemetryBuffer[0] = BigInt(999);
        globalProfiler.reset();
        expect(TelemetryBuffer[0]).toBe(BigInt(0));
      });

      it('clears timeMetrics', () => {
        globalProfiler.start('op');
        globalProfiler.end('op');
        globalProfiler.reset();
        expect((globalProfiler as any).timeMetrics.size).toBe(0);
      });

      it('clears counters', () => {
        globalProfiler.increment('hits');
        globalProfiler.reset();
        expect((globalProfiler as any).counters.size).toBe(0);
      });

      it('does not clear gauges', () => {
        globalProfiler.gauge('temp', 72);
        globalProfiler.reset();
        expect((globalProfiler as any).gauges.size).toBeGreaterThan(0);
      });

      it('updates startTick to currentTick', () => {
        globalProfiler.tick();
        globalProfiler.tick();
        globalProfiler.tick();
        globalProfiler.reset();
        expect((globalProfiler as any).startTick).toBe((globalProfiler as any).currentTick);
      });
    });

    describe('report', () => {
      it('does not report before windowSize is reached', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        globalProfiler.tick();
        globalProfiler.report(5000);
        expect(logSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
      });

      it('reports when windowSize is reached', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        for (let i = 0; i < 5000; i++) {
          globalProfiler.tick();
        }
        TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(100_000_000);
        globalProfiler.report(5000);
        expect(logSpy).toHaveBeenCalled();
        logSpy.mockRestore();
      });

      it('skips zero counters in report', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        for (let i = 0; i < 5001; i++) globalProfiler.tick();
        globalProfiler.report(5000);
        const output = logSpy.mock.calls.map(c => c[0]).join('\\n');
        expect(output).not.toContain('PHYSICS_TICK');
        logSpy.mockRestore();
      });

      it('highlights critical path when >25% of frame budget', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        for (let i = 0; i < 5000; i++) {
          globalProfiler.tick();
        }
        TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(500_000_000_000);
        globalProfiler.report(5000);
        const output = logSpy.mock.calls.map(c => c[0]).join('\\n');
        expect(output).toContain('CRITICAL');
        logSpy.mockRestore();
      });

      it('outputs worker telemetry when available', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const workerBuf = new BigUint64Array(5);
        workerBuf[0] = BigInt(50_000_000);
        setLatestWorkerTelemetry([workerBuf]);
        for (let i = 0; i < 5001; i++) globalProfiler.tick();
        TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(100_000_000);
        globalProfiler.report(5000);
        const output = logSpy.mock.calls.map(c => c[0]).join('\\n');
        expect(output).toContain('Global Worker Telemetry');
        logSpy.mockRestore();
      });

      it('outputs straggler report for physics tick', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const workerBuf1 = new BigUint64Array(5);
        workerBuf1[0] = BigInt(10_000_000);
        const workerBuf2 = new BigUint64Array(5);
        workerBuf2[0] = BigInt(90_000_000);
        setLatestWorkerTelemetry([workerBuf1, workerBuf2]);
        for (let i = 0; i < 5001; i++) globalProfiler.tick();
        TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(100_000_000);
        globalProfiler.report(5000);
        const output = logSpy.mock.calls.map(c => c[0]).join('\\n');
        expect(output).toContain('Straggler Report');
        logSpy.mockRestore();
      });

      it('outputs legacy counters when present', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
        globalProfiler.increment('hits', 10);
        for (let i = 0; i < 5001; i++) globalProfiler.tick();
        globalProfiler.report(5000);
        expect(tableSpy).toHaveBeenCalled();
        logSpy.mockRestore();
        tableSpy.mockRestore();
      });

      it('outputs legacy gauges when present', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
        globalProfiler.gauge('mem', 50);
        for (let i = 0; i < 5001; i++) globalProfiler.tick();
        globalProfiler.report(5000);
        expect(tableSpy).toHaveBeenCalled();
        logSpy.mockRestore();
        tableSpy.mockRestore();
      });

      it('resets after reporting', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        for (let i = 0; i < 5001; i++) globalProfiler.tick();
        TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(100_000_000);
        globalProfiler.report(5000);
        expect(TelemetryBuffer[TelemetryIndices.PHYSICS_TICK]).toBe(BigInt(0));
        logSpy.mockRestore();
      });

      it('uses default windowSize of 5000', () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        for (let i = 0; i < 5001; i++) globalProfiler.tick();
        TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] = BigInt(100_000_000);
        globalProfiler.report();
        expect(logSpy).toHaveBeenCalled();
        logSpy.mockRestore();
      });
    });
  });

  describe('Profiler class', () => {
    it('creates independent instances', () => {
      const p1 = new Profiler();
      const p2 = new Profiler();
      p1.increment('a', 1);
      p2.increment('b', 2);
      expect((p1 as any).counters.get('a')).toBe(1);
      expect((p1 as any).counters.get('b')).toBeUndefined();
      expect((p2 as any).counters.get('b')).toBe(2);
      expect((p2 as any).counters.get('a')).toBeUndefined();
    });

    it('starts with empty metrics', () => {
      const profiler = new Profiler();
      expect((profiler as any).timeMetrics.size).toBe(0);
      expect((profiler as any).counters.size).toBe(0);
      expect((profiler as any).gauges.size).toBe(0);
      expect((profiler as any).currentTick).toBe(0);
    });

    it('is independent from globalProfiler', () => {
      const profiler = new Profiler();
      const globalTickBefore = (globalProfiler as any).currentTick;
      profiler.tick();
      profiler.tick();
      expect((profiler as any).currentTick).toBe(2);
      expect((globalProfiler as any).currentTick).toBe(globalTickBefore);
    });
  });
});
`;

fs.writeFileSync(path, content, 'utf8');
console.log('File written successfully');
console.log('Lines:', content.split('\\n').length);
