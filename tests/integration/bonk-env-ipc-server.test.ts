/**
 * bonk-env-ipc-server.test.ts — Regression coverage for issue #223
 *
 * A BonkEnv created with enableIpcServer: true must actually bind its
 * allocated port with an IpcBridge so an external ZMQ DEALER client (the
 * Python BonkVecEnv transport) can connect and complete init/reset/step.
 * Previously the port was allocated/reserved but never bound — clients got
 * ECONNREFUSED while isActive() reported success.
 */
import { describe, it, expect } from 'vitest';
import * as net from 'net';
import * as zmq from 'zeromq';
import { BonkEnv } from '../../src/env/bonk-env';
import { PortManager } from '../../src/utils/port-manager';

const IPC_SERVER_TEST_START = 16400;

function canConnectTcp(port: number, timeoutMs: number = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for condition (waited ${timeoutMs}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

describe('BonkEnv IPC server mode (issue #223)', () => {
  it('binds env.port and serves an external ZMQ DEALER client', { timeout: 60000 }, async () => {
    const portManager = new PortManager({ startPort: IPC_SERVER_TEST_START, endPort: IPC_SERVER_TEST_START + 49 });
    const env = new BonkEnv({
      numEnvs: 1,
      useSharedMemory: false,
      portManager,
      enableIpcServer: true,
    });

    await env.start();

    try {
      expect(env.isActive()).toBe(true);
      expect(await canConnectTcp(env.port)).toBe(true);

      const client = new zmq.Dealer();
      try {
        await client.connect(`tcp://127.0.0.1:${env.port}`);

        await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
        const initReply = JSON.parse((await client.receive())[0].toString());
        expect(initReply.status).toBe('ok');

        await client.send(JSON.stringify({ command: 'reset', seeds: [42] }));
        const resetReply = JSON.parse((await client.receive())[0].toString());
        expect(resetReply.status).toBe('ok');
        expect(resetReply.data.observation).toHaveLength(1);

        await client.send(JSON.stringify({ command: 'step', actions: [0] }));
        const stepReply = JSON.parse((await client.receive())[0].toString());
        expect(stepReply.status).toBe('ok');
        expect(stepReply.data).toHaveLength(1);
        expect(Number.isFinite(stepReply.data[0].reward)).toBe(true);
        expect(typeof stepReply.data[0].done).toBe('boolean');
      } finally {
        client.close();
      }
    } finally {
      await env.stop();
    }

    expect(env.isActive()).toBe(false);
    expect(portManager.isAllocated(env.port)).toBe(false);
    expect(await canConnectTcp(env.port)).toBe(false);
  });

  it('binds an explicitly configured port when IPC server mode is enabled', { timeout: 60000 }, async () => {
    const port = IPC_SERVER_TEST_START + 50;
    const portManager = new PortManager({ startPort: port, endPort: port + 10 });
    const env = new BonkEnv({
      numEnvs: 1,
      useSharedMemory: false,
      portManager,
      port,
      enableIpcServer: true,
    });

    await env.start();

    try {
      expect(env.isActive()).toBe(true);
      expect(await canConnectTcp(env.port)).toBe(true);

      const client = new zmq.Dealer();
      try {
        await client.connect(`tcp://127.0.0.1:${env.port}`);
        await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
        const initReply = JSON.parse((await client.receive())[0].toString());
        expect(initReply.status).toBe('ok');
      } finally {
        client.close();
      }
    } finally {
      await env.stop();
    }

    expect(portManager.isAllocated(env.port)).toBe(false);
  });

  it('does not bind a port when IPC server mode is not requested', { timeout: 60000 }, async () => {
    const portManager = new PortManager({ startPort: IPC_SERVER_TEST_START + 100, endPort: IPC_SERVER_TEST_START + 149 });
    const env = new BonkEnv({
      numEnvs: 1,
      useSharedMemory: false,
      portManager,
    });

    await env.start();

    try {
      expect(env.isActive()).toBe(true);
      expect(await canConnectTcp(env.port)).toBe(false);
    } finally {
      await env.stop();
    }

    expect(portManager.isAllocated(env.port)).toBe(false);
  });

  it('does not bind an explicitly configured port without enableIpcServer', { timeout: 60000 }, async () => {
    const port = IPC_SERVER_TEST_START + 150;
    const portManager = new PortManager({ startPort: port, endPort: port + 10 });
    const env = new BonkEnv({
      numEnvs: 1,
      useSharedMemory: false,
      portManager,
      port,
    });

    await env.start();

    try {
      expect(env.isActive()).toBe(true);
      expect(await canConnectTcp(env.port)).toBe(false);
    } finally {
      await env.stop();
    }

    expect(portManager.isAllocated(env.port)).toBe(false);
  });

  it('client full-shutdown tears the environment down (isActive/port follow reality)', { timeout: 60000 }, async () => {
    const portManager = new PortManager({ startPort: IPC_SERVER_TEST_START + 200, endPort: IPC_SERVER_TEST_START + 249 });
    const env = new BonkEnv({
      numEnvs: 1,
      useSharedMemory: false,
      portManager,
      enableIpcServer: true,
    });

    await env.start();

    const client = new zmq.Dealer();
    try {
      await client.connect(`tcp://127.0.0.1:${env.port}`);
      await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
      const initReply = JSON.parse((await client.receive())[0].toString());
      expect(initReply.status).toBe('ok');

      await client.send(JSON.stringify({ command: 'close', shutdown: true }));
      const closeReply = JSON.parse((await client.receive())[0].toString());
      expect(closeReply.status).toBe('ok');

      await waitFor(() => !env.isActive());
    } finally {
      client.close();
    }

    expect(env.isActive()).toBe(false);
    expect(portManager.isAllocated(env.port)).toBe(false);
    expect(await canConnectTcp(env.port)).toBe(false);
  });

  it('rejects start() when the port cannot be bound (EADDRINUSE)', { timeout: 60000 }, async () => {
    const port = IPC_SERVER_TEST_START + 250;
    const portManager = new PortManager({ startPort: port, endPort: port + 10 });
    const blocker = await occupyPort(port);

    try {
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager,
        port,
        enableIpcServer: true,
      });

      await expect(env.start()).rejects.toThrow();
      expect(env.isActive()).toBe(false);
      expect(portManager.isAllocated(port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('bind failure rejects start() without leaking an unhandled rejection from the serve chain (#252)', { timeout: 60000 }, async () => {
    const port = IPC_SERVER_TEST_START + 255;
    const portManager = new PortManager({ startPort: port, endPort: port + 5 });
    const blocker = await occupyPort(port);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const env = new BonkEnv({
        numEnvs: 1,
        useSharedMemory: false,
        portManager,
        port,
        enableIpcServer: true,
      });

      await expect(env.start()).rejects.toThrow();
      expect(env.isActive()).toBe(false);
      expect(portManager.isAllocated(port)).toBe(false);

      // Let any stray rejection propagation settle. The rejected side of the
      // `serve.then(...)` teardown chain must be handled (bind failures surface
      // via bridge.ready), so a failed bind must not emit an unhandled rejection
      // that would terminate the process on Node >=20 (unhandled-rejections=throw).
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('survives a stop()/start() cycle without the stale serve teardown killing it (#223)', { timeout: 60000 }, async () => {
    const portManager = new PortManager({ startPort: IPC_SERVER_TEST_START + 300, endPort: IPC_SERVER_TEST_START + 349 });
    const env = new BonkEnv({
      numEnvs: 1,
      useSharedMemory: false,
      portManager,
      enableIpcServer: true,
    });

    async function driveClient() {
      const client = new zmq.Dealer();
      try {
        await client.connect(`tcp://127.0.0.1:${env.port}`);
        await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
        const initReply = JSON.parse((await client.receive())[0].toString());
        expect(initReply.status).toBe('ok');
        await client.send(JSON.stringify({ command: 'step', actions: [0] }));
        const stepReply = JSON.parse((await client.receive())[0].toString());
        expect(stepReply.status).toBe('ok');
        expect(stepReply.data).toHaveLength(1);
      } finally {
        client.close();
      }
    }

    await env.start();
    expect(env.isActive()).toBe(true);
    await driveClient();
    await env.stop();
    expect(env.isActive()).toBe(false);

    // Give the first serve loop's settle handler (now guarded on its own bridge
    // instance) a chance to run so a regression that tears down a restarted env
    // would manifest here.
    await new Promise((r) => setTimeout(r, 200));

    await env.start();
    expect(env.isActive()).toBe(true);
    expect(await canConnectTcp(env.port)).toBe(true);
    await driveClient();

    // The restarted service is still alive and serving well after the first
    // cycle's serve promise has settled.
    expect(env.isActive()).toBe(true);
    expect(await canConnectTcp(env.port)).toBe(true);

    await env.stop();
    expect(env.isActive()).toBe(false);
  });

  it('one client session close does not clear global init for other clients (#223)', { timeout: 60000 }, async () => {
    const portManager = new PortManager({ startPort: IPC_SERVER_TEST_START + 350, endPort: IPC_SERVER_TEST_START + 399 });
    const env = new BonkEnv({
      numEnvs: 1,
      useSharedMemory: false,
      portManager,
      enableIpcServer: true,
    });
    await env.start();

    const clientA = new zmq.Dealer();
    const clientB = new zmq.Dealer();
    try {
      await clientA.connect(`tcp://127.0.0.1:${env.port}`);
      await clientB.connect(`tcp://127.0.0.1:${env.port}`);

      async function initStep(client: zmq.Dealer) {
        await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
        const initReply = JSON.parse((await client.receive())[0].toString());
        expect(initReply.status).toBe('ok');
        await client.send(JSON.stringify({ command: 'step', actions: [0] }));
        const stepReply = JSON.parse((await client.receive())[0].toString());
        expect(stepReply.status).toBe('ok');
        await client.send(JSON.stringify({ command: 'reset', seeds: [1] }));
        const resetReply = JSON.parse((await client.receive())[0].toString());
        expect(resetReply.status).toBe('ok');
      }

      await initStep(clientA);
      await initStep(clientB);

      // A ends its session without a full shutdown. On an adopted (host)
      // pool this must be a no-op for the shared global init state.
      await clientA.send(JSON.stringify({ command: 'close' }));
      const closeReply = JSON.parse((await clientA.receive())[0].toString());
      expect(closeReply.status).toBe('ok');

      // B must still init/reset/step against the still-initialized adopted pool.
      await clientB.send(JSON.stringify({ command: 'reset', seeds: [1] }));
      const resetReply = JSON.parse((await clientB.receive())[0].toString());
      expect(resetReply.status).toBe('ok');
      expect(resetReply.data.observation).toHaveLength(1);

      await clientB.send(JSON.stringify({ command: 'step', actions: [0] }));
      const stepReply = JSON.parse((await clientB.receive())[0].toString());
      expect(stepReply.status).toBe('ok');
      expect(stepReply.data).toHaveLength(1);
    } finally {
      clientA.close();
      clientB.close();
      await env.stop();
    }
  });

  it('serializes concurrent programmatic BonkEnv step and IPC requests on the shared pool (#223)', { timeout: 60000 }, async () => {
    const portManager = new PortManager({ startPort: IPC_SERVER_TEST_START + 400, endPort: IPC_SERVER_TEST_START + 449 });
    const env = new BonkEnv({
      numEnvs: 1,
      useSharedMemory: false,
      portManager,
      enableIpcServer: true,
    });
    await env.start();

    const client = new zmq.Dealer();
    try {
      await client.connect(`tcp://127.0.0.1:${env.port}`);
      await client.send(JSON.stringify({ command: 'init', numEnvs: 1, useSharedMemory: false }));
      const initReply = JSON.parse((await client.receive())[0].toString());
      expect(initReply.status).toBe('ok');
      await client.send(JSON.stringify({ command: 'reset', seeds: [1] }));
      const resetReply = JSON.parse((await client.receive())[0].toString());
      expect(resetReply.status).toBe('ok');

      const ipcStep = async () => {
        await client.send(JSON.stringify({ command: 'step', actions: [0] }));
        const reply = JSON.parse((await client.receive())[0].toString());
        expect(reply.status).toBe('ok');
        expect(reply.data).toHaveLength(1);
        return reply;
      };

      // Race the programmatic env API against an IPC request on the SAME
      // adopted pool. The pool-level operation lock must serialize them, so a
      // single DEALER socket only has one receive() in flight per pair; without
      // the lock these would interleave worker signaling and corrupt the shared
      // buffers mid-serialization.
      const [progStep] = await Promise.all([env.step([0]), ipcStep()]);
      expect(progStep).toHaveLength(1);

      const [progReset] = await Promise.all([env.reset([1]), ipcStep()]);
      expect(progReset).toHaveLength(1);

      // The pool is still coherent after the interleaving: a final step works.
      await ipcStep();
    } finally {
      client.close();
      await env.stop();
    }
  });
});