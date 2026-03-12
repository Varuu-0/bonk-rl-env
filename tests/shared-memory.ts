/**
 * test-shared-memory.ts
 * Standalone verification for SharedMemoryManager logic.
 */
import { SharedMemoryManager } from '../src/ipc/shared-memory';
import assert from 'assert';

function testSAB() {
    console.log('--- Testing SharedMemoryManager ---');

    const numEnvs = 4;
    const ringSize = 16;

    // 1. Test isSupported
    console.log(`SharedArrayBuffer supported: ${SharedMemoryManager.isSupported()}`);
    if (!SharedMemoryManager.isSupported()) {
        console.warn('Skipping test as SharedArrayBuffer is not supported in this environment.');
        return;
    }

    // 2. Test Initialization
    const shm = new SharedMemoryManager(numEnvs, ringSize);
    console.log('Initialized SharedMemoryManager');

    // 3. Test Action Ring Buffer
    const actions = new Uint8Array([1, 2, 4, 8]);
    shm.writeActions(actions);

    const slot = shm.readActionSlot();
    const readActions = shm.readActions(slot);
    console.log(`Read actions from slot ${slot}: ${readActions}`);
    assert.deepStrictEqual(Array.from(readActions), [1, 2, 4, 8], 'Action mismatch');

    // 4. Test Synchronization (Worker side)
    assert.strictEqual(shm.hasNewActions(), true, 'Should have new actions');
    shm.signalWorkerConsumed();
    assert.strictEqual(shm.hasNewActions(), false, 'Should have consumed actions');

    // 5. Test Results signaling
    shm.writeReward(0, 1.5);
    shm.writeDone(0, 1);
    shm.signalMainReady();

    const results = shm.readResults();
    console.log(`Read reward: ${results.rewards[0]}, done: ${results.dones[0]}`);
    assert.strictEqual(results.rewards[0], 1.5, 'Reward mismatch');
    assert.strictEqual(results.dones[0], 1, 'Done flag mismatch');

    // 6. Test Ring Buffer Advancement
    const actions2 = new Uint8Array([16, 32, 1, 2]);
    shm.writeActions(actions2);
    const slot2 = shm.readActionSlot();
    console.log(`Advanced to slot: ${slot2}`);
    assert.strictEqual(slot2, (slot + 1) % ringSize, 'Slot did not advance correctly');

    console.log('--- SharedMemoryManager Tests Passed! ---');
    shm.dispose();
}

testSAB();
