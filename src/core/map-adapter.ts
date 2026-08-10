/**
 * Map definition adapter.
 *
 * The engine's PhysicsEngine consumes a small, flattened `MapDef` shape
 * (`{ name, spawnPoints, bodies[] (collides nested g1-g4), capZones[],
 * joints[] (name-keyed bodies), physics { ppm, bounds, deathCenter } }`).
 *
 * The Bonk Map Exporter (Webscripts/mapexporter.js) and the bundled maps in
 * `maps/` emit the real bonk.io format instead: `metadata`, `settings`,
 * `spawns[]` (array), `physicsBodies/physicsFixtures/physicsShapes/
 * physicsJoints`, flat `bodies[]` (collidesGroup1-4), and `capZones[]`
 * referencing platforms by `fixtureIndex`. This module converts that real
 * format into the engine's `MapDef` so shipped maps load faithfully.
 */

import { MapDef } from './physics-engine';

interface FlatBody {
    bodyIndex: number;
    fixtureIndex: number;
    name?: string;
    type?: string;
    bodyType?: string;
    x?: number;
    y?: number;
    angle?: number;
    linearVelocity?: { x: number; y: number };
    angularVelocity?: number;
    static?: boolean;
    isLethal?: boolean;
    noPhysics?: boolean;
    noGrapple?: boolean;
    innerGrapple?: boolean;
    friction?: number;
    restitution?: number;
    density?: number;
    fricPlayers?: boolean;
    collisionGroup?: number;
    collidesGroup1?: boolean;
    collidesGroup2?: boolean;
    collidesGroup3?: boolean;
    collidesGroup4?: boolean;
    collidesPlayers?: boolean;
    color?: number;
    ppm?: number;
    width?: number;
    height?: number;
    radius?: number;
    scale?: number;
    vertices?: { x: number; y: number }[];
}

interface FlatSpawn {
    index?: number;
    name?: string;
    x?: number;
    y?: number;
    xVelocity?: number;
    yVelocity?: number;
    priority?: number;
    ffa?: boolean;
    red?: boolean;
    blue?: boolean;
    green?: boolean;
    yellow?: boolean;
}

interface FlatCapZone {
    index?: number;
    name?: string;
    type?: number;
    typeName?: string;
    captureTime?: number;
    fixtureIndex?: number;
}

interface FlatJoint {
    index?: number;
    type?: string;
    bodyA?: number;
    bodyB?: number;
    anchorA?: { x: number; y: number };
    anchorB?: { x: number; y: number };
    length?: number;
    frequencyHz?: number;
    dampingRatio?: number;
    collideConnected?: boolean;
    data?: Record<string, unknown>;
}

interface ExportedMap {
    metadata?: { name?: string; author?: string; dbid?: number };
    settings?: Record<string, unknown>;
    physics?: Record<string, unknown>;
    spawns?: FlatSpawn[];
    capZones?: FlatCapZone[];
    bodies?: FlatBody[];
    physicsBodies?: FlatBody[];
    physicsJoints?: FlatJoint[];
    physicsFixtures?: unknown[];
    physicsShapes?: unknown[];
}

/**
 * Detect whether `raw` is already the engine's internal `MapDef` (a flattened
 * `spawnPoints` object + nested-collides `bodies[]`) versus the real exported
 * bonk format. A `spawnPoints` object with a `bodies[]` array marks MapDef.
 */
function isInternalMapDef(raw: any): raw is MapDef {
    return !!raw
        && typeof raw === 'object'
        && raw.spawnPoints !== null
        && typeof raw.spawnPoints === 'object'
        && !Array.isArray(raw.spawnPoints)
        && Array.isArray(raw.bodies)
        && raw.bodies.length > 0
        && typeof raw.bodies[0] === 'object'
        && !('collidesGroup1' in raw.bodies[0]);
}

/** Convert a flat body into a MapBodyDef, preserving facade metadata. */
function toBodyDef(body: FlatBody, index: number): any {
    return {
        name: body.name ?? body.bodyType ?? `body_${index}`,
        type: (body.type === 'rect' || body.type === 'circle'
            || body.type === 'polygon') ? body.type : 'rect',
        x: body.x ?? 0,
        y: body.y ?? 0,
        width: body.width,
        height: body.height,
        radius: body.radius,
        vertices: body.vertices,
        static: body.static ?? body.bodyType === 'static',
        density: body.density,
        restitution: body.restitution,
        angle: body.angle,
        isLethal: body.isLethal,
        noPhysics: body.noPhysics,
        noGrapple: body.noGrapple,
        innerGrapple: body.innerGrapple,
        friction: body.friction,
        // The exporter emits flat collidesGroupN booleans; the engine reads a
        // nested `collides: { g1, g2, g3, g4 }`. Convert here.
        collides: {
            g1: body.collidesGroup1 ?? false,
            g2: body.collidesGroup2 ?? false,
            g3: body.collidesGroup3 ?? false,
            g4: body.collidesGroup4 ?? false,
        },
        color: body.color,
        linearVelocity: body.linearVelocity,
        angularVelocity: body.angularVelocity,
        surfaceName: body.bodyType,
    };
}

/**
 * Normalize a loaded map into the engine's internal MapDef. Accepts either the
 * real exported bonk format (from maps/*.json or the mapexporter) or an already
 * normalized MapDef (returned unchanged).
 */
export function normalizeMap(raw: unknown): MapDef {
    // Already in engine MapDef shape — pass through unchanged.
    if (isInternalMapDef(raw)) return raw;

    const map = (raw || {}) as ExportedMap;
    const bodies = (map.bodies || map.physicsBodies || []).map(toBodyDef);

    // Build a fixture-index -> body-name map so cap zones can resolve their
    // platform body by name (the engine links zones to named platforms).
    const nameByFixture = new Map<number, string>();
    (map.bodies || map.physicsBodies || []).forEach((b, i) => {
        if (b && b.fixtureIndex !== undefined) {
            nameByFixture.set(b.fixtureIndex, b.name ?? `body_${i}`);
        }
    });

    // Map-mode default spawn resolution: pick blue/red-capable spawn points
    // first, then ffa, then any. Mirror the engine's reset() team logic and
    // prefer distinct blue/red positions for realistic 1v1 (some maps flag
    // every spawn as both blue and red; skip an already-chosen spawn for the
    // other team so the two teams don't stack).
    const spawns = map.spawns || [];
    const blueCandidates = spawns.filter(sp => sp && sp.blue === true);
    const redCandidates = spawns.filter(sp => sp && sp.red === true);
    const ffaCandidates = spawns.filter(sp => sp && sp.ffa === true);
    const anyWithCoords = spawns.filter(sp => sp && sp.x !== undefined && sp.y !== undefined);

    let blueSpawn = blueCandidates[0] || ffaCandidates[0] || anyWithCoords[0];
    let redSpawn = redCandidates.find(sp => sp !== blueSpawn)
        || redCandidates[0]
        || ffaCandidates.find(sp => sp !== blueSpawn)
        || anyWithCoords.find(sp => sp !== blueSpawn)
        || anyWithCoords[0];

    const toPoint = (sp: FlatSpawn | undefined): { x: number; y: number } | undefined =>
        sp && sp.x !== undefined && sp.y !== undefined ? { x: sp.x, y: sp.y } : undefined;

    const bluePt = toPoint(blueSpawn);
    const redPt = toPoint(redSpawn);
    const spawnPoints: Record<string, { x: number; y: number }> = {};
    if (bluePt) spawnPoints.team_blue = bluePt;
    if (redPt) spawnPoints.team_red = redPt;
    // If there was exactly one usable spawn, reuse it for both teams.
    if (!spawnPoints.team_blue || !spawnPoints.team_red) {
        const fallback = toPoint(anyWithCoords[0]);
        if (fallback) {
            if (!spawnPoints.team_blue) spawnPoints.team_blue = fallback;
            if (!spawnPoints.team_red) spawnPoints.team_red = fallback;
        }
    }

    // Cap zones: resolve fixtureIndex -> named platform body.
    const capZones = (map.capZones || []).map((zone, i) => {
        const fixtureName = zone.fixtureIndex !== undefined
            ? nameByFixture.get(zone.fixtureIndex)
            : undefined;
        return {
            index: zone.index ?? i,
            owner: '',
            type: zone.type ?? 1,
            fixture: fixtureName ?? zone.name ?? '',
            shapeType: 'rect',
            l: zone.captureTime,
        };
    });

    // Joints: the exporter stores body references as integer indices into
    // physicsBodies; the engine resolves them by NAME via the body map. Map
    // index -> name using the ordered flat bodies list.
    const bodiesByName = new Map<number, string>();
    (map.bodies || map.physicsBodies || []).forEach((b, i) => {
        if (b) bodiesByName.set(b.bodyIndex ?? i, b.name ?? `body_${i}`);
    });
    const joints = (map.physicsJoints || []).map(j => {
        const bodyA = j.bodyA !== undefined ? bodiesByName.get(j.bodyA) : undefined;
        const bodyB = j.bodyB !== undefined
            && j.bodyB >= 0
            ? bodiesByName.get(j.bodyB)
            : undefined;
        const safeType = (t: string | undefined): 'rv' | 'distance' | 'lpj' | string =>
            t === undefined ? 'rv' : t;
        const out: Record<string, unknown> = {
            type: safeType(j.type),
            bodyA: bodyA ?? '',
            bodyB: bodyB ?? '',
            anchorA: j.anchorA,
            anchorB: j.anchorB,
            collideConnected: j.collideConnected ?? false,
        };
        if (j.frequencyHz !== undefined) out.frequencyHz = j.frequencyHz;
        if (j.dampingRatio !== undefined) out.dampingRatio = j.dampingRatio;
        return out;
    });

    const ph = map.physics || {};
    const bounds = {
        width: (ph as any).boundsWidth ?? (ph as any).bounds?.width,
        height: (ph as any).boundsHeight ?? (ph as any).bounds?.height,
    };

    // Compute the map's bounding-box center from its bodies. The native death
    // circle is centered on the map's authored origin (850 map units from the
    // map center); export coordinates are not guaranteed to be world-origin
    // centered, so derive the center from the geometry so spawns survive and
    // discs beyond the circle die correctly (see env mapDeathCenter).
    let deathCenter: { x: number; y: number } | undefined;
    if (bodies.length > 0) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const b of bodies) {
            let bx0 = b.x, bx1 = b.x, by0 = b.y, by1 = b.y;
            if (b.type === 'circle' && b.radius) { bx0 = b.x - b.radius; bx1 = b.x + b.radius; by0 = b.y - b.radius; by1 = b.y + b.radius; }
            else if (b.type === 'rect' && b.width && b.height) { bx0 = b.x - b.width / 2; bx1 = b.x + b.width / 2; by0 = b.y - b.height / 2; by1 = b.y + b.height / 2; }
            else if (b.vertices && b.vertices.length) {
                for (const v of b.vertices) { if (v.x < bx0) bx0 = v.x; if (v.x > bx1) bx1 = v.x; if (v.y < by0) by0 = v.y; if (v.y > by1) by1 = v.y; }
            }
            if (bx0 < minX) minX = bx0; if (bx1 > maxX) maxX = bx1;
            if (by0 < minY) minY = by0; if (by1 > maxY) maxY = by1;
        }
        if (isFinite(minX) && isFinite(maxX) && isFinite(minY) && isFinite(maxY)) {
            deathCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        }
    }

    const physics = (ph as any).ppm !== undefined || bounds.width !== undefined || deathCenter
        ? {
            ppm: (ph as any).ppm,
            bounds: bounds.width !== undefined ? bounds : undefined,
            deathCenter,
        }
        : undefined;

    return {
        name: map.metadata?.name ?? 'Untitled Map',
        spawnPoints,
        bodies,
        capZones: capZones.length > 0 ? capZones : undefined,
        joints: joints.length > 0 ? joints as any : undefined,
        physics,
    };
}