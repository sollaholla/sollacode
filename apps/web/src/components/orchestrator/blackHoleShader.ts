/**
 * The voice orb as a wormhole: a sphere you look *through* into another
 * universe — a tilted spiral galaxy and its stars — with the light bent on
 * the way. Inside the rim the deflection grows from nothing at the centre to
 * a full wrap at the edge, so the far galaxy is pulled into rings and its
 * stars double against the limb; outside the rim a point-mass lens smears the
 * stars behind the throat into tangential arcs that tighten toward it. A
 * bright Einstein ring sits on the rim, and the whole thing glows with the
 * voice: `u_intensity` is the loudness, and it drives the core, the ring and
 * the halo spilling out past the edge.
 *
 * A fragment shader because none of that can be faked with gradients — the
 * earlier CSS drawing showed seams where its layers met and could not warp
 * anything. The CSS drawing survives only as the fallback for a context
 * without WebGL.
 *
 * Output is premultiplied alpha over a transparent canvas: the sphere is
 * opaque, the arcs and halo outside it are luminous over clear, so the same
 * surface composes over the settings page, the listening overlay's dimmed
 * backdrop, and the floating bubble's transparent window.
 */

export interface BlackHoleFrame {
  readonly time: number;
  readonly inner: readonly [number, number, number];
  readonly outer: readonly [number, number, number];
  readonly brightness: number;
  readonly intensity: number;
  readonly seed: number;
}

export interface BlackHoleRenderer {
  readonly render: (frame: BlackHoleFrame) => void;
  readonly resize: (width: number, height: number) => void;
  readonly destroy: () => void;
}

const VERTEX_SOURCE = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAGMENT_SOURCE = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_inner;
uniform vec3 u_outer;
uniform float u_brightness;
uniform float u_intensity;
uniform float u_seed;

// The orb's rim, as a fraction of the canvas: the canvas is CANVAS_SCALE times
// the orb, and uv runs -0.5..0.5 across it.
const float RIM = 0.5 / 2.4;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  return 0.55 * vnoise(p) + 0.28 * vnoise(p * 2.1 + 5.2) + 0.17 * vnoise(p * 4.3 + 9.1);
}

// A sparse star field on the sphere of directions. Time twinkles each star on
// a phase and rate drawn from its own cell hash, so no two blink together and
// the field never pulses as a whole.
vec3 stars(vec3 d, float density, float t) {
  vec2 uv = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0))) * vec2(30.0, 19.0);
  vec2 cell = floor(uv);
  vec2 f = fract(uv);
  vec3 col = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      float h = hash(c + u_seed);
      if (h > 1.0 - density) {
        vec2 pos = vec2(hash(c * 1.7 + 3.1), hash(c * 2.3 + 7.7));
        float dist = length(f - (vec2(float(i), float(j)) + pos));
        float bright = (h - (1.0 - density)) / density;
        float rad = 0.16 + 0.22 * bright;
        float s = exp(-(dist * dist) / (rad * rad)) * (0.3 + bright);
        // Brighter stars scintillate less, the way the real sky behaves.
        float rate = 0.8 + 2.6 * hash(c * 4.1 + 0.7);
        float phase = 6.2831853 * hash(c * 6.7 + 2.9);
        float depth = 0.32 * (1.0 - 0.55 * bright);
        s *= 1.0 - depth + depth * (0.5 + 0.5 * sin(t * rate + phase));
        vec3 tint = mix(vec3(0.80, 0.88, 1.0), vec3(1.0, 0.92, 0.72), hash(c * 0.9 + 1.3));
        col += s * tint;
      }
    }
  }
  return col;
}

// The universe on the far side of the wormhole: a spiral galaxy seen at a
// tilt, stars around it. Sampled by direction; the galaxy sits at the front
// pole, so looking straight through the throat looks into its core.
vec3 farUniverse(vec3 d, float t) {
  // Tilt the galaxy so we see it as a lens rather than face-on.
  float tilt = 0.95;
  vec3 g3 = vec3(d.x, d.y * cos(tilt) - d.z * sin(tilt), d.y * sin(tilt) + d.z * cos(tilt));
  // Stereographic coordinates from the back pole: continuous everywhere the
  // ray can land, the galaxy centred at g = 0.
  vec2 g = g3.xy / (1.0 + max(g3.z, -0.98)) * 1.05;
  float rho = length(g);
  float phi = atan(g.y, g.x);

  float core = exp(-rho * rho * 16.0);
  float bulge = exp(-rho * rho * 2.0) * 0.5;
  // Differential rotation: the core turns faster than the outskirts, so the
  // arms wind up over time instead of sweeping round as a rigid pinwheel.
  // The divisor is kept shallow on purpose. A steep one starves the outer
  // radii, and through the throat it is the outer annulus that fills most of
  // the visible disc, so a steep falloff makes the galaxy look frozen.
  float spin = t * 0.30 / (0.55 + rho);
  float spiral = 0.5 + 0.5 * cos(3.0 * (phi + spin) + 1.5 * rho);
  float arms = pow(spiral, 1.2) * exp(-rho * 1.0) * smoothstep(0.04, 0.28, rho) * 0.45;
  float dust = fbm(g * 5.0 + vec2(t * 0.10, 0.0));
  float lanes = smoothstep(0.35, 0.75, fbm(g * 9.0 - vec2(0.0, t * 0.07)));
  arms *= 0.55 + 0.9 * dust;
  arms *= 1.0 - 0.45 * lanes;

  vec3 coreCol = mix(u_inner, vec3(1.0, 0.98, 0.93), 0.55);
  vec3 armCol = mix(u_outer, u_inner, 0.35);
  vec3 outskirts = mix(u_outer, vec3(0.30, 0.42, 1.0), 0.45);
  vec3 col = coreCol * (core * 0.9 + bulge)
    + mix(armCol, outskirts, smoothstep(0.35, 1.3, rho)) * arms * 1.6
    + outskirts * 0.28 * dust * exp(-rho * 0.7)
    + armCol * 0.10 * fbm(g * 2.5 + 3.0) * exp(-rho * 0.5);
  col += stars(d, 0.12, t) * 0.8;
  return col;
}

// One sample of the picture at a fragment position.
vec4 shade(vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * u_res) / min(u_res.x, u_res.y);
  float edge = 1.0 - smoothstep(0.42, 0.5, length(uv));
  if (edge <= 0.0) { return vec4(0.0); }

  float t = u_time;
  float r = length(uv);
  float b = r / RIM;                 // 1.0 at the rim of the sphere
  vec2 n = r > 0.0 ? uv / r : vec2(0.0, 1.0);
  float glow = 0.35 + u_intensity;   // the voice: brighter core, hotter rim

  vec3 col = vec3(0.0);
  float alpha = 0.0;
  // Width of one pixel in units of b, for the rim blend below.
  float px = 1.0 / (min(u_res.x, u_res.y) * RIM);
  float rimMix = smoothstep(1.0 - px, 1.0 + px, b);

  if (rimMix < 1.0) {
    // Inside the throat. The deflection grows from nothing at the centre to
    // a full wrap at the rim, which is what stretches the far universe into
    // rings and doubles its stars against the edge.
    float theta = pow(b, 0.58) * 2.75;
    // The space dragged round. At 0.012 this took nearly nine minutes for a
    // single revolution, which reads as a still image; it now turns in about
    // a minute and a half, slow enough to stay calm in a corner bubble.
    float twist = t * 0.07;
    vec2 m = vec2(cos(twist), sin(twist));
    vec2 nn = vec2(n.x * m.x - n.y * m.y, n.x * m.y + n.y * m.x);
    vec3 dir = normalize(vec3(nn * sin(theta), cos(theta)));
    col = farUniverse(dir, t) * (0.9 + 0.6 * u_intensity);
    col = col / (1.0 + col * 0.7);

    // Limb: light near the rim has come the long way round and is fainter,
    // then the Einstein ring where the lens focuses everything behind it.
    float limb = smoothstep(0.78, 1.0, b);
    col = mix(col, col * 0.45, limb * 0.6);
    float ring = exp(-pow((b - 0.982) * 70.0, 2.0));
    float ringSoft = exp(-pow((b - 0.95) * 12.0, 2.0)) * 0.16;
    col += (u_inner * ring * 1.15 + u_outer * ringSoft) * glow;
    // Warm bloom inside the rim as it speaks.
    col += u_outer * smoothstep(0.55, 1.0, b) * 0.25 * u_intensity;
    alpha = 1.0;
  }
  if (rimMix > 0.0) {
    vec3 inCol = col;
    float inAlpha = alpha;
    col = vec3(0.0);
    // Outside: a point-mass lens. A source at angle beta appears at theta
    // with theta - E^2/theta = beta, so everything behind the throat is
    // smeared tangentially into arcs around it, and the arcs pull in as the
    // rim is approached.
    float E = 0.92;
    float bo = max(b, 1.0);
    float beta = bo - (E * E) / bo;
    // The field orbits the throat, faster close in, so the lensed arcs sweep
    // around the rim instead of hanging fixed in the sky.
    float orbit = t * 0.35 / (0.35 + b);
    vec2 no = vec2(
      n.x * cos(orbit) - n.y * sin(orbit),
      n.x * sin(orbit) + n.y * cos(orbit)
    );
    vec2 src = no * beta * RIM;
    vec3 dir = normalize(vec3(src * 2.1, 1.0));
    // The source plane is sampled once: the mapping itself stretches each
    // star tangentially by b/beta and squeezes it radially, which is the arc.
    vec3 sky = stars(dir, 0.045, t);
    float fade = 1.0 - smoothstep(1.0, 1.9, b);
    col += sky * (0.55 + 0.45 * u_intensity) * fade * 0.9;
    // The glow spilling out of the throat, swelling with the voice.
    float halo = exp(-(b - 1.0) * 4.2) * 0.4 * glow;
    float haloWide = exp(-(b - 1.0) * 1.3) * 0.12 * u_intensity;
    col += u_outer * halo + u_inner * haloWide;
    // The rim seen from outside: a hair of the ring bleeds past the edge.
    col += u_inner * exp(-pow((b - 1.0) * 55.0, 2.0)) * 0.55 * glow;
    alpha = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
    col = mix(inCol, col, rimMix);
    alpha = mix(inAlpha, alpha, rimMix);
  }

  col *= u_brightness;
  col *= edge;
  alpha *= edge;
  alpha = clamp(max(alpha, max(col.r, max(col.g, col.b))), 0.0, 1.0);
  return vec4(col, alpha);
}

// Four rotated-grid samples per pixel: the rim, the thin ring and the
// point-lensed stars are all far narrower than a pixel at the small sizes
// the orb is drawn at, and a single sample crawls as they move.
void main() {
  vec4 acc = shade(gl_FragCoord.xy + vec2(0.125, 0.375));
  acc += shade(gl_FragCoord.xy + vec2(0.375, -0.125));
  acc += shade(gl_FragCoord.xy + vec2(-0.125, -0.375));
  acc += shade(gl_FragCoord.xy + vec2(-0.375, 0.125));
  gl_FragColor = acc * 0.25;
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("BlackHoleOrb shader failed to compile", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Builds the renderer on a canvas, or returns null when WebGL is unavailable
 * so the caller can leave the CSS fallback showing.
 */
export function createBlackHoleRenderer(canvas: HTMLCanvasElement): BlackHoleRenderer | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  if (gl === null) return null;

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  const program = gl.createProgram();
  if (vertex === null || fragment === null || program === null) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("BlackHoleOrb program failed to link", gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const uniforms = {
    res: gl.getUniformLocation(program, "u_res"),
    time: gl.getUniformLocation(program, "u_time"),
    inner: gl.getUniformLocation(program, "u_inner"),
    outer: gl.getUniformLocation(program, "u_outer"),
    brightness: gl.getUniformLocation(program, "u_brightness"),
    intensity: gl.getUniformLocation(program, "u_intensity"),
    seed: gl.getUniformLocation(program, "u_seed"),
  };

  gl.clearColor(0, 0, 0, 0);

  return {
    resize: (width, height) => {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
    },
    render: (frame) => {
      gl.uniform2f(uniforms.res, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, frame.time);
      gl.uniform3f(uniforms.inner, frame.inner[0], frame.inner[1], frame.inner[2]);
      gl.uniform3f(uniforms.outer, frame.outer[0], frame.outer[1], frame.outer[2]);
      gl.uniform1f(uniforms.brightness, frame.brightness);
      gl.uniform1f(uniforms.intensity, frame.intensity);
      gl.uniform1f(uniforms.seed, frame.seed);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    destroy: () => {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      // Deliberately not `loseContext()`: a canvas hands back the *same*
      // context on the next `getContext`, lost or not, and React's development
      // double-mount re-creates the renderer on this canvas straight after
      // destroying it. Losing the context there left the second renderer
      // compiling into a dead context, which drew nothing at all.
    },
  };
}

/** `#rrggbb` → linear-ish 0..1 triple for the shader. */
export function hexToRgb(hex: string): readonly [number, number, number] {
  const value = hex.replace("#", "");
  const n = Number.parseInt(value.length === 3 ? value.replace(/./g, "$&$&") : value, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
