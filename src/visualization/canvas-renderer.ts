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

import type { MapDef, PlayerInput } from '../core/physics-engine';
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

export class VisualServer {
  private port: number;
  private app: ReturnType<typeof express> | null = null;
  private httpServer: http.Server | null = null;
  private io: SocketIOServer | null = null;
  private mapDef: MapDef | null = null;
  private humanInput: PlayerInput | null = null;

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

      socket.on('input', (input: PlayerInput) => {
        if (input && typeof input === 'object') {
          this.humanInput = {
            left: !!input.left,
            right: !!input.right,
            up: !!input.up,
            down: !!input.down,
            heavy: !!input.heavy,
            grapple: !!input.grapple,
          };
        }
      });

      socket.on('disconnect', () => {
        const remaining = this.io?.engine?.clientsCount ?? 0;
        console.log(`[VisualServer] Client disconnected (id=${socket.id}, remaining=${remaining})`);
        if (remaining === 0) {
          this.humanInput = null;
        }
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
   * Get the latest human input. Returns 0 (no action) if no human is connected.
   */
  getAction(): PlayerInput | number {
    return this.humanInput ?? 0;
  }

  /**
   * Gracefully shut down the server, closing all connections.
   */
  async stop(): Promise<void> {
    // Close all Socket.IO connections
    if (this.io) {
      await new Promise<void>((resolve) => {
        this.io!.close(() => {
          console.log('[VisualServer] Socket.IO closed');
          resolve();
        });
      });
      this.io = null;
    }

    // Close the HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => {
          if (err) {
            console.error(`[VisualServer] Error closing HTTP server: ${err.message}`);
            reject(err);
          } else {
            console.log('[VisualServer] HTTP server closed');
            resolve();
          }
        });
      });
      this.httpServer = null;
    }

    this.app = null;
    this.mapDef = null;
    this.humanInput = null;
  }
}
