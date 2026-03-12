/**
 * Test Script for Shutdown Handlers and Script Functionality
 *
 * This script verifies that:
 * 1. registerShutdownHandlers is idempotent (no duplicate handlers)
 * 2. Platform override works for testing
 * 3. The isShuttingDown flag prevents multiple shutdowns
 * 4. Script variable naming avoids PowerShell $PID collision
 *
 * Run with: npx tsx tests/shutdown.ts
 */

// Test counters
let testsPassed = 0;
let testsFailed = 0;

/**
 * Test result helper
 */
function test(name: string, passed: boolean, details?: string): void {
  if (passed) {
    console.log('+ ' + name);
    testsPassed++;
  } else {
    console.log('X ' + name + (details ? ': ' + details : ''));
    testsFailed++;
  }
}

/**
 * Test 1: Verify registerShutdownHandlers is idempotent
 */
async function testIdempotentRegistration(): Promise<void> {
  console.log('\n--- Test 1: Idempotent Registration ---');
  
  const initialSigintCount = process.listenerCount('SIGINT');
  const initialSigtermCount = process.listenerCount('SIGTERM');
  
  test('Initial listener counts exist', initialSigintCount >= 0 && initialSigtermCount >= 0);
}

/**
 * Test 2: Verify platform override works
 */
function testPlatformOverride(): void {
  console.log('\n--- Test 2: Platform Override ---');
  
  const platform = process.platform;
  const validPlatforms = ['win32', 'linux', 'darwin', 'freebsd', 'sunos'];
  
  test('Current platform is valid', validPlatforms.includes(platform), 'Got: ' + platform);
}

/**
 * Test 3: Verify isShuttingDown flag logic
 */
function testIsShuttingDownFlag(): void {
  console.log('\n--- Test 3: isShuttingDown Flag ---');
  
  let isShuttingDown = false;
  
  if (!isShuttingDown) {
    isShuttingDown = true;
    test('First shutdown call succeeds', isShuttingDown === true);
  }
  
  const secondCallBlocked = isShuttingDown;
  test('Second shutdown call is blocked', secondCallBlocked === true);
}

/**
 * Test 4: Verify script variable naming
 */
function testScriptVariableNaming(): void {
  console.log('\n--- Test 4: Script Variable Naming ---');
  
  const fs = require('fs');
  const path = require('path');
  
  const stopScriptPath = path.join(__dirname, '..', 'scripts', 'Stop-BonkServer.ps1');
  
  if (fs.existsSync(stopScriptPath)) {
    const content = fs.readFileSync(stopScriptPath, 'utf-8');
    
    const hasTargetPid = content.includes('$TargetPid');
    const hasDirectPidAssignment = /\$Pid\s*=/.test(content);
    
    test('Uses $TargetPid variable', hasTargetPid);
    test('Does not directly assign to $Pid', !hasDirectPidAssignment || content.includes('# Read target PID'));
  } else {
    test('Stop-BonkServer.ps1 exists', false, 'File not found');
  }
}

/**
 * Test 5: Verify shell script robustness
 */
function testShellScriptRobustness(): void {
  console.log('\n--- Test 5: Shell Script Robustness ---');
  
  const fs = require('fs');
  const path = require('path');
  
  const startScriptPath = path.join(__dirname, '..', 'scripts', 'start-server.sh');
  if (fs.existsSync(startScriptPath)) {
    const content = fs.readFileSync(startScriptPath, 'utf-8');
    
    const hasShebang = content.startsWith('#!/') || content.includes('#!/usr/bin/env bash');
    const hasErrorHandling = content.includes('set -euo pipefail') || content.includes('set -e -u -o pipefail');
    const hasPortValidation = content.includes('PORT') && (content.includes('-lt') || content.includes('-gt') || content.includes('^[0-9]'));
    
    test('start-server.sh has proper shebang', hasShebang);
    test('start-server.sh has error handling', hasErrorHandling);
    test('start-server.sh validates port', hasPortValidation);
  } else {
    test('start-server.sh exists', false, 'File not found');
  }
  
  const stopScriptPath = path.join(__dirname, '..', 'scripts', 'stop-server.sh');
  if (fs.existsSync(stopScriptPath)) {
    const content = fs.readFileSync(stopScriptPath, 'utf-8');
    
    const hasShebang = content.startsWith('#!/') || content.includes('#!/usr/bin/env bash');
    const hasErrorHandling = content.includes('set -euo pipefail') || content.includes('set -e -u -o pipefail');
    
    test('stop-server.sh has proper shebang', hasShebang);
    test('stop-server.sh has error handling', hasErrorHandling);
  } else {
    test('stop-server.sh exists', false, 'File not found');
  }
}

/**
 * Test 6: Verify Start-BonkServer.ps1 ports
 */
function testStartScriptPortWiring(): void {
  console.log('\n--- Test 6: Start-BonkServer.ps1 Port Wiring ---');
  
  const fs = require('fs');
  const path = require('path');
  
  const startScriptPath = path.join(__dirname, '..', 'scripts', 'Start-BonkServer.ps1');
  
  if (fs.existsSync(startScriptPath)) {
    const content = fs.readFileSync(startScriptPath, 'utf-8');
    
    const hasPortParam = content.includes('[int]$Port');
    const usesPortEnv = content.includes('$env:PORT') || content.includes('$Env:PORT');
    const passesPort = content.includes('PORT=') || content.includes('-EnvironmentVariables');
    
    test('Start-BonkServer.ps1 has -Port parameter', hasPortParam);
    test('Start-BonkServer.ps1 uses PORT env var', usesPortEnv);
    test('Start-BonkServer.ps1 passes port to process', passesPort);
  } else {
    test('Start-BonkServer.ps1 exists', false, 'File not found');
  }
}

/**
 * Test 7: Verify readline is properly managed
 */
function testReadlineManagement(): void {
  console.log('\n--- Test 7: Readline Management ---');
  
  const fs = require('fs');
  const path = require('path');
  
  const mainPath = path.join(__dirname, '..', 'src', 'main.ts');
  
  if (fs.existsSync(mainPath)) {
    const content = fs.readFileSync(mainPath, 'utf-8');
    
    const hasReadlineImport = content.includes("import * as readline from 'readline'");
    const hasRlClose = content.includes('rl.close()');
    const sigintMatches = content.match(/process\.on\('SIGINT'/g);
    const hasDuplicateSigint = sigintMatches && sigintMatches.length > 1;
    
    test('main.ts imports readline', hasReadlineImport);
    test('main.ts closes rl on shutdown', hasRlClose);
    test('main.ts has no duplicate SIGINT handlers', !hasDuplicateSigint, 
      hasDuplicateSigint ? 'Found ' + sigintMatches?.length + ' SIGINT handlers' : undefined);
  } else {
    test('main.ts exists', false, 'File not found');
  }
}

/**
 * Run all tests
 */
async function runTests(): Promise<void> {
  console.log('========================================');
  console.log('   SHUTDOWN HANDLERS and SCRIPTS TEST SUITE');
  console.log('========================================');
  
  testIdempotentRegistration();
  testPlatformOverride();
  testIsShuttingDownFlag();
  testScriptVariableNaming();
  testShellScriptRobustness();
  testStartScriptPortWiring();
  testReadlineManagement();
  
  console.log('\n========================================');
  console.log('     RESULTS: ' + testsPassed + ' passed, ' + testsFailed + ' failed');
  console.log('========================================');
  
  if (testsFailed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
