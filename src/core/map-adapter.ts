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

import { MapDef, GROUND_BODY_NAME } from './physics-engine';

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
    lowerAngle?: number;
    upperAngle?: number;
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
    // The exporter (Webscripts/mapexporter.js) pushes a literal `null` for any
    // joint it cannot export to keep raw-array indices stable, so entries may
    // be null as well as FlatJoint.
    physicsJoints?: (FlatJoint | null)[];
    physicsFixtures?: unknown[];
    physicsShapes?: unknown[];
}

/**
 * Detect whether `raw` is already the engine's internal `MapDef` (a flattened
 * `spawnPoints` object + nested-collides `bodies[]`) versus the real exported
 * bonk format. A `spawnPoints` object marks MapDef; the real exported format
 * keys spawns under a `spawns[]` array instead, so that positive marker alone
 * is enough to discriminate without requiring a `bodies[]` array.
 */
function isInternalMapDef(raw: any): raw is MapDef {
    return !!raw
        && typeof raw === 'object'
        && raw.spawnPoints !== null
        && typeof raw.spawnPoints === 'object'
        && !Array.isArray(raw.spawnPoints)
        // Accept an omitted or `null` `bodies` key as internal: a programmatic
        // MapDef with no bodies (e.g. a pure-cap-zone or spawn-only map)
        // legitimately carries spawnPoints/capZones/joints without a bodies
        // array and must still pass through to preserve them (#273). The
        // `spawnPoints`-object check above already excludes the real exported
        // format (which uses `spawns[]`), so widening here does not
        // misclassify exported maps.
        && (raw.bodies === undefined || raw.bodies === null || Array.isArray(raw.bodies))
        // Null/undefined array entries (e.g. `bodies: [null]`, valid JSON) are
        // corrupt placeholders, not flat exported bodies — treat them as
        // internal so authored spawnPoints/capZones/joints are preserved and
        // only the empty remainder reaches the pass-through (which sanitizes
        // it) or the exporter path. Any real flat body (collidesGroupN)
        // still classifies the payload as exported (#273).
        && (raw.bodies === undefined
            || raw.bodies === null
            || raw.bodies.every((b: any) => b === null
                || b === undefined
                || (typeof b === 'object' && !('collidesGroup1' in b))));
}

/** Convert a flat body into a MapBodyDef, preserving facade metadata. */
function toBodyDef(body: FlatBody, index: number): any {
    const ox = body.x ?? 0;
    const oy = body.y ?? 0;
    // The exporter emits flat polygon vertices as WORLD coordinates
    // (mapexporter.js:518-521: `x: bx + cx + v[0]`), but PhysicsEngine.addBody
    // consumes MapBodyDef.vertices as BODY-LOCAL while also placing the body at
    // def.x/def.y — treating the absolute vertices as local double-translates
    // every exported polygon by its own position (#318). Normalize the
    // exporter's absolute vertices to body-local here so the engine, renderer,
    // cap-zone sensors and the death-center all agree on one convention.
    const vertices = body.type === 'polygon' && body.vertices
        ? body.vertices.map(v => ({ x: v.x - ox, y: v.y - oy }))
        : body.vertices;
    return {
        name: body.name ?? body.bodyType ?? `body_${index}`,
        type: (body.type === 'rect' || body.type === 'circle'
            || body.type === 'polygon') ? body.type : 'rect',
        x: ox,
        y: oy,
        width: body.width,
        height: body.height,
        radius: body.radius,
        vertices,
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
    // Already in engine MapDef shape — pass through unchanged, defaulting an
    // omitted `bodies` to `[]` (and dropping corrupt null/undefined entries
    // from a present array) so downstream `for (const b of mapData.bodies)`
    // loops in the environment never iterate `undefined` or `null` (#273).
    if (isInternalMapDef(raw)) {
        return {
            ...raw,
            bodies: (raw.bodies ?? []).filter((b: unknown) => b !== null && b !== undefined),
        };
    }

    const map = (raw || {}) as ExportedMap;

    // Native map settings (blank map: re:false, nc:false, pq:1, gd:25, fl:false
    // — DEOBFUSCATION §33.1), validated against the native sanitizer
    // (mergeIntoNewMap, .deobf/alpha2s.pretty.js 12279-12287):
    //   - pq   kept when `1 <= pq <= 2`           (guard [326], line 12279)
    //   - gd   kept when `gd >= 2 && pq <= 100`   (line 12282; since pq is
    //         already validated to 1..2, the `pq <= 100` half is always true)
    //   - re/nc/fl kept when booleans             (typeof === "boolean" guards)
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
    // Guard the exporter path against corrupt/placeholder entries (e.g.
    // `bodies: [null]`, valid JSON): filter them out so toBodyDef never
    // receives a null body and the filtered list stays index-aligned with
    // `bodies` downstream (#273).
    const flatSource = (flatBodies || map.physicsBodies || [])
        .filter((b): b is FlatBody => b !== null && b !== undefined);
    const bodies = flatSource.map(toBodyDef);

    // Build a fixture-index -> body-name map so cap zones can resolve their
    // platform body. Export fixtures all share the name "Unnamed Shape", so a
    // body looked up by name alone resolves to the first match. Give each
    // cap-zone-referenced body a fixture-unique name (e.g. "Unnamed Shape#13")
    // so the engine's `bodies.find(b => b.name === zone.fixture)` selects the
    // actual platform rather than the first "Unnamed Shape."
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
    // The exporter (Webscripts/mapexporter.js) emits a literal `null` for any
    // joint it cannot export to keep raw-array indices stable, so `physicsJoints`
    // may contain `null` entries (per the `(FlatJoint | null)` contract). A
    // programmatic `mapData` may also hand us a dense array containing literal
    // `undefined` entries (Array.prototype.map skips sparse holes without
    // invoking its callback, so holes never reach this code). Skip both null
    // and undefined (with a warning) instead of throwing on dereference — a map
    // with an unexportable joint must still load its bodies, spawns and cap
    // zones. The raw array position (`jointIdx`) is kept for joint naming and
    // gear-referent lookups so filtered-out entries cannot mis-wire gear
    // referents.
    const joints = (map.physicsJoints || []).map((j, jointIdx) => {
        if (j === null || j === undefined) {
            console.warn(`[map-adapter] Skipping null/undefined physicsJoints entry at index ${jointIdx}`);
            return null;
        }
        // bodyA: -1 means the joint is anchored to the static ground body on the
        // A side (§33.8: ba/bb of -1 = ground on either side). Emit the reserved
        // ground name; addJoint resolves it to the synthetic ground body. Any
        // other negative index is malformed and stays '' (warn+skip in engine).
        const bodyA = j.bodyA !== undefined && j.bodyA >= 0
            ? bodiesByName.get(j.bodyA)
            : j.bodyA !== undefined && j.bodyA === -1
                ? GROUND_BODY_NAME
                : undefined;
        // bodyB: -1 means the joint is anchored to the ground (world). Forward
        // it as a ground joint (empty bodyB) rather than dropping it — P2
        // supports ground-anchored joints via a synthetic static ground body.
        // Any other negative index is malformed and stays '' (warn+skip in
        // engine), mirroring the bodyA policy above.
        const isGround = j.bodyB !== undefined && j.bodyB === -1;
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
            lowerAngle: j.lowerAngle,
            upperAngle: j.upperAngle,
            maxMotorForce: j.maxMotorForce,
            maxMotorTorque: j.maxMotorTorque,
            motorSpeed: j.motorSpeed,
            enableMotor: j.enableMotor,
            enableLimit: j.enableLimit,
            length: j.length,
            rayCast: (j as any).rayCast,
            // Forward distance-joint spring tuning when authored. The exporter
            // emits null for un-tuned d joints (mapexporter.js:565-566), so the
            // != null guard keeps the rigid (0/0) defaults for both absent and
            // explicit-null values (#286).
        };
        if (j.frequencyHz != null) out.frequencyHz = j.frequencyHz;
        if (j.dampingRatio != null) out.dampingRatio = j.dampingRatio;
        // Gear (g) referents: ja/jb index into the SAME joints array.
        if (j.type === 'g' || safeType(j.type) === 'g') {
            out.ratio = j.ratio ?? 1;
            const src = map.physicsJoints || [];
            const ja = (j as any).ja !== undefined ? (j as any).ja : undefined;
            const jb = (j as any).jb !== undefined ? (j as any).jb : undefined;
            if (ja !== undefined && src[ja]) out.jointA = `joint_${ja}`;
            if (jb !== undefined && src[jb]) out.jointB = `joint_${jb}`;
            // Native gear joints carry no ba/bb (§33.8 tag 5), so the exporter
            // emits bodyA/bodyB as null. Derive them from the referent joints
            // exactly like the native factory does (7836-7843: "bodyA/B from
            // those joints") so the gear joint still resolves in the engine.
            // A referent side of -1 (static ground) becomes the reserved ground
            // name, which addJoint resolves to the synthetic ground body.
            const refA = ja !== undefined ? src[ja] : undefined;
            const refB = jb !== undefined ? src[jb] : undefined;
            if (!out.bodyA && refA && refA.bodyA !== undefined) {
                out.bodyA = refA.bodyA >= 0
                    ? (bodiesByName.get(refA.bodyA) ?? '')
                    : refA.bodyA === -1 ? GROUND_BODY_NAME : '';
            }
            if (!out.bodyB && refB && refB.bodyB !== undefined) {
                out.bodyB = refB.bodyB >= 0
                    ? (bodiesByName.get(refB.bodyB) ?? '')
                    : refB.bodyB === -1 ? GROUND_BODY_NAME : '';
            }
        }
        return out;
    }).filter((j): j is Record<string, unknown> => j !== null);

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
                // MapBodyDef polygon vertices are BODY-LOCAL (toBodyDef above
                // normalizes the exporter's world-space emission), and addBody
                // places the body at def.x/def.y with the shape at the body
                // origin — so the polygon's world extent is b.x + v.x, exactly
                // where the engine builds the fixture (#332, #318).
                for (const v of b.vertices) {
                    const vx = b.x + v.x;
                    const vy = b.y + v.y;
                    if (vx < bx0) bx0 = vx; if (vx > bx1) bx1 = vx;
                    if (vy < by0) by0 = vy; if (vy > by1) by1 = vy;
                }
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
