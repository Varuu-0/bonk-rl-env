import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, resetConfig } from '../../src/config/config-loader';

describe('config-loader worker pool and IPC surfaces (#317)', () => {
    const testDir = path.join(__dirname, '..', 'fixtures', `config-loader-ipc-${process.pid}`);
    const configPath = path.join(testDir, 'config.json');
    const envKeys = [
        'NUM_WORKERS', 'MAX_WORKERS', 'RING_BUFFER_SIZE', 'MESSAGE_TIMEOUT_MS', 'STEP_TIMEOUT_MS',
        'ZMQ_BACKLOG', 'SOCKET_TYPE', 'SERIALIZATION', 'TCP_KEEPALIVE', 'SND_HWM', 'RCV_HWM', 'LINGER_MS',
    ];
    let savedEnv: Record<string, string | undefined>;
    let savedArgv: string[];

    beforeEach(() => {
        savedEnv = {};
        for (const key of envKeys) {
            savedEnv[key] = process.env[key];
            delete (process.env as any)[key];
        }
        savedArgv = [...process.argv];
        process.argv = ['node', 'script.js'];
        resetConfig();
        fs.mkdirSync(testDir, { recursive: true });
        if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    });

    afterEach(() => {
        for (const key of envKeys) {
            if (savedEnv[key] === undefined) delete (process.env as any)[key];
            else process.env[key] = savedEnv[key]!;
        }
        process.argv = savedArgv;
        resetConfig();
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('applies all documented worker-pool and IPC environment variables', () => {
        Object.assign(process.env, {
            NUM_WORKERS: '2',
            MAX_WORKERS: '4',
            RING_BUFFER_SIZE: '32',
            MESSAGE_TIMEOUT_MS: '9999',
            STEP_TIMEOUT_MS: '777',
            ZMQ_BACKLOG: '200',
            SOCKET_TYPE: 'ROUTER',
            SERIALIZATION: 'json',
            TCP_KEEPALIVE: '1',
            SND_HWM: '500',
            RCV_HWM: '600',
            LINGER_MS: '700',
        });

        const config = loadConfig(testDir);
        expect(config.workerPool).toMatchObject({
            numWorkers: 2,
            maxWorkers: 4,
            ringBufferSize: 32,
            messageTimeoutMs: 9999,
            stepTimeoutMs: 777,
        });
        expect(config.server.zmqBacklog).toBe(200);
        expect(config.ipc).toEqual({
            socketType: 'ROUTER',
            serialization: 'json',
            tcpKeepalive: 1,
            sndHwm: 500,
            rcvHwm: 600,
            lingerMs: 700,
        });
    });

    it('uses MAX_WORKERS to cap automatic worker detection from env', () => {
        process.env.MAX_WORKERS = '1';
        const config = loadConfig(testDir);
        expect(config.workerPool.maxWorkers).toBe(1);
        expect(config.workerPool.numWorkers).toBe(1);
    });

    it('ignores invalid worker-pool and IPC environment values', () => {
        Object.assign(process.env, {
            NUM_WORKERS: '2abc',
            MAX_WORKERS: '0',
            RING_BUFFER_SIZE: '15',
            MESSAGE_TIMEOUT_MS: '99',
            STEP_TIMEOUT_MS: 'Infinity',
            ZMQ_BACKLOG: '0',
            SOCKET_TYPE: 'invalid',
            SERIALIZATION: 'yaml',
            TCP_KEEPALIVE: '2',
            SND_HWM: '-1',
            RCV_HWM: '1.5',
            LINGER_MS: 'garbage',
        });

        const config = loadConfig(testDir);
        expect(config.workerPool.numWorkers).toBe(Math.min(os.cpus().length, 8));
        expect(config.workerPool.maxWorkers).toBe(8);
        expect(config.workerPool.ringBufferSize).toBe(16);
        expect(config.workerPool.messageTimeoutMs).toBe(30000);
        expect(config.workerPool.stepTimeoutMs).toBe(5000);
        expect(config.server.zmqBacklog).toBe(100);
        expect(config.ipc).toEqual({
            socketType: 'ROUTER',
            serialization: 'json',
            tcpKeepalive: 0,
            sndHwm: 1000,
            rcvHwm: 1000,
            lingerMs: 1000,
        });

        resetConfig();
        process.env.SOCKET_TYPE = 'DEALER';
        process.env.SERIALIZATION = 'msgpack';
        expect(loadConfig(testDir).ipc).toMatchObject({ socketType: 'DEALER', serialization: 'msgpack' });
    });

    it('applies documented worker-pool and IPC CLI flags', () => {
        process.argv = [
            'node', 'script.js',
            '--num-workers', '3',
            '--max-workers', '5',
            '--ring-buffer-size', '64',
            '--message-timeout-ms', '10000',
            '--step-timeout-ms', '800',
            '--zmq-backlog', '250',
            '--socket-type', 'ROUTER',
            '--serialization', 'json',
            '--tcp-keepalive', '1',
            '--snd-hwm', '501',
            '--rcv-hwm', '601',
            '--linger-ms', '701',
        ];

        const config = loadConfig(testDir);
        expect(config.workerPool).toMatchObject({
            numWorkers: 3,
            maxWorkers: 5,
            ringBufferSize: 64,
            messageTimeoutMs: 10000,
            stepTimeoutMs: 800,
        });
        expect(config.server.zmqBacklog).toBe(250);
        expect(config.ipc).toEqual({
            socketType: 'ROUTER',
            serialization: 'json',
            tcpKeepalive: 1,
            sndHwm: 501,
            rcvHwm: 601,
            lingerMs: 701,
        });
    });

    it('uses --max-workers to cap automatic worker detection', () => {
        process.argv = ['node', 'script.js', '--max-workers', '1'];
        const config = loadConfig(testDir);
        expect(config.workerPool.maxWorkers).toBe(1);
        expect(config.workerPool.numWorkers).toBe(1);
    });

    it('preserves config-file values while env and CLI layers override them', () => {
        fs.writeFileSync(configPath, JSON.stringify({
            server: { zmqBacklog: 50 },
            workerPool: {
                numWorkers: 2,
                maxWorkers: 3,
                ringBufferSize: 8,
                messageTimeoutMs: 300,
                stepTimeoutMs: 400,
            },
            ipc: {
                socketType: 'ROUTER',
                serialization: 'json',
                tcpKeepalive: 0,
                sndHwm: 100,
                rcvHwm: 200,
                lingerMs: 300,
            },
        }));
        process.env.MAX_WORKERS = '4';
        process.env.RING_BUFFER_SIZE = '32';
        process.env.SND_HWM = '500';
        process.argv = [
            'node', 'script.js',
            '--num-workers', '5',
            '--message-timeout-ms', '900',
            '--linger-ms', '700',
            '--zmq-backlog', '80',
        ];

        const config = loadConfig(testDir);
        expect(config.server.zmqBacklog).toBe(80);
        expect(config.workerPool).toMatchObject({
            numWorkers: 5,
            maxWorkers: 4,
            ringBufferSize: 32,
            messageTimeoutMs: 900,
            stepTimeoutMs: 400,
        });
        expect(config.ipc).toEqual({
            socketType: 'ROUTER',
            serialization: 'json',
            tcpKeepalive: 0,
            sndHwm: 500,
            rcvHwm: 200,
            lingerMs: 700,
        });
    });

    it('supports the documented --use-shared-memory flag', () => {
        process.argv = ['node', 'script.js', '--use-shared-memory'];
        expect(loadConfig(testDir).workerPool.useSharedMemory).toBe(true);
    });

    it('rejects invalid CLI values without changing defaults', () => {
        process.argv = [
            'node', 'script.js',
            '--max-workers', '0',
            '--ring-buffer-size', '15',
            '--message-timeout-ms', '99',
            '--step-timeout-ms', 'abc',
            '--zmq-backlog', '0',
            '--tcp-keepalive', '2',
            '--snd-hwm', '-1',
            '--rcv-hwm', '1.5',
            '--linger-ms', 'bad',
        ];

        const config = loadConfig(testDir);
        expect(config.workerPool.maxWorkers).toBe(8);
        expect(config.workerPool.ringBufferSize).toBe(16);
        expect(config.workerPool.messageTimeoutMs).toBe(30000);
        expect(config.workerPool.stepTimeoutMs).toBe(5000);
        expect(config.server.zmqBacklog).toBe(100);
        expect(config.ipc.tcpKeepalive).toBe(0);
        expect(config.ipc.sndHwm).toBe(1000);
        expect(config.ipc.rcvHwm).toBe(1000);
        expect(config.ipc.lingerMs).toBe(1000);
    });

    it('normalizes invalid config-file values before runtime consumption', () => {
        fs.writeFileSync(configPath, JSON.stringify({
            server: { zmqBacklog: 2147483648 },
            workerPool: {
                ringBufferSize: 15,
                messageTimeoutMs: 99,
                stepTimeoutMs: 2147483648,
            },
            ipc: {
                socketType: 'PAIR',
                serialization: 'yaml',
                sndHwm: 2147483648,
                rcvHwm: -1,
                lingerMs: '0x10',
            },
        }));

        const config = loadConfig(testDir);
        expect(config.server.zmqBacklog).toBe(100);
        expect(config.workerPool.ringBufferSize).toBe(16);
        expect(config.workerPool.messageTimeoutMs).toBe(30000);
        expect(config.workerPool.stepTimeoutMs).toBe(5000);
        expect(config.ipc).toMatchObject({
            socketType: 'ROUTER',
            serialization: 'json',
            sndHwm: 1000,
            rcvHwm: 1000,
            lingerMs: 1000,
        });
    });
});
