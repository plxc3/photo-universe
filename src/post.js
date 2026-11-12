import * as THREE from 'three';

const TAU = Math.PI * 2;

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c) {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * (v ** (1 / 2.4)) - 0.055;
}

function rgbFloatToHex(r, g, b) {
  const toByte = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
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
 * Extracts perceptual spectral key, luminous gallery accent swatch, normalized mood RGB,
 * and darkroom tone classification from a photograph's average RGB [0..255].
 */
export function extractPhotoMood(r255, g255, b255) {
  const spectralKey = rgbToSpectralKey(r255, g255, b255);
  const rn = Math.max(0, Math.min(255, r255)) / 255;
  const gn = Math.max(0, Math.min(255, g255)) / 255;
  const bn = Math.max(0, Math.min(255, b255)) / 255;

  if (spectralKey >= 1) {
    return {
      spectralKey,
      accentHex: '#cfc9bf',
      moodRgb: [0.58, 0.56, 0.54],
      toneLabel: '银盐 · SILVER',
    };
  }

  // Lift dark/muted averages into a tasteful luminous curatorial accent without clipping.
  const luma = 0.2126 * rn + 0.7152 * gn + 0.0722 * bn;
  const lift = luma < 0.42 ? 0.42 / Math.max(0.08, luma) : 1.0;
  let ar = Math.min(1, rn * lift);
  let ag = Math.min(1, gn * lift);
  let ab = Math.min(1, bn * lift);
  const mean = (ar + ag + ab) / 3;
  ar = Math.max(0.18, Math.min(0.96, mean + (ar - mean) * 1.45));
  ag = Math.max(0.18, Math.min(0.96, mean + (ag - mean) * 1.45));
  ab = Math.max(0.18, Math.min(0.96, mean + (ab - mean) * 1.45));

  // Ensure linear->sRGB perceptual balance for UI chips.
  const sr = linearToSrgb(srgbToLinear(ar) * 0.92 + 0.04);
  const sg = linearToSrgb(srgbToLinear(ag) * 0.92 + 0.04);
  const sb = linearToSrgb(srgbToLinear(ab) * 0.92 + 0.04);

  let toneLabel = '琥珀 · AMBER';
  if (spectralKey >= 0.84) toneLabel = '绯红 · CRIMSON';
  else if (spectralKey >= 0.68) toneLabel = '暮紫 · VIOLET';
  else if (spectralKey >= 0.48) toneLabel = '钴蓝 · COBALT';
  else if (spectralKey >= 0.30) toneLabel = '冰青 · CYAN';
  else if (spectralKey >= 0.14) toneLabel = '苍翠 · EMERALD';

  return {
    spectralKey,
    accentHex: rgbFloatToHex(sr, sg, sb),
    moodRgb: [
      Number(sr.toFixed(3)),
      Number(sg.toFixed(3)),
      Number(sb.toFixed(3)),
    ],
    toneLabel,
  };
}

/**
 * Mood-driven volumetric darkroom atmosphere backdrop:
 * Renders a depth-off full-screen light field behind all 3D geometry (`renderOrder = -10`),
 * replacing flat dead `#000000` with two slow-drifting volumetric lobes that smoothly
 * bleed toward the hovered or focused photograph's dominant palette.
 */
export function createAtmosphereField() {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const uniforms = {
    uTime: { value: 0 },
    uPrimaryColor: { value: new THREE.Color('#2b1e15') },
    uSecondaryColor: { value: new THREE.Color('#121a2b') },
    uIntensity: { value: 0.085 },
    uTunnelFactor: { value: 0 },
    uFocusFactor: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    transparent: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.9999, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform float uTime;
      uniform vec3 uPrimaryColor;
      uniform vec3 uSecondaryColor;
      uniform float uIntensity;
      uniform float uTunnelFactor;
      uniform float uFocusFactor;
      varying vec2 vUv;

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      void main() {
        vec2 uv = vUv;
        float t = uTime * 0.15;

        vec2 c1 = vec2(
          0.50 + sin(t * 0.93) * 0.08 + cos(t * 0.47) * 0.03,
          0.50 + cos(t * 0.79) * 0.07 + sin(t * 0.61) * 0.02
        );
        vec2 c2 = vec2(
          0.46 + cos(t * 0.71) * 0.10,
          0.53 + sin(t * 0.83) * 0.08
        );

        float r1 = mix(0.46, 0.64, uFocusFactor);
        float r2 = mix(0.40, 0.52, uFocusFactor);
        float lobe1 = pow(smoothstep(r1, 0.0, distance(uv, c1)), 2.8);
        float lobe2 = pow(smoothstep(r2, 0.0, distance(uv, c2)), 3.0);

        // Keep true OLED obsidian black (#010103 in sRGB) across outer frame & tunnel abyss
        float tunnelSuppress = 1.0 - uTunnelFactor * 0.92;
        float gazeBoost = 1.0 + uFocusFactor * 1.45;
        float amp = uIntensity * tunnelSuppress * gazeBoost;

        vec3 base = vec3(0.00024, 0.00026, 0.00046);
        vec3 color = base;
        color += uPrimaryColor * (lobe1 * amp);
        color += uSecondaryColor * (lobe2 * amp * 0.78);

        float centerDist = distance(uv, vec2(0.5, 0.5));
        float edgeVignette = smoothstep(0.78, 0.14, centerDist);
        color *= mix(0.18, 1.0, edgeVignette);

        // Linear-safe micro-dither prevents 8-bit banding without lifting black floor
        float dither = (hash12(gl_FragCoord.xy + fract(uTime) * 97.0) - 0.5) * 0.00035;
        gl_FragColor = vec4(max(vec3(0.0), color + dither), 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return {
    mesh,
    uniforms,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
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
    uWarpBoost: { value: 0 },
    uAudioPulse: { value: 0 },
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
      uniform float uWarpBoost;
      uniform float uAudioPulse;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.24 + aPhase) * 0.85;
        p.y += cos(uTime * 0.19 + aPhase * 1.3) * 0.85;
        p.z = -132.0 + mod(p.z + 132.0 + uConveyor * 0.55 + uTime * (0.45 + uWarpBoost * 8.5), 196.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = max(1.0, -mv.z);
        float pulseSize = 1.0 + uAudioPulse * 0.28 + uWarpBoost * 0.45;
        gl_PointSize = clamp((28.0 * aScale * pulseSize * uPixelRatio) / dist, 1.0, 6.8);
        float nearFade = smoothstep(2.0, 10.0, dist);
        float farFade = 1.0 - smoothstep(75.0, 165.0, dist);
        vAlpha = nearFade * farFade * (0.55 + 0.45 * sin(uTime * 0.7 + aPhase)) * (1.0 + uAudioPulse * 0.35 + uWarpBoost * 0.55);
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
 * 2) Full-resolution composite with 14-tap Golden-Angle Vogel Disc Bokeh DOF
 *    (during 3D In-Situ Gaze), tunnel velocity chromatic dispersion, ACES Filmic
 *    highlight roll-off, fine silver-halide film grain, and optical vignette.
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
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexelSize;
        varying vec2 vUv;
        vec3 extractBright(vec3 c) {
          float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float knee = smoothstep(0.64, 1.04, luma);
          vec3 hdrGlint = max(vec3(0.0), c - vec3(0.92)) * 1.45;
          return (c * knee + hdrGlint) * vec3(1.08, 0.95, 0.84);
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
        uSceneTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uTime: { value: 0 },
        uWarp: { value: 0 },
        uFocusBlur: { value: 0 },
        uHalation: { value: 0.30 },
        uGrain: { value: 0.016 },
        uPointerUv: { value: new THREE.Vector2(0.5, 0.5) },
        uPointerVel: { value: new THREE.Vector2(0, 0) },
        uRippleEnergy: { value: 0 },
        uAudioEnergy: { value: 0 },
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
        precision highp float;
        uniform sampler2D tScene;
        uniform sampler2D tHalation;
        uniform vec2 uSceneTexel;
        uniform float uTime;
        uniform float uWarp;
        uniform float uFocusBlur;
        uniform float uHalation;
        uniform float uGrain;
        uniform vec2 uPointerUv;
        uniform vec2 uPointerVel;
        uniform float uRippleEnergy;
        uniform float uAudioEnergy;
        varying vec2 vUv;

        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        // Subtle ACES-inspired filmic shoulder so bright HDR glints roll off smoothly
        vec3 filmicShoulder(vec3 x) {
          return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
        }

        // 22-tap Golden-Angle Vogel Disc + prefiltered halation cushion for velvety optical bokeh
        vec3 sampleOpticalBokeh(vec2 uv, float amount) {
          vec2 radius = uSceneTexel * (13.5 * amount);
          float jitter = hash12(gl_FragCoord.xy) * 6.2831853;
          vec3 acc = texture2D(tScene, uv).rgb * 1.15;
          float total = 1.15;
          for (int i = 1; i <= 22; i++) {
            float fi = float(i);
            float r = sqrt(fi / 22.5);
            float theta = fi * 2.39996323 + jitter * 0.16;
            vec2 offset = vec2(cos(theta), sin(theta)) * r * radius;
            vec2 sampleUv = clamp(uv + offset, 0.001, 0.999);
            vec3 sharpTap = texture2D(tScene, sampleUv).rgb;
            vec3 softTap = texture2D(tHalation, sampleUv).rgb;
            vec3 tap = mix(sharpTap, max(sharpTap * 0.72, softTap * 1.12), smoothstep(0.25, 0.9, amount) * 0.42);
            float luma = dot(tap, vec3(0.2126, 0.7152, 0.0722));
            // Specular bokeh highlight emphasis (medium-format lens aperture character)
            float weight = 1.0 + smoothstep(0.22, 0.85, luma) * 1.35;
            acc += tap * weight;
            total += weight;
          }
          return acc / total;
        }

        void main() {
          vec2 centered = vUv - vec2(0.5);
          float r2 = dot(centered, centered);

          // Active Theory Hydra-inspired screen-space glass wake & velocity refraction
          float aspect = uSceneTexel.y / max(1e-6, uSceneTexel.x);
          vec2 toPtr = (vUv - uPointerUv) * vec2(aspect, 1.0);
          float ptrDist2 = dot(toPtr, toPtr);
          float ptrDist = sqrt(ptrDist2 + 1e-6);
          float wake = exp(-ptrDist2 * 36.0) * uRippleEnergy * (1.0 - smoothstep(0.1, 0.6, uFocusBlur));
          float ringWave = sin(ptrDist * 42.0 - uTime * 8.5) * exp(-ptrDist2 * 18.0) * uRippleEnergy * 0.35;
          vec2 fluidRefract = uPointerVel * (wake * 0.014) + (toPtr / ptrDist) * (ringWave * 0.0028);
          vec2 baseUv = clamp(vUv - fluidRefract, 0.001, 0.999);

          vec2 dispersion = centered * r2 * (0.0085 * uWarp) + fluidRefract * 0.55;

          vec3 color;
          if (uFocusBlur > 0.006) {
            color = sampleOpticalBokeh(baseUv, uFocusBlur);
          } else {
            float r = texture2D(tScene, clamp(baseUv + dispersion, 0.0, 1.0)).r;
            float g = texture2D(tScene, baseUv).g;
            float b = texture2D(tScene, clamp(baseUv - dispersion, 0.0, 1.0)).b;
            color = vec3(r, g, b);
          }

          vec3 glow = texture2D(tHalation, baseUv).rgb;
          float liveHalation = uHalation * (1.0 + uFocusBlur * 0.45 + uAudioEnergy * 0.24 + uWarp * 0.16);
          color += glow * liveHalation;
          color = mix(clamp(color, 0.0, 1.0), filmicShoulder(color * 1.08), 0.42);

          // Optical lens vignette deepens subtly during close-up 3D Gaze
          float vignette = 1.0 - r2 * mix(0.22, 0.46, uFocusBlur);
          color *= vignette;

          gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
          #include <colorspace_fragment>

          // Apply silver-halide grain AFTER sRGB conversion & mask out obsidian shadows
          float srgbLuma = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
          float noise = hash12(gl_FragCoord.xy + fract(uTime * 7.3) * 197.0) - 0.5;
          float grainMask = smoothstep(0.045, 0.28, srgbLuma) * (1.0 - smoothstep(0.88, 1.0, srgbLuma) * 0.5);
          gl_FragColor.rgb = clamp(gl_FragColor.rgb + noise * uGrain * grainMask, 0.0, 1.0);
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
    this.compositeMaterial.uniforms.uSceneTexel.value.set(1 / w, 1 / h);
    const bw = Math.max(1, Math.floor(w * 0.28));
    const bh = Math.max(1, Math.floor(h * 0.28));
    this.bloomTarget.setSize(bw, bh);
    this.halationMaterial.uniforms.uTexelSize.value.set(1 / bw, 1 / bh);
  }

  render(scene, camera, {
    time = 0,
    warp = 0,
    focusBlur = 0,
    pointerUv = null,
    pointerVel = null,
    rippleEnergy = 0,
    audioEnergy = 0,
  } = {}) {
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

    const cu = this.compositeMaterial.uniforms;
    cu.tScene.value = this.sceneTarget.texture;
    cu.tHalation.value = this.bloomTarget.texture;
    cu.uTime.value = time;
    cu.uWarp.value = warp;
    cu.uFocusBlur.value = focusBlur;
    if (pointerUv) cu.uPointerUv.value.copy(pointerUv);
    if (pointerVel) cu.uPointerVel.value.copy(pointerVel);
    cu.uRippleEnergy.value = rippleEnergy;
    cu.uAudioEnergy.value = audioEnergy;
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
