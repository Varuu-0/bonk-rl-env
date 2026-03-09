/**
 * SharedMemoryManager - Zero-Copy IPC using SharedArrayBuffer
 */
export class SharedMemoryManager {
    private buffer: SharedArrayBuffer;
    private views: {
        actions: Uint8Array;
        observations: Float32Array;
        rewards: Float32Array;
        dones: Uint8Array;
        truncated: Uint8Array;
        ticks: Uint32Array;
    };
    private seeds: Uint32Array;
    private control: {
        stepCounter: Int32Array;
        workerReady: Int32Array;
        mainReady: Int32Array;
        actionSlotIndex: Int32Array;
        command: Int32Array; // 0=step, 1=reset, 2=shutdown
    };

    private numEnvs: number;
    private ringSize: number;
    private actionRingMask: number;
    private currentActionSlot: number = 0;
    private ownsBuffer: boolean = false;

    constructor(numEnvs: number, ringSize: number = 16, existingBuffer?: SharedArrayBuffer) {
        this.numEnvs = numEnvs;
        this.ringSize = ringSize;
        this.actionRingMask = ringSize - 1;

        const align8 = (n: number) => (n + 7) & ~7;
        const actionBytes = align8(numEnvs * ringSize);
        const obsBytes = align8(numEnvs * 14 * 4);
        const rewardBytes = align8(numEnvs * 4);
        const doneBytes = align8(numEnvs * 1);
        const truncatedBytes = align8(numEnvs * 1);
        const tickBytes = align8(numEnvs * 4);
        const seedBytes = align8(numEnvs * 4);
        const controlBytes = 64; // Reserve plenty

        const totalBytes = actionBytes + obsBytes + rewardBytes + doneBytes + truncatedBytes + tickBytes + seedBytes + controlBytes;

        if (existingBuffer) {
            this.buffer = existingBuffer;
            this.ownsBuffer = false;
        } else {
            this.buffer = new SharedArrayBuffer(totalBytes);
            this.ownsBuffer = true;
        }

        let offset = 0;
        this.views = {
            actions: new Uint8Array(this.buffer, offset, numEnvs * ringSize),
            observations: null as any,
            rewards: null as any,
            dones: null as any,
            truncated: null as any,
            ticks: null as any
        };
        offset = align8(offset + actionBytes);

        this.views.observations = new Float32Array(this.buffer, offset, numEnvs * 14);
        offset = align8(offset + obsBytes);

        this.views.rewards = new Float32Array(this.buffer, offset, numEnvs);
        offset = align8(offset + rewardBytes);

        this.views.dones = new Uint8Array(this.buffer, offset, numEnvs);
        offset = align8(offset + doneBytes);

        this.views.truncated = new Uint8Array(this.buffer, offset, numEnvs);
        offset = align8(offset + truncatedBytes);

        this.views.ticks = new Uint32Array(this.buffer, offset, numEnvs);
        offset = align8(offset + tickBytes);

        this.seeds = new Uint32Array(this.buffer, offset, numEnvs);
        offset = align8(offset + seedBytes);

        this.control = {
            stepCounter: new Int32Array(this.buffer, offset, 1),
            workerReady: new Int32Array(this.buffer, offset + 4, 1),
            mainReady: new Int32Array(this.buffer, offset + 8, 1),
            actionSlotIndex: new Int32Array(this.buffer, offset + 12, 1),
            command: new Int32Array(this.buffer, offset + 16, 1)
        };

        if (!existingBuffer) {
            this.reset();
        }
    }

    static isSupported() { return typeof SharedArrayBuffer !== 'undefined'; }

    static calculateBufferSize(numEnvs: number, ringSize: number = 16): number {
        const align8 = (n: number) => (n + 7) & ~7;
        return align8(numEnvs * ringSize) + align8(numEnvs * 14 * 4) + align8(numEnvs * 4) +
            align8(numEnvs * 1) + align8(numEnvs * 1) + align8(numEnvs * 4) +
            align8(numEnvs * 4) + 64;
    }

    getBuffer() { return this.buffer; }
    getNumEnvs() { return this.numEnvs; }

    writeActions(actions: Uint8Array) {
        const slot = this.currentActionSlot;
        Atomics.store(this.control.actionSlotIndex, 0, slot);
        this.views.actions.set(actions, slot * this.numEnvs);
        this.currentActionSlot = (this.currentActionSlot + 1) & this.actionRingMask;
    }

    writeSeeds(seeds: number[]) {
        this.seeds.set(seeds.slice(0, this.numEnvs));
    }

    readSeeds(): Uint32Array { return this.seeds; }

    sendCommand(cmd: number) {
        Atomics.store(this.control.command, 0, cmd);
        Atomics.store(this.control.workerReady, 0, 1);
        Atomics.notify(this.control.workerReady, 0, 1);
    }

    readCommand(): number { return Atomics.load(this.control.command, 0); }

    signalWorkerReady() {
        Atomics.store(this.control.workerReady, 0, 1);
        Atomics.notify(this.control.workerReady, 0, 1);
    }

    signalMainReady() {
        Atomics.store(this.control.mainReady, 0, 1);
        Atomics.notify(this.control.mainReady, 0, 1);
    }

    waitForResults(timeout: number = Infinity) {
        const res = Atomics.wait(this.control.mainReady, 0, 0, timeout === Infinity ? undefined : timeout);
        this.consumeResultsSignal();
        return res;
    }

    isResultsReady() { return Atomics.load(this.control.mainReady, 0) === 1; }
    consumeResultsSignal() { Atomics.store(this.control.mainReady, 0, 0); }

    readResults() {
        return {
            observations: this.views.observations,
            rewards: this.views.rewards,
            dones: this.views.dones,
            truncated: this.views.truncated,
            ticks: this.views.ticks
        };
    }

    writeObservation(envIndex: number, obs: number[]) {
        this.views.observations.set(obs, envIndex * 14);
    }

    writeReward(envIndex: number, reward: number) { this.views.rewards[envIndex] = reward; }
    writeDone(envIndex: number, done: number) { this.views.dones[envIndex] = done; }
    writeTruncated(envIndex: number, truncated: number) { this.views.truncated[envIndex] = truncated; }
    writeTick(envIndex: number, tick: number) { this.views.ticks[envIndex] = tick; }

    incrementStepCounter() { return Atomics.add(this.control.stepCounter, 0, 1); }

    waitForActions(timeout: number = Infinity) {
        return Atomics.wait(this.control.workerReady, 0, 0, timeout === Infinity ? undefined : timeout);
    }

    signalWorkerConsumed() { Atomics.store(this.control.workerReady, 0, 0); }

    readActionSlot() { return Atomics.load(this.control.actionSlotIndex, 0) & this.actionRingMask; }

    getActionsView(slot: number) {
        return this.views.actions.subarray(slot * this.numEnvs, (slot + 1) * this.numEnvs);
    }

    readActions(slot: number) {
        return this.views.actions.slice(slot * this.numEnvs, (slot + 1) * this.numEnvs);
    }

    reset() {
        this.views.actions.fill(0);
        this.views.observations.fill(0);
        this.views.rewards.fill(0);
        this.views.dones.fill(0);
        this.views.truncated.fill(0);
        this.views.ticks.fill(0);
        this.seeds.fill(0);
        Atomics.store(this.control.stepCounter, 0, 0);
        Atomics.store(this.control.workerReady, 0, 0);
        Atomics.store(this.control.mainReady, 0, 0);
        Atomics.store(this.control.actionSlotIndex, 0, 0);
        Atomics.store(this.control.command, 0, 0);
        this.currentActionSlot = 0;
    }

    getControl() { return this.control; }

    dispose() {
        if (this.ownsBuffer) this.buffer = null as any;
        this.views = null as any;
        this.control = null as any;
        this.seeds = null as any;
    }
}
