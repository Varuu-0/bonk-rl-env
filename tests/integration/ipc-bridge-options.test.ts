import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IpcBridge } from '../../src/ipc/ipc-bridge';
import { PortManager } from '../../src/utils/port-manager';

describe('IpcBridge consumes IPC socket configuration (#317)', () => {
    let bridge: IpcBridge;
    let portManager: PortManager;
    let port: number;

    beforeAll(() => {
        portManager = new PortManager({ startPort: 15900, endPort: 15999 });
        port = portManager.allocate();
        bridge = new IpcBridge({
            server: { port, zmqBacklog: 250 },
            ipc: {
                socketType: 'ROUTER',
                serialization: 'json',
                tcpKeepalive: 1,
                sndHwm: 501,
                rcvHwm: 601,
                lingerMs: 701,
            },
        } as any);
    });

    afterAll(async () => {
        try { await bridge.close(); } catch { /* best effort cleanup */ }
        portManager.release(port);
    });

    it('applies configured options before the first bind', () => {
        const socket: any = (bridge as any).sock;
        expect(socket.sendHighWaterMark).toBe(501);
        expect(socket.receiveHighWaterMark).toBe(601);
        expect(socket.tcpKeepalive).toBe(1);
        expect(socket.linger).toBe(701);
        expect(socket.backlog).toBe(250);
    });

    it('rejects unsupported protocol variants instead of silently changing the wire contract', () => {
        expect(() => new IpcBridge({ ipc: { socketType: 'DEALER' } } as any)).toThrow(
            'Unsupported ipc.socketType',
        );
        expect(() => new IpcBridge({ ipc: { serialization: 'msgpack' } } as any)).toThrow(
            'Unsupported ipc.serialization',
        );
    });

    it('rejects values outside the native ZeroMQ integer range', () => {
        expect(() => new IpcBridge({ ipc: { sndHwm: 2147483648 } } as any)).toThrow(
            'Invalid ipc.sndHwm',
        );
    });

    it('re-applies configured options when the bridge restarts', async () => {
        const serve1 = bridge.start();
        serve1.catch(() => {});
        await bridge.ready;
        await bridge.close();
        await serve1;

        const serve2 = bridge.start();
        serve2.catch(() => {});
        await bridge.ready;
        const socket: any = (bridge as any).sock;
        expect(socket.sendHighWaterMark).toBe(501);
        expect(socket.receiveHighWaterMark).toBe(601);
        expect(socket.tcpKeepalive).toBe(1);
        expect(socket.linger).toBe(701);
        expect(socket.backlog).toBe(250);

        await bridge.close();
        await serve2;
    }, 30000);
});
