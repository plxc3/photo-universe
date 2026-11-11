import * as THREE from 'three';

/**
 * Instanced 3D photograph card material with custom GLSL 3-point chiaroscuro,
 * Kodachrome micro-contrast, proximity hover lift, and active focus slot masking.
 */
export function createInstancedCardMaterial(texture, uniforms) {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    color: '#ffffff',
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const varyings = [
      'varying vec2 vPaperUv;',
      'varying vec3 vPhotoNormal;',
      'varying vec3 vWorldNormal;',
      'varying vec3 vViewDir;',
      'varying float vPhotoDepth;',
      'varying float vHoverLift;',
      'varying float vFocusKeep;',
      '',
    ].join('\n');
    const vertUniforms = [
      'uniform vec3 uHoverWorld;',
      'uniform float uHoverStrength;',
      'uniform float uFocusAmount;',
      'uniform float uFocusSlotHide;',
      'uniform vec3 uFocusWorld;',
      '',
    ].join('\n');
    shader.vertexShader = 'attribute vec4 atlasRect;\n' + vertUniforms + varyings + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = atlasRect.xy + vMapUv * atlasRect.zw;\n#endif',
    );
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 cardWorldCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
      #else
        vec3 cardWorldCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
      #endif
      float hoverDist = length(cardWorldCenter - uHoverWorld);
      vHoverLift = uHoverStrength * exp(-(hoverDist * hoverDist) / 16.0);
      vFocusKeep = 1.0 - smoothstep(0.04, 0.20, length(cardWorldCenter - uFocusWorld));
      transformed *= mix(1.0, 1.0 - vFocusKeep, max(uFocusSlotHide, smoothstep(0.02, 0.28, uFocusAmount)));
      transformed.z += vHoverLift * 0.36 * (1.0 - uFocusAmount);
      transformed.xy *= 1.0 + vHoverLift * 0.052 * (1.0 - uFocusAmount);`);
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      vPaperUv = uv;
      vPhotoNormal = normalize(normalMatrix * mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
      vViewDir = normalize(-mvPosition.xyz);
      vPhotoDepth = -mvPosition.z;`);
    shader.fragmentShader = varyings
      + 'uniform float uReveal;\nuniform float uDepthNear;\nuniform float uDepthFar;\nuniform float uTunnelMode;\nuniform float uFocusAmount;\nuniform vec3 uPaperBackground;\n'
      + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      vec3 n = normalize(vPhotoNormal);
      vec3 wn = normalize(vWorldNormal);
      if (!gl_FrontFacing) {
        n = -n;
        wn = -wn;
      }
      vec3 v = normalize(vViewDir);

      // 3-point gallery chiaroscuro gives the 24-facet stellated polyhedron razor-sharp 3D relief
      float keyLight = clamp(dot(wn, normalize(vec3(-0.48, 0.60, 0.64))), 0.0, 1.0);
      float rimLight = clamp(dot(wn, normalize(vec3(0.70, 0.22, -0.68))), 0.0, 1.0);
      float skyFill = clamp(wn.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 sculptShade = vec3(0.38, 0.40, 0.45)
        + vec3(0.84, 0.81, 0.76) * pow(keyLight, 1.15)
        + vec3(0.24, 0.27, 0.34) * pow(rimLight, 1.6)
        + vec3(0.07, 0.08, 0.10) * skyFill;
      vec3 activeShade = mix(sculptShade, vec3(1.03, 1.02, 1.00), uTunnelMode);

      vec3 halfVec = normalize(normalize(vec3(-0.30, 0.42, 0.86)) + v);
      float spec = pow(clamp(dot(n, halfVec), 0.0, 1.0), 42.0) * mix(0.38, 0.14, uTunnelMode);
      float fresnel = pow(1.0 - abs(dot(n, v)), 3.8) * 0.09;

      // Rich Kodachrome slide chroma & micro-contrast against deep obsidian void
      float luma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      diffuseColor.rgb = clamp(mix(vec3(luma), diffuseColor.rgb, 1.28) * 1.08, 0.0, 1.15);

      float backShade = gl_FrontFacing ? 1.0 : mix(0.74, 0.88, uTunnelMode);
      float horizonFade = mix(
        mix(1.0, 0.84, smoothstep(uDepthNear, uDepthFar, vPhotoDepth)),
        1.0 - smoothstep(38.0, 148.0, vPhotoDepth),
        uTunnelMode
      );
      float focusDim = mix(1.0, mix(0.20, 1.0, vFocusKeep), uFocusAmount);
      vec2 edge = min(vPaperUv, vec2(1.0) - vPaperUv);
      float edgeDistance = min(edge.x, edge.y);
      float bevel = (1.0 - smoothstep(0.008, 0.030, edgeDistance)) * 0.06;
      diffuseColor.rgb = (diffuseColor.rgb * activeShade + vec3(spec + fresnel + bevel) * vec3(1.0, 0.96, 0.90)) * backShade * horizonFade;
      diffuseColor.rgb *= (1.0 + vHoverLift * 0.32 * (1.0 - uFocusAmount)) * focusDim;
      float aa = max(0.003, min(fwidth(edgeDistance), 0.014));
      diffuseColor.rgb *= smoothstep(0.0, aa, edgeDistance);
      diffuseColor.rgb = mix(uPaperBackground, diffuseColor.rgb, uReveal);`);
  };
  material.customProgramCacheKey = () => 'memoria-darkroom-v6';
  return material;
}

/**
 * Full-frame 48x36 subdivided exhibition plate shader with leading-edge paper peel,
 * aspect-independent coverUv mapping, and counter-parallax optical glass curtain.
 */
export function createFocusLiquidMaterial(blankTex) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTexPrev: { value: blankTex },
      uTexCurr: { value: blankTex },
      uUvRectPrev: { value: new THREE.Vector4(0, 0, 1, 1) },
      uUvRectCurr: { value: new THREE.Vector4(0, 0, 1, 1) },
      uAspectPrev: { value: 1.5 },
      uAspectCurr: { value: 1.5 },
      uPlateAspect: { value: 1.5 },
      uLiftProgress: { value: 1 },
      uPeelDir: { value: new THREE.Vector2(0, 1) },
      uStartShade: { value: new THREE.Vector3(1, 1, 1) },
      uMix: { value: 1 },
      uFlowDir: { value: 1 },
      uCurl: { value: 0 },
      uTilt: { value: new THREE.Vector2(0, 0) },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
    },
    vertexShader: `
      uniform float uCurl;
      uniform vec2 uTilt;
      uniform float uLiftProgress;
      uniform vec2 uPeelDir;
      varying vec2 vUv;
      varying float vSheen;
      void main() {
        vUv = uv;
        vec3 pos = position;
        vec2 centered = uv - vec2(0.5);

        // Organic Leading-Edge Paper Peel during 3D lift-off & return (0 at endpoints)
        float lp = clamp(uLiftProgress, 0.0, 1.0);
        float flightEnv = sin(lp * 3.14159265);
        float peelLead = dot(centered, uPeelDir) * flightEnv * 0.22;
        float silkCamber = (0.16 - (centered.x * centered.x * 0.82 + centered.y * centered.y * 0.54)) * flightEnv * 0.28;

        // Gentle ribbon flex during photo carriage step + optical hover tilt
        float archX = (centered.x * centered.x - 0.0833) * uCurl * 0.28;
        float waveY = sin(centered.y * 3.14159265) * uCurl * 0.075;
        float hoverZ = (centered.x * uTilt.x - centered.y * uTilt.y) * 0.065 * lp;

        pos.z += hoverZ + peelLead + silkCamber - archX + waveY;
        vSheen = clamp(
          0.5 + (centered.x * 0.85 + centered.y * 0.55)
          + (uTilt.x * 0.65 - uTilt.y * 0.45) * lp
          + uCurl * 0.30
          + peelLead * 1.15,
          0.0,
          1.0
        );
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uTexPrev;
      uniform sampler2D uTexCurr;
      uniform vec4 uUvRectPrev;
      uniform vec4 uUvRectCurr;
      uniform float uAspectPrev;
      uniform float uAspectCurr;
      uniform float uPlateAspect;
      uniform float uLiftProgress;
      uniform vec3 uStartShade;
      uniform float uMix;
      uniform float uFlowDir;
      uniform float uOpacity;
      uniform float uTime;
      varying vec2 vUv;
      varying vec2 vSheenVec;
      varying float vSheen;

      vec2 coverUv(vec2 uv, float imgAspect, float plateAspect) {
        float safeImg = max(0.05, imgAspect);
        float safePlate = max(0.05, plateAspect);
        vec2 c = uv - vec2(0.5);
        if (safePlate > safeImg) {
          c.y *= safeImg / safePlate;
        } else {
          c.x *= safePlate / safeImg;
        }
        return c + vec2(0.5);
      }

      vec2 mapRect(vec2 uv, vec4 rect) {
        return rect.xy + clamp(uv, 0.001, 0.999) * rect.zw;
      }

      void main() {
        float t = clamp(uMix, 0.0, 1.0);
        vec3 col;

        if (t >= 0.9995) {
          vec2 uvC = coverUv(vUv, uAspectCurr, uPlateAspect);
          col = texture2D(uTexCurr, mapRect(uvC, uUvRectCurr)).rgb;
        } else if (t <= 0.0005) {
          vec2 uvP = coverUv(vUv, uAspectPrev, uPlateAspect);
          col = texture2D(uTexPrev, mapRect(uvP, uUvRectPrev)).rgb;
        } else {
          // Counter-parallax optical film carriage + curved glass curtain (zero 50/50 ghosting & zero stretch)
          float p = t * t * (3.0 - 2.0 * t);
          float env = sin(p * 3.14159265);

          float coord = (uFlowDir > 0.0 ? (1.0 - vUv.x) : vUv.x) * 0.86 + (1.0 - vUv.y) * 0.14;
          float wave = sin(vUv.y * 3.14159265) * 0.045 * env;
          float w = 0.34;
          float threshold = p * (1.0 + 2.0 * w) - w;
          float mask = smoothstep(coord - w + wave, coord + w + wave, threshold);
          float frontEnv = 4.0 * mask * (1.0 - mask);

          // Zoom margin strictly bounds parallax + glass refraction so edges never clamp-streak
          float zoomPrev = 1.0 + 0.135 * p;
          float zoomCurr = 1.0 + 0.135 * (1.0 - p);
          float refractX = uFlowDir * 0.016 * frontEnv * env;
          float refractY = sin(vUv.y * 6.2831853 + uTime * 1.8) * 0.006 * frontEnv * env;

          vec2 basePrev = coverUv(vUv, uAspectPrev, uPlateAspect);
          vec2 baseCurr = coverUv(vUv, uAspectCurr, uPlateAspect);

          vec2 uvPrev = (basePrev - vec2(0.5)) / zoomPrev + vec2(0.5) + vec2(uFlowDir * 0.052 * p + refractX, refractY);
          vec2 uvCurr = (baseCurr - vec2(0.5)) / zoomCurr + vec2(0.5) + vec2(-uFlowDir * 0.052 * (1.0 - p) - refractX, -refractY);

          vec3 colPrev = texture2D(uTexPrev, mapRect(uvPrev, uUvRectPrev)).rgb * (1.0 - 0.22 * p);
          vec3 colCurr = texture2D(uTexCurr, mapRect(uvCurr, uUvRectCurr)).rgb;

          col = mix(colPrev, colCurr, mask);
          col += vec3(1.0, 0.97, 0.92) * (frontEnv * env * 0.038);
        }

        // Continuous lighting development from 3D crystal facet shade -> pure exhibition light
        float shadeBlend = smoothstep(0.0, 0.62, clamp(uLiftProgress, 0.0, 1.0));
        vec3 facetShade = mix(uStartShade, vec3(1.0), shadeBlend);
        col *= facetShade;

        float sheen = pow(clamp(1.0 - abs(vSheen - 0.52) * 2.1, 0.0, 1.0), 3.0) * 0.028;
        col += vec3(1.0, 0.97, 0.92) * sheen;

        vec2 edge = min(vUv, vec2(1.0) - vUv);
        float edgeDist = min(edge.x, edge.y);
        float aa = max(0.0018, fwidth(edgeDist));
        float alpha = smoothstep(0.0, aa, edgeDist) * uOpacity;
        if (alpha < 0.003) discard;
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }
    `,
  });
}
