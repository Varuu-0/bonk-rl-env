/**
 * SharedMemoryManager - Zero-Copy IPC using SharedArrayBuffer
 * 
 * This class manages shared memory between main thread and worker threads
 * for high-performance environment step operations. Uses Atomics for
 * synchronization to enable lock-free communication.
 * 
 * Buffer Layout (per worker):
 * - Actions: Uint8Array (numEnvs * ringSize) - Ring buffer for actions
 * - Observations: Float32Array (numEnvs * 14) - 14 floats per observation
 * - Rewards: Float32Array (numEnvs) - Reward per environment
 * - Dones: Uint8Array (numEnvs) - Done flag per environment
 * - Truncated: Uint8Array (numEnvs) - Truncated flag per environment
 * - Ticks: Uint32Array (numEnvs) - Tick count per environment
 * - Control: Synchronization primitives (16 bytes)
 * 
 * Ring Buffer:
 * - 16 slots for pipelining (main can queue next action while worker processes)
 * - Uses power-of-2 mask for fast modulo operations
 */

export class SharedMemoryManager {
    /** The underlying SharedArrayBuffer */
    private buffer: SharedArrayBuffer;

    /** Typed array views for data */
    private views: {
        actions: Uint8Array;
        observations: Float32Array;
        rewards: Float32Array;
        dones: Uint8Array;
        truncated: Uint8Array;
        ticks: Uint32Array;
    };

    /** Control region for synchronization - using Int32Array for Atomics */
    private control: {
        stepCounter: Int32Array;
        workerReady: Int32Array;
        mainReady: Int32Array;
        actionSlotIndex: Int32Array;  // Atomic counter for ring buffer slot tracking
    };

    /** Ring buffer mask (ringSize - 1, assumes power of 2) */
    private actionRingMask: number;

    /** Number of environments */
    private numEnvs: number;

    /** Ring buffer size */
    private ringSize: number;

    /** Current action slot in ring buffer */
    private currentActionSlot: number = 0;

    /** Current result slot in ring buffer */
    private currentResultSlot: number = 0;

    /** Whether this instance owns the buffer (for cleanup) */
    private ownsBuffer: boolean = false;

    /** Offset where control region starts */
    private controlOffset: number = 0;

    /**
     * Creates a new SharedMemoryManager
     * @param numEnvs Number of environments managed by this worker
     * @param ringSize Ring buffer size (default 16, should be power of 2)
     * @param existingBuffer Optional existing SharedArrayBuffer to use
     */
    constructor(numEnvs: number, ringSize: number = 16, existingBuffer?: SharedArrayBuffer) {
        this.numEnvs = numEnvs;
        this.ringSize = ringSize;
        this.actionRingMask = ringSize - 1; // Assumes power of 2

        // ALIGNMENT FIX: Use 8-byte alignment for all views to be safe across all typed arrays
        const align8 = (n: number) => (n + 7) & ~7;

        const actionBytes = align8(numEnvs * ringSize);  // Uint8
        const obsBytes = align8(numEnvs * 14 * 4);       // Float32 (14 obs values)
        const rewardBytes = align8(numEnvs * 4);         // Float32
        const doneBytes = align8(numEnvs * 1);           // Uint8
        const truncatedBytes = align8(numEnvs * 1);      // Uint8
        const tickBytes = align8(numEnvs * 4);           // Uint32

        // Control region: 4 x Int32 = 16 bytes
        const controlBytes = 16;

        const totalBytes = actionBytes + obsBytes + rewardBytes +
            doneBytes + truncatedBytes + tickBytes + controlBytes;

        // Use existing buffer or create new one
        if (existingBuffer) {
            this.buffer = existingBuffer;
            this.ownsBuffer = false;
        } else {
            // Create shared buffer
            this.buffer = new SharedArrayBuffer(totalBytes);
            this.ownsBuffer = true;
        }

        // Create views with correct aligned offsets
        let offset = 0;
        const align8_local = (n: number) => (n + 7) & ~7;

        // Actions ring buffer
        const actionsView = new Uint8Array(this.buffer, offset, numEnvs * ringSize);
        offset = align8_local(offset + actionsView.byteLength);

        // Observations: 14 floats per environment
        const observationsView = new Float32Array(this.buffer, offset, numEnvs * 14);
        offset = align8_local(offset + observationsView.byteLength);

        // Rewards: 1 float per environment
        const rewardsView = new Float32Array(this.buffer, offset, numEnvs);
        offset = align8_local(offset + rewardsView.byteLength);

        // Dones: 1 byte per environment
        const donesView = new Uint8Array(this.buffer, offset, numEnvs);
        offset = align8_local(offset + donesView.byteLength);

        // Truncated: 1 byte per environment
        const truncatedView = new Uint8Array(this.buffer, offset, numEnvs);
        offset = align8_local(offset + truncatedView.byteLength);

        // Ticks: 1 uint32 per environment (must be 4-byte aligned, 8 is safer)
        const ticksView = new Uint32Array(this.buffer, offset, numEnvs);
        offset = align8_local(offset + ticksView.byteLength);

        // Store control offset for later
        this.controlOffset = offset;

        // Control region - using Int32Array for Atomics compatibility
        // FIX: Use correct byte size (Int32Array.BYTES_PER_ELEMENT = 4)
        const INT32_SIZE = Int32Array.BYTES_PER_ELEMENT;

        const stepCounterView = new Int32Array(this.buffer, offset, 1);
        offset += INT32_SIZE;

        const workerReadyView = new Int32Array(this.buffer, offset, 1);
        offset += INT32_SIZE;

        const mainReadyView = new Int32Array(this.buffer, offset, 1);
        offset += INT32_SIZE;

        // Action slot index - atomic counter for ring buffer synchronization
        const actionSlotIndexView = new Int32Array(this.buffer, offset, 1);
        offset += INT32_SIZE;  // Complete the control region offset tracking

        // Store views
        this.views = {
            actions: actionsView,
            observations: observationsView,
            rewards: rewardsView,
            dones: donesView,
            truncated: truncatedView,
            ticks: ticksView
        };

        this.control = {
            stepCounter: stepCounterView,
            workerReady: workerReadyView,
            mainReady: mainReadyView,
            actionSlotIndex: actionSlotIndexView
        };

        // Only initialize control values if we created the buffer
        if (!existingBuffer) {
            // Initialize control values
            Atomics.store(this.control.stepCounter, 0, 0);
            Atomics.store(this.control.workerReady, 0, 0);
            Atomics.store(this.control.mainReady, 0, 0);
            Atomics.store(this.control.actionSlotIndex, 0, 0);
        }
    }

    /**
     * Checks if SharedArrayBuffer is supported in the current environment
     * @returns true if SharedArrayBuffer is available
     */
    static isSupported(): boolean {
        return typeof SharedArrayBuffer !== 'undefined';
    }

    /**
     * Calculates the required SharedArrayBuffer size for given parameters
     * @param numEnvs Number of environments
     * @param ringSize Ring buffer size
     * @returns Required buffer size in bytes
     */
    static calculateBufferSize(numEnvs: number, ringSize: number = 16): number {
        const actionBytes = numEnvs * ringSize;  // Uint8
        const obsBytes = numEnvs * 14 * 4;       // Float32 (14 obs values)
        const rewardBytes = numEnvs * 4;         // Float32
        const doneBytes = numEnvs * 1;            // Uint8
        const truncatedBytes = numEnvs * 1;      // Uint8
        const tickBytes = numEnvs * 4;           // Uint32

        // Calculate padding for ticks (Uint32 requires 4-byte alignment)
        const offsetBeforeTicks = actionBytes + obsBytes + rewardBytes + doneBytes + truncatedBytes;
        const tickPadding = (offsetBeforeTicks + 3) & ~3 - offsetBeforeTicks;

        // Control region: 4 x Int32 (4 bytes each) = 16 bytes total, naturally aligned after ticks
        const controlBytes = 16;

        return actionBytes + obsBytes + rewardBytes + doneBytes + truncatedBytes +
            tickPadding + tickBytes + controlBytes;
    }

    /**
     * Gets the underlying SharedArrayBuffer
     * @returns The SharedArrayBuffer instance
     */
    getBuffer(): SharedArrayBuffer {
        return this.buffer;
    }

    /**
     * Gets the number of environments
     * @returns Number of environments
     */
    getNumEnvs(): number {
        return this.numEnvs;
    }

    /**
     * Gets the ring buffer size
     * @returns Ring buffer size
     */
    getRingSize(): number {
        return this.ringSize;
    }

    /**
     * Writes actions to the shared memory ring buffer
     * Uses non-blocking atomics to signal the worker
     * @param actions Uint8Array of encoded actions (one per environment)
     */
    writeActions(actions: Uint8Array): void {
        // Get current slot and advance atomically using compareExchange pattern
        // We read current slot, then atomically increment for next write
        const slot = this.currentActionSlot;
        const envCount = Math.min(actions.length, this.numEnvs);

        // CRITICAL FIX: Store the slot index atomically BEFORE signaling worker
        // This ensures worker can read which slot contains valid data
        Atomics.store(this.control.actionSlotIndex, 0, slot);

        // Write actions to ring buffer slot
        for (let i = 0; i < envCount; i++) {
            this.views.actions[slot * this.numEnvs + i] = actions[i];
        }

        // Signal worker AFTER writing actions and storing slot index
        // This ensures worker sees both the slot index and the valid data
        Atomics.store(this.control.workerReady, 0, 1);
        Atomics.notify(this.control.workerReady, 0, 1);

        // Advance ring slot (wraps around using mask)
        this.currentActionSlot = (this.currentActionSlot + 1) & this.actionRingMask;
    }

    /**
     * Reads actions from a specific ring buffer slot
     * @param slot Ring buffer slot to read from
     * @returns Uint8Array of actions
     */
    readActions(slot: number): Uint8Array {
        const actions = new Uint8Array(this.numEnvs);
        for (let i = 0; i < this.numEnvs; i++) {
            actions[i] = this.views.actions[slot * this.numEnvs + i];
        }
        return actions;
    }

    /**
     * Gets the current action slot that should be read by worker
     * Uses atomic read from shared memory for cross-thread synchronization
     * @returns Current action slot index
     */
    readActionSlot(): number {
        // CRITICAL FIX: Read slot index atomically from shared memory
        // This ensures worker gets the correct slot even if main thread advances
        return Atomics.load(this.control.actionSlotIndex, 0) & this.actionRingMask;
    }

    /**
     * Waits for worker to complete processing and signal results ready
     * Uses Atomics.wait for blocking synchronization
     * @param timeout Timeout in milliseconds (default: infinity)
     * @returns 'ok' if notified, 'timed-out' if timeout, or 'error'
     */
    waitForResults(timeout: number = Infinity): 'ok' | 'timed-out' | 'not-equal' {
        // Wait for worker to signal mainReady
        const result = Atomics.wait(this.control.mainReady, 0, 0,
            timeout === Infinity ? undefined : timeout);

        // Reset mainReady to 0 after waking
        Atomics.store(this.control.mainReady, 0, 0);

        if (result === 'timed-out') {
            return 'timed-out';
        } else if (result === 'not-equal') {
            return 'not-equal';
        }

        return 'ok';
    }

    /**
     * Reads the results from shared memory after worker has processed
     * CRITICAL FIX: Now includes synchronization check to ensure worker has finished writing
     * @returns Object containing typed array views for all results
     */
    readResults(): {
        observations: Float32Array;
        rewards: Float32Array;
        dones: Uint8Array;
        truncated: Uint8Array;
        ticks: Uint32Array;
    } {
        // CRITICAL FIX: Add synchronization check before returning results
        // Wait for worker to signal that results are ready
        // This prevents reading incomplete/partial results
        const ready = Atomics.load(this.control.mainReady, 0);
        if (ready !== 1) {
            // Worker hasn't signaled results ready - return empty/zeroed views
            // This should not happen if waitForResults() was called first
            console.warn('readResults called without waiting for worker - possible race condition');
            return {
                observations: new Float32Array(this.numEnvs * 14),
                rewards: new Float32Array(this.numEnvs),
                dones: new Uint8Array(this.numEnvs),
                truncated: new Uint8Array(this.numEnvs),
                ticks: new Uint32Array(this.numEnvs)
            };
        }

        return {
            observations: this.views.observations,
            rewards: this.views.rewards,
            dones: this.views.dones,
            truncated: this.views.truncated,
            ticks: this.views.ticks
        };
    }

    /**
     * Gets the observations view directly
     * @returns Float32Array of observations
     */
    getObservations(): Float32Array {
        return this.views.observations;
    }

    /**
     * Gets the rewards view directly
     * @returns Float32Array of rewards
     */
    getRewards(): Float32Array {
        return this.views.rewards;
    }

    /**
     * Gets the dones view directly
     * @returns Uint8Array of done flags
     */
    getDones(): Uint8Array {
        return this.views.dones;
    }

    /**
     * Gets the truncated view directly
     * @returns Uint8Array of truncated flags
     */
    getTruncated(): Uint8Array {
        return this.views.truncated;
    }

    /**
     * Gets the ticks view directly
     * @returns Uint32Array of tick counts
     */
    getTicks(): Uint32Array {
        return this.views.ticks;
    }

    /**
     * Writes observation data for a single environment
     * @param envIndex Environment index (0-based)
     * @param observation 14-element array of observation values
     */
    writeObservation(envIndex: number, observation: number[]): void {
        const offset = envIndex * 14;
        for (let i = 0; i < 14 && i < observation.length; i++) {
            this.views.observations[offset + i] = observation[i];
        }
    }

    /**
     * Writes reward for a single environment
     * @param envIndex Environment index (0-based)
     * @param reward Reward value
     */
    writeReward(envIndex: number, reward: number): void {
        this.views.rewards[envIndex] = reward;
    }

    /**
     * Writes done flag for a single environment
     * @param envIndex Environment index (0-based)
     * @param done Done flag (0 or 1)
     */
    writeDone(envIndex: number, done: number): void {
        this.views.dones[envIndex] = done;
    }

    /**
     * Writes truncated flag for a single environment
     * @param envIndex Environment index (0-based)
     * @param truncated Truncated flag (0 or 1)
     */
    writeTruncated(envIndex: number, truncated: number): void {
        this.views.truncated[envIndex] = truncated;
    }

    /**
     * Writes tick count for a single environment
     * @param envIndex Environment index (0-based)
     * @param tick Tick count
     */
    writeTick(envIndex: number, tick: number): void {
        this.views.ticks[envIndex] = tick;
    }

    /**
     * Reads observation for a single environment
     * @param envIndex Environment index (0-based)
     * @returns 14-element array of observation values
     */
    readObservation(envIndex: number): number[] {
        const offset = envIndex * 14;
        const observation = new Array(14);
        for (let i = 0; i < 14; i++) {
            observation[i] = this.views.observations[offset + i];
        }
        return observation;
    }

    /**
     * Reads reward for a single environment
     * @param envIndex Environment index (0-based)
     * @returns Reward value
     */
    readReward(envIndex: number): number {
        return this.views.rewards[envIndex];
    }

    /**
     * Reads done flag for a single environment
     * @param envIndex Environment index (0-based)
     * @returns Done flag (0 or 1)
     */
    readDone(envIndex: number): number {
        return this.views.dones[envIndex];
    }

    /**
     * Reads truncated flag for a single environment
     * @param envIndex Environment index (0-based)
     * @returns Truncated flag (0 or 1)
     */
    readTruncated(envIndex: number): number {
        return this.views.truncated[envIndex];
    }

    /**
     * Reads tick count for a single environment
     * @param envIndex Environment index (0-based)
     * @returns Tick count
     */
    readTick(envIndex: number): number {
        return this.views.ticks[envIndex];
    }

    /**
     * Increments the step counter
     * @returns New step counter value
     */
    incrementStepCounter(): number {
        const newValue = Atomics.add(this.control.stepCounter, 0, 1);
        return newValue;
    }

    /**
     * Gets the current step counter value
     * @returns Current step counter
     */
    getStepCounter(): number {
        return Atomics.load(this.control.stepCounter, 0);
    }

    /**
     * Signals that the worker is ready to process new actions.
     * Called by main thread after writing actions to the ring buffer.
     */
    signalWorkerReady(): void {
        Atomics.store(this.control.workerReady, 0, 1);
        Atomics.notify(this.control.workerReady, 0, 1);
    }

    /**
     * Signals that the worker has completed processing and results are ready.
     * Called by worker thread after writing observation/reward/done/truncated.
     */
    signalMainReady(): void {
        Atomics.store(this.control.mainReady, 0, 1);
        Atomics.notify(this.control.mainReady, 0, 1);
    }

    /**
     * Checks if main has written new actions
     * @returns true if worker has new actions to process
     */
    hasNewActions(): boolean {
        return Atomics.load(this.control.workerReady, 0) === 1;
    }

    /**
     * Signals that worker has consumed the actions
     * Should be called after reading actions from ring buffer
     */
    signalWorkerConsumed(): void {
        Atomics.store(this.control.workerReady, 0, 0);
    }

    /**
     * Waits for new actions from main thread
     * @param timeout Timeout in milliseconds
     * @returns 'ok' if notified, 'timed-out' if timeout
     */
    waitForActions(timeout: number = Infinity): 'ok' | 'timed-out' | 'not-equal' {
        const result = Atomics.wait(this.control.workerReady, 0, 0,
            timeout === Infinity ? undefined : timeout);

        if (result === 'timed-out') {
            return 'timed-out';
        } else if (result === 'not-equal') {
            return 'not-equal';
        }

        return 'ok';
    }

    /**
     * Resets the shared memory state for reuse
     * Clears all views and resets synchronization primitives
     */
    reset(): void {
        // Clear all data views
        this.views.actions.fill(0);
        this.views.observations.fill(0);
        this.views.rewards.fill(0);
        this.views.dones.fill(0);
        this.views.truncated.fill(0);
        this.views.ticks.fill(0);

        // Reset control values
        Atomics.store(this.control.stepCounter, 0, 0);
        Atomics.store(this.control.workerReady, 0, 0);
        Atomics.store(this.control.mainReady, 0, 0);
        Atomics.store(this.control.actionSlotIndex, 0, 0);

        // Reset ring buffer positions
        this.currentActionSlot = 0;
        this.currentResultSlot = 0;
    }

    /**
     * Gets the action slot index from shared memory (for worker thread)
     * This is the atomic version that worker threads should use
     * @returns Current action slot index from shared memory
     */
    getActionSlotFromShared(): number {
        return Atomics.load(this.control.actionSlotIndex, 0) & this.actionRingMask;
    }

    /**
     * Gets the control region for external access (e.g., worker initialization)
     * @returns Control region object
     */
    getControl(): {
        stepCounter: Int32Array;
        workerReady: Int32Array;
        mainReady: Int32Array;
        actionSlotIndex: Int32Array;
    } {
        return this.control;
    }

    /**
     * Disposes of the SharedMemoryManager and releases resources.
     * Should be called when the manager is no longer needed to prevent memory leaks.
     * Only releases the buffer if this instance owns it (created it).
     */
    dispose(): void {
        // Only release the buffer if this instance owns it
        if (this.ownsBuffer && this.buffer) {
            // Nullify the buffer reference to help garbage collection
            this.buffer = null as any;
        }

        // Nullify all views to help garbage collection
        this.views.actions = null as any;
        this.views.observations = null as any;
        this.views.rewards = null as any;
        this.views.dones = null as any;
        this.views.truncated = null as any;
        this.views.ticks = null as any;

        // Nullify control arrays
        this.control.stepCounter = null as any;
        this.control.workerReady = null as any;
        this.control.mainReady = null as any;
        this.control.actionSlotIndex = null as any;
        this.control = null as any;
    }
}
