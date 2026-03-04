/**
 * main.ts — Entry point for the bonk.io RL environment with IPC bridge.
 *
 * Replaces the original index.ts (which started the Express/Socket.IO server).
 * Instantiates the BonkEnvironment and starts the ZeroMQ IPC Bridge on port 5555.
 */

import { BonkEnvironment } from './environment';
import { IpcBridge } from './ipc-bridge';

async function main() {
    console.log('=== Bonk.io Headless RL Environment ===');
    console.log('Initializing environment...');

    const env = new BonkEnvironment({
        numOpponents: 1,
        randomOpponent: true,
    });

    const bridge = new IpcBridge(env, 5555);

    // Handle graceful shutdown
    const shutdown = async () => {
        console.log('\nShutting down IPC bridge and physics engine...');
        await bridge.close();
        env.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log('Starting IPC Bridge. Waiting for Python connection...');
    await bridge.start();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
