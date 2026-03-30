/**
 * VisualServer — Express + Socket.IO server for streaming game state to a browser client.
 *
 * Receives MapDef (static geometry) and Observation (dynamic per-tick state) from the
 * simulation and broadcasts them to connected browser clients for real-time rendering.
 *
 * Architecture:
 *   - Map geometry is sent once on client connection (static).
 *   - Per-frame state is broadcast to all clients via the 'state' event.
 *   - The browser client (served from public/index.html) renders using Canvas 2D.
 */

import * as http from 'http';
import * as path from 'path';
import express from 'express';
import { Server as SocketIOServer, Socket } from 'socket.io';
import cors from 'cors';

import type { MapDef } from '../core/physics-engine';
import type { Observation } from '../core/environment';

// ─── Types ───────────────────────────────────────────────────────────

/** Per-player state sent to the browser each frame. */
interface PlayerFrame {
  x: number;
  y: number;
  isHeavy: boolean;
  alive: boolean;
}

/** Full frame payload emitted to all clients every tick. */
interface FrameData {
  players: PlayerFrame[];
  tick: number;
}

// ─── VisualServer ────────────────────────────────────────────────────

/** Human-readable input state sent by browser clients. */
interface HumanInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  heavy: boolean;
  grapple: boolean;
}

export class VisualServer {
  private port: number;
  private app: ReturnType<typeof express> | null = null;
  private httpServer: http.Server | null = null;
  private io: SocketIOServer | null = null;
  private mapDef: MapDef | null = null;
  private _currentAction: number = 0;

  constructor(port: number = 3000) {
    this.port = port;
  }

  /**
   * Start the HTTP server and Socket.IO.
   *
   * @param mapDef — Static map geometry, sent once to each connecting client.
   */
  async start(mapDef: MapDef): Promise<void> {
    this.mapDef = mapDef;

    // Express app with CORS enabled for development convenience
    this.app = express();
    this.app.use(cors());

    // Serve the static browser client (index.html, CSS, JS)
    const publicDir = path.join(__dirname, 'public');
    this.app.use(express.static(publicDir));

    // Create HTTP server and attach Socket.IO
    this.httpServer = http.createServer(this.app);
    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    // Handle client connections
    this.io.on('connection', (socket: Socket) => {
      const clientCount = this.io?.engine?.clientsCount ?? 0;
      console.log(`[VisualServer] Client connected (id=${socket.id}, total=${clientCount})`);

      // Send the full static map definition immediately on connection
      socket.emit('map', this.mapDef);

      // Listen for human input
      socket.on('input', (input: HumanInput) => {
        this._currentAction = this.encodeInput(input);
      });

      socket.on('disconnect', () => {
        this._currentAction = 0;
        const remaining = this.io?.engine?.clientsCount ?? 0;
        console.log(`[VisualServer] Client disconnected (id=${socket.id}, remaining=${remaining})`);
      });
    });

    // Start listening
    return new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, () => {
        console.log(`[VisualServer] Listening on http://localhost:${this.port}`);
        resolve();
      });

      this.httpServer!.on('error', (err: Error) => {
        console.error(`[VisualServer] Failed to start: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * Return the current human input as an action integer.
   * Bit 0=left, 1=right, 2=up, 3=down, 4=heavy, 5=grapple.
   * Returns 0 when no human client is connected or no input received.
   */
  getAction(): number {
    return this._currentAction;
  }

  private encodeInput(input: HumanInput): number {
    let action = 0;
    if (input.left)    action |= 1;
    if (input.right)   action |= 2;
    if (input.up)      action |= 4;
    if (input.down)    action |= 8;
    if (input.heavy)   action |= 16;
    if (input.grapple) action |= 32;
    return action;
  }

  /**
   * Broadcast a single frame of game state to all connected clients.
   *
   * @param observation — Current environment observation (player + opponents).
   * @param tickCount — Current simulation tick (used for synchronization/debugging).
   */
  broadcast(observation: Observation, tickCount: number): void {
    if (!this.io) return;

    const frameData: FrameData = {
      players: [
        {
          x: observation.playerX,
          y: observation.playerY,
          isHeavy: observation.playerIsHeavy,
          alive: true,
        },
        ...observation.opponents.map((op) => ({
          x: op.x,
          y: op.y,
          isHeavy: op.isHeavy,
          alive: op.alive,
        })),
      ],
      tick: tickCount,
    };

    this.io.emit('state', frameData);
  }

  /**
   * Gracefully shut down the server, closing all connections.
   */
  async stop(): Promise<void> {
    // Close all Socket.IO connections (this also closes the underlying HTTP server)
    if (this.io) {
      await new Promise<void>((resolve) => {
        this.io!.close(() => {
          console.log('[VisualServer] Socket.IO closed');
          resolve();
        });
      });
      this.io = null;
    }

    // Close the HTTP server only if it's still listening
    if (this.httpServer && this.httpServer.listening) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close((err) => {
          if (err) {
            console.warn(`[VisualServer] HTTP server close warning: ${err.message}`);
          } else {
            console.log('[VisualServer] HTTP server closed');
          }
          resolve();
        });
      });
    }
    this.httpServer = null;

    this.app = null;
    this.mapDef = null;
  }
}
