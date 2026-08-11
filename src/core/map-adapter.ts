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
    fricp?: boolean;              // native compact key for f_p (friction polarity)
    fricPlayers?: boolean | number; // native enum f_p: 0=null, 1=false, 2=true
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
    // Native per-type fields (§33.8) surfaced flattened by the exporter:
    angle?: number;
    axis?: { x: number; y: number };       // prismatic local axis
    referenceAngle?: number;               // prismatic reference angle
    lowerTranslation?: number;
    upperTranslation?: number;
    lowerLimit?: number;
    upperLimit?: number;
    maxMotorForce?: number;
    maxMotorTorque?: number;
    motorSpeed?: number;
    enableMotor?: boolean;
    enableLimit?: boolean;
    // Gear (g):
    ja?: number;
    jb?: number;
    ratio?: number;
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
        // Don't require a non-empty bodies[] — a programmatic MapDef with no
        // bodies (e.g. a pure-cap-zone or spawn-only map) must still pass
        // through to preserve its spawnPoints/capZones/joints (#review).
        && (raw.bodies.length === 0 || typeof raw.bodies[0] === 'object')
        && (raw.bodies.length === 0 || !('collidesGroup1' in raw.bodies[0]));
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
        // Native `f_p` selects velocity-independent negative friction (§33.4).
        // `fricPlayers` is enum-typed in the exporter: 2=true (polarity on),
        // 1=false, 0=null. Treat explicit `true` or enum 2 as polarity; the
        // boolean `fricp` form is accepted too but is not an emitted key.
        fricPolarity: body.fricPlayers === true || body.fricPlayers === 2
            || body.fricp === true,
        // Native `f_c` (collisionGroup) passthrough for map-data fidelity; the
        // engine's filter is driven by the exported collidesGroupN booleans
        // (see collides{} below), so f_c is retained as provenance, not read
        // for behavior (P4 differential validation can calibrate exact bits).
        collisionGroup: body.collisionGroup,
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

    // Native map settings (blank map: re:false, nc:false, pq:1, gd:25, fl:false
    // — DEOBFUSCATION §33.1), validated against the native sanitizer
    // (mergeIntoNewMap, pretty 12279-12287): pq kept when 1..2, gd kept when
    // >= 2 (the native guard's `pq <= 100` half is always true since pq <= 2),
    // re/nc/fl kept when booleans.
    const settings = (() => {
        const s = (map as any).settings;
        if (!s || typeof s !== 'object') return undefined;
        const out: NonNullable<MapDef['settings']> = {};
        if (typeof s.re === 'boolean') out.re = s.re;
        if (typeof s.nc === 'boolean') out.nc = s.nc;
        if (typeof s.fl === 'boolean') out.fl = s.fl;
        if (typeof s.pq === 'number' && Number.isInteger(s.pq) && s.pq >= 1 && s.pq <= 2) out.pq = s.pq;
        if (typeof s.gd === 'number' && Number.isFinite(s.gd) && s.gd >= 2) out.gd = s.gd;
        return Object.keys(out).length > 0 ? out : undefined;
    })();

    // Prefer the exporter's flat `bodies[]` (already flattened rect/circle/
    // polygon with x/y/width in map px). Only fall back to physicsBodies when
    // the flat list is absent, and guard against that placeholder format (which
    // carries `position`/`fixtures`, not x/y/width) silently producing
    // degenerate 0×0 bodies.
    const flatBodies = map.bodies && map.bodies.length ? map.bodies : null;
    const bodies = (flatBodies || map.physicsBodies || []).map(toBodyDef);

    // Build a fixture-index -> body-name map so cap zones can resolve their
    // platform body. Export fixtures all share the name "Unnamed Shape", so a
    // body looked up by name alone resolves to the first match. Give each
    // cap-zone-referenced body a fixture-unique name (e.g. "Unnamed Shape#13")
    // so the engine's `bodies.find(b => b.name === zone.fixture)` selects the
    // actual platform rather than the first "Unnamed Shape."
    const flatSource = flatBodies || map.physicsBodies || [];
    const nameByFixture = new Map<number, string>();
    const capFriendlyNames = new Map<number, string>();
    flatSource.forEach((b, i) => {
        if (b && b.fixtureIndex !== undefined) {
            nameByFixture.set(b.fixtureIndex, b.name ?? `body_${i}`);
        }
    });
    // Pre-rename every cap-zone-referenced fixture to a unique friendly name,
    // mutating the exported bodies list we already derived `bodies` from so
    // find-by-name is unambiguous. Flat bodies carry the fixtureIndex on the
    // body, so we match by that.
    const capFixtureIndexes = new Set<number>(
        (map.capZones || []).map(z => z.fixtureIndex).filter((x): x is number => typeof x === 'number'),
    );
    bodies.forEach((b, i) => {
        const fxIdx = flatSource[i]?.fixtureIndex;
        if (fxIdx !== undefined && capFixtureIndexes.has(fxIdx)) {
            const uniqueName = `${b.name ?? `body_${i}`}#${fxIdx}`;
            b.name = uniqueName;
            capFriendlyNames.set(fxIdx, uniqueName);
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

    // Cap zones: resolve fixtureIndex -> the unique named platform body.
    const capZones = (map.capZones || []).map((zone, i) => {
        const fixtureName = zone.fixtureIndex !== undefined
            ? capFriendlyNames.get(zone.fixtureIndex) ?? nameByFixture.get(zone.fixtureIndex)
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
    // index -> name using the derived bodies[] (which carries the unique
    // cap-zone names), keyed by the flat body's bodyIndex or array position.
    const bodiesByName = new Map<number, string>();
    flatSource.forEach((b, i) => {
        if (b) bodiesByName.set(b.bodyIndex ?? i, bodies[i]?.name ?? b.name ?? `body_${i}`);
    });
    const joints = (map.physicsJoints || []).map((j, jointIdx) => {
        // bodyA must be a valid, non-negative body index; an out-of-range or
        // negative bodyA is a malformed reference and cannot resolve.
        const bodyA = j.bodyA !== undefined && j.bodyA >= 0
            ? bodiesByName.get(j.bodyA)
            : undefined;
        // bodyB: -1 means the joint is anchored to the ground (world). Forward
        // it as a ground joint (empty bodyB) rather than dropping it — P2
        // supports ground-anchored joints via a synthetic static ground body.
        const isGround = j.bodyB !== undefined && j.bodyB < 0;
        const bodyB = j.bodyB !== undefined && j.bodyB >= 0
            ? bodiesByName.get(j.bodyB)
            : undefined;
        const safeType = (t: string | undefined): string =>
            t === undefined ? 'rv' : t;
        const out: Record<string, unknown> = {
            type: safeType(j.type),
            // Joints are named by their array position so gear referents (which
            // reference `physicsJoints` by index) resolve consistently.
            name: `joint_${jointIdx}`,
            bodyA: bodyA ?? '',
            bodyB: bodyB ?? '',
            isGround,
            anchorA: j.anchorA,
            anchorB: j.anchorB,
            collideConnected: j.collideConnected ?? j.data?.cc ?? false,
            // Native per-type fields (§33.8) forwarded for exact construction:
            angle: j.angle,
            axis: j.axis,                          // prismatic local axis
            referenceAngle: j.referenceAngle,       // prismatic reference angle
            lowerTranslation: j.lowerTranslation,
            upperTranslation: j.upperTranslation,
            lowerLimit: j.lowerLimit,
            upperLimit: j.upperLimit,
            maxMotorForce: j.maxMotorForce,
            maxMotorTorque: j.maxMotorTorque,
            motorSpeed: j.motorSpeed,
            enableMotor: j.enableMotor,
            enableLimit: j.enableLimit,
            length: j.length,
            rayCast: (j as any).rayCast,
        };
        // Gear (g) referents: ja/jb index into the SAME joints array.
        if (j.type === 'g' || safeType(j.type) === 'g') {
            out.ratio = j.ratio ?? 1;
            const src = map.physicsJoints || [];
            const ja = (j as any).ja !== undefined ? (j as any).ja : undefined;
            const jb = (j as any).jb !== undefined ? (j as any).jb : undefined;
            if (ja !== undefined && src[ja]) out.jointA = `joint_${ja}`;
            if (jb !== undefined && src[jb]) out.jointB = `joint_${jb}`;
        }
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
        settings,
    };
}