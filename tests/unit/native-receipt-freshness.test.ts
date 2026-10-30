import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const RECEIPTS_DIR = path.join(ROOT, 'validation', 'native');

/** Canonical receipts whose provenance must cover current sources. Each
 * entry maps a receipt file to the provenance field -> on-disk source file
 * it pins. A receipt is stale when any recorded hash differs from the
 * current disk hash; that means the "pass" evidence no longer describes the
 * code that would run today. */
const PINNED_RECEIPTS: ReadonlyArray<{ receipt: string; pins: Record<string, string> }> = [
  {
    receipt: 'native-mode-all-final-v6.json',
    pins: { localClassicPhysicsSha256: 'src/core/classic-physics.ts' },
  },
  {
    receipt: 'native-mode-football-final-v7.json',
    pins: { localFootballPhysicsSha256: 'src/core/football-physics.ts' },
  },
  {
    receipt: 'native-mode-environment-final-v8.json',
    pins: {
      environmentSha256: 'src/core/environment.ts',
      nativeMapSessionSha256: 'src/core/native-map-session.ts',
      nativeModeSessionSha256: 'src/core/native-mode-session.ts',
    },
  },
  {
    receipt: 'native-environment-final-v6.json',
    pins: { environmentSha256: 'src/core/environment.ts' },
  },
  {
    receipt: 'native-mode-dynamic-map-v4.json',
    pins: {
      environmentSha256: 'src/core/environment.ts',
      nativeMapSessionSha256: 'src/core/native-map-session.ts',
      nativeSessionSha256: 'src/core/native-session.ts',
      nativeModeSessionSha256: 'src/core/native-mode-session.ts',
      nativeClassicWorldSha256: 'src/core/native-classic-world.ts',
    },
  },
  {
    receipt: 'native-lpj-lsj-v3.json',
    pins: {
      nativeMapStateSha256: 'src/core/native-map-state.ts',
      nativeWorldSha256: 'src/core/native-world.ts',
    },
  },
];

const digest = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('native differential receipt freshness gate', () => {
  it('keeps the pinned receipt set explicit', () => {
    expect(PINNED_RECEIPTS.map((entry) => entry.receipt)).toEqual([
      'native-mode-all-final-v6.json',
      'native-mode-football-final-v7.json',
      'native-mode-environment-final-v8.json',
      'native-environment-final-v6.json',
      'native-mode-dynamic-map-v4.json',
      'native-lpj-lsj-v3.json',
    ]);
  });

  it('every pinned receipt exists and is a passing receipt', () => {
    for (const { receipt } of PINNED_RECEIPTS) {
      const file = path.join(RECEIPTS_DIR, receipt);
      expect(fs.existsSync(file), `${receipt} must exist on disk`).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(parsed.pass, `${receipt} must record pass: true`).toBe(true);
    }
  });

  it.runIf(fs.existsSync(path.join(ROOT, 'src', 'core', 'environment.ts')))(
    'every pinned receipt provenance hash matches the current source on disk',
    () => {
      const stale: string[] = [];
      for (const { receipt, pins } of PINNED_RECEIPTS) {
        const file = path.join(RECEIPTS_DIR, receipt);
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          provenance?: Record<string, string>;
        };
        expect(parsed.provenance, `${receipt} must record provenance`).toBeDefined();
        for (const [field, source] of Object.entries(pins)) {
          const recorded = parsed.provenance![field];
          expect(recorded, `${receipt}.${field} must be recorded`).toBeDefined();
          const onDisk = digest(path.join(ROOT, source));
          if (recorded !== onDisk) {
            stale.push(
              `${receipt}: ${field} records ${recorded?.slice(0, 12)}… but ${source} on disk is ${onDisk.slice(0, 12)}…`,
            );
          }
        }
      }
      // A stale receipt means the recorded native-parity evidence predates
      // the current code: re-run the comparator and regenerate the receipt
      // before trusting or publishing the pass claim.
      expect(
        stale,
        `Stale native differential receipts (re-run the comparator to regenerate):\n${stale.join('\n')}`,
      ).toEqual([]);
    },
  );
});
