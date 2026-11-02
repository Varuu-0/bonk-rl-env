/**
 * Minimal type surface for the Bonk Map Exporter userscript's pure map
 * extraction paths, exposed for Node tests (see the module.exports hook at
 * the end of mapexporter.js). The browser-only UI bootstrap is skipped when
 * `window`/`document` are absent.
 */
export function extractMap(
  state: Record<string, any>,
  options?: { capZoneTimeInTicks?: boolean },
): {
  physicsJoints: any[];
  [key: string]: any;
};

/**
 * Convert a runtime map object (gs.map or tick state) into strict NativeMap
 * JSON that validates with the engine's validateNativeMapJson and loads via
 * mapPath/mapData. This is the userscript's primary download output.
 */
export function toNativeMap(state: Record<string, any>): {
  v: number;
  s: Record<string, any>;
  physics: Record<string, any>;
  spawns: any[];
  capZones: any[];
  m: Record<string, any>;
};
