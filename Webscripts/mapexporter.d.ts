/**
 * Minimal type surface for the Bonk Map Exporter userscript's pure map
 * extraction path, exposed for Node tests (see the module.exports hook at the
 * end of mapexporter.js). The browser-only UI bootstrap is skipped when
 * `window`/`document` are absent.
 */
export function extractMap(
  state: Record<string, any>,
  options?: { capZoneTimeInTicks?: boolean },
): {
  physicsJoints: any[];
  [key: string]: any;
};
