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

  it('starts a server when a port is explicitly configured for IPC server mode', { timeout: 60000 }, async () => {
    const port = IPC_SERVER_TEST_START + 50;
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
});