/**
 * ESM loader hooks that stub the CDN imports, so browser modules which pull
 * Tone/MediaPipe off a CDN can still be unit-tested in Node. Only the names
 * our own code actually imports need to exist.
 */
const STUB = `
export class FilesetResolver { static async forVisionTasks() { return {}; } }
export class HandLandmarker {
  static async createFromOptions(_v, o) {
    return { close() {}, detectForVideo: () => ({ landmarks: [], worldLandmarks: [], handednesses: [] }),
             _d: o?.baseOptions?.delegate };
  }
}
export default {};
`;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('https://')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(STUB), shortCircuit: true };
  }
  return next(specifier, context);
}
