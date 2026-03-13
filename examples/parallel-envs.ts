/**
 * parallel-envs.ts — Example script demonstrating parallel environment execution
 *
 * This script demonstrates how to spawn multiple Bonk environments
 * and run them in parallel for RL training.
 *
 * Usage:
 *   npx tsx examples/parallel-envs.ts
 *
 * Expected output:
 *   - Creates 4 environments on ports 6000-6003
 *   - Resets each environment
 *   - Performs a few steps
 *   - Cleans up all environments
 */

import { EnvManager } from '../src/env/env-manager';
import { BonkEnv } from '../src/env/bonk-env';

async function main() {
    console.log('=== Parallel Environments Example ===\n');

    // Create environment manager with default settings
    const manager = new EnvManager({
        portManager: {
            startPort: 6000,
            endPort: 7000
        },
        defaultEnvConfig: {
            numEnvs: 1,
            useSharedMemory: false  // Disable for simplicity in this example
        }
    });

    try {
        // Create a pool of 4 environments
        console.log('Creating pool of 4 environments...\n');
        const envs = await manager.createPool(4);

        console.log(`Created ${envs.length} environments:`);
        for (const env of envs) {
            console.log(`  - ${env.id}: port ${env.port}`);
        }
        console.log();

        // Reset all environments
        console.log('Resetting all environments...');
        const observations = await manager.resetAll([1, 2, 3, 4]);
        console.log(`Received ${observations.length} observation(s)\n`);

        // Perform a few steps
        console.log('Performing 5 steps...');
        for (let step = 0; step < 5; step++) {
            // Create random actions (6 binary flags packed into an integer)
            // Bit 0: left, Bit 1: right, Bit 2: up, Bit 3: down, Bit 4: heavy, Bit 5: grapple
            const actions = envs.map(() => Math.floor(Math.random() * 64));
            
            const results = await manager.stepAll(actions);
            
            console.log(`  Step ${step + 1}:`);
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                if (Array.isArray(result) && result[0]) {
                    const r = result[0];
                    console.log(`    Env ${i}: reward=${r.reward?.toFixed(3)}, done=${r.done}, tick=${r.info?.tick}`);
                } else if (result && result[0]) {
                    const r = result[0];
                    console.log(`    Env ${i}: reward=${r.reward?.toFixed(3)}, done=${r.done}, tick=${r.info?.tick}`);
                }
            }
        }

        console.log('\n=== Example completed successfully ===');
        console.log('All environments ran in parallel without port conflicts.');

    } catch (error) {
        console.error('Error:', error);
        throw error;
    } finally {
        // Clean up all environments
        console.log('\nShutting down all environments...');
        await manager.shutdownAll();
        console.log('Done.');
    }
}

// Also demonstrate creating a single environment manually
async function demonstrateSingleEnv() {
    console.log('\n=== Single Environment Demo ===\n');

    const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false
    });

    console.log(`Created environment: ${env.id}`);
    console.log(`Port: ${env.port}`);

    await env.start();
    console.log('Environment started');

    const obs = await env.reset([42]);
    console.log('Environment reset, observation received');

    await env.stop();
    console.log('Environment stopped');
}

// Run both demonstrations
main()
    .then(() => demonstrateSingleEnv())
    .catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
