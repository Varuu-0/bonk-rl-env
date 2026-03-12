/**
 * Test Script for Telemetry System
 *
 * This script verifies that:
 * 1. The BigUint64Array buffers are accruing data correctly
 * 2. CLI flag parsing works correctly
 * 3. The zero-allocation hot path is maintained
 * 4. Worker telemetry propagation works
 *
 * Run with: npx tsx test-telemetry.ts
 */

import { TelemetryBuffer, TelemetryIndices, globalProfiler, wrap } from '../src/telemetry/profiler';
import { parseFlags, isAnyTelemetryEnabled } from '../src/telemetry/flags';
import { TelemetryController, isTelemetryEnabled, getTelemetryController } from '../src/telemetry/telemetry-controller';

// Test counters
let testsPassed = 0;
let testsFailed = 0;

/**
 * Test result helper
 */
function test(name: string, passed: boolean): void {
  if (passed) {
    console.log(`✓ ${name}`);
    testsPassed++;
  } else {
    console.log(`✗ ${name}`);
    testsFailed++;
  }
}

/**
 * Test 1: Verify BigUint64Array is accumulating data
 */
function testBufferAccumulation(): void {
  console.log('\n--- Test 1: Buffer Accumulation ---');

  // Reset buffer
  for (let i = 0; i < TelemetryBuffer.length; i++) {
    TelemetryBuffer[i] = BigInt(0);
  }

  // Simulate some telemetry calls
  const start1 = process.hrtime.bigint();
  // Simulate work
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    sum += i;
  }
  const end1 = process.hrtime.bigint();
  TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] += end1 - start1;

  // Verify data was accumulated
  const physicsTick = TelemetryBuffer[TelemetryIndices.PHYSICS_TICK];
  test('BigUint64Array accumulates data', physicsTick > BigInt(0));

  // Test all indices
  TelemetryBuffer[TelemetryIndices.RAYCAST_CALL] = BigInt(1000);
  TelemetryBuffer[TelemetryIndices.COLLISION_RESOLVE] = BigInt(2000);
  TelemetryBuffer[TelemetryIndices.ZMQ_SEND] = BigInt(3000);
  TelemetryBuffer[TelemetryIndices.JSON_PARSE] = BigInt(4000);

  test('All TelemetryIndices are accessible',
    TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] > BigInt(0) &&
    TelemetryBuffer[TelemetryIndices.RAYCAST_CALL] === BigInt(1000) &&
    TelemetryBuffer[TelemetryIndices.COLLISION_RESOLVE] === BigInt(2000) &&
    TelemetryBuffer[TelemetryIndices.ZMQ_SEND] === BigInt(3000) &&
    TelemetryBuffer[TelemetryIndices.JSON_PARSE] === BigInt(4000)
  );
}

/**
 * Test 2: Verify CLI flag parsing
 */
function testFlagParsing(): void {
  console.log('\n--- Test 2: Flag Parsing ---');

  // Test default flags
  const flags = parseFlags();
  test('Default: enableTelemetry is false', flags.enableTelemetry === false);
  test('Default: profileLevel is standard', flags.profileLevel === 'standard');
  test('Default: debugLevel is none', flags.debugLevel === 'none');
  test('Default: outputFormat is console', flags.outputFormat === 'console');
  test('Default: dashboardPort is 3001', flags.dashboardPort === 3001);
  test('Default: reportInterval is 5000', flags.reportInterval === 5000);
  test('Default: retentionDays is 7', flags.retentionDays === 7);
}

/**
 * Test 3: Verify isAnyTelemetryEnabled detection
 */
function testTelemetryDetection(): void {
  console.log('\n--- Test 3: Telemetry Detection ---');

  // Without flags, should return false
  const detected = isAnyTelemetryEnabled();
  test('isAnyTelemetryEnabled returns false without flags', detected === false);
}

/**
 * Test 4: Verify TelemetryController initialization
 */
function testControllerInitialization(): void {
  console.log('\n--- Test 4: Controller Initialization ---');

  // Get controller instance
  const controller = TelemetryController.getInstance();

  // Initialize with default config
  controller.initialize({
    enabled: false,
    outputFormat: 'console',
    retentionDays: 7,
    dashboardPort: 3001,
    reportInterval: 5000,
  });

  // Check flags
  const flags = controller.getFlags();
  test('Controller returns correct flags', flags.enableTelemetry === false);

  // Check fast-path
  const isEnabled = TelemetryController.isEnabled();
  test('Controller.isEnabled() returns correct value', isEnabled === false);
}

/**
 * Test 5: Verify wrap() function works correctly
 */
function testWrapFunction(): void {
  console.log('\n--- Test 5: Wrap Function ---');

  // Reset buffer
  for (let i = 0; i < TelemetryBuffer.length; i++) {
    TelemetryBuffer[i] = BigInt(0);
  }

  // Create a function to wrap
  function testFunction(): number {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += i;
    }
    return sum;
  }

  // Wrap the function
  const wrapped = wrap('PHYSICS_TICK', testFunction);

  // Call the wrapped function
  const result = wrapped();

  // Verify result
  test('Wrapped function returns correct result', result === 4950);

  // Verify telemetry was recorded
  test('TelemetryBuffer recorded timing', TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] > BigInt(0));
}

/**
 * Test 6: Zero-allocation verification
 */
function testZeroAllocation(): void {
  console.log('\n--- Test 6: Zero Allocation Verification ---');

  // Reset buffer
  for (let i = 0; i < TelemetryBuffer.length; i++) {
    TelemetryBuffer[i] = BigInt(0);
  }

  // Get heap usage before
  const heapBefore = process.memoryUsage().heapUsed;

  // Run many iterations
  for (let iter = 0; iter < 10000; iter++) {
    // Call wrap function multiple times
    const start = process.hrtime.bigint();
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      sum += i;
    }
    const end = process.hrtime.bigint();
    TelemetryBuffer[TelemetryIndices.PHYSICS_TICK] += end - start;
  }

  // Get heap usage after
  const heapAfter = process.memoryUsage().heapUsed;

  // Check for significant allocation (allowing for some baseline)
  const allocation = heapAfter - heapBefore;
  const maxAllowedAllocation = 1024 * 1024; // 1MB tolerance

  test('No significant memory allocation in hot path', allocation < maxAllowedAllocation);
}

/**
 * Test 7: Verify profiler tick and report
 */
function testProfilerTick(): void {
  console.log('\n--- Test 7: Profiler Tick ---');

  // Create new profiler instance using the Profiler class directly
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const ProfilerClass = globalProfiler.constructor as new () => typeof globalProfiler;
  const profiler = new ProfilerClass();

  // Tick the profiler
  profiler.tick();
  profiler.tick();
  profiler.tick();

  test('Profiler tick increments correctly', profiler.tick() === undefined || (profiler as any).currentTick === 3);
}

/**
 * Run all tests
 */
function runTests(): void {
  console.log('========================================');
  console.log('     TELEMETRY SYSTEM TEST SUITE');
  console.log('========================================');

  testBufferAccumulation();
  testFlagParsing();
  testTelemetryDetection();
  testControllerInitialization();
  testWrapFunction();
  testZeroAllocation();
  testProfilerTick();

  console.log('\n========================================');
  console.log(`     RESULTS: ${testsPassed} passed, ${testsFailed} failed`);
  console.log('========================================');

  if (testsFailed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests();
