const fs = require('fs');
const p = 'C:/Users/varun/Desktop/Projects/bonk-rl-env/tests/unit/profiler.test.ts';
let c = fs.readFileSync(p, 'utf8');

const insertAfter = `      });
    });

    describe('getAndResetMetrics', () => {`;

const newTests = `      });
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
        expect(snapshot.currentTick).toBe(1);
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

    describe('getAndResetMetrics', () => {`;

c = c.replace(insertAfter, newTests);
fs.writeFileSync(p, c, 'utf8');
console.log('done');
