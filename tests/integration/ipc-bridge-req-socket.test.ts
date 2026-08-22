/**
 * ipc-bridge-req-socket.test.ts — ZMQ REQ-socket regression coverage for issue #410
 *
 * A standard ZeroMQ REQ peer sends its payload as [identity, "", payload] and
 * its receive state machine silently discards any reply that does not re-echo
 * the empty delimiter frame. The bridge previously always replied with the
 * 2-frame DEALER envelope [identity, payload], so every REQ client hung
 * forever while the server had already executed the step/reset — a client
 * timeout plus retry would then double-step the pool.
 *
 * The fix mirrors the request envelope on both reply sites (the eager
 * telemetry-window send and the trailing send). These tests connect a real
 * zmq.Request socket to a started bridge, assert replies arrive within an
 * explicit receive timeout, verify DEALER peers keep their plain 2-frame
 * replies, and pin down the frame shapes of both reply paths.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as zmq from 'zeromq';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { getTelemetryController } from '../../src/telemetry/telemetry-controller';
import { PortManager } from '../../src/utils/port-manager';

// Explicit REQ receive/send timeouts: pre-fix the REQ client fails with a
// receive timeout instead of hanging the suite forever.
const REQ_TIMEOUT_MS = 15000;

describe('IpcBridge ZMQ REQ-socket envelope mirroring (issue #410)', () => {
  let bridge: IpcBridge;
  let portManager: PortManager;
  let port: number;
  let trailingCapturePort: number;
  let eagerCapturePort: number;

  beforeAll(async () => {
    // Dedicated range so concurrent vitest forks cannot collide with other
    // ipc-bridge suites (e.g. ipc-bridge-options.test.ts).
    portManager = new PortManager({ startPort: 16000, endPort: 16099 });
    port = portManager.allocate();
    bridge = new IpcBridge({ server: { port } } as any);
    // start() runs the serve loop until close(), so do not await it;
    // await ready instead of a fixed sleep so bind failures surface here.
    void bridge.start();
    await bridge.ready;
  }, 30000);

  afterAll(async () => {
    try {
      await bridge.close();
    } catch {
      /* ignore */
    }
    portManager.release(port);
    if (trailingCapturePort !== undefined) portManager.release(trailingCapturePort);
    if (eagerCapturePort !== undefined) portManager.release(eagerCapturePort);
  }, 10000);

  it('REQ client receives replies for init, reset and step', async () => {
    const req = new zmq.Request({ receiveTimeout: REQ_TIMEOUT_MS, sendTimeout: REQ_TIMEOUT_MS });
    await req.connect(`tcp://127.0.0.1:${port}`);

    const sendCommand = async (client: zmq.Request, cmd: object): Promise<any> => {
      await client.send(JSON.stringify(cmd));
      const [reply] = await client.receive();
      return JSON.parse(reply.toString());
    };

    try {
      const initReply = await sendCommand(req, { command: 'init', numEnvs: 1, useSharedMemory: false });
      expect(initReply.status).toBe('ok');

      const resetReply = await sendCommand(req, { command: 'reset', seeds: [7] });
      expect(resetReply.status).toBe('ok');
      expect(resetReply.data.observation).toHaveLength(1);

      const stepReply = await sendCommand(req, { command: 'step', actions: [0] });
      expect(stepReply.status).toBe('ok');
      expect(stepReply.data).toHaveLength(1);
    } finally {
      req.close();
    }
  }, 60000);

  it('DEALER clients still receive normal replies on the same endpoint', async () => {
    const dealer = new zmq.Dealer();
    await dealer.connect(`tcp://127.0.0.1:${port}`);

    const sendCommand = async (cmd: object): Promise<any> => {
      await dealer.send(JSON.stringify(cmd));
      const [reply] = await dealer.receive();
      return JSON.parse(reply.toString());
    };

    try {
      // The REQ test above engaged per-client session mode, so this identity
      // owns its own session instead of borrowing any bypass pool.
      const initReply = await sendCommand({ command: 'init', numEnvs: 1, useSharedMemory: false });
      expect(initReply.status).toBe('ok');

      const resetReply = await sendCommand({ command: 'reset', seeds: [3] });
      expect(resetReply.status).toBe('ok');
      expect(resetReply.data.observation).toHaveLength(1);

      const stepReply = await sendCommand({ command: 'step', actions: [0] });
      expect(stepReply.status).toBe('ok');
      expect(stepReply.data).toHaveLength(1);
    } finally {
      dealer.close();
    }
  }, 60000);

  describe('reply frame shapes (both reply sites)', () => {
    // Safety net so telemetry enabled for the eager-site test cannot leak
    // into anything else sharing this worker.
    afterAll(() => {
      getTelemetryController().updateFlags({ enableTelemetry: false });
    });

    it('mirrors the REQ envelope at the trailing reply site', async () => {
      trailingCapturePort = portManager.allocate();
      const captureBridge = new IpcBridge({ server: { port: trailingCapturePort } } as any);
      const sentFrames: any[][] = [];
      (captureBridge as any)._wrappedSend = async (frames: any[]) => {
        sentFrames.push(frames);
      };
      try {
        await (captureBridge as any).handleRequest(Buffer.from('req-peer'), JSON.stringify({ command: 'reset' }), {
          reqEnvelope: true,
        });
        await (captureBridge as any).handleRequest(Buffer.from('dealer-peer'), JSON.stringify({ command: 'reset' }));
        expect(sentFrames).toHaveLength(2);

        expect(sentFrames[0]).toHaveLength(3);
        expect(sentFrames[0][0].toString()).toBe('req-peer');
        // The echoed empty delimiter REQ state machines require.
        expect(Buffer.from(sentFrames[0][1]).length).toBe(0);
        expect(JSON.parse(sentFrames[0][2].toString()).status).toBe('error');

        expect(sentFrames[1]).toHaveLength(2);
        expect(sentFrames[1][0].toString()).toBe('dealer-peer');
        expect(JSON.parse(sentFrames[1][1].toString()).status).toBe('error');
      } finally {
        try {
          await captureBridge.close();
        } catch {
          /* ignore */
        }
      }
    }, 30000);

    it('mirrors the REQ envelope at the eager telemetry-window reply site', async () => {
      eagerCapturePort = portManager.allocate();
      const captureBridge = new IpcBridge({ server: { port: eagerCapturePort } } as any);
      const sentFrames: any[][] = [];
      (captureBridge as any)._wrappedSend = async (frames: any[]) => {
        sentFrames.push(frames);
      };
      // Force every step boundary into the eager telemetry-window branch.
      getTelemetryController().updateFlags({ enableTelemetry: true, reportInterval: 1 });
      try {
        await captureBridge.initEnv(1, {}, false);
        await (captureBridge as any).handleRequest(
          Buffer.from('req-peer'),
          JSON.stringify({ command: 'step', actions: [0] }),
          { reqEnvelope: true },
        );
        expect(sentFrames).toHaveLength(1);

        expect(sentFrames[0]).toHaveLength(3);
        expect(sentFrames[0][0].toString()).toBe('req-peer');
        expect(Buffer.from(sentFrames[0][1]).length).toBe(0);
        const payload = JSON.parse(sentFrames[0][2].toString());
        expect(payload.status).toBe('ok');
        expect(payload.data).toHaveLength(1);
      } finally {
        getTelemetryController().updateFlags({ enableTelemetry: false });
        try {
          await captureBridge.close();
        } catch {
          /* ignore */
        }
      }
    }, 60000);
  });
});
