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
    bodyIndex?: number;
    fixtureIndex?: number;
    name?: string;
    type?: string;
    bodyType?: string;
    x?: number;
    y?: number;
    /** Position-keyed flat bodies use this instead of (or in addition to) x/y. */
    position?: { x?: number; y?: number } | null;
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
    shapeIndex?: number | null;
    width?: number;
    height?: number;
    radius?: number;
    scale?: number;
    vertices?: { x: number; y: number }[];
    renderShape?: {
        type: 'rect' | 'circle' | 'polygon';
        bodyPosition: { x: number; y: number };
        bodyAngle: number;
        center: { x: number; y: number };
        angle: number;
        width?: number;
        height?: number;
        radius?: number;
        vertices?: { x: number; y: number }[];
        scale?: number;
    };
}

interface NativeShape {
    type?: string;
    typeName?: string;
    center?: { x: number; y: number } | null;
    angle?: number;
    width?: number;
    height?: number;
    radius?: number;
    scale?: number;
    vertices?: { x: number; y: number }[];
}

interface NativeFixture extends FlatBody {
    shapeIndex?: number | null;
    shape?: NativeShape | null;
    death?: boolean;
}

interface NativeBody {
    index?: number;
    name?: string | null;
    type?: string;
    typeName?: string;
    position?: { x: number; y: number } | null;
    angle?: number;
    linearVelocity?: { x: number; y: number } | null;
    angularVelocity?: number;
    friction?: number;
    restitution?: number;
    density?: number;
    linearDamping?: number;
    angularDamping?: number;
    collisionGroup?: number;
    collidesGroup1?: boolean;
    collidesGroup2?: boolean;
    collidesGroup3?: boolean;
    collidesGroup4?: boolean;
    fricPlayers?: boolean | number;
    fixtureIndices?: number[];
    fixtures?: (NativeFixture | null)[];
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
    // The exporter (Webscripts/mapexporter.js) preserves raw-array indices with
    // literal null placeholders for unsupported bodies, so entries may be null
    // as well as FlatBody/NativeBody.
    physicsBodies?: (FlatBody | NativeBody | null)[];
    physicsJoints?: (FlatJoint | null)[];
    physicsFixtures?: (NativeFixture | null)[];
    physicsShapes?: (NativeShape | null)[];
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

interface NativeBodyRef {
    index: number;
    x: number;
    y: number;
    angle: number;
}

interface NativeFixtureRef {
    type?: 'rect' | 'circle' | 'polygon';
    center?: { x: number; y: number };
    angle?: number;
    width?: number;
    height?: number;
    radius?: number;
    scale?: number;
    vertices?: { x: number; y: number }[];
}

function isNativeBody(value: unknown): value is NativeBody {
    if (!value || typeof value !== 'object') return false;
    const body = value as Record<string, unknown>;
    // A native body is defined by its structured fixture hierarchy, not by a
    // `position` or `x` key: programmatic/exporter flat bodies may also carry
    // a `position` (position-keyed flat bodies) or `x` (the exporter flat
    // compatibility view), and treating them as native would silently drop
    // them (they flatten to nothing without fixtures). The fixture list must
    // be non-empty to count: an object that carries flat markers (x/width)
    // alongside an empty fixtures/fixtureIndices list is a flat body with a
    // stray structured key, not a native body.
    return (Array.isArray(body.fixtures) && body.fixtures.length > 0)
        || (Array.isArray(body.fixtureIndices) && body.fixtureIndices.length > 0);
}

function isFlatBody(value: unknown): value is FlatBody {
    return !!value
        && typeof value === 'object'
        && !isNativeBody(value)
        // Require a positive flat marker; the complement of isNativeBody is
        // too broad for arbitrary objects riding along in physicsBodies. A
        // `position` key is a valid flat marker for position-keyed bodies.
        && ('x' in value || 'width' in value || 'vertices' in value
            || 'radius' in value || 'collidesGroup1' in value || 'position' in value);
}

function nativeShapeType(shape: NativeShape | null | undefined): string | undefined {
    if (!shape) return undefined;
    if (shape.type === 'bx' || shape.typeName === 'rect') return 'rect';
    if (shape.type === 'ci' || shape.typeName === 'circle') return 'circle';
    if (shape.type === 'po' || shape.typeName === 'polygon') return 'polygon';
    return undefined;
}

function nativeFixtureFor(
    body: NativeBody | undefined,
    fixtureIndex: number | undefined,
    map: ExportedMap,
): NativeFixture | undefined {
    const bodyFixture = fixtureIndex === undefined
        ? undefined
        : body?.fixtures?.find((fixture) => fixture !== null && fixture.fixtureIndex === fixtureIndex);
    const rawFixture = bodyFixture ?? (fixtureIndex !== undefined ? map.physicsFixtures?.[fixtureIndex] : undefined);
    if (!rawFixture) return undefined;

    const shape = rawFixture.shape
        ?? (rawFixture.shapeIndex !== undefined && rawFixture.shapeIndex !== null
            ? map.physicsShapes?.[rawFixture.shapeIndex] ?? undefined
            : undefined);
    return shape ? { ...rawFixture, shape } : rawFixture;
}

function nativeBodyRef(body: NativeBody, index: number): NativeBodyRef {
    return {
        index: body.index ?? index,
        x: body.position?.x ?? 0,
        y: body.position?.y ?? 0,
        angle: body.angle ?? 0,
    };
}

function nativeFixtureRef(fixture: NativeFixture | undefined): NativeFixtureRef | undefined {
    const shape = fixture?.shape;
    if (!shape) return undefined;
    return {
        type: nativeShapeType(shape) as NativeFixtureRef['type'],
        center: shape.center ?? undefined,
        angle: shape.angle ?? 0,
        width: shape.width,
        height: shape.height,
        radius: shape.radius,
        scale: shape.scale,
        vertices: shape.vertices,
    };
}

function rotatePoint(x: number, y: number, angle: number): { x: number; y: number } {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** Flatten structured native bodies when an exporter omits its compatibility view. */
function flattenNativeBodies(map: ExportedMap, nativeBodies: NativeBody[]): FlatBody[] {
    const flat: FlatBody[] = [];
    nativeBodies.forEach((nativeBody, bodyArrayIndex) => {
        const bodyIndex = nativeBody.index ?? bodyArrayIndex;
        const bodyPosition = nativeBody.position ?? { x: 0, y: 0 };
        const bodyAngle = nativeBody.angle ?? 0;
        // Prefer the authoritative `fixtureIndices` list, but never let an
        // empty `[]` shadow a populated `fixtures` array (an omitted or
        // placeholder list must not silently drop every fixture). When the
        // index list is absent, derive indices from the fixtures themselves:
        // index-less fixtures fall back to their RAW array position — the
        // physicsFixtures index convention — so a null placeholder cannot
        // shift the derived index into a different fixture slot.
        const fixtureIndexes = (nativeBody.fixtureIndices && nativeBody.fixtureIndices.length > 0)
            ? nativeBody.fixtureIndices
            : (nativeBody.fixtures ?? [])
                .map((fixture, i) => (fixture === null || fixture === undefined ? null : (fixture.fixtureIndex ?? i)))
                .filter((idx): idx is number => idx !== null);

        fixtureIndexes.forEach((fixtureIndex) => {
            const fixture = nativeFixtureFor(nativeBody, fixtureIndex, map);
            const shape = fixture?.shape;
            const type = shape ? nativeShapeType(shape) : undefined;
            const bodyType = nativeBody.typeName
                ?? (nativeBody.type === 's' ? 'static' : nativeBody.type === 'd' ? 'dynamic' : nativeBody.type);
            // Shape-less fixtures are still materialized as aliases so cap
            // zones and joints can resolve their names, but they carry no
            // geometry — the engine warns and skips shape creation while
            // keeping the native-body alias registered.
            const center = shape?.center ?? { x: 0, y: 0 };
            const worldCenter = shape ? rotatePoint(center.x, center.y, bodyAngle) : { x: 0, y: 0 };
            if (!shape) {
                console.warn(
                    `[map-adapter] Fixture ${fixtureIndex} of native body ${bodyIndex} has no shape; `
                    + 'keeping the alias without geometry',
                );
            } else if (!type) {
                console.warn(
                    `[map-adapter] Skipping unsupported shape type for fixture ${fixtureIndex} `
                    + `of native body ${bodyIndex} (type "${shape.type ?? ''}" / "${shape.typeName ?? ''}")`,
                );
            }
            const flatBody: FlatBody = {
                bodyIndex,
                fixtureIndex,
                name: fixture?.name ?? nativeBody.name ?? undefined,
                type,
                bodyType,
                x: bodyPosition.x + worldCenter.x,
                y: bodyPosition.y + worldCenter.y,
                angle: bodyAngle + (shape?.angle ?? 0),
                linearVelocity: nativeBody.linearVelocity ?? undefined,
                angularVelocity: nativeBody.angularVelocity,
                static: bodyType === 'static',
                isLethal: fixture?.isLethal ?? fixture?.death,
                noPhysics: fixture?.noPhysics,
                noGrapple: fixture?.noGrapple,
                innerGrapple: fixture?.innerGrapple,
                friction: fixture?.friction ?? nativeBody.friction,
                restitution: fixture?.restitution ?? nativeBody.restitution,
                density: fixture?.density ?? nativeBody.density,
                fricPlayers: fixture?.fricPlayers ?? nativeBody.fricPlayers,
                collisionGroup: fixture?.collisionGroup ?? nativeBody.collisionGroup,
                collidesGroup1: fixture?.collidesGroup1 ?? nativeBody.collidesGroup1,
                collidesGroup2: fixture?.collidesGroup2 ?? nativeBody.collidesGroup2,
                collidesGroup3: fixture?.collidesGroup3 ?? nativeBody.collidesGroup3,
                collidesGroup4: fixture?.collidesGroup4 ?? nativeBody.collidesGroup4,
                color: fixture?.color,
            };
            if (type === 'rect') {
                flatBody.width = shape?.width;
                flatBody.height = shape?.height;
            } else if (type === 'circle') {
                flatBody.radius = shape?.radius;
            } else if (type === 'polygon') {
                flatBody.scale = shape?.scale;
                // The flat facade's polygon vertices feed getCapZoneSensorSize,
                // which rotates them by fixtureDef.angle about fixtureDef.x —
                // i.e. they must stay the shape's raw local vertices (scaled),
                // NOT world-transformed, or the sensor picks up an extra
                // translation and a second rotation. deathCenter (below) adds
                // the body offset back when the source was flattened.
                const vertexScale = shape?.scale ?? 1;
                flatBody.vertices = (shape?.vertices ?? []).map((vertex) => ({
                    x: vertex.x * vertexScale,
                    y: vertex.y * vertexScale,
                }));
            }
            flat.push(flatBody);
        });
    });
    return flat;
}

/** Convert a flat fixture into a MapBodyDef, preserving native body metadata. */
function toBodyDef(
    body: FlatBody,
    index: number,
    name: string,
    nativeBody?: NativeBody,
    nativeFixture?: NativeFixture,
): any {
    const bodyType = nativeBody?.typeName
        ?? (nativeBody?.type === 's' ? 'static' : nativeBody?.type === 'd' ? 'dynamic' : nativeBody?.type);
    const shape = nativeFixture?.shape;
    const type = (body.type === 'rect' || body.type === 'circle' || body.type === 'polygon')
        ? body.type
        : nativeShapeType(shape);
    // Cap-zone sensors and the death-center AABB consume the flat facade's
    // x/y. When this fixture is rebuilt from a native body, the engine places
    // the shape at nativeBody.x/y + R(angle)·shapeCenter, so emit that exact
    // world-space center here instead of an un-rotated bodyPos + center —
    // otherwise sensors land off the actual Box2D shape for rotated or
    // off-center fixtures.
    const fixtureCenter = nativeFixture?.shape?.center;
    const worldCenter = fixtureCenter && nativeBody
        ? rotatePoint(fixtureCenter.x, fixtureCenter.y, nativeBody.angle ?? 0)
        : undefined;
    return {
        name,
        type,
        x: worldCenter && nativeBody ? (nativeBody.position?.x ?? 0) + worldCenter.x : body.x ?? body.position?.x ?? 0,
        y: worldCenter && nativeBody ? (nativeBody.position?.y ?? 0) + worldCenter.y : body.y ?? body.position?.y ?? 0,
        vertices: body.vertices ?? shape?.vertices,
        static: body.static ?? (body.bodyType === 'static' || bodyType === 'static'),
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
        surfaceName: body.bodyType ?? bodyType,
        linearDamping: nativeBody?.linearDamping,
        angularDamping: nativeBody?.angularDamping,
        nativeBody: nativeBody ? nativeBodyRef(nativeBody, body.bodyIndex ?? index) : undefined,
        nativeFixture: nativeFixtureRef(nativeFixture),
        // Keep the structured shape's dimensions available when the flat view
        // omitted them. The engine still uses the flat values for legacy maps.
        width: body.width ?? shape?.width,
        height: body.height ?? shape?.height,
        radius: body.radius ?? shape?.radius,
        renderBodyIndex: body.bodyIndex ?? index,
        renderShape: body.renderShape,
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
// Prefer the native-body fixture-owner mapping as the authority for body
    // grouping (issue #307): a flat bodyIndex can point at a null placeholder
    // slot or a different body, so key everything the engine groups by the
    // resolved native body index instead of the raw flat index.
    const nativeBodies = (map.physicsBodies || []).reduce<NativeBody[]>((out, body, i) => {
        if (isNativeBody(body)) {
            out.push(body.index === undefined ? { ...body, index: i } : body);
        }
        return out;
    }, []);
    const nativeBodiesByIndex = new Map<number, NativeBody>();
    const nativeBodyByFixture = new Map<number, NativeBody>();
    nativeBodies.forEach((body, i) => {
        nativeBodiesByIndex.set(body.index ?? i, body);
        for (const fixtureIndex of body.fixtureIndices ?? []) {
            nativeBodyByFixture.set(fixtureIndex, body);
        }
        for (const fixture of body.fixtures ?? []) {
            if (fixture?.fixtureIndex !== undefined) nativeBodyByFixture.set(fixture.fixtureIndex, body);
        }
    });
    const nativeBodyFor = (body: FlatBody): NativeBody | undefined => {
        // A fixture belongs to exactly one native body; prefer that owner when
        // it is known so a stale/misaligned flat `bodyIndex` (e.g. pointing at
        // a null slot or a different body) cannot group the fixture under the
        // wrong native body. The fixtureIndex fallback still resolves when the
        // flat view omits bodyIndex entirely.
if (body.fixtureIndex !== undefined) {
            const owner = nativeBodyByFixture.get(body.fixtureIndex);
            if (owner) return owner;
        }
        return body.bodyIndex !== undefined ? nativeBodiesByIndex.get(body.bodyIndex) : undefined;
    };

    // Prefer the exporter's flat compatibility view when it exists. If an
    // export contains only the structured hierarchy, flatten its fixtures for
    // the existing MapDef facade while retaining nativeBody/nativeFixture
    // metadata so PhysicsEngine can rebuild one Box2D body per bodyIndex.
    const flatSource = (flatBodies || (map.physicsBodies || []).filter(isFlatBody))
        .filter((b): b is FlatBody => b !== null && b !== undefined)
        .map((b) => ({ ...b }));
    // The exporter's flat compatibility view bakes the fixture's world
    // position (bodyPos + center, mapexporter.js:518-521) into every polygon
    // vertex and emits the shape scale separately. Every geometry consumer
    // (the cap-zone sensor AABB, the derived-fixture polygon baking in
    // PhysicsEngine, deathCenter) uses the shape-LOCAL convention — world
    // vertex = def.x/y + R(def.angle)·(scaled v) — so rebase the world-baked
    // vertices onto def.x/y and bake the scale in. Flat-source polygons then
    // carry exactly the same convention as flattened-native polygons, and a
    // rotated/off-center native fixture lands correctly whether or not its
    // structured fixture resolves.
    if (flatBodies) {
        // When the structured hierarchy carries real native bodies / fixtures /
        // shapes, the flat bodies[] view is unambiguously the exporter's
        // compatibility view, whose polygon vertices are ALWAYS world-baked
        // (mapexporter.js:518-521) — rebase them unconditionally. A distance
        // heuristic here misclassifies one-sided/wedge polygons whose bake
        // center is near the world origin (the bake offset can partially cancel
        // the shape extent, so the vertices' greatest distance from the bake
        // center exceeds their greatest distance from the world origin),
        // leaving them double-offset with `scale` dropped. Only NATIVE bodies
        // count as structured: flat (position-keyed, fixture-less) physicsBodies
        // entries belong to the same legacy hand-authored map, not the exporter.
        const hasStructured =
            (Array.isArray(map.physicsBodies) && map.physicsBodies.some((b) => isNativeBody(b)))
            || (Array.isArray(map.physicsFixtures) && map.physicsFixtures.some((f) => {
                if (f === null || f === undefined) return false;
                return !!(f.shape || typeof f.shapeIndex === 'number');
            }))
            || (Array.isArray(map.physicsShapes) && map.physicsShapes.some((s) => {
                if (s === null || s === undefined) return false;
                return !!(s.type || s.typeName);
            }));
        // The exporter flat view always emits its identity keys, while a bare
        // hand-authored legacy polygon carries only name/type/x/y/vertices.
        // These keys are a deterministic world-baked signal that works even
        // when the structured arrays are absent or all-null (a trimmed/corrupt
        // export): the exporter world-bakes every flat polygon vertex, so no
        // distance signature is needed — and no distance heuristic that can
        // misfire for near-origin wedges.
        const fromExporterFlatView = (body: FlatBody): boolean =>
            body.bodyIndex !== undefined
            || body.fixtureIndex !== undefined
            || body.shapeIndex !== undefined
            || body.bodyType !== undefined
            || body.collidesGroup1 !== undefined
            || body.collidesGroup2 !== undefined
            || body.collidesGroup3 !== undefined
            || body.collidesGroup4 !== undefined;
        for (const b of flatSource) {
            if (b.type !== 'polygon' || !Array.isArray(b.vertices) || b.vertices.length === 0) continue;
            // Resolve the bake center exactly like toBodyDef resolves the
            // placement (b.x ?? b.position?.x ?? 0), so a position-keyed flat
            // polygon is rebased about the point it will actually be placed
            // at — rebasing about (0,0) would silently shift every vertex by
            // -position·scale.
            const cx = b.x ?? b.position?.x ?? 0;
            const cy = b.y ?? b.position?.y ?? 0;
            // Without an authored placement there is nothing baked into the
            // vertices to rebase: leave them untouched (def.x/y default to 0
            // downstream, so the shape-local reading is the only one that
            // makes sense).
            if ((b.x === undefined && b.position?.x === undefined)
                && (b.y === undefined && b.position?.y === undefined)) continue;
            // Rebase only world-baked vertices. A bare hand-authored legacy
            // polygon (no structured hierarchy AND no exporter flat identity
            // keys) follows the shape-local convention — world = def.x/y +
            // R(def.angle)·v — which every consumer already handles as-is;
            // rebasing it would silently shift the shape.
            if (!hasStructured && !fromExporterFlatView(b)) continue;
            const vertexScale = b.scale ?? 1;
            b.vertices = b.vertices.map((v) => ({
                x: (v.x - cx) * vertexScale,
                y: (v.y - cy) * vertexScale,
            }));
        }
    }
    // Render enrichment (renderShape/renderBodyIndex) resolves the structured
    // fixture shape for each flat export body so renderers can redraw it
    // faithfully without re-deriving placement from physicsBodies.
    const sourceBodies: any[] = Array.isArray(map.physicsBodies) ? map.physicsBodies : [];
    const sourceBodiesByFlatPosition = sourceBodies.filter((body) => body !== null && body !== undefined);
    const sourceShapes: any[] = Array.isArray(map.physicsShapes) ? map.physicsShapes : [];
    const withRenderShape = (body: FlatBody, index: number): FlatBody => {
        const shapeIndex = body.shapeIndex;
        // bodyIndex references raw physicsBodies positions. Positional fallback
        // must follow flatSource, which excludes raw null placeholders.
        const sourceBody = typeof body.bodyIndex === 'number'
            ? sourceBodies[body.bodyIndex]
            : sourceBodiesByFlatPosition[index];
        const sourceShape = typeof shapeIndex === 'number' ? sourceShapes[shapeIndex] : undefined;
        if (!sourceBody || !sourceBody.position || !sourceShape || !sourceShape.center) return body;
        const type = sourceShape.type === 'bx' ? 'rect'
            : sourceShape.type === 'ci' ? 'circle'
            : sourceShape.type === 'po' ? 'polygon'
            : undefined;
        if (!type) return body;
        return {
            ...body,
            renderShape: {
                type,
                bodyPosition: { x: sourceBody.position.x ?? 0, y: sourceBody.position.y ?? 0 },
                bodyAngle: sourceBody.angle ?? 0,
                center: { x: sourceShape.center.x ?? 0, y: sourceShape.center.y ?? 0 },
                angle: sourceShape.angle ?? 0,
                width: sourceShape.width,
                height: sourceShape.height,
                radius: sourceShape.radius,
                vertices: sourceShape.vertices,
                scale: sourceShape.scale,
            },
        };
    };
    const renderSource = flatSource.map(withRenderShape);
    const source = flatSource.length > 0
        ? renderSource
        : flattenNativeBodies(map, nativeBodies);

    // Exported fixtures frequently use the shared default name "Unnamed Shape"
    // even when their structured parent body has a meaningful name. Use the
    // native body name as the alias base in that case, then make every fixture
    // alias unique. The unique aliases are still backed by one grouped engine
    // body when they share a native bodyIndex.
    const baseNames = source.map((body, i) => {
        const nativeBody = nativeBodyFor(body);
        const fixtureName = body.name;
        return fixtureName && fixtureName !== 'Unnamed Shape'
            ? fixtureName
            : nativeBody?.name ?? fixtureName ?? body.bodyType ?? `body_${i}`;
    });
    const nameCounts = new Map<string, number>();
    for (const name of baseNames) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    const usedNames = new Set<string>();
    const names = baseNames.map((baseName, i) => {
        const suffix = source[i].fixtureIndex ?? i;
        let name = (nameCounts.get(baseName) ?? 0) > 1 ? `${baseName}#${suffix}` : baseName;
        if (usedNames.has(name)) {
            let collision = 1;
            while (usedNames.has(`${name}#${collision}`)) collision++;
            name = `${name}#${collision}`;
        }
        usedNames.add(name);
        return name;
    });
    const nameByFixture = new Map<number, string>();
    source.forEach((body, i) => {
        if (body.fixtureIndex !== undefined) nameByFixture.set(body.fixtureIndex, names[i]);
    });

    const bodies = source.map((body, i) => {
        const nativeBody = nativeBodyFor(body);
        const nativeFixture = nativeFixtureFor(nativeBody, body.fixtureIndex, map);
        return toBodyDef(body, i, names[i], nativeBody, nativeFixture);
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

    // Cap zones: resolve fixtureIndex -> the unique named fixture alias.
    // Cap-zone-referenced fixtures additionally get a fixture-unique friendly
    // name (e.g. "Unnamed Shape#13") so find-by-name selects the actual
    // platform rather than the first same-named fixture.
    const capFixtureIndexes = new Set<number>(
        (map.capZones || []).map(z => z.fixtureIndex).filter((x): x is number => typeof x === 'number'),
    );
    const capFriendlyNames = new Map<number, string>();
    // Friendly renames apply only to the flat-export path (main-line render
    // contract); structured-only maps keep the shape-less alias names authored
    // by flattenNativeBodies, which names[] already deduplicates.
    if (flatSource.length > 0) {
        bodies.forEach((b, i) => {
            const fxIdx = source[i]?.fixtureIndex;
            if (fxIdx !== undefined && capFixtureIndexes.has(fxIdx) && !b.name.endsWith(`#${fxIdx}`)) {
                const uniqueName = `${b.name}#${fxIdx}`;
                b.name = uniqueName;
                capFriendlyNames.set(fxIdx, uniqueName);
            }
        });
    }
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
    // physicsBodies; the engine resolves them by NAME via the body map. Each
    // native body may have several flat fixture aliases, so retain only the
    // first alias for each bodyIndex. PhysicsEngine maps all aliases back to
    // that one grouped Box2D body.
    const bodiesByName = new Map<number, string>();
    source.forEach((b, i) => {
        const nativeBody = nativeBodyFor(b);
        // Key joints by the resolved native body index (where the engine
        // actually groups fixtures) before the flat bodyIndex, so a flat
        // bodyIndex that hits a null slot or belongs to a different native
        // body cannot mis-wire the joint to the wrong grouped body.
        const bodyIndex = nativeBody?.index
            ?? b.bodyIndex
            ?? i;
        if (!bodiesByName.has(bodyIndex)) bodiesByName.set(bodyIndex, bodies[i]?.name ?? names[i]);
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
                // Polygon vertices are shape-local (scaled) in one unified
                // convention (world vertex = def.x/y + R(def.angle)·v), so
                // rotate before the bounds — an unrotated AABB would center
                // the death circle on the wrong point for rotated polygons.
                const cosA = Math.cos(b.angle ?? 0);
                const sinA = Math.sin(b.angle ?? 0);
                for (const v of b.vertices) {
                    const vx = (b.x ?? 0) + v.x * cosA - v.y * sinA;
                    const vy = (b.y ?? 0) + v.x * sinA + v.y * cosA;
                    if (vx < bx0) bx0 = vx; if (vx > bx1) bx1 = vx; if (vy < by0) by0 = vy; if (vy > by1) by1 = vy;
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
        // `physics.bro` is front-to-back. Preserve it only for renderers; the
        // physics engine intentionally continues to consume flattened bodies.
        bodyRenderOrder: Array.isArray((map as any).bodyRenderOrder)
            ? (map as any).bodyRenderOrder.filter((index: unknown): index is number => typeof index === 'number' && Number.isInteger(index) && index >= 0)
            : undefined,
        capZones: capZones.length > 0 ? capZones : undefined,
        joints: joints.length > 0 ? joints as any : undefined,
        physics,
        settings,
    };
}
