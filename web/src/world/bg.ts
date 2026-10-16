// bg.ts — ytan (CONTRACT §14): en WebGL-shader (three.js) med gaussiskt ljusfall från --wb-canvas-center
// (50 %/36 %) till --wb-canvas-edge, ungefär 0,75 LSB dither och en prickgrid i världen (24 enheter,
// ungefär 0,95 px, 8,5 % mörkare) som fördubblas mjukt när avståndet blir under 12 skärm-px.
// OrthographicCamera med samma kamera som DOM:en (§10.2). Ritas bara när kameran eller storleken ändras.
// Utan WebGL döljs canvasen och #stage visar CSS-gradienten i base.css.
import { Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer } from 'three';
import type { Camera } from '../../../shared/protocol.ts';
import { ortho } from './camera.ts';
import type { Tokens } from './tokens.ts';

const VERT = /* glsl */ `
varying vec2 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = vec2(w.x, -w.y); // three.js har y uppåt, världen y nedåt
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec2 uRes;      // ritbuffertens storlek i enhets-px
uniform float uDpr;
uniform float uZoom;
uniform vec3 uCenter;
uniform vec3 uEdge;
uniform float uSpacing;
uniform float uDarken;
varying vec2 vWorld;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 1 inne i en prick med radien r (skärm-px), mjukt kantad.
float dots(vec2 w, float sp, float z, float r, float aa) {
  vec2 g = (fract(w / sp + 0.5) - 0.5) * sp * z;
  return 1.0 - smoothstep(r - aa, r + aa, length(g));
}

void main() {
  vec2 view = uRes / uDpr;
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec2 q = (fc - vec2(0.5 * view.x, 0.36 * view.y)) / length(view);
  float light = exp(-dot(q, q) * 3.4);
  vec3 col = mix(uEdge, uCenter, light);

  float lv = log2(12.0 / (uSpacing * uZoom));
  float k = max(ceil(lv), 0.0);
  float sp = uSpacing * exp2(k);
  float fine = smoothstep(12.0, 20.0, sp * uZoom);
  float aa = 0.5 / uDpr + 0.3;
  float g = max(dots(vWorld, 2.0 * sp, uZoom, 0.95, aa), dots(vWorld, sp, uZoom, 0.95, aa) * fine);
  col *= 1.0 - uDarken * g;

  col += (hash(gl_FragCoord.xy) - 0.5) * (1.5 / 255.0);
  gl_FragColor = vec4(col, 1.0);
}`;

export interface Surface {
  render(cam: Camera, vw: number, vh: number): void;
  dispose(): void;
}

export function createSurface(canvas: HTMLCanvasElement, tokens: Tokens): Surface | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'low-power' });
  } catch (err) {
    console.warn('[world] WebGL saknas, ytan blir en CSS-gradient', err);
    return null;
  }
  renderer.autoClear = true;
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
  // Färgerna är sRGB rakt in i shadern (ingen färghantering), precis som i CSS.
  const uniforms = {
    uRes: { value: new Vector2(1, 1) },
    uDpr: { value: 1 },
    uZoom: { value: 1 },
    uCenter: { value: new Vector3(...tokens.canvasCenter) },
    uEdge: { value: new Vector3(...tokens.canvasEdge) },
    uSpacing: { value: tokens.gridSpacing },
    uDarken: { value: tokens.gridDarken },
  };
  const material = new ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false });
  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  let size = '';

  return {
    render(cam, vw, vh) {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const key = `${vw}x${vh}@${dpr}`;
      if (key !== size) {
        size = key;
        renderer.setPixelRatio(dpr);
        renderer.setSize(vw, vh, false);
      }
      const o = ortho(cam, vw, vh);
      camera.left = o.left;
      camera.right = o.right;
      camera.top = o.top;
      camera.bottom = o.bottom;
      camera.updateProjectionMatrix();
      mesh.position.set((o.left + o.right) / 2, (o.top + o.bottom) / 2, 0);
      mesh.scale.set(o.right - o.left, o.top - o.bottom, 1);
      const buf = renderer.getDrawingBufferSize(new Vector2());
      uniforms.uRes.value.copy(buf);
      uniforms.uDpr.value = buf.x / vw;
      uniforms.uZoom.value = cam.zoom;
      renderer.render(scene, camera);
    },
    dispose() {
      material.dispose();
      mesh.geometry.dispose();
      renderer.dispose();
    },
  };
}
