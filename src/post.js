import * as THREE from 'three';

const TAU = Math.PI * 2;

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Perceptually uniform OKLab spectral sort key from average RGB [0..255].
 * Saturated photographs sort continuously around the hue wheel starting at warm
 * amber-gold; low-chroma monochrome prints form a cohesive silver-charcoal bridge.
 */
export function rgbToSpectralKey(r255, g255, b255) {
  const r = srgbToLinear(Math.max(0, Math.min(255, r255)) / 255);
  const g = srgbToLinear(Math.max(0, Math.min(255, g255)) / 255);
  const b = srgbToLinear(Math.max(0, Math.min(255, b255)) / 255);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bLab = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;

  const chroma = Math.hypot(a, bLab);
  if (chroma < 0.010) {
    return 1 + Math.max(0, Math.min(1, L)) * 0.25;
  }
  // Anchor 0.0 at warm gold (~55 deg in OKLab) for an editorial warm-to-cool-to-warm arc.
  const hue = (Math.atan2(bLab, a) - 0.96 + TAU * 2) % TAU;
  return hue / TAU;
}

/**
 * Subtle 3D floating dust motes providing spatial parallax and depth scale
 * without touching `PhotoUniverse.meshes` raycasting or disposal invariants.
 */
export function createDustField(count = 260) {
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const phases = new Float32Array(count);

  let seed = 0x51f2a9c3;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };

  for (let i = 0; i < count; i++) {
    const theta = rand() * TAU;
    const radius = 8.5 + rand() * 44;
    positions[i * 3] = Math.cos(theta) * radius;
    positions[i * 3 + 1] = Math.sin(theta) * radius;
    positions[i * 3 + 2] = -132 + rand() * 196;
    scales[i] = 0.55 + rand() * 1.45;
    phases[i] = rand() * TAU;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const uniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: 1 },
    uOpacity: { value: 0.24 },
    uConveyor: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aScale;
      attribute float aPhase;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uConveyor;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.24 + aPhase) * 0.85;
        p.y += cos(uTime * 0.19 + aPhase * 1.3) * 0.85;
        p.z = -132.0 + mod(p.z + 132.0 + uConveyor * 0.55 + uTime * 0.45, 196.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = max(1.0, -mv.z);
        gl_PointSize = clamp((28.0 * aScale * uPixelRatio) / dist, 1.0, 5.5);
        float nearFade = smoothstep(2.0, 10.0, dist);
        float farFade = 1.0 - smoothstep(75.0, 165.0, dist);
        vAlpha = nearFade * farFade * (0.55 + 0.45 * sin(uTime * 0.7 + aPhase));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float r2 = dot(c, c);
        if (r2 > 0.25) discard;
        float soft = exp(-r2 * 14.0);
        gl_FragColor = vec4(vec3(0.96, 0.91, 0.84), soft * vAlpha * uOpacity);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -1;
  return {
    points,
    uniforms,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Lightweight 2-pass darkroom optical pipeline:
 * 1) Quarter-resolution warm photochemical halation extraction + blur
 * 2) Full-resolution composite with tunnel velocity chromatic dispersion,
 *    fine silver-halide film grain, and subtle optical vignette.
 */
export class DarkroomPipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    const isWebGL2 = Boolean(renderer.capabilities?.isWebGL2);
    const targetOptions = {
      type: isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    };
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, targetOptions);
    this.bloomTarget = new THREE.WebGLRenderTarget(1, 1, {
      ...targetOptions,
      depthBuffer: false,
    });

    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadGeometry = new THREE.PlaneGeometry(2, 2);

    this.halationMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec2 uTexelSize;
        varying vec2 vUv;
        vec3 extractBright(vec3 c) {
          float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float knee = smoothstep(0.62, 0.98, luma);
          return c * knee * vec3(1.08, 0.93, 0.82);
        }
        void main() {
          vec2 o = uTexelSize * 2.2;
          vec3 sum = extractBright(texture2D(tDiffuse, vUv).rgb) * 0.28;
          sum += extractBright(texture2D(tDiffuse, vUv + vec2(o.x, o.y)).rgb) * 0.12;
          sum += extractBright(texture2D(tDiffuse, vUv + vec2(-o.x, o.y)).rgb) * 0.12;
          sum += extractBright(texture2D(tDiffuse, vUv + vec2(o.x, -o.y)).rgb) * 0.12;
          sum += extractBright(texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb) * 0.12;
          sum += extractBright(texture2D(tDiffuse, vUv + vec2(o.x * 2.1, 0.0)).rgb) * 0.06;
          sum += extractBright(texture2D(tDiffuse, vUv + vec2(-o.x * 2.1, 0.0)).rgb) * 0.06;
          sum += extractBright(texture2D(tDiffuse, vUv + vec2(0.0, o.y * 2.1)).rgb) * 0.06;
          sum += extractBright(texture2D(tDiffuse, vUv + vec2(0.0, -o.y * 2.1)).rgb) * 0.06;
          gl_FragColor = vec4(sum, 1.0);
        }
      `,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tHalation: { value: null },
        uTime: { value: 0 },
        uWarp: { value: 0 },
        uHalation: { value: 0.24 },
        uGrain: { value: 0.015 },
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tScene;
        uniform sampler2D tHalation;
        uniform float uTime;
        uniform float uWarp;
        uniform float uHalation;
        uniform float uGrain;
        varying vec2 vUv;

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          vec2 centered = vUv - vec2(0.5);
          float r2 = dot(centered, centered);
          vec2 dispersion = centered * r2 * (0.0085 * uWarp);

          float r = texture2D(tScene, clamp(vUv + dispersion, 0.0, 1.0)).r;
          float g = texture2D(tScene, vUv).g;
          float b = texture2D(tScene, clamp(vUv - dispersion, 0.0, 1.0)).b;
          vec3 color = vec3(r, g, b);

          vec3 glow = texture2D(tHalation, vUv).rgb;
          color += glow * uHalation;

          // Subtle optical vignette that preserves center brightness
          float vignette = 1.0 - r2 * 0.18;
          color *= vignette;

          // Fine monochrome silver-halide film grain
          float noise = hash12(gl_FragCoord.xy + fract(uTime * 7.3) * 197.0) - 0.5;
          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          color += noise * uGrain * (0.35 + 0.65 * smoothstep(0.02, 0.35, luma));

          gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
          #include <colorspace_fragment>
        }
      `,
    });

    this.halationMesh = new THREE.Mesh(this.quadGeometry, this.halationMaterial);
    this.halationScene = new THREE.Scene();
    this.halationScene.add(this.halationMesh);

    this.compositeMesh = new THREE.Mesh(this.quadGeometry, this.compositeMaterial);
    this.compositeScene = new THREE.Scene();
    this.compositeScene.add(this.compositeMesh);
  }

  setSize(width, height, pixelRatio = 1) {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    this.sceneTarget.setSize(w, h);
    const bw = Math.max(1, Math.floor(w * 0.28));
    const bh = Math.max(1, Math.floor(h * 0.28));
    this.bloomTarget.setSize(bw, bh);
    this.halationMaterial.uniforms.uTexelSize.value.set(1 / bw, 1 / bh);
  }

  render(scene, camera, { time = 0, warp = 0 } = {}) {
    if (!this.enabled) {
      this.renderer.render(scene, camera);
      return;
    }
    const previousTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.render(scene, camera);

    this.halationMaterial.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this.renderer.setRenderTarget(this.bloomTarget);
    this.renderer.render(this.halationScene, this.orthoCamera);

    this.compositeMaterial.uniforms.tScene.value = this.sceneTarget.texture;
    this.compositeMaterial.uniforms.tHalation.value = this.bloomTarget.texture;
    this.compositeMaterial.uniforms.uTime.value = time;
    this.compositeMaterial.uniforms.uWarp.value = warp;
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.render(this.compositeScene, this.orthoCamera);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.bloomTarget.dispose();
    this.quadGeometry.dispose();
    this.halationMaterial.dispose();
    this.compositeMaterial.dispose();
  }
}
