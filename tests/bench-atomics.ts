// Measure Atomics operation latencies to build accurate throughput model

const ITERATIONS = 100000;

// 1. Atomics.wait round-trip (single thread, non-blocking — measures syscall overhead)
function benchWaitNoBlock() {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);
    arr[0] = 1;  // Set value so wait returns immediately

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        Atomics.wait(arr, 0, 0);  // value != expected, returns immediately
    }
    const elapsed = performance.now() - start;
    console.log(`Atomics.wait (no-block): ${(elapsed / ITERATIONS * 1000).toFixed(2)}μs × ${ITERATIONS} = ${elapsed.toFixed(1)}ms`);
}

// 2. Atomics.store latency
function benchStore() {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        Atomics.store(arr, 0, i);
    }
    const elapsed = performance.now() - start;
    console.log(`Atomics.store:             ${(elapsed / ITERATIONS * 1000).toFixed(2)}μs × ${ITERATIONS} = ${elapsed.toFixed(1)}ms`);
}

// 3. Atomics.load latency
function benchLoad() {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);
    arr[0] = 42;

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        Atomics.load(arr, 0);
    }
    const elapsed = performance.now() - start;
    console.log(`Atomics.load:              ${(elapsed / ITERATIONS * 1000).toFixed(2)}μs × ${ITERATIONS} = ${elapsed.toFixed(1)}ms`);
}

// 4. Atomics.notify latency
function benchNotify() {
    const sab = new SharedArrayBuffer(4);
    const arr = new Int32Array(sab);
    arr[0] = 1;

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        Atomics.notify(arr, 0, 1);
    }
    const elapsed = performance.now() - start;
    console.log(`Atomics.notify:            ${(elapsed / ITERATIONS * 1000).toFixed(2)}μs × ${ITERATIONS} = ${elapsed.toFixed(1)}ms`);
}

// 5. TypedArray.set (memcpy) for different sizes
function benchTypedArraySet() {
    for (const size of [1, 8, 16, 64, 128, 512, 4096]) {
        const src = new Uint8Array(size);
        const dst = new Uint8Array(size);
        const ITERS = 100000;

        const start = performance.now();
        for (let i = 0; i < ITERS; i++) {
            dst.set(src);
        }
        const elapsed = performance.now() - start;
        console.log(`TypedArray.set(${String(size).padStart(4)}):   ${(elapsed / ITERS * 1000).toFixed(2)}μs × ${ITERS} = ${elapsed.toFixed(1)}ms`);
    }
}

// 6. Float64Array indexed read
function benchFloat64Read() {
    const sab = new SharedArrayBuffer(8 * 14 * 128);
    const arr = new Float64Array(sab);
    for (let i = 0; i < arr.length; i++) arr[i] = i;

    const ITERS = 100000;
    let sum = 0;
    const start = performance.now();
    for (let i = 0; i < ITERS; i++) {
        sum += arr[i % (14 * 128)];
    }
    const elapsed = performance.now() - start;
    console.log(`Float64Array read (14×128): ${(elapsed / ITERS * 1000).toFixed(2)}μs × ${ITERS} = ${elapsed.toFixed(1)}ms (sum=${sum.toFixed(0)})`);
}

// 7. Object allocation cost (what extractObservation does)
function benchObjectAlloc() {
    const ITERS = 100000;
    const results: any[] = [];

    const start = performance.now();
    for (let i = 0; i < ITERS; i++) {
        results.push({
            playerX: 1, playerY: 2, playerVelX: 3, playerVelY: 4,
            playerAngle: 5, playerAngularVel: 6, playerIsHeavy: false,
            opponents: [{ x: 7, y: 8, velX: 9, velY: 10, isHeavy: false, alive: true }],
            tick: 11,
        });
    }
    const elapsed = performance.now() - start;
    console.log(`Object alloc (obs-like):    ${(elapsed / ITERS * 1000).toFixed(2)}μs × ${ITERS} = ${elapsed.toFixed(1)}ms`);
    results.length = 0;
}

// 8. Object mutation (what pre-allocated extractObservation does)
function benchObjectMutate() {
    const ITERS = 100000;
    const template: any = {
        playerX: 0, playerY: 0, playerVelX: 0, playerVelY: 0,
        playerAngle: 0, playerAngularVel: 0, playerIsHeavy: false,
        opponents: [{ x: 0, y: 0, velX: 0, velY: 0, isHeavy: false, alive: false }],
        tick: 0,
    };

    const start = performance.now();
    for (let i = 0; i < ITERS; i++) {
        template.playerX = i;
        template.playerY = i * 2;
        template.playerVelX = i * 3;
        template.playerVelY = i * 4;
        template.playerAngle = i * 5;
        template.playerAngularVel = i * 6;
        template.opponents[0].x = i * 7;
        template.opponents[0].y = i * 8;
        template.tick = i;
    }
    const elapsed = performance.now() - start;
    console.log(`Object mutate (template):   ${(elapsed / ITERS * 1000).toFixed(2)}μs × ${ITERS} = ${elapsed.toFixed(1)}ms`);
}

// 9. Full sendCommand cycle (what the pool does per worker)
function benchSendCommand() {
    const sab = new SharedArrayBuffer(8);
    const cmd = new Int32Array(sab, 0, 1);
    const workerReady = new Int32Array(sab, 4, 1);
    const ITERS = 100000;

    const start = performance.now();
    for (let i = 0; i < ITERS; i++) {
        Atomics.store(cmd, 0, 1);        // set command
        Atomics.store(cmd, 0, 0);        // clear command (matches actual code pattern)
        Atomics.notify(workerReady, 0, 1);
    }
    const elapsed = performance.now() - start;
    console.log(`sendCommand cycle:          ${(elapsed / ITERS * 1000).toFixed(2)}μs × ${ITERS} = ${elapsed.toFixed(1)}ms`);
}

// 10. Atomics.wait blocking (actual thread wakeup)
function benchWaitBlocking() {
    const { Worker } = require('worker_threads');
    const ITERS = 500;

    // Use two SABs for a clean ping-pong handshake
    const pingSab = new SharedArrayBuffer(4);  // main -> worker signal
    const pongSab = new SharedArrayBuffer(4);  // worker -> main signal
    const ping = new Int32Array(pingSab);
    const pong = new Int32Array(pongSab);

    const workerCode = `
        const { parentPort } = require('worker_threads');
        parentPort.on('message', (data) => {
            const ping = new Int32Array(data.pingSab);
            const pong = new Int32Array(data.pongSab);
            for (let i = 0; i < ${ITERS}; i++) {
                // Wait for main to ping (value 0 -> wait until 1)
                Atomics.wait(ping, 0, 0);
                // Signal back
                Atomics.store(pong, 0, 1);
                Atomics.notify(pong, 0, 1);
                // Reset ping so we block next iteration
                Atomics.store(ping, 0, 0);
            }
            process.exit(0);
        });
    `;

    try {
        const w = new Worker(workerCode, { eval: true });
        w.postMessage({ pingSab, pongSab });

        // Warmup: let worker reach its first Atomics.wait
        const warmup = performance.now();
        while (performance.now() - warmup < 100) {}

        let totalWait = 0;
        const allStart = performance.now();
        for (let i = 0; i < ITERS; i++) {
            // Ping worker
            Atomics.store(ping, 0, 1);
            Atomics.notify(ping, 0, 1);
            // Wait for pong
            const ws = performance.now();
            Atomics.wait(pong, 0, 0, 5000);
            totalWait += performance.now() - ws;
            // Reset pong for next iteration
            Atomics.store(pong, 0, 0);
        }
        const allElapsed = performance.now() - allStart;
        console.log(`Atomics.wait (blocking, 500): ${(totalWait / ITERS * 1000).toFixed(2)}μs avg × ${ITERS} = ${allElapsed.toFixed(1)}ms total`);
        w.terminate();
    } catch (e: any) {
        console.log(`Atomics.wait (blocking): SKIPPED (${e.message})`);
    }
}

// Run all benchmarks
console.log('=== Atomics & Memory Operation Latencies ===\n');
benchWaitNoBlock();
benchStore();
benchLoad();
benchNotify();
console.log('');
benchTypedArraySet();
console.log('');
benchFloat64Read();
console.log('');
benchObjectAlloc();
benchObjectMutate();
console.log('');
benchSendCommand();
benchWaitBlocking();
console.log('\n=== Done ===');
process.exit(0);
