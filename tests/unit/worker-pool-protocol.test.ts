import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerPool } from '../../src/core/worker-pool';

describe('WorkerPool message protocol', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('wraps the message counter and skips IDs with live callbacks', async () => {
    vi.useFakeTimers();
    const pool = new WorkerPool(1) as any;
    const liveAtMax = { resolve: vi.fn(), reject: vi.fn(), timeout: undefined };
    const liveAtZero = { resolve: vi.fn(), reject: vi.fn(), timeout: undefined };
    pool.msgId = 0xFFFFFFFF;
    pool.callbacks.set(0xFFFFFFFF, liveAtMax);
    pool.callbacks.set(0, liveAtZero);

    const worker = { postMessage: vi.fn() };
    const response = pool.sendMessage(worker, { type: 'test' });

    expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, type: 'test' });
    expect(pool.callbacks.get(0xFFFFFFFF)).toBe(liveAtMax);
    expect(pool.callbacks.get(0)).toBe(liveAtZero);

    expect(pool.callbacks.get(1)).toBeDefined();
    const callback = pool.callbacks.get(1);
    pool.callbacks.delete(1);
    clearTimeout(callback.timeout);
    callback.resolve('ok');

    await expect(response).resolves.toBe('ok');
  });

  it('removes the allocated callback when a message times out', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = new WorkerPool(1) as any;
    const worker = { postMessage: vi.fn() };

    const response = pool.sendMessage(worker, { type: 'test' });
    const rejection = expect(response).rejects.toThrow('Message 0 timed out');
    expect(pool.callbacks.has(0)).toBe(true);

    await vi.advanceTimersByTimeAsync(30000);

    await rejection;
    expect(pool.callbacks.has(0)).toBe(false);
  });
});
