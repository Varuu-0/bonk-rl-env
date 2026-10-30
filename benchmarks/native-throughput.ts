/**
 * Real raw-native Classic resident throughput. Construction, warmup, measured
 * stepping, explicit resets and close are timed separately. The default is a
 * smoke; large/sustained matrices require explicit flags.
 *
 * Example: npx tsx benchmarks/native-throughput.ts --envs 1,16 --workers 1,2
 *   --transports direct,message,shared --frame-skips 1,3 --steps 512
 */
import {
  runThroughputMain,
  DEFAULT_OPTIONS,
  runMetadata,
  writeReceiptNoOverwrite,
  parseOptions,
  type BenchmarkOptions,
} from './native-benchmark-lib';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

runThroughputMain(process.argv.slice(2)).catch((error) => {
  console.error(error);
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--out-dir');
  const outDir =
    outputIndex >= 0 && args[outputIndex + 1] ? path.resolve(args[outputIndex + 1]!) : DEFAULT_OPTIONS.outDir;
  let options: BenchmarkOptions | undefined;
  try {
    options = parseOptions(args);
  } catch {
    /* Preserve the original parse/validation error. */
  }
  try {
    const file = writeReceiptNoOverwrite(outDir, 'native-throughput-driver-failure', {
      ...runMetadata(options ?? { ...DEFAULT_OPTIONS, outDir }, randomUUID(), 'native-throughput-driver-failure'),
      status: 'FAIL',
      error:
        error instanceof Error
          ? { message: error.message, stack: error.stack, cause: (error as Error & { cause?: unknown }).cause }
          : String(error),
    });
    console.error(`Native benchmark failure receipt: ${file}`);
  } catch (receiptError) {
    console.error('Failed to persist benchmark failure receipt', receiptError);
  }
  process.exitCode = 1;
});
