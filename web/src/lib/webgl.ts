/**
 * Cheap, memoized WebGL-availability probe. The 3D hero accent is decorative
 * only — where WebGL is missing (headless test envs like jsdom, locked-down
 * browsers, GPU blocklists) callers render a static fallback instead of ever
 * mounting a react-three-fiber `<Canvas>`. Kept dependency-free and guarded so
 * it can be called during render on the server or the client without throwing.
 */
let cached: boolean | null = null;

export function supportsWebGL(): boolean {
  if (cached !== null) return cached;
  if (typeof document === "undefined") {
    cached = false;
    return cached;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    cached = Boolean(gl);
  } catch {
    cached = false;
  }
  return cached;
}
