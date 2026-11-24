    (() => {
      let canvas = document.getElementById("field");
      const heading = document.getElementById("name");
      const mottoEl = document.querySelector(".motto");
      const linksEl = document.querySelector(".links");
      const themeToggle = document.getElementById("theme-toggle");
      const lightQuery = window.matchMedia("(prefers-color-scheme: light)");
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const identityCharacters = [];
      const draggableCharacters = [];

      // followX/followY lag behind the real pointer; the field reads those, so a jittery
      // hand does not produce a jittery page.
      const pointer = { x: -1000, y: -1000, followX: -1000, followY: -1000, active: false };

      const THEME_STORAGE_KEY = "yu030x-theme";
      const PHYSICS_STEP = 1 / 60;
      const MAX_DROPLETS = 16;

      // 4x4 ordered Bayer matrix thresholds in [0.5/16, 15.5/16], used by the Canvas 2D
      // fallback to match the WebGL fragment shader bit-for-bit.
      const BAYER_4X4 = new Float32Array([
         0.5 / 16,  8.5 / 16,  2.5 / 16, 10.5 / 16,
        12.5 / 16,  4.5 / 16, 14.5 / 16,  6.5 / 16,
         3.5 / 16, 11.5 / 16,  1.5 / 16,  9.5 / 16,
        15.5 / 16,  7.5 / 16, 13.5 / 16,  5.5 / 16
      ]);

      // Misty Sea ("雾海月蓝") low-fatigue Bayer palettes for dark and paper themes.
      const themes = {
        dark: {
          background: "#0e141b",
          backRGB: [14 / 255, 20 / 255, 27 / 255],
          frontHex: "#8fb5c9",
          frontRGB: [143 / 255, 181 / 255, 201 / 255],
          lumScale: 1.0,
          lumGamma: 1.0,
          label: "Switch to paper theme"
        },
        paper: {
          background: "#f2efe9",
          backRGB: [242 / 255, 239 / 255, 233 / 255],
          frontHex: "#476675",
          frontRGB: [71 / 255, 102 / 255, 117 / 255],
          lumScale: 0.98,
          lumGamma: 1.1,
          label: "Switch to dark theme"
        }
      };

      const config = {
        desktopPixelSize: 2.5,
        mobilePixelSize: 2.0,
        fallbackDesktopGap: 4,
        fallbackMobileGap: 4,
        pointerRadius: 13,
        pointerSmoothing: 0.35,
        maximumPixelRatio: 2,
        mobileMaximumPixelRatio: 2,
        identity: {
          heading: {
            speed: 0.00108,
            wavelength: 0.0105,
            lift: 5.6,
            tilt: 1
          },
          motto: {
            speed: 0.0016,
            wavelength: 0.014,
            lift: 3.4,
            tilt: 1.7
          }
        },
        drag: {
          spring: 0.13,
          damping: 0.82,
          followStiffness: 0.34,
          returnStiffness: 0.1,
          followDamping: 0.66,
          maxRange: 84,
          stretchPerPixel: 0.055,
          maxStretch: 0.72,
          collisionPacking: 0.82,
          collisionBounce: 0.2,
          collisionPasses: 3
        },
        dwellDuration: 3900,
        morphDuration: 1050,
        glitchRows: 0.2,
        glitchThrow: 30,
        formRipple: {
          frequencyX: 0.032,
          frequencyY: 0.021,
          speed: 7.56,
          amplitude: 0.065,
          reach: 1.18,
          edge: 0.22,
          shimmer: 0.36
        },
        water: {
          tension: 0.42,
          damping: 0.978,
          levelling: 0.012,
          maxHeight: 2.5,
          pointerImpulse: 0.055,
          pointerReach: 2,
          formSplash: 0.42,
          horizon: 0.52,
          depthScale: 1,
          nearClip: 0.019,
          spread: 1.7,
          fadeIn: 0.055,
          crestGain: 0.72,
          amplitude: 0.9
        }
      };

      const LIGHTHOUSE_SCALE = 1.16;
      const LIGHTHOUSE_LAMP = -0.89;
      const FORM_CENTER_X = 0.63;
      const FORM_CENTER_X_NARROW = 0.64;
      const FORM_CENTER_Y = 0.46;
      const FORM_CENTER_Y_NARROW = 0.38;

      function formCenterX() {
        return width * (width < 760 ? FORM_CENTER_X_NARROW : FORM_CENTER_X);
      }

      function formCenterY() {
        return height * (width < 760 ? FORM_CENTER_Y_NARROW : FORM_CENTER_Y);
      }

      function formRadiusCss() {
        return Math.min(width, height) * (width < 760 ? 0.34 : 0.29);
      }

      const beamConfig = {
        speed: 0.62,
        halfWidth: 0.115,
        reach: 3.1,
        gain: 1.18,
        tilt: 0.22,
        lampGain: 0.82,
        flareGain: 1.15,
        coreReach: 0.34
      };

      const fishConfig = {
        minDelay: 6000,
        maxDelay: 15000,
        gravity: 680,
        riseMin: 110,
        riseMax: 185,
        driftMin: 95,
        driftMax: 180,
        length: 0.4,
        dropletMax: MAX_DROPLETS,
        dropletPerSplash: 10,
        dropletSpeed: 175,
        dropletGravity: 900,
        dropletLife: 1100,
        splashImpulse: 0.5
      };

      const swellWaves = [
        { angle: 1.4, wavelength: 2.3, amplitude: 1 },
        { angle: 1.13, wavelength: 1.35, amplitude: 0.42 },
        { angle: 0.42, wavelength: 0.62, amplitude: 0.18 }
      ];

      const forms = [
        { id: "lighthouse", ambient: true, procedural: false, draw: drawLighthouse, alphaGrid: null, waterMask: null, texture: null },
        { id: "signal", ambient: false, procedural: true, draw: drawSignalMask, alphaGrid: null, waterMask: null, texture: null },
        { id: "envelope", ambient: false, procedural: true, draw: drawEnvelopeMask, alphaGrid: null, waterMask: null, texture: null },
        { id: "fork", ambient: false, procedural: true, draw: drawForkMask, alphaGrid: null, waterMask: null, texture: null }
      ];

      const formIndex = new Map(forms.map((form, index) => [form.id, index]));
      const ambientOrder = forms.reduce((order, form, index) => {
        if (form.ambient) {
          order.push(index);
        }
        return order;
      }, []);

      const maskCanvas = document.createElement("canvas");
      const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });

      let width = 0;
      let height = 0;
      let dpr = 1;
      let cellPx = 3;
      let maskWidth = 0;
      let maskHeight = 0;
      let waterCols = 0;
      let waterRows = 0;
      let animationFrame = 0;
      let lastPaint = 0;
      let physicsAccumulator = 0;
      let resizeFrame = 0;
      let rasterKey = "";

      let themeName = themes[document.documentElement.dataset.theme] ? document.documentElement.dataset.theme : "dark";
      let theme = themes[themeName];

      // Interactive water heightfield + packed upload buffer
      let waterHeight = null;
      let waterVelocity = null;
      let waterTexData = null;

      // Morph state
      let sourceAlphaGrid = null;
      let sourceByteData = null;
      let sourceFormIdx = 0;
      let usingBlendedSourceTex = false;
      let toForm = 0;
      let morphStart = -Infinity;
      let blend = 1;
      let dwellUntil = 0;
      let ambientCursor = 0;
      let heldForm = null;
      let beamWeight = 1;
      let sourceBeamWeight = 1;
      let signalWeight = 0;
      let sourceSignalWeight = 0;
      let envelopeWeight = 0;
      let sourceEnvelopeWeight = 0;
      let envelopeHoverStart = 0;
      let envelopeOpen = 0;
      let forkWeight = 0;
      let sourceForkWeight = 0;
      let forkHoverStart = 0;

      // Fish & droplets
      const fish = {
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        surfaceY: 0,
        nextJumpAt: 0,
        startTime: 0,
        duration: 0.9,
        dir: 1,
        breached: false,
        reentered: false
      };
      const splashTakeoff = { x: 0, y: 0, time: -10000 };
      const splashLanding = { x: 0, y: 0, time: -10000 };
      const droplets = [];
      const dropletUniformData = new Float32Array(MAX_DROPLETS * 4);
      const linksRect = new Float32Array([0, 0, 0, 0]);
      const mottoRect = new Float32Array([0, 0, 0, 0]);

      // Drag state for YU030X letters
      const drag = {
        active: false,
        character: null,
        pointerId: null,
        originX: 0,
        originY: 0,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        lastX: 0,
        lastY: 0
      };

      let lastPointerX = 0;
      let lastPointerY = 0;

      // Renderer backend: WebGL primary + Canvas 2D Bayer fallback
      let useWebGL = false;
      let gl = null;
      let glProgram = null;
      let glQuadBuffer = null;
      let glUniforms = null;
      let glBlendedSourceTex = null;
      let glWaterTex = null;
      let contextLost = false;
      let fallbackContext = null;

      function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      }

      // ---------------------------------------------------------------------------
      // Shaded Form Drawing (outputs smooth alpha gradients for 4x4 Bayer halftone)
      // ---------------------------------------------------------------------------

      function drawLighthouse(ctx, radius, waterline) {
        const r = radius * LIGHTHOUSE_SCALE;
        const base = waterline;
        const towerTop = -0.68 * r;
        const shaftH = Math.max(0.55 * r, base - towerTop);

        // Tapered masonry shaft with 3D cylindrical sunlit shading
        const shaftGrad = ctx.createLinearGradient(-0.275 * r, 0, 0.275 * r, 0);
        shaftGrad.addColorStop(0, "rgba(255, 255, 255, 0.46)");
        shaftGrad.addColorStop(0.28, "rgba(255, 255, 255, 0.98)");
        shaftGrad.addColorStop(0.58, "rgba(255, 255, 255, 0.74)");
        shaftGrad.addColorStop(0.86, "rgba(255, 255, 255, 0.32)");
        shaftGrad.addColorStop(1, "rgba(255, 255, 255, 0.48)");

        ctx.fillStyle = shaftGrad;
        ctx.beginPath();
        ctx.moveTo(-0.275 * r, base);
        ctx.lineTo(-0.145 * r, towerTop);
        ctx.lineTo(0.145 * r, towerTop);
        ctx.lineTo(0.275 * r, base);
        ctx.closePath();
        ctx.fill();

        // Two bold architectural stripes scaled cleanly along the shaft height
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "#ffffff";
        ctx.globalAlpha = 0.78;
        const bandHeight = shaftH * 0.145;
        for (const frac of [0.22, 0.58]) {
          ctx.beginPath();
          ctx.rect(-0.32 * r, towerTop + shaftH * frac, 0.64 * r, bandHeight);
          ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;

        // Bold overhanging gallery deck + cornice lip
        const balconyGrad = ctx.createLinearGradient(0, -0.76 * r, 0, towerTop);
        balconyGrad.addColorStop(0, "rgba(255, 255, 255, 0.98)");
        balconyGrad.addColorStop(1, "rgba(255, 255, 255, 0.58)");
        ctx.fillStyle = balconyGrad;
        ctx.beginPath();
        ctx.rect(-0.25 * r, -0.76 * r, 0.5 * r, 0.08 * r);
        ctx.fill();

        ctx.strokeStyle = "rgba(255, 255, 255, 0.96)";
        ctx.lineWidth = Math.max(1.4, 0.025 * r);
        ctx.beginPath();
        ctx.moveTo(-0.26 * r, -0.76 * r);
        ctx.lineTo(0.26 * r, -0.76 * r);
        ctx.stroke();

        // Gallery railing + 4 posts
        ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
        ctx.lineWidth = Math.max(1.5, 0.032 * r);
        ctx.beginPath();
        ctx.moveTo(-0.24 * r, -0.835 * r);
        ctx.lineTo(0.24 * r, -0.835 * r);
        for (const px of [-0.22, -0.09, 0.09, 0.22]) {
          ctx.moveTo(px * r, -0.835 * r);
          ctx.lineTo(px * r, -0.76 * r);
        }
        ctx.stroke();

        // Framed lantern glass chamber
        ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
        ctx.beginPath();
        ctx.rect(-0.155 * r, -1.01 * r, 0.31 * r, 0.25 * r);
        ctx.fill();

        ctx.strokeStyle = "rgba(255, 255, 255, 0.96)";
        ctx.lineWidth = Math.max(1.6, 0.036 * r);
        ctx.beginPath();
        ctx.moveTo(-0.165 * r, -1.01 * r);
        ctx.lineTo(0.165 * r, -1.01 * r);
        ctx.moveTo(-0.165 * r, -0.76 * r);
        ctx.lineTo(0.165 * r, -0.76 * r);
        for (const mx of [-0.145, 0, 0.145]) {
          ctx.moveTo(mx * r, -1.01 * r);
          ctx.lineTo(mx * r, -0.76 * r);
        }
        ctx.stroke();

        // Hemispherical cupola dome + ball finial + lightning spire
        const domeGrad = ctx.createLinearGradient(-0.175 * r, 0, 0.175 * r, 0);
        domeGrad.addColorStop(0, "rgba(255, 255, 255, 0.96)");
        domeGrad.addColorStop(0.55, "rgba(255, 255, 255, 0.72)");
        domeGrad.addColorStop(1, "rgba(255, 255, 255, 0.42)");
        ctx.fillStyle = domeGrad;
        ctx.beginPath();
        ctx.arc(0, -1.01 * r, 0.175 * r, Math.PI, 0);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
        ctx.beginPath();
        ctx.arc(0, -1.2 * r, Math.max(1.5, 0.032 * r), 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = "rgba(255, 255, 255, 0.94)";
        ctx.lineWidth = Math.max(1.4, 0.03 * r);
        ctx.beginPath();
        ctx.moveTo(0, -1.2 * r);
        ctx.lineTo(0, -1.3 * r);
        ctx.stroke();

        // Stepped coastal cliff / rock base
        const rockGrad = ctx.createLinearGradient(0, base - 0.16 * r, 0, base);
        rockGrad.addColorStop(0, "rgba(255, 255, 255, 0.9)");
        rockGrad.addColorStop(1, "rgba(255, 255, 255, 0.3)");
        ctx.fillStyle = rockGrad;
        ctx.beginPath();
        ctx.moveTo(-0.52 * r, base);
        ctx.lineTo(-0.36 * r, base - 0.12 * r);
        ctx.quadraticCurveTo(-0.18 * r, base - 0.17 * r, 0, base - 0.13 * r);
        ctx.quadraticCurveTo(0.2 * r, base - 0.17 * r, 0.36 * r, base - 0.11 * r);
        ctx.lineTo(0.52 * r, base);
        ctx.closePath();
        ctx.fill();
      }

      // Procedural forms draw live in the shader; these masks seed splashForm() water ripples.
      function drawSignalMask(ctx, radius) {
        ctx.fillRect(-radius * 0.58, -radius * 0.38, radius * 1.16, radius * 0.76);
      }

      function drawEnvelopeMask(ctx, radius) {
        ctx.fillRect(-radius * 0.56, -radius * 0.3, radius * 1.12, radius * 0.74);
      }

      function drawForkMask(ctx, radius) {
        ctx.fillRect(-radius * 0.36, -radius * 0.48, radius * 0.74, radius * 0.96);
      }

      // ---------------------------------------------------------------------------
      // WebGL 4x4 Bayer Shader Setup
      // ---------------------------------------------------------------------------

      const VERTEX_SHADER_SOURCE = `
        attribute vec2 a_pos;
        void main() {
          gl_Position = vec4(a_pos, 0.0, 1.0);
        }
      `;

      const FRAGMENT_SHADER_SOURCE = `
        precision highp float;

        uniform vec2 u_resolution;
        uniform vec2 u_cssSize;
        uniform float u_dpr;
        uniform float u_cellPx;
        uniform float u_time;
        uniform float u_reducedMotion;

        uniform vec3 u_colorFront;
        uniform vec3 u_colorBack;
        uniform float u_lumScale;
        uniform float u_lumGamma;

        uniform sampler2D u_sourceTex;
        uniform sampler2D u_targetTex;
        uniform sampler2D u_waterTex;
        uniform float u_mix;
        uniform float u_turbulence;
        uniform float u_glitchSeed;
        uniform float u_glitchRows;
        uniform float u_glitchThrow;

        uniform vec2 u_formCenter;
        uniform float u_formRadius;
        uniform float u_rippleOuter;
        uniform float u_rippleInner;
        uniform float u_rippleAmp;
        uniform float u_rippleShimmer;

        uniform vec2 u_lampPos;
        uniform float u_beamWeight;
        uniform float u_beamReach;
        uniform float u_beamCoreReach;

        uniform float u_signalWeight;
        uniform float u_envelopeWeight;
        uniform float u_envelopeOpen;
        uniform float u_forkWeight;
        uniform float u_forkAge;

        uniform vec2 u_pointerPos;
        uniform float u_pointerActive;
        uniform float u_pointerRadius;

        uniform vec4 u_fish;
        uniform vec4 u_fishAnim;
        uniform float u_fishSurfaceY;
        uniform float u_fishVySign;
        uniform vec4 u_splashA;
        uniform vec4 u_splashB;
        uniform vec4 u_droplets[16];
        uniform vec4 u_linksRect;
        uniform vec4 u_mottoRect;

        float hash21(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        float invSmooth(float a, float b, float x) {
          return 1.0 - smoothstep(a, b, x);
        }

        float sdBox(vec2 p, vec2 b) {
          vec2 d = abs(p) - b;
          return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
        }

        float sdSegment(vec2 p, vec2 a, vec2 b) {
          vec2 pa = p - a;
          vec2 ba = b - a;
          float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
          return length(pa - ba * h);
        }

        float rectClearance(vec2 p, vec4 r, float pad, float feather) {
          if (r.z <= r.x || r.w <= r.y) {
            return 1.0;
          }
          vec2 halfSize = (r.zw - r.xy) * 0.5 + vec2(pad);
          vec2 center = (r.xy + r.zw) * 0.5;
          vec2 q = abs(p - center) - halfSize;
          float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
          return smoothstep(-feather, feather, dist);
        }

        // Branchless exact 4x4 Bayer ordered-dithering threshold in [0.5/16, 15.5/16].
        float bayer2(vec2 p) {
          return 2.0 * p.x + 3.0 * p.y - 4.0 * p.x * p.y;
        }

        float bayer4x4(vec2 c) {
          vec2 p = mod(floor(c), 4.0);
          vec2 p2 = mod(p, 2.0);
          vec2 p1 = floor(p * 0.5);
          return (4.0 * bayer2(p2) + bayer2(p1) + 0.5) / 16.0;
        }

        float evalSwellWave(vec2 worldXZ, float angle, float wavelength, float amp, float t) {
          float k = 6.2831853 / wavelength;
          vec2 dir = vec2(cos(angle), sin(angle));
          float w = 1.05 * sqrt(k);
          float phase = dot(worldXZ, dir) * k - w * t;
          return sin(phase) * amp;
        }

        // Compact tech oscilloscope / spectrum analyzer for Blog hover
        float evalSignal(vec2 p, vec2 center, float r, float t, float rm) {
          float halfW = r * 0.58;
          float halfH = r * 0.38;
          vec2 lp = p - center;
          if (abs(lp.x) > halfW + 18.0 || abs(lp.y) > halfH + 18.0) {
            return 0.0;
          }

          float wt = rm > 0.5 ? 0.0 : t;
          float lum = 0.0;

          // Corner brackets
          float bd = abs(sdBox(lp, vec2(halfW, halfH)));
          float brkLen = r * 0.14;
          if (abs(lp.x) > halfW - brkLen && abs(lp.y) > halfH - brkLen) {
            lum = max(lum, smoothstep(2.2, 0.5, bd) * 0.88);
          }

          // Center axis & 7 frequency ticks
          float axisY = -halfH * 0.12;
          if (abs(lp.x) < halfW * 0.92) {
            lum = max(lum, smoothstep(1.2, 0.2, abs(lp.y - axisY)) * 0.22);
          }
          if (abs(lp.x) <= halfW * 0.9 && abs(lp.y - axisY) < 4.5) {
            float tx = (lp.x / (halfW * 0.86) + 1.0) * 3.0;
            float tickDist = abs(tx - floor(tx + 0.5)) * (halfW * 0.86 / 3.0);
            lum = max(lum, smoothstep(1.3, 0.2, tickDist) * 0.4);
          }

          // Modulated carrier wave + secondary harmonic echo
          float ux = lp.x / (halfW * 0.92);
          if (abs(ux) <= 1.0) {
            float env = exp(-ux * ux * 2.2);
            float wy = axisY - halfH * 0.52 * env * (sin(ux * 9.5 - wt * 3.4) * 0.72 + sin(ux * 19.0 + wt * 2.1) * 0.28);
            float dy = abs(lp.y - wy);
            lum = max(lum, smoothstep(3.2, 0.5, dy) * 0.98);
            lum = max(lum, smoothstep(13.0, 0.0, dy) * 0.32);

            float wy2 = axisY - halfH * 0.34 * env * sin(ux * 6.5 + wt * 2.2 + 1.2);
            lum = max(lum, smoothstep(2.4, 0.4, abs(lp.y - wy2)) * 0.42);
          }

          // Lower 9-bar live spectrum analyzer
          if (abs(ux) < 0.94 && lp.y >= halfH * 0.32 && lp.y <= halfH * 0.86) {
            float slot = (ux * 0.5 + 0.5) * 9.0;
            float bi = floor(slot);
            float bx = fract(slot);
            float bh = 0.25 + 0.75 * (0.5 + 0.5 * sin(wt * 3.2 + bi * 1.15 + sin(bi * 2.3)));
            float barTop = mix(halfH * 0.86, halfH * 0.32, bh);
            if (abs(bx - 0.5) < 0.28 && lp.y >= barTop) {
              float barGrad = mix(0.78, 0.34, (lp.y - barTop) / max(halfH * 0.54, 1.0));
              lum = max(lum, barGrad);
            }
          }

          // Sweeping horizontal scan trace
          if (abs(lp.x) < halfW * 0.94 && abs(lp.y) < halfH * 0.92 && rm < 0.5) {
            float scanUx = mod(wt * 0.42, 2.0) - 1.0;
            float trail = ux - scanUx;
            if (trail > 0.0) {
              trail -= 2.0;
            }
            if (trail <= 0.0 && trail > -0.28) {
              lum += (1.0 + trail / 0.28) * 0.16;
            }
          }

          return clamp(lum, 0.0, 1.0);
        }

        // Animated 3D opening/closing envelope with emerging letter sheet for Mail hover
        float evalEnvelope(vec2 p, vec2 center, float r, float open) {
          float halfW = r * 0.56;
          float halfH = r * 0.37;
          vec2 lp = p - (center + vec2(0.0, r * 0.08));
          if (abs(lp.x) > halfW + 18.0 || lp.y < -halfH * 2.3 - 14.0 || lp.y > halfH + 14.0) {
            return 0.0;
          }

          float lum = 0.0;
          float fold = cos(open * 3.14159265);
          float tipY = -halfH + fold * halfH * 1.12;
          float lift = smoothstep(0.32, 1.0, open) * halfH * 0.92;

          // Layer 1: Open top flap pointing UP behind emerging letter
          if (fold < 0.0) {
            float edgeY = -halfH + fold * halfH * 1.12 * (1.0 - abs(lp.x) / halfW);
            if (abs(lp.x) <= halfW && lp.y <= -halfH && lp.y >= edgeY) {
              lum = mix(0.22, 0.44, clamp((-halfH - lp.y) / max(-fold * halfH * 1.12, 1.0), 0.0, 1.0));
            }
            float dL = sdSegment(lp, vec2(-halfW, -halfH), vec2(0.0, tipY));
            float dR = sdSegment(lp, vec2(halfW, -halfH), vec2(0.0, tipY));
            lum = max(lum, smoothstep(2.6, 0.5, min(dL, dR)) * 0.9);
          }

          // Layer 2: Rising inner letter card
          if (lift > 1.0 && lp.y <= -halfH + 1.0) {
            float cardTop = -halfH - lift;
            float cardBottom = -halfH + 2.0;
            float cardHalfW = halfW * 0.78;
            float cardCenterY = (cardTop + cardBottom) * 0.5;
            float cardHalfH = (cardBottom - cardTop) * 0.5;
            float cardD = sdBox(lp - vec2(0.0, cardCenterY), vec2(cardHalfW, cardHalfH));

            if (cardD <= 0.0) {
              lum = mix(0.42, 0.3, clamp((lp.y - cardTop) / max(lift, 1.0), 0.0, 1.0));
              // Three crisp note lines moving rigidly with the card
              float l1 = sdSegment(lp, vec2(-halfW * 0.52, cardTop + halfH * 0.25), vec2(halfW * 0.52, cardTop + halfH * 0.25));
              float l2 = sdSegment(lp, vec2(-halfW * 0.52, cardTop + halfH * 0.47), vec2(halfW * 0.52, cardTop + halfH * 0.47));
              float l3 = sdSegment(lp, vec2(-halfW * 0.52, cardTop + halfH * 0.69), vec2(halfW * 0.22, cardTop + halfH * 0.69));
              float lineDist = min(l1, min(l2, l3));
              lum = max(lum, smoothstep(2.1, 0.5, lineDist) * 0.96);
            }
            lum = max(lum, smoothstep(2.4, 0.5, abs(cardD)) * 0.94);
          }

          // Layer 3: Front pocket body (occludes bottom of open flap & letter)
          float pocketD = sdBox(lp, vec2(halfW, halfH));
          lum = max(lum, smoothstep(8.0, 0.0, max(pocketD, 0.0)) * 0.26);
          if (pocketD <= 0.0) {
            float pocketFill = mix(0.18, 0.36, clamp((lp.y + halfH) / (2.0 * halfH), 0.0, 1.0));
            float sL = sdSegment(lp, vec2(-halfW, halfH), vec2(-halfW * 0.14, -halfH * 0.04));
            float sR = sdSegment(lp, vec2(halfW, halfH), vec2(halfW * 0.14, -halfH * 0.04));
            float seam = smoothstep(2.2, 0.5, min(sL, sR)) * 0.54;
            lum = max(pocketFill, seam);
          }
          lum = max(lum, smoothstep(2.6, 0.5, abs(pocketD)) * 0.95);

          // Layer 4: Closed / closing front flap pointing DOWN in front of pocket
          if (fold >= 0.0) {
            float edgeY = -halfH + fold * halfH * 1.12 * (1.0 - abs(lp.x) / halfW);
            if (abs(lp.x) <= halfW && lp.y > edgeY && lp.y < edgeY + 8.0 && pocketD <= 0.0) {
              lum *= mix(0.55, 1.0, (lp.y - edgeY) / 8.0);
            }
            if (abs(lp.x) <= halfW && lp.y >= -halfH && lp.y <= edgeY) {
              lum = mix(0.56, 0.3, clamp((lp.y + halfH) / max(fold * halfH * 1.12, 1.0), 0.0, 1.0));
            }
            float dL = sdSegment(lp, vec2(-halfW, -halfH), vec2(0.0, tipY));
            float dR = sdSegment(lp, vec2(halfW, -halfH), vec2(0.0, tipY));
            lum = max(lum, smoothstep(2.6, 0.5, min(dL, dR)) * 0.98);
          }

          return clamp(lum, 0.0, 1.0);
        }

        // Compact GitHub branch tree with repeating extend-hold-retract entrance animation
        float evalFork(vec2 p, vec2 center, float r, float age, float rm) {
          vec2 lp = p - center;
          if (abs(lp.x) > r * 0.62 || abs(lp.y) > r * 0.68) {
            return 0.0;
          }

          float trunkX = -r * 0.26;
          float branchX = r * 0.28;
          float topY = -r * 0.4;
          float botY = r * 0.42;
          float juncY = r * 0.1;
          float nodeR = max(6.0, r * 0.088);
          float strokeW = max(2.2, r * 0.036);

          float grow = 1.0;
          if (rm < 0.5) {
            float cycle = mod(age, 5.2);
            if (cycle < 0.85) {
              float t = cycle / 0.85;
              grow = t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;
            } else if (cycle < 3.6) {
              grow = 1.0;
            } else if (cycle < 4.45) {
              float t = (cycle - 3.6) / 0.85;
              grow = 1.0 - (t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0);
            } else {
              grow = 0.0;
            }
          }

          float lum = 0.0;

          // Main vertical trunk
          float dTrunk = sdSegment(lp, vec2(trunkX, botY - nodeR), vec2(trunkX, topY + nodeR));
          lum = max(lum, invSmooth(strokeW * 0.5, strokeW + 1.8, dTrunk) * 0.92);
          lum = max(lum, invSmooth(strokeW, strokeW + 9.0, dTrunk) * 0.26);

          // S-curve branch extending right from trunk and retracting smoothly
          if (grow > 0.01) {
            float ySpan = (topY + nodeR) - juncY;
            float tRaw = clamp((lp.y - juncY) / ySpan, 0.0, grow);
            float s = tRaw * tRaw * (3.0 - 2.0 * tRaw);
            vec2 curvePt = vec2(mix(trunkX, branchX, s), juncY + tRaw * ySpan);
            float dsdT = 6.0 * tRaw * (1.0 - tRaw);
            float dxdy = (branchX - trunkX) * dsdT / ySpan;
            float dBranch = (lp.y <= juncY && lp.y >= juncY + grow * ySpan)
              ? abs(lp.x - curvePt.x) / sqrt(1.0 + dxdy * dxdy)
              : length(lp - curvePt);
            lum = max(lum, invSmooth(strokeW * 0.5, strokeW + 1.8, dBranch) * 0.92);
            lum = max(lum, invSmooth(strokeW, strokeW + 9.0, dBranch) * 0.26);
          }

          // Two steady trunk nodes + right branch node emerging at end of extension
          vec2 botNode = vec2(trunkX, botY);
          vec2 topMain = vec2(trunkX, topY);
          vec2 topBranch = vec2(branchX, topY);
          float branchVis = rm > 0.5 ? 1.0 : smoothstep(0.76, 1.0, grow);
          float curBranchR = nodeR * mix(0.45, 1.0, branchVis);

          float dBot = length(lp - botNode);
          float dTopM = length(lp - topMain);
          float dTopB = length(lp - topBranch);

          lum = max(lum, invSmooth(nodeR * 0.8, nodeR * 2.5, dBot) * 0.36);
          lum = max(lum, invSmooth(strokeW * 0.5, strokeW + 1.6, abs(dBot - nodeR)) * 0.98);

          lum = max(lum, invSmooth(nodeR * 0.8, nodeR * 2.5, dTopM) * 0.36);
          lum = max(lum, invSmooth(strokeW * 0.5, strokeW + 1.6, abs(dTopM - nodeR)) * 0.98);

          if (branchVis > 0.01) {
            lum = max(lum, invSmooth(curBranchR * 0.8, curBranchR * 2.5, dTopB) * 0.36 * branchVis);
            lum = max(lum, invSmooth(strokeW * 0.5, strokeW + 1.6, abs(dTopB - curBranchR)) * 0.98 * branchVis);
          }

          // Keep node centers cleanly hollow
          lum *= smoothstep(nodeR - strokeW * 0.7, nodeR - strokeW * 0.2, dBot);
          lum *= smoothstep(nodeR - strokeW * 0.7, nodeR - strokeW * 0.2, dTopM);
          if (branchVis > 0.01) {
            lum *= mix(1.0, smoothstep(curBranchR - strokeW * 0.7, curBranchR - strokeW * 0.2, dTopB), branchVis);
          }

          return clamp(lum, 0.0, 1.0);
        }

        // Expanding perspective foam rings + upward V-crown water plume on fish breach/reentry
        float evalSplash(vec2 p, vec4 sp) {
          if (sp.w < 0.5 || sp.z < 0.0 || sp.z >= 0.95) {
            return 0.0;
          }
          float age = sp.z;
          vec2 d = p - sp.xy;
          float lum = 0.0;

          float rx = 8.0 + age * 62.0;
          float ry = rx * 0.27;
          float ringDist = abs(length(vec2(d.x / rx, d.y / ry)) - 1.0) * ry;
          float fade = pow(1.0 - age / 0.95, 1.3);
          lum = max(lum, invSmooth(0.5, 2.6, ringDist) * 0.85 * fade);

          if (age > 0.12) {
            float rx2 = 4.0 + (age - 0.12) * 42.0;
            float ry2 = rx2 * 0.27;
            float ringDist2 = abs(length(vec2(d.x / rx2, d.y / ry2)) - 1.0) * ry2;
            float fade2 = pow(1.0 - (age - 0.12) / 0.83, 1.4);
            lum = max(lum, invSmooth(0.4, 2.1, ringDist2) * 0.65 * fade2);
          }

          if (age < 0.44 && d.y <= 3.0) {
            float cProg = age / 0.44;
            float crownH = sin(cProg * 3.14159265) * 28.0;
            float wingW = 7.0 + cProg * 20.0;
            float cFade = 1.0 - cProg;
            float plumeL = sdSegment(d, vec2(-3.0, 0.0), vec2(-wingW, -crownH));
            float plumeR = sdSegment(d, vec2(3.0, 0.0), vec2(wingW, -crownH));
            float plumeC = sdSegment(d, vec2(0.0, 0.0), vec2(0.0, -crownH * 0.85));
            lum = max(lum, invSmooth(0.6, 3.2, min(plumeL, min(plumeR, plumeC))) * 0.92 * cFade);
          }

          return clamp(lum, 0.0, 1.0);
        }

        void main() {
          vec2 cell = floor(gl_FragCoord.xy / u_cellPx);
          vec2 cellCenterPx = (cell + 0.5) * u_cellPx;

          // Top-down CSS pixel coordinate matching DOM & mouse coordinates
          vec2 pos = vec2(
            cellCenterPx.x / u_dpr,
            (u_resolution.y - cellCenterPx.y) / u_dpr
          );
          vec2 uv = pos / u_cssSize;

          // Morph glitch horizontal row offset
          float glitchShiftCss = 0.0;
          if (u_turbulence > 0.001) {
            float bandRow = floor(pos.y / 6.0);
            float h = hash21(vec2(bandRow, u_glitchSeed));
            if (h < u_glitchRows * u_turbulence) {
              glitchShiftCss = (hash21(vec2(bandRow, u_glitchSeed + 17.0)) - 0.5) * u_glitchThrow * u_turbulence;
            }
          }
          vec2 formUV = vec2(clamp(uv.x + glitchShiftCss / u_cssSize.x, 0.0, 1.0), uv.y);
          vec2 formPos = vec2(pos.x + glitchShiftCss, pos.y);

          float srcVal = texture2D(u_sourceTex, formUV).a;
          float dstVal = texture2D(u_targetTex, formUV).a;
          float texShapeVal = mix(srcVal, dstVal, u_mix);

          float procSignal = u_signalWeight > 0.005 ? evalSignal(formPos, u_formCenter, u_formRadius, u_time, u_reducedMotion) * u_signalWeight : 0.0;
          float procEnvelope = u_envelopeWeight > 0.005 ? evalEnvelope(formPos, u_formCenter, u_formRadius, u_envelopeOpen) * u_envelopeWeight : 0.0;
          float procFork = u_forkWeight > 0.005 ? evalFork(formPos, u_formCenter, u_formRadius, u_forkAge, u_reducedMotion) * u_forkWeight : 0.0;
          float procShapeVal = max(procSignal, max(procEnvelope, procFork));
          float shapeVal = max(texShapeVal, procShapeVal);

          // Travelling wave shimmer through the form disc
          vec2 formOffset = pos - u_formCenter;
          float formDist = length(formOffset);
          float zone = 1.0 - smoothstep(u_rippleInner, u_rippleOuter, formDist);
          float ripplePhase = formOffset.x * 0.032 + formOffset.y * 0.021 - (u_reducedMotion > 0.5 ? 0.0 : u_time * 7.56);
          float rippleWave = 0.5 + 0.5 * sin(ripplePhase);
          float pulseScale = u_reducedMotion > 0.5 ? 0.0 : u_rippleShimmer * zone;
          float formPulse = 1.0 - pulseScale * (1.0 - rippleWave);
          float procPulse = mix(1.0, formPulse, 0.28);
          float discShimmer = (u_reducedMotion > 0.5 ? 0.0 : rippleWave * u_rippleAmp * zone * smoothstep(0.04, 0.3, shapeVal));

          // Rotating horizontal lighthouse beam
          float beam = 0.0;
          float beamShaft = 0.0;
          if (u_beamWeight > 0.005) {
            vec2 d = pos - u_lampPos;
            float dist = length(d);
            float angle = atan(d.y, d.x);

            float turn = u_reducedMotion > 0.5 ? 0.8 : u_time * 0.62;
            float towardViewer = sin(turn);
            float facing = max(0.0, towardViewer);
            float sweepAngle = atan(0.22, cos(turn));

            float diff = abs(mod(angle - sweepAngle + 3.14159265, 6.2831853) - 3.14159265);
            float halfW = 0.115 * (1.0 + 0.9 * facing);
            float across = clamp(1.0 - diff / halfW, 0.0, 1.0);
            float radial = pow(clamp(1.0 - dist / u_beamReach, 0.0, 1.0), 1.35);
            float gain = u_beamWeight * max(0.0, 0.24 + 0.76 * towardViewer) * 1.18;

            beamShaft = across * (0.35 + 0.65 * across) * radial * gain;
            float backLobe = across * (0.3 + 0.7 * across) * pow(clamp(1.0 - dist / (u_beamReach * 0.55), 0.0, 1.0), 1.6) * u_beamWeight * max(0.0, -towardViewer) * 0.18;
            float core = pow(clamp(1.0 - dist / u_beamCoreReach, 0.0, 1.0), 1.6) * u_beamWeight * (0.82 + 1.15 * facing * facing);
            beam = beamShaft + backLobe + core;
          }

          // Interactive simulated water heightfield
          float simH = (texture2D(u_waterTex, uv).r - 0.5) * 5.0;
          float waterRippleGlow = abs(simH) * 0.42;

          // Perspective ocean swells below horizon
          float horizonY = u_cssSize.y * 0.52;
          float crest = 0.0;
          if (pos.y > horizonY) {
            float below = (pos.y - horizonY) / u_cssSize.y;
            float seaFade = smoothstep(0.0, 0.055, below);
            float worldZ = 1.0 / (below + 0.019);
            float worldX = (pos.x - u_cssSize.x * 0.5) / u_cssSize.y * worldZ * 1.7;
            vec2 worldXZ = vec2(worldX, worldZ);

            float waveT = u_reducedMotion > 0.5 ? 0.0 : u_time;
            float waveH = 0.0;
            waveH += evalSwellWave(worldXZ, 1.4, 2.3, 1.0, waveT);
            waveH += evalSwellWave(worldXZ, 1.13, 1.35, 0.42, waveT);
            waveH += evalSwellWave(worldXZ, 0.42, 0.62, 0.18, waveT);

            float seaAmp = u_reducedMotion > 0.5 ? 0.45 : 0.9;
            float surface = simH + waveH * seaFade * seaAmp;
            float ridge = surface > 0.0 ? pow(surface, 1.55) * 0.72 * seaFade : 0.0;
            crest = ridge * (1.0 + 0.55 * beamShaft);
          }

          // Tiny twinkling cursor halo (few-pixel radius)
          float pointerLum = 0.0;
          if (u_pointerActive > 0.5 && u_reducedMotion < 0.5) {
            float pDist = length(pos - u_pointerPos);
            float pInf = clamp(1.0 - pDist / u_pointerRadius, 0.0, 1.0);
            if (pInf > 0.0) {
              float twinklePhase = hash21(cell + vec2(3.7, 9.1)) * 6.2831853;
              float twinkle = 0.52 + 0.48 * sin(u_time * 7.2 + twinklePhase);
              pointerLum = pInf * pInf * 0.82 * twinkle;
            }
          }

          // 16-frame isometric polar-bend leaping fish SDF:
          // straight breach upward -> graceful C-arch at apex -> streamlined dive downward
          float fishLum = 0.0;
          if (u_fish.w > 0.5) {
            vec2 fd = pos - u_fish.xy;
            if (length(fd) < u_fishAnim.w * 1.45) {
              float c = cos(u_fish.z);
              float s = sin(u_fish.z);
              vec2 local = vec2(fd.x * c + fd.y * s, -fd.x * s + fd.y * c);
              if (u_fishAnim.y < 0.0) {
                local.y = -local.y;
              }

              float prog = clamp(u_fishAnim.x, 0.0, 1.0);
              float arcEnv = sin(clamp((prog - 0.08) / 0.84, 0.0, 1.0) * 3.14159265);
              float bendAngle = 1.35 * pow(max(arcEnv, 0.0), 1.15);
              float diveTuck = smoothstep(0.66, 0.96, prog);
              float breachBoost = exp(-abs(u_fish.y - u_fishSurfaceY) / 42.0) * max(0.0, -u_fishVySign);

              float bodyLen = u_fishAnim.w * 0.68 * (1.0 + 0.08 * diveTuck);
              float bodyH = u_fishAnim.w * 0.24 * (1.0 - 0.06 * diveTuck);
              float tailFlare = mix(1.18, 0.74, diveTuck);
              float whipAmp = mix(0.68, 0.22, diveTuck) * mix(1.0, 1.25, breachBoost);

              float arcX = local.x;
              float radialY = local.y;
              if (bendAngle > 0.03) {
                float bendR = bodyLen / bendAngle;
                float dyCenter = bendR - local.y;
                float theta = atan(local.x, max(dyCenter, 1.0));
                arcX = theta * bendR;
                radialY = bendR - length(vec2(local.x, dyCenter));
              }

              float nx = arcX / (bodyLen * 0.5);
              float whipWeight = invSmooth(-1.6, 0.45, nx);
              float whip = sin(u_fishAnim.z - nx * 2.4) * bodyH * whipAmp * whipWeight;
              float by = radialY - whip;

              // Tapered streamlined body (nx in [-0.95, 1.0])
              if (nx > -1.05 && nx < 1.08) {
                float t = clamp((1.0 - nx) * 0.5, 0.0, 1.0);
                float halfH = bodyH * 0.56 * pow(max(t, 1e-4), 0.48) * pow(max(1e-4, 1.0 - t * 0.88), 0.72) * 2.15;
                float bodyMask = invSmooth(halfH - 1.2, halfH + 1.5, abs(by)) * invSmooth(0.92, 1.05, nx) * smoothstep(-1.02, -0.82, nx);
                float bodyShade = 0.65 + 0.35 * clamp(1.0 - abs(by) / max(halfH, 1.0), 0.0, 1.0);
                fishLum = max(fishLum, bodyMask * bodyShade);
              }

              // Sweeping crescent swallowtail (nx in [-1.72, -0.78])
              if (nx < -0.75 && nx > -1.78) {
                float tx = clamp((-0.78 - nx) / 0.94, 0.0, 1.0);
                float outerY = mix(bodyH * 0.14, bodyH * 0.92 * tailFlare, pow(max(tx, 1e-4), 0.82));
                float notchY = mix(0.0, bodyH * 0.42 * tailFlare, smoothstep(0.25, 1.0, tx));
                float tailMask = invSmooth(outerY - 1.0, outerY + 1.4, abs(by)) * smoothstep(notchY - 1.0, notchY + 1.4, abs(by));
                fishLum = max(fishLum, tailMask * 0.86);
              }

              // Swept dorsal fin on top
              if (nx > -0.34 && nx < 0.34 && by < -bodyH * 0.32) {
                float dx = (nx + 0.3) / 0.62;
                float topY = mix(-bodyH * 0.44, -bodyH * 1.02, smoothstep(0.0, 0.45, dx));
                if (dx > 0.45) {
                  topY = mix(-bodyH * 1.02, -bodyH * 0.38, (dx - 0.45) / 0.55);
                }
                float dorsalMask = smoothstep(topY - 1.4, topY + 1.0, by) * smoothstep(-0.34, -0.22, nx) * invSmooth(0.22, 0.34, nx);
                fishLum = max(fishLum, dorsalMask * 0.84);
              }

              // Delicate pectoral fin on belly
              if (nx > 0.02 && nx < 0.44 && by > bodyH * 0.28) {
                float px = (nx - 0.05) / 0.37;
                float botY = mix(bodyH * 0.4, bodyH * 0.84, 1.0 - abs(px - 0.45) * 1.4);
                float pecMask = invSmooth(botY - 0.9, botY + 1.3, by) * smoothstep(0.02, 0.14, nx) * invSmooth(0.32, 0.44, nx);
                fishLum = max(fishLum, pecMask * 0.72);
              }

              // Refracted waterline clipping: bright in air, faint refracted shadow underwater
              if (fishLum > 0.0 && pos.y > u_fishSurfaceY) {
                fishLum *= invSmooth(u_fishSurfaceY - 2.0, u_fishSurfaceY + 26.0, pos.y) * 0.34;
              }
            }
          }

          float splashLum = max(evalSplash(pos, u_splashA), evalSplash(pos, u_splashB));

          // Splash droplets
          float dropletLum = 0.0;
          for (int i = 0; i < 16; i++) {
            vec4 dr = u_droplets[i];
            if (dr.w > 0.001) {
              float dd = length(pos - dr.xy);
              dropletLum = max(dropletLum, invSmooth(0.0, dr.z, dd) * dr.w);
            }
          }

          float shapedForm = max(texShapeVal * formPulse, procShapeVal * procPulse);
          float rawLum = shapedForm + discShimmer + beam + crest + waterRippleGlow + pointerLum + fishLum + splashLum + dropletLum;
          float linksMask = mix(0.22, 1.0, rectClearance(pos, u_linksRect, 6.0, 22.0));
          float mottoMask = mix(0.26, 1.0, rectClearance(pos, u_mottoRect, 6.0, 16.0));
          rawLum *= min(linksMask, mottoMask);
          float lum = clamp(pow(clamp(rawLum, 0.0, 1.0), u_lumGamma) * u_lumScale, 0.0, 1.0);

          float lit = step(bayer4x4(cell), lum);
          gl_FragColor = vec4(mix(u_colorBack, u_colorFront, lit), 1.0);
        }
      `;

      function compileShader(glCtx, type, source) {
        const shader = glCtx.createShader(type);
        if (!shader) {
          return null;
        }
        glCtx.shaderSource(shader, source);
        glCtx.compileShader(shader);
        if (!glCtx.getShaderParameter(shader, glCtx.COMPILE_STATUS)) {
          console.warn("Shader compile failed:", glCtx.getShaderInfoLog(shader));
          glCtx.deleteShader(shader);
          return null;
        }
        return shader;
      }

      function createDataTexture(glCtx, texWidth, texHeight, data, format) {
        const tex = glCtx.createTexture();
        glCtx.bindTexture(glCtx.TEXTURE_2D, tex);
        glCtx.pixelStorei(glCtx.UNPACK_ALIGNMENT, 1);
        glCtx.pixelStorei(glCtx.UNPACK_FLIP_Y_WEBGL, false);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_S, glCtx.CLAMP_TO_EDGE);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_T, glCtx.CLAMP_TO_EDGE);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MIN_FILTER, glCtx.LINEAR);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MAG_FILTER, glCtx.LINEAR);
        glCtx.texImage2D(glCtx.TEXTURE_2D, 0, format, texWidth, texHeight, 0, format, glCtx.UNSIGNED_BYTE, data);
        return tex;
      }

      function replaceCanvasForFallback() {
        const replacement = document.createElement("canvas");
        replacement.id = "field";
        replacement.setAttribute("aria-hidden", "true");
        canvas.replaceWith(replacement);
        canvas = replacement;
        attachCanvasListeners();
      }

      function initWebGL() {
        try {
          gl = canvas.getContext("webgl", {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: false
          }) || canvas.getContext("experimental-webgl", {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false
          });
        } catch (error) {
          gl = null;
        }

        if (!gl) {
          return false;
        }

        const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);

        if (!vs || !fs) {
          if (vs) gl.deleteShader(vs);
          if (fs) gl.deleteShader(fs);
          gl = null;
          replaceCanvasForFallback();
          return false;
        }

        glProgram = gl.createProgram();
        gl.attachShader(glProgram, vs);
        gl.attachShader(glProgram, fs);
        gl.linkProgram(glProgram);
        gl.deleteShader(vs);
        gl.deleteShader(fs);

        if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
          console.warn("Program link failed:", gl.getProgramInfoLog(glProgram));
          gl.deleteProgram(glProgram);
          glProgram = null;
          gl = null;
          replaceCanvasForFallback();
          return false;
        }

        gl.useProgram(glProgram);

        glQuadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, glQuadBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
          gl.STATIC_DRAW
        );

        const posLoc = gl.getAttribLocation(glProgram, "a_pos");
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        glUniforms = {
          resolution: gl.getUniformLocation(glProgram, "u_resolution"),
          cssSize: gl.getUniformLocation(glProgram, "u_cssSize"),
          dpr: gl.getUniformLocation(glProgram, "u_dpr"),
          cellPx: gl.getUniformLocation(glProgram, "u_cellPx"),
          time: gl.getUniformLocation(glProgram, "u_time"),
          reducedMotion: gl.getUniformLocation(glProgram, "u_reducedMotion"),
          colorFront: gl.getUniformLocation(glProgram, "u_colorFront"),
          colorBack: gl.getUniformLocation(glProgram, "u_colorBack"),
          lumScale: gl.getUniformLocation(glProgram, "u_lumScale"),
          lumGamma: gl.getUniformLocation(glProgram, "u_lumGamma"),
          sourceTex: gl.getUniformLocation(glProgram, "u_sourceTex"),
          targetTex: gl.getUniformLocation(glProgram, "u_targetTex"),
          waterTex: gl.getUniformLocation(glProgram, "u_waterTex"),
          mix: gl.getUniformLocation(glProgram, "u_mix"),
          turbulence: gl.getUniformLocation(glProgram, "u_turbulence"),
          glitchSeed: gl.getUniformLocation(glProgram, "u_glitchSeed"),
          glitchRows: gl.getUniformLocation(glProgram, "u_glitchRows"),
          glitchThrow: gl.getUniformLocation(glProgram, "u_glitchThrow"),
          formCenter: gl.getUniformLocation(glProgram, "u_formCenter"),
          formRadius: gl.getUniformLocation(glProgram, "u_formRadius"),
          rippleOuter: gl.getUniformLocation(glProgram, "u_rippleOuter"),
          rippleInner: gl.getUniformLocation(glProgram, "u_rippleInner"),
          rippleAmp: gl.getUniformLocation(glProgram, "u_rippleAmp"),
          rippleShimmer: gl.getUniformLocation(glProgram, "u_rippleShimmer"),
          lampPos: gl.getUniformLocation(glProgram, "u_lampPos"),
          beamWeight: gl.getUniformLocation(glProgram, "u_beamWeight"),
          beamReach: gl.getUniformLocation(glProgram, "u_beamReach"),
          beamCoreReach: gl.getUniformLocation(glProgram, "u_beamCoreReach"),
          signalWeight: gl.getUniformLocation(glProgram, "u_signalWeight"),
          envelopeWeight: gl.getUniformLocation(glProgram, "u_envelopeWeight"),
          envelopeOpen: gl.getUniformLocation(glProgram, "u_envelopeOpen"),
          forkWeight: gl.getUniformLocation(glProgram, "u_forkWeight"),
          forkAge: gl.getUniformLocation(glProgram, "u_forkAge"),
          pointerPos: gl.getUniformLocation(glProgram, "u_pointerPos"),
          pointerActive: gl.getUniformLocation(glProgram, "u_pointerActive"),
          pointerRadius: gl.getUniformLocation(glProgram, "u_pointerRadius"),
          fish: gl.getUniformLocation(glProgram, "u_fish"),
          fishAnim: gl.getUniformLocation(glProgram, "u_fishAnim"),
          fishSurfaceY: gl.getUniformLocation(glProgram, "u_fishSurfaceY"),
          fishVySign: gl.getUniformLocation(glProgram, "u_fishVySign"),
          splashA: gl.getUniformLocation(glProgram, "u_splashA"),
          splashB: gl.getUniformLocation(glProgram, "u_splashB"),
          droplets: gl.getUniformLocation(glProgram, "u_droplets"),
          linksRect: gl.getUniformLocation(glProgram, "u_linksRect"),
          mottoRect: gl.getUniformLocation(glProgram, "u_mottoRect")
        };

        gl.uniform1i(glUniforms.sourceTex, 0);
        gl.uniform1i(glUniforms.targetTex, 1);
        gl.uniform1i(glUniforms.waterTex, 2);
        return true;
      }

      function attachCanvasListeners() {
        canvas.addEventListener("webglcontextlost", (event) => {
          event.preventDefault();
          contextLost = true;
        });

        canvas.addEventListener("webglcontextrestored", () => {
          contextLost = false;
          for (const form of forms) {
            form.texture = null;
          }
          glBlendedSourceTex = null;
          glWaterTex = null;
          if (initWebGL()) {
            rasterKey = "";
            resize();
          }
        });
      }

      // ---------------------------------------------------------------------------
      // Grid & Water Simulation
      // ---------------------------------------------------------------------------

      function buildWaterGrid() {
        if (useWebGL) {
          waterCols = Math.max(64, Math.min(180, Math.round(width / 10)));
          waterRows = Math.max(40, Math.min(110, Math.round(height / 10)));
        } else {
          waterCols = maskWidth;
          waterRows = maskHeight;
        }

        const cells = waterCols * waterRows;
        waterHeight = new Float32Array(cells);
        waterVelocity = new Float32Array(cells);
        waterTexData = new Uint8Array(cells);
        waterTexData.fill(128);

        if (useWebGL && gl) {
          if (glWaterTex) {
            gl.deleteTexture(glWaterTex);
          }
          glWaterTex = createDataTexture(gl, waterCols, waterRows, waterTexData, gl.LUMINANCE);
        }
      }

      function stepWater() {
        if (reducedMotion || !waterHeight) {
          return;
        }

        const { tension, damping, levelling, maxHeight } = config.water;

        for (let row = 0; row < waterRows; row += 1) {
          const rowBase = row * waterCols;
          const aboveBase = row > 0 ? rowBase - waterCols : rowBase;
          const belowBase = row < waterRows - 1 ? rowBase + waterCols : rowBase;

          for (let column = 0; column < waterCols; column += 1) {
            const cell = rowBase + column;
            const left = column > 0 ? cell - 1 : cell;
            const right = column < waterCols - 1 ? cell + 1 : cell;
            const level = waterHeight[cell];
            const neighbourAverage = (
              waterHeight[aboveBase + column] +
              waterHeight[belowBase + column] +
              waterHeight[left] +
              waterHeight[right]
            ) * 0.25;

            waterVelocity[cell] =
              (waterVelocity[cell] + (neighbourAverage - level) * tension - level * levelling) * damping;
          }
        }

        for (let cell = 0; cell < waterHeight.length; cell += 1) {
          const next = waterHeight[cell] + waterVelocity[cell];
          waterHeight[cell] = next > maxHeight ? maxHeight : (next < -maxHeight ? -maxHeight : next);
        }
      }

      function disturbWater(x, y, strength) {
        if (reducedMotion || !waterHeight || !width || !height) {
          return;
        }

        const centerColumn = Math.round((x / width) * (waterCols - 1));
        const centerRow = Math.round((y / height) * (waterRows - 1));
        const reach = config.water.pointerReach;

        for (let row = centerRow - reach; row <= centerRow + reach; row += 1) {
          if (row < 0 || row >= waterRows) {
            continue;
          }

          for (let column = centerColumn - reach; column <= centerColumn + reach; column += 1) {
            if (column < 0 || column >= waterCols) {
              continue;
            }

            const distance = Math.hypot(column - centerColumn, row - centerRow);

            if (distance > reach) {
              continue;
            }

            const falloff = 1 - distance / (reach + 1);
            waterVelocity[row * waterCols + column] -= strength * falloff * falloff;
          }
        }
      }

      function splashForm(index) {
        if (reducedMotion || !waterHeight) {
          return;
        }

        const mask = forms[index].waterMask;
        if (!mask) {
          return;
        }

        const strength = config.water.formSplash;
        for (let cell = 0; cell < waterHeight.length; cell += 1) {
          waterHeight[cell] += mask[cell] * strength;
        }
      }

      function uploadWaterTexture() {
        if (!useWebGL || !gl || !glWaterTex || !waterHeight) {
          return;
        }

        for (let cell = 0; cell < waterHeight.length; cell += 1) {
          const encoded = Math.round((0.5 + waterHeight[cell] * 0.2) * 255);
          waterTexData[cell] = encoded < 0 ? 0 : (encoded > 255 ? 255 : encoded);
        }

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, glWaterTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, waterCols, waterRows, gl.LUMINANCE, gl.UNSIGNED_BYTE, waterTexData);
      }

      // ---------------------------------------------------------------------------
      // Fish & Droplets
      // ---------------------------------------------------------------------------

      function spawnDroplets(x, y, upward, biasDir = 0) {
        if (reducedMotion) {
          return;
        }

        for (let index = 0; index < fishConfig.dropletPerSplash; index += 1) {
          if (droplets.length >= fishConfig.dropletMax) {
            break;
          }

          const wing = index < fishConfig.dropletPerSplash - 3
            ? (index % 2 === 0 ? -1 : 1) * (0.35 + Math.random() * 0.5)
            : (Math.random() - 0.5) * 0.4;
          const angle = -Math.PI / 2 + wing + biasDir * 0.25;
          const speed = fishConfig.dropletSpeed * (0.42 + Math.random() * 0.68) * upward;

          droplets.push({
            x: x + (Math.random() - 0.5) * 12,
            y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: fishConfig.dropletLife * (0.55 + Math.random() * 0.5),
            age: 0
          });
        }
      }

      function scheduleFish(time) {
        fish.nextJumpAt = time + fishConfig.minDelay + Math.random() * (fishConfig.maxDelay - fishConfig.minDelay);
      }

      function launchFish(time) {
        const horizonY = height * config.water.horizon;
        const surfaceY = horizonY + (height - horizonY) * (0.36 + Math.random() * 0.44);
        const rise = fishConfig.riseMin + Math.random() * (fishConfig.riseMax - fishConfig.riseMin);
        const direction = Math.random() < 0.5 ? -1 : 1;
        const fLen = Math.max(28, formRadiusCss() * fishConfig.length);
        const submergeDepth = fLen * 0.58;

        fish.active = true;
        fish.surfaceY = surfaceY;
        fish.x = width * (0.14 + Math.random() * 0.72);
        fish.y = surfaceY + submergeDepth;
        fish.vy = -Math.sqrt(2 * fishConfig.gravity * (rise + submergeDepth));
        fish.vx = direction * (fishConfig.driftMin + Math.random() * (fishConfig.driftMax - fishConfig.driftMin));
        fish.startTime = time;
        fish.duration = (2 * Math.abs(fish.vy)) / fishConfig.gravity;
        fish.dir = direction;
        fish.breached = false;
        fish.reentered = false;

        document.documentElement.dataset.fish = "airborne";
        disturbWater(fish.x, surfaceY, fishConfig.splashImpulse * 0.45);
        scheduleFish(time);
      }

      function updateFish(time, deltaSeconds) {
        if (reducedMotion) {
          return;
        }

        if (!fish.active) {
          if (time >= fish.nextJumpAt) {
            launchFish(time);
          }
          return;
        }

        const fLen = Math.max(28, formRadiusCss() * fishConfig.length);
        fish.vy += fishConfig.gravity * deltaSeconds;
        fish.x += fish.vx * deltaSeconds;
        fish.y += fish.vy * deltaSeconds;

        if (!fish.breached && fish.vy < 0 && fish.y <= fish.surfaceY + fLen * 0.15) {
          fish.breached = true;
          splashTakeoff.x = fish.x;
          splashTakeoff.y = fish.surfaceY;
          splashTakeoff.time = time;
          spawnDroplets(fish.x, fish.surfaceY, 1.08, fish.dir * 0.35);
          disturbWater(fish.x, fish.surfaceY, fishConfig.splashImpulse * 1.1);
        }

        if (!fish.reentered && fish.vy > 0 && fish.y >= fish.surfaceY - fLen * 0.18) {
          fish.reentered = true;
          splashLanding.x = fish.x;
          splashLanding.y = fish.surfaceY;
          splashLanding.time = time;
          spawnDroplets(fish.x, fish.surfaceY, 1.18, -fish.dir * 0.25);
          disturbWater(fish.x, fish.surfaceY, fishConfig.splashImpulse * 1.4);
        }

        if (fish.vy > 0 && fish.y >= fish.surfaceY + fLen * 0.78) {
          fish.active = false;
          document.documentElement.dataset.fish = "idle";
        }
      }

      function updateDroplets(deltaSeconds) {
        for (let index = droplets.length - 1; index >= 0; index -= 1) {
          const droplet = droplets[index];

          droplet.vy += fishConfig.dropletGravity * deltaSeconds;
          droplet.x += droplet.vx * deltaSeconds;
          droplet.y += droplet.vy * deltaSeconds;
          droplet.age += deltaSeconds * 1000;

          if (droplet.age >= droplet.life || droplet.y > height + 20) {
            droplets.splice(index, 1);
          }
        }
      }

      // ---------------------------------------------------------------------------
      // Form Rasterization & Morph Management
      // ---------------------------------------------------------------------------

      function rasterizeForms() {
        const scale = maskWidth / Math.max(1, width);
        const centerX = formCenterX() * scale;
        const centerY = formCenterY() * scale;
        const radius = formRadiusCss() * scale;
        const waterline = height * config.water.horizon * scale - centerY;

        maskCanvas.width = maskWidth;
        maskCanvas.height = maskHeight;

        const cells = maskWidth * maskHeight;
        if (!sourceByteData || sourceByteData.length !== cells) {
          sourceByteData = new Uint8Array(cells);
        }

        for (const form of forms) {
          maskContext.setTransform(1, 0, 0, 1, 0, 0);
          maskContext.clearRect(0, 0, maskWidth, maskHeight);
          maskContext.globalAlpha = 1;
          maskContext.globalCompositeOperation = "source-over";
          maskContext.strokeStyle = "#ffffff";
          maskContext.fillStyle = "#ffffff";
          maskContext.lineWidth = 1;
          maskContext.lineCap = "butt";
          maskContext.lineJoin = "miter";
          maskContext.translate(centerX, centerY);
          form.draw(maskContext, radius, waterline);

          const rgba = maskContext.getImageData(0, 0, maskWidth, maskHeight).data;
          const grid = new Float32Array(cells);
          const bytes = new Uint8Array(cells);

          for (let cell = 0; cell < cells; cell += 1) {
            const byteAlpha = rgba[cell * 4 + 3];
            bytes[cell] = byteAlpha;
            grid[cell] = byteAlpha / 255;
          }

          form.alphaGrid = grid;

          // Downsampled mask for splashForm() water simulation disturbances
          const waterMask = new Float32Array(waterCols * waterRows);
          for (let wr = 0; wr < waterRows; wr += 1) {
            const mr = Math.min(maskHeight - 1, Math.round((wr + 0.5) / waterRows * maskHeight - 0.5));
            const wBase = wr * waterCols;
            const mBase = mr * maskWidth;
            for (let wc = 0; wc < waterCols; wc += 1) {
              const mc = Math.min(maskWidth - 1, Math.round((wc + 0.5) / waterCols * maskWidth - 0.5));
              waterMask[wBase + wc] = grid[mBase + mc];
            }
          }
          form.waterMask = waterMask;

          if (form.procedural) {
            grid.fill(0);
            bytes.fill(0);
          }

          if (useWebGL && gl) {
            if (form.texture) {
              gl.deleteTexture(form.texture);
            }
            form.texture = createDataTexture(gl, maskWidth, maskHeight, bytes, gl.ALPHA);
          }
        }

        sourceAlphaGrid = Float32Array.from(forms[toForm].alphaGrid);
        sourceFormIdx = toForm;
        usingBlendedSourceTex = false;

        if (useWebGL && gl) {
          if (glBlendedSourceTex) {
            gl.deleteTexture(glBlendedSourceTex);
          }
          for (let cell = 0; cell < cells; cell += 1) {
            sourceByteData[cell] = Math.round(sourceAlphaGrid[cell] * 255);
          }
          glBlendedSourceTex = createDataTexture(gl, maskWidth, maskHeight, sourceByteData, gl.ALPHA);
        }

        sourceBeamWeight = forms[toForm].id === "lighthouse" ? 1 : 0;
        beamWeight = sourceBeamWeight;
        sourceSignalWeight = forms[toForm].id === "signal" ? 1 : 0;
        signalWeight = sourceSignalWeight;
        sourceEnvelopeWeight = forms[toForm].id === "envelope" ? 1 : 0;
        envelopeWeight = sourceEnvelopeWeight;
        sourceForkWeight = forms[toForm].id === "fork" ? 1 : 0;
        forkWeight = sourceForkWeight;
        blend = 1;
      }

      function uploadBlendedSourceTexture() {
        if (!useWebGL || !gl || !glBlendedSourceTex || !sourceAlphaGrid) {
          return;
        }

        for (let cell = 0; cell < sourceAlphaGrid.length; cell += 1) {
          const byteAlpha = Math.round(sourceAlphaGrid[cell] * 255);
          sourceByteData[cell] = byteAlpha < 0 ? 0 : (byteAlpha > 255 ? 255 : byteAlpha);
        }

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, glBlendedSourceTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, maskWidth, maskHeight, gl.ALPHA, gl.UNSIGNED_BYTE, sourceByteData);
      }

      function setForm(index, time) {
        if (index === toForm || !sourceAlphaGrid) {
          return;
        }

        const previousTarget = forms[toForm].alphaGrid;
        const settled = easeInOutCubic(blend);

        if (settled >= 1) {
          sourceAlphaGrid.set(previousTarget);
          sourceFormIdx = toForm;
          usingBlendedSourceTex = false;
        } else if (settled > 0) {
          for (let cell = 0; cell < sourceAlphaGrid.length; cell += 1) {
            sourceAlphaGrid[cell] += (previousTarget[cell] - sourceAlphaGrid[cell]) * settled;
          }
          usingBlendedSourceTex = true;
          uploadBlendedSourceTexture();
        }

        sourceBeamWeight = beamWeight;
        sourceSignalWeight = signalWeight;
        sourceEnvelopeWeight = envelopeWeight;
        sourceForkWeight = forkWeight;
        if (forms[index].id === "envelope") {
          envelopeHoverStart = time;
        } else if (forms[index].id === "fork") {
          forkHoverStart = time;
        }
        toForm = index;
        morphStart = time;
        blend = reducedMotion ? 1 : 0;
        document.documentElement.dataset.form = forms[index].id;
        splashForm(index);

        if (reducedMotion) {
          sourceAlphaGrid.set(forms[toForm].alphaGrid);
          usingBlendedSourceTex = false;
          sourceBeamWeight = forms[toForm].id === "lighthouse" ? 1 : 0;
          sourceSignalWeight = forms[toForm].id === "signal" ? 1 : 0;
          sourceEnvelopeWeight = forms[toForm].id === "envelope" ? 1 : 0;
          sourceForkWeight = forms[toForm].id === "fork" ? 1 : 0;
          paint(performance.now());
        }
      }

      function advanceMorph(time) {
        if (blend < 1) {
          blend = Math.min(1, (time - morphStart) / config.morphDuration);

          if (blend >= 1) {
            sourceAlphaGrid.set(forms[toForm].alphaGrid);
            sourceFormIdx = toForm;
            usingBlendedSourceTex = false;
            sourceBeamWeight = forms[toForm].id === "lighthouse" ? 1 : 0;
            sourceSignalWeight = forms[toForm].id === "signal" ? 1 : 0;
            sourceEnvelopeWeight = forms[toForm].id === "envelope" ? 1 : 0;
            sourceForkWeight = forms[toForm].id === "fork" ? 1 : 0;
            dwellUntil = time + config.dwellDuration;
          }

          return;
        }

        if (heldForm !== null || reducedMotion || ambientOrder.length <= 1) {
          return;
        }

        if (time >= dwellUntil) {
          ambientCursor = (ambientCursor + 1) % ambientOrder.length;
          setForm(ambientOrder[ambientCursor], time);
        }
      }

      function holdForm(id) {
        const index = formIndex.get(id);
        if (index === undefined) {
          return;
        }

        cancelScheduledRelease();
        heldForm = index;
        setForm(index, performance.now());
      }

      function releaseForm() {
        cancelScheduledRelease();
        if (heldForm === null) {
          return;
        }

        heldForm = null;
        setForm(ambientOrder[ambientCursor], performance.now());
      }

      let releaseTimer = 0;

      function scheduleRelease() {
        if (heldForm === null) {
          return;
        }

        cancelScheduledRelease();
        releaseTimer = window.setTimeout(() => {
          releaseTimer = 0;
          releaseForm();
        }, 140);
      }

      function cancelScheduledRelease() {
        if (releaseTimer !== 0) {
          window.clearTimeout(releaseTimer);
          releaseTimer = 0;
        }
      }

      // ---------------------------------------------------------------------------
      // Theme Handling
      // ---------------------------------------------------------------------------

      function readStoredTheme() {
        try {
          const stored = localStorage.getItem(THEME_STORAGE_KEY);
          return stored === "dark" || stored === "paper" ? stored : null;
        } catch (error) {
          return null;
        }
      }

      function applyTheme(name, persist) {
        themeName = name;
        theme = themes[name];
        document.documentElement.dataset.theme = name;
        themeToggle.setAttribute("aria-label", theme.label);

        if (persist) {
          try {
            localStorage.setItem(THEME_STORAGE_KEY, name);
          } catch (error) {
            // Storage can be unavailable; the theme still applies for this visit.
          }
        }

        paint(performance.now());
      }

      // ---------------------------------------------------------------------------
      // Elastic Draggable Heading Characters
      // ---------------------------------------------------------------------------

      function wrapIdentityTextCharacters() {
        const textNodes = [
          { node: heading, draggable: true, stretches: true, float: config.identity.heading },
          { node: document.querySelector(".motto"), draggable: false, stretches: false, float: config.identity.motto }
        ];

        const dragConfig = config.drag;

        for (const line of textNodes) {
          const characters = Array.from(line.node.textContent);
          line.node.textContent = "";

          for (const character of characters) {
            if (/\s/.test(character)) {
              line.node.appendChild(document.createTextNode(character));
              continue;
            }

            const element = document.createElement("span");
            element.className = "identity-character";
            element.textContent = character;
            line.node.appendChild(element);

            identityCharacters.push({
              element,
              centerX: 0,
              centerY: 0,
              float: line.float,
              stretches: line.stretches,
              draggable: line.draggable,
              stiffness: dragConfig.followStiffness,
              radiusX: 0,
              radiusY: 0,
              lagX: 0,
              lagY: 0,
              lagVX: 0,
              lagVY: 0,
              transform: ""
            });

            if (line.draggable) {
              draggableCharacters.push(identityCharacters[identityCharacters.length - 1]);
            }
          }
        }
      }

      function resetIdentityTextTransforms() {
        for (const character of identityCharacters) {
          if (character.transform === "") {
            continue;
          }

          character.element.style.transform = "";
          character.transform = "";
        }
      }

      function measureIdentityCharacters() {
        resetIdentityTextTransforms();

        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        const packing = config.drag.collisionPacking;

        for (const character of identityCharacters) {
          const bounds = character.element.getBoundingClientRect();
          character.centerX = bounds.left + bounds.width / 2 + scrollX;
          character.centerY = bounds.top + bounds.height / 2 + scrollY;
          character.radiusX = bounds.width * 0.5 * packing;
          character.radiusY = bounds.height * 0.5 * packing;
        }
      }

      function resolveCharacterCollisions() {
        const settings = config.drag;
        const bodies = draggableCharacters;

        for (let pass = 0; pass < settings.collisionPasses; pass += 1) {
          for (let i = 0; i < bodies.length; i += 1) {
            const a = bodies[i];

            for (let j = i + 1; j < bodies.length; j += 1) {
              const b = bodies[j];
              const spanX = a.radiusX + b.radiusX;
              const spanY = a.radiusY + b.radiusY;

              if (spanX <= 0 || spanY <= 0) {
                continue;
              }

              let gapX = (b.centerX + b.lagX) - (a.centerX + a.lagX);
              const restingSide = b.centerX >= a.centerX ? 1 : -1;

              if (gapX * restingSide < 0) {
                gapX = restingSide * 0.01;
              }

              const unitX = gapX / spanX;
              const unitY = ((b.centerY + b.lagY) - (a.centerY + a.lagY)) / spanY;
              const reach = Math.hypot(unitX, unitY);

              if (reach >= 1 || reach < 1e-6) {
                continue;
              }

              const overlap = (1 - reach) / reach;
              const pushX = unitX * overlap * spanX;
              const pushY = unitY * overlap * spanY;

              const aHeld = drag.active && a === drag.character;
              const bHeld = drag.active && b === drag.character;
              const aShare = aHeld ? 0 : (bHeld ? 1 : 0.5);
              const bShare = bHeld ? 0 : (aHeld ? 1 : 0.5);

              a.lagX -= pushX * aShare;
              a.lagY -= pushY * aShare;
              b.lagX += pushX * bShare;
              b.lagY += pushY * bShare;

              a.lagVX -= pushX * aShare * settings.collisionBounce;
              a.lagVY -= pushY * aShare * settings.collisionBounce;
              b.lagVX += pushX * bShare * settings.collisionBounce;
              b.lagVY += pushY * bShare * settings.collisionBounce;
            }
          }
        }
      }

      function updateDrag() {
        if (reducedMotion) {
          drag.x = 0;
          drag.y = 0;
          drag.vx = 0;
          drag.vy = 0;
          drag.character = null;
          return;
        }

        if (drag.active) {
          return;
        }

        const settings = config.drag;
        drag.vx = (drag.vx - drag.x * settings.spring) * settings.damping;
        drag.vy = (drag.vy - drag.y * settings.spring) * settings.damping;
        drag.x += drag.vx;
        drag.y += drag.vy;

        if (Math.abs(drag.x) < 0.05 && Math.abs(drag.y) < 0.05 && Math.hypot(drag.vx, drag.vy) < 0.05) {
          drag.x = 0;
          drag.y = 0;
          drag.vx = 0;
          drag.vy = 0;
          drag.character = null;
        }
      }

      function limitDrag(rawX, rawY) {
        const settings = config.drag;
        const distance = Math.hypot(rawX, rawY);

        if (distance < 0.001) {
          drag.x = 0;
          drag.y = 0;
          return;
        }

        const limited = settings.maxRange * Math.tanh(distance / settings.maxRange);
        drag.x = rawX / distance * limited;
        drag.y = rawY / distance * limited;
      }

      function draggableCharacterAt(clientX, clientY) {
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        let best = null;
        let bestDistance = Infinity;

        for (const character of draggableCharacters) {
          const offsetX = character.centerX - scrollX - clientX;
          const offsetY = character.centerY - scrollY - clientY;
          const distance = offsetX * offsetX + offsetY * offsetY;

          if (distance < bestDistance) {
            bestDistance = distance;
            best = character;
          }
        }

        return best;
      }

      function stepIdentityPhysics() {
        if (reducedMotion) {
          return;
        }

        const settings = config.drag;
        for (const character of draggableCharacters) {
          const held = character === drag.character;
          const targetX = held ? drag.x : 0;
          const targetY = held ? drag.y : 0;
          const stiffness = held ? settings.followStiffness : settings.returnStiffness;

          character.lagVX = (character.lagVX + (targetX - character.lagX) * stiffness) * settings.followDamping;
          character.lagVY = (character.lagVY + (targetY - character.lagY) * stiffness) * settings.followDamping;
          character.lagX += character.lagVX;
          character.lagY += character.lagVY;
        }

        resolveCharacterCollisions();
      }

      function applyIdentityTransforms(time) {
        if (reducedMotion) {
          resetIdentityTextTransforms();
          return;
        }

        const settings = config.drag;

        for (const character of identityCharacters) {
          let offsetX = character.lagX;
          let offsetY = character.lagY;
          let rotation = 0;
          let stretch = 0;
          let stretchAngle = 0;

          const float = character.float;
          const phase = time * float.speed + character.centerX * float.wavelength;

          offsetY += Math.sin(phase) * float.lift;
          rotation += Math.cos(phase) * float.tilt;

          if (character.stretches) {
            const chaseSpeed = Math.hypot(character.lagVX, character.lagVY);
            if (chaseSpeed > 0.2) {
              stretch = Math.min(settings.maxStretch, chaseSpeed * settings.stretchPerPixel);
              stretchAngle = Math.atan2(character.lagVY, character.lagVX) * 180 / Math.PI;
            }
          }

          let transform = "";

          if (Math.abs(offsetX) > 0.01 || Math.abs(offsetY) > 0.01 || Math.abs(rotation) > 0.01) {
            transform = `translate(${offsetX.toFixed(3)}px, ${offsetY.toFixed(3)}px) rotate(${rotation.toFixed(3)}deg)`;
          }

          if (stretch > 0.001) {
            const along = (1 + stretch).toFixed(4);
            const across = (1 / (1 + stretch * 0.75)).toFixed(4);
            transform += ` rotate(${stretchAngle.toFixed(2)}deg) scale(${along}, ${across}) rotate(${(-stretchAngle).toFixed(2)}deg)`;
          }

          if (transform !== character.transform) {
            character.element.style.transform = transform;
            character.transform = transform;
          }
        }
      }

      // ---------------------------------------------------------------------------
      // Resize & Paint (WebGL + Canvas 2D Fallback)
      // ---------------------------------------------------------------------------

      function measureUiSafeZones() {
        if (linksEl) {
          const r = linksEl.getBoundingClientRect();
          linksRect[0] = r.left;
          linksRect[1] = r.top;
          linksRect[2] = r.right;
          linksRect[3] = r.bottom;
        }
        if (mottoEl) {
          const r = mottoEl.getBoundingClientRect();
          mottoRect[0] = r.left;
          mottoRect[1] = r.top;
          mottoRect[2] = r.right;
          mottoRect[3] = r.bottom;
        }
      }

      function resize() {
        width = window.innerWidth;
        height = window.innerHeight;

        const maxDpr = width < 760 ? config.mobileMaximumPixelRatio : config.maximumPixelRatio;
        dpr = Math.min(window.devicePixelRatio || 1, maxDpr);

        const pixelSize = width < 760 ? config.mobilePixelSize : config.desktopPixelSize;
        cellPx = Math.max(1, Math.round(pixelSize * dpr));

        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));

        if (useWebGL && gl) {
          gl.viewport(0, 0, canvas.width, canvas.height);
          const maskScale = width < 760 ? Math.min(dpr, 1.5) : 0.65;
          const scaleWidth = Math.max(240, Math.min(760, Math.round(width * maskScale)));
          const scaleHeight = Math.max(180, Math.round(scaleWidth * (height / Math.max(1, width))));
          maskWidth = scaleWidth;
          maskHeight = scaleHeight;
        } else {
          if (fallbackContext) {
            fallbackContext.setTransform(dpr, 0, 0, dpr, 0, 0);
          }
          const gap = width < 760 ? config.fallbackMobileGap : config.fallbackDesktopGap;
          maskWidth = Math.max(1, Math.ceil(width / gap));
          maskHeight = Math.max(1, Math.ceil(height / gap));
        }

        const nextRasterKey = `${maskWidth}x${maskHeight}x${Math.round(width)}x${Math.round(height)}`;
        if (nextRasterKey !== rasterKey) {
          rasterKey = nextRasterKey;
          buildWaterGrid();
          rasterizeForms();
        }

        measureIdentityCharacters();
        measureUiSafeZones();
        paint(performance.now());
      }

      function updateFormWeights(time, mix, targetId) {
        beamWeight = sourceBeamWeight + ((targetId === "lighthouse" ? 1 : 0) - sourceBeamWeight) * mix;
        signalWeight = sourceSignalWeight + ((targetId === "signal" ? 1 : 0) - sourceSignalWeight) * mix;
        envelopeWeight = sourceEnvelopeWeight + ((targetId === "envelope" ? 1 : 0) - sourceEnvelopeWeight) * mix;
        forkWeight = sourceForkWeight + ((targetId === "fork" ? 1 : 0) - sourceForkWeight) * mix;

        if (reducedMotion) {
          envelopeOpen = targetId === "envelope" ? 0.85 : 0;
        } else if (targetId === "envelope") {
          const cycle = Math.max(0, (time - envelopeHoverStart) * 0.001) % 3.4;
          if (cycle < 0.75) {
            envelopeOpen = easeInOutCubic(cycle / 0.75);
          } else if (cycle < 1.65) {
            envelopeOpen = 1.0;
          } else if (cycle < 2.4) {
            envelopeOpen = 1 - easeInOutCubic((cycle - 1.65) / 0.75);
          } else {
            envelopeOpen = 0.0;
          }
        } else {
          envelopeOpen = Math.max(0, envelopeOpen - 0.06);
        }
      }

      function computeFishAnim(time, radiusCss) {
        const fishLen = Math.max(30, radiusCss * fishConfig.length);
        const rawProgress = fish.active && fish.duration > 0
          ? Math.min(1, Math.max(0, (time - fish.startTime) * 0.001 / fish.duration))
          : 0;
        const totalFrames = 16;
        const steppedProgress = Math.floor(rawProgress * totalFrames) / totalFrames;
        const poseProgress = steppedProgress * 0.45 + rawProgress * 0.55;
        const swimCadence = !fish.active
          ? 12
          : (fish.vy < 0 && Math.abs(fish.y - fish.surfaceY) < fishLen * 0.8 ? 18 : (fish.vy > 0 ? 10 : 12));
        const swimFrame = Math.floor((time * 0.001) * swimCadence) % totalFrames;
        const swimFramePhase = swimFrame * (Math.PI * 2 / totalFrames);
        return { progress: poseProgress, dir: fish.dir, swimFramePhase, fishLen };
      }

      function paintWebGL(time) {
        if (contextLost || !gl || !glProgram || !sourceAlphaGrid) {
          return;
        }

        const targetForm = forms[toForm];
        if (!targetForm.texture) {
          return;
        }

        const sourceTex = usingBlendedSourceTex && glBlendedSourceTex
          ? glBlendedSourceTex
          : (blend >= 1 ? targetForm.texture : (forms[sourceFormIdx].texture || targetForm.texture));

        const mix = easeInOutCubic(blend);
        const morphing = blend < 1;
        const turbulence = morphing ? Math.max(0, 1 - Math.abs(blend - 0.5) / 0.24) : 0;
        const glitchSeed = Math.floor(time / 70);

        const centerX = formCenterX();
        const centerY = formCenterY();
        const radiusCss = formRadiusCss();
        const rippleOuter = radiusCss * config.formRipple.reach;
        const rippleInner = rippleOuter * (1 - config.formRipple.edge);
        const lampX = centerX;
        const lampY = centerY + LIGHTHOUSE_LAMP * radiusCss * LIGHTHOUSE_SCALE;

        updateFormWeights(time, mix, targetForm.id);
        uploadWaterTexture();

        dropletUniformData.fill(0);
        const count = Math.min(MAX_DROPLETS, droplets.length);
        for (let i = 0; i < count; i += 1) {
          const d = droplets[i];
          const remaining = Math.max(0, 1 - d.age / d.life);
          dropletUniformData[i * 4] = d.x;
          dropletUniformData[i * 4 + 1] = d.y;
          dropletUniformData[i * 4 + 2] = 3.2;
          dropletUniformData[i * 4 + 3] = remaining;
        }

        gl.useProgram(glProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sourceTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, targetForm.texture);

        gl.uniform2f(glUniforms.resolution, canvas.width, canvas.height);
        gl.uniform2f(glUniforms.cssSize, width, height);
        gl.uniform1f(glUniforms.dpr, dpr);
        gl.uniform1f(glUniforms.cellPx, cellPx);
        gl.uniform1f(glUniforms.time, time * 0.001);
        gl.uniform1f(glUniforms.reducedMotion, reducedMotion ? 1.0 : 0.0);

        gl.uniform3fv(glUniforms.colorFront, theme.frontRGB);
        gl.uniform3fv(glUniforms.colorBack, theme.backRGB);
        gl.uniform1f(glUniforms.lumScale, theme.lumScale);
        gl.uniform1f(glUniforms.lumGamma, theme.lumGamma);

        gl.uniform1f(glUniforms.mix, mix);
        gl.uniform1f(glUniforms.turbulence, turbulence);
        gl.uniform1f(glUniforms.glitchSeed, glitchSeed);
        gl.uniform1f(glUniforms.glitchRows, config.glitchRows);
        gl.uniform1f(glUniforms.glitchThrow, config.glitchThrow);

        gl.uniform2f(glUniforms.formCenter, centerX, centerY);
        gl.uniform1f(glUniforms.formRadius, radiusCss);
        gl.uniform1f(glUniforms.rippleOuter, rippleOuter);
        gl.uniform1f(glUniforms.rippleInner, rippleInner);
        gl.uniform1f(glUniforms.rippleAmp, config.formRipple.amplitude);
        gl.uniform1f(glUniforms.rippleShimmer, config.formRipple.shimmer);

        gl.uniform2f(glUniforms.lampPos, lampX, lampY);
        gl.uniform1f(glUniforms.beamWeight, beamWeight);
        gl.uniform1f(glUniforms.beamReach, radiusCss * beamConfig.reach);
        gl.uniform1f(glUniforms.beamCoreReach, radiusCss * beamConfig.coreReach);

        gl.uniform1f(glUniforms.signalWeight, signalWeight);
        gl.uniform1f(glUniforms.envelopeWeight, envelopeWeight);
        gl.uniform1f(glUniforms.envelopeOpen, envelopeOpen);
        gl.uniform1f(glUniforms.forkWeight, forkWeight);
        gl.uniform1f(glUniforms.forkAge, reducedMotion ? 1.0 : Math.max(0, (time - forkHoverStart) * 0.001));

        gl.uniform2f(glUniforms.pointerPos, pointer.followX, pointer.followY);
        gl.uniform1f(glUniforms.pointerActive, pointer.active ? 1.0 : 0.0);
        gl.uniform1f(glUniforms.pointerRadius, config.pointerRadius);

        const heading = fish.active ? Math.atan2(fish.vy, fish.vx) : 0;
        const fishAnim = computeFishAnim(time, radiusCss);
        const vySign = fish.active ? Math.max(-1, Math.min(1, fish.vy / 300)) : 0;
        const ageA = (time - splashTakeoff.time) * 0.001;
        const ageB = (time - splashLanding.time) * 0.001;
        gl.uniform4f(glUniforms.fish, fish.x, fish.y, heading, fish.active ? 1.0 : 0.0);
        gl.uniform4f(glUniforms.fishAnim, fishAnim.progress, fishAnim.dir, fishAnim.swimFramePhase, fishAnim.fishLen);
        gl.uniform1f(glUniforms.fishSurfaceY, fish.surfaceY);
        gl.uniform1f(glUniforms.fishVySign, vySign);
        gl.uniform4f(glUniforms.splashA, splashTakeoff.x, splashTakeoff.y, ageA, ageA >= 0 && ageA < 0.95 ? 1.0 : 0.0);
        gl.uniform4f(glUniforms.splashB, splashLanding.x, splashLanding.y, ageB, ageB >= 0 && ageB < 0.95 ? 1.0 : 0.0);
        gl.uniform4fv(glUniforms.droplets, dropletUniformData);
        gl.uniform4fv(glUniforms.linksRect, linksRect);
        gl.uniform4fv(glUniforms.mottoRect, mottoRect);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      function rectClearanceJs(px, py, rect, pad, feather) {
        if (rect[2] <= rect[0] || rect[3] <= rect[1]) {
          return 1;
        }
        const hx = (rect[2] - rect[0]) * 0.5 + pad;
        const hy = (rect[3] - rect[1]) * 0.5 + pad;
        const cx = (rect[0] + rect[2]) * 0.5;
        const cy = (rect[1] + rect[3]) * 0.5;
        const qx = Math.abs(px - cx) - hx;
        const qy = Math.abs(py - cy) - hy;
        const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
        const t = Math.min(1, Math.max(0, (dist + feather) / (2 * feather)));
        return t * t * (3 - 2 * t);
      }

      function smoothstepJs(edge0, edge1, x) {
        const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
        return t * t * (3 - 2 * t);
      }

      function sdBoxJs(px, py, bx, by) {
        const dx = Math.abs(px) - bx;
        const dy = Math.abs(py) - by;
        return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
      }

      function sdSegmentJs(px, py, ax, ay, bx, by) {
        const pax = px - ax;
        const pay = py - ay;
        const bax = bx - ax;
        const bay = by - ay;
        const denom = Math.max(bax * bax + bay * bay, 1e-6);
        const h = Math.min(1, Math.max(0, (pax * bax + pay * bay) / denom));
        return Math.hypot(pax - bax * h, pay - bay * h);
      }

      function evalSignalJs(px, py, cx, cy, r, t, rm) {
        const halfW = r * 0.58;
        const halfH = r * 0.38;
        const lpx = px - cx;
        const lpy = py - cy;
        if (Math.abs(lpx) > halfW + 18 || Math.abs(lpy) > halfH + 18) {
          return 0;
        }
        const wt = rm ? 0 : t;
        let lum = 0;
        const bd = Math.abs(sdBoxJs(lpx, lpy, halfW, halfH));
        const brkLen = r * 0.14;
        if (Math.abs(lpx) > halfW - brkLen && Math.abs(lpy) > halfH - brkLen) {
          lum = Math.max(lum, smoothstepJs(2.2, 0.5, bd) * 0.88);
        }
        const axisY = -halfH * 0.12;
        if (Math.abs(lpx) < halfW * 0.92) {
          lum = Math.max(lum, smoothstepJs(1.2, 0.2, Math.abs(lpy - axisY)) * 0.22);
        }
        const ux = lpx / (halfW * 0.92);
        if (Math.abs(ux) <= 1) {
          const env = Math.exp(-ux * ux * 2.2);
          const wy = axisY - halfH * 0.52 * env * (Math.sin(ux * 9.5 - wt * 3.4) * 0.72 + Math.sin(ux * 19 + wt * 2.1) * 0.28);
          const dy = Math.abs(lpy - wy);
          lum = Math.max(lum, smoothstepJs(3.2, 0.5, dy) * 0.98, smoothstepJs(13, 0, dy) * 0.32);
          const wy2 = axisY - halfH * 0.34 * env * Math.sin(ux * 6.5 + wt * 2.2 + 1.2);
          lum = Math.max(lum, smoothstepJs(2.4, 0.4, Math.abs(lpy - wy2)) * 0.42);
        }
        if (Math.abs(ux) < 0.94 && lpy >= halfH * 0.32 && lpy <= halfH * 0.86) {
          const slot = (ux * 0.5 + 0.5) * 9;
          const bi = Math.floor(slot);
          const bx = slot - bi;
          const bh = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(wt * 3.2 + bi * 1.15 + Math.sin(bi * 2.3)));
          const barTop = halfH * 0.86 + (halfH * 0.32 - halfH * 0.86) * bh;
          if (Math.abs(bx - 0.5) < 0.28 && lpy >= barTop) {
            lum = Math.max(lum, 0.78 - 0.44 * ((lpy - barTop) / Math.max(halfH * 0.54, 1)));
          }
        }
        return Math.min(1, lum);
      }

      function evalEnvelopeJs(px, py, cx, cy, r, open) {
        const halfW = r * 0.56;
        const halfH = r * 0.37;
        const lpx = px - cx;
        const lpy = py - (cy + r * 0.08);
        if (Math.abs(lpx) > halfW + 18 || lpy < -halfH * 2.3 - 14 || lpy > halfH + 14) {
          return 0;
        }
        let lum = 0;
        const fold = Math.cos(open * Math.PI);
        const tipY = -halfH + fold * halfH * 1.12;
        const lift = smoothstepJs(0.32, 1, open) * halfH * 0.92;

        if (fold < 0) {
          const edgeY = -halfH + fold * halfH * 1.12 * (1 - Math.abs(lpx) / halfW);
          if (Math.abs(lpx) <= halfW && lpy <= -halfH && lpy >= edgeY) {
            const frac = Math.min(1, Math.max(0, (-halfH - lpy) / Math.max(-fold * halfH * 1.12, 1)));
            lum = 0.22 + 0.22 * frac;
          }
          const dL = sdSegmentJs(lpx, lpy, -halfW, -halfH, 0, tipY);
          const dR = sdSegmentJs(lpx, lpy, halfW, -halfH, 0, tipY);
          lum = Math.max(lum, smoothstepJs(2.6, 0.5, Math.min(dL, dR)) * 0.9);
        }

        if (lift > 1 && lpy <= -halfH + 1) {
          const cardTop = -halfH - lift;
          const cardCenterY = (cardTop - halfH + 2) * 0.5;
          const cardHalfH = (-halfH + 2 - cardTop) * 0.5;
          const cardD = sdBoxJs(lpx, lpy - cardCenterY, halfW * 0.78, cardHalfH);
          if (cardD <= 0) {
            lum = 0.42 - 0.12 * Math.min(1, Math.max(0, (lpy - cardTop) / Math.max(lift, 1)));
            const l1 = sdSegmentJs(lpx, lpy, -halfW * 0.52, cardTop + halfH * 0.25, halfW * 0.52, cardTop + halfH * 0.25);
            const l2 = sdSegmentJs(lpx, lpy, -halfW * 0.52, cardTop + halfH * 0.47, halfW * 0.52, cardTop + halfH * 0.47);
            const l3 = sdSegmentJs(lpx, lpy, -halfW * 0.52, cardTop + halfH * 0.69, halfW * 0.22, cardTop + halfH * 0.69);
            lum = Math.max(lum, smoothstepJs(2.1, 0.5, Math.min(l1, l2, l3)) * 0.96);
          }
          lum = Math.max(lum, smoothstepJs(2.4, 0.5, Math.abs(cardD)) * 0.94);
        }

        const pocketD = sdBoxJs(lpx, lpy, halfW, halfH);
        lum = Math.max(lum, smoothstepJs(8, 0, Math.max(pocketD, 0)) * 0.26);
        if (pocketD <= 0) {
          const pocketFill = 0.18 + 0.18 * Math.min(1, Math.max(0, (lpy + halfH) / (2 * halfH)));
          const sL = sdSegmentJs(lpx, lpy, -halfW, halfH, -halfW * 0.14, -halfH * 0.04);
          const sR = sdSegmentJs(lpx, lpy, halfW, halfH, halfW * 0.14, -halfH * 0.04);
          lum = Math.max(pocketFill, smoothstepJs(2.2, 0.5, Math.min(sL, sR)) * 0.54);
        }
        lum = Math.max(lum, smoothstepJs(2.6, 0.5, Math.abs(pocketD)) * 0.95);

        if (fold >= 0) {
          const edgeY = -halfH + fold * halfH * 1.12 * (1 - Math.abs(lpx) / halfW);
          if (Math.abs(lpx) <= halfW && lpy >= -halfH && lpy <= edgeY) {
            const frac = Math.min(1, Math.max(0, (lpy + halfH) / Math.max(fold * halfH * 1.12, 1)));
            lum = 0.56 - 0.26 * frac;
          }
          const dL = sdSegmentJs(lpx, lpy, -halfW, -halfH, 0, tipY);
          const dR = sdSegmentJs(lpx, lpy, halfW, -halfH, 0, tipY);
          lum = Math.max(lum, smoothstepJs(2.6, 0.5, Math.min(dL, dR)) * 0.98);
        }
        return Math.min(1, lum);
      }

      function evalForkJs(px, py, cx, cy, r, age, rm) {
        const lpx = px - cx;
        const lpy = py - cy;
        if (Math.abs(lpx) > r * 0.62 || Math.abs(lpy) > r * 0.68) {
          return 0;
        }
        const trunkX = -r * 0.26;
        const branchX = r * 0.28;
        const topY = -r * 0.4;
        const botY = r * 0.42;
        const juncY = r * 0.1;
        const nodeR = Math.max(6, r * 0.088);
        const strokeW = Math.max(2.2, r * 0.036);

        let grow = 1;
        if (!rm) {
          const cycle = age % 5.2;
          if (cycle < 0.85) {
            grow = easeInOutCubic(cycle / 0.85);
          } else if (cycle < 3.6) {
            grow = 1;
          } else if (cycle < 4.45) {
            grow = 1 - easeInOutCubic((cycle - 3.6) / 0.85);
          } else {
            grow = 0;
          }
        }
        let lum = 0;

        const dTrunk = sdSegmentJs(lpx, lpy, trunkX, botY - nodeR, trunkX, topY + nodeR);
        lum = Math.max(lum, smoothstepJs(strokeW + 1.8, strokeW * 0.5, dTrunk) * 0.92);
        lum = Math.max(lum, smoothstepJs(strokeW + 9, strokeW, dTrunk) * 0.26);

        if (grow > 0.01) {
          const ySpan = (topY + nodeR) - juncY;
          const tRaw = Math.min(grow, Math.max(0, (lpy - juncY) / ySpan));
          const s = tRaw * tRaw * (3 - 2 * tRaw);
          const cxPt = trunkX + (branchX - trunkX) * s;
          const cyPt = juncY + tRaw * ySpan;
          const dxdy = (branchX - trunkX) * 6 * tRaw * (1 - tRaw) / ySpan;
          const dBranch = (lpy <= juncY && lpy >= juncY + grow * ySpan)
            ? Math.abs(lpx - cxPt) / Math.hypot(1, dxdy)
            : Math.hypot(lpx - cxPt, lpy - cyPt);
          lum = Math.max(lum, smoothstepJs(strokeW + 1.8, strokeW * 0.5, dBranch) * 0.92);
          lum = Math.max(lum, smoothstepJs(strokeW + 9, strokeW, dBranch) * 0.26);
        }

        const branchVis = rm ? 1 : smoothstepJs(0.76, 1, grow);
        const curBranchR = nodeR * (0.45 + 0.55 * branchVis);
        const dBot = Math.hypot(lpx - trunkX, lpy - botY);
        const dTopM = Math.hypot(lpx - trunkX, lpy - topY);
        const dTopB = Math.hypot(lpx - branchX, lpy - topY);

        lum = Math.max(lum, smoothstepJs(nodeR * 2.5, nodeR * 0.8, dBot) * 0.36);
        lum = Math.max(lum, smoothstepJs(strokeW + 1.6, strokeW * 0.5, Math.abs(dBot - nodeR)) * 0.98);
        lum = Math.max(lum, smoothstepJs(nodeR * 2.5, nodeR * 0.8, dTopM) * 0.36);
        lum = Math.max(lum, smoothstepJs(strokeW + 1.6, strokeW * 0.5, Math.abs(dTopM - nodeR)) * 0.98);
        if (branchVis > 0.01) {
          lum = Math.max(lum, smoothstepJs(curBranchR * 2.5, curBranchR * 0.8, dTopB) * 0.36 * branchVis);
          lum = Math.max(lum, smoothstepJs(strokeW + 1.6, strokeW * 0.5, Math.abs(dTopB - curBranchR)) * 0.98 * branchVis);
        }

        lum *= smoothstepJs(nodeR - strokeW * 0.7, nodeR - strokeW * 0.2, dBot);
        lum *= smoothstepJs(nodeR - strokeW * 0.7, nodeR - strokeW * 0.2, dTopM);
        if (branchVis > 0.01) {
          lum *= 1 - (1 - smoothstepJs(curBranchR - strokeW * 0.7, curBranchR - strokeW * 0.2, dTopB)) * branchVis;
        }
        return Math.min(1, lum);
      }

      function evalSplashJs(px, py, sp, time) {
        const age = (time - sp.time) * 0.001;
        if (age < 0 || age >= 0.95) {
          return 0;
        }
        const dx = px - sp.x;
        const dy = py - sp.y;
        let lum = 0;

        const rx = 8 + age * 62;
        const ry = rx * 0.27;
        const ringDist = Math.abs(Math.hypot(dx / rx, dy / ry) - 1) * ry;
        lum = Math.max(lum, smoothstepJs(2.6, 0.5, ringDist) * 0.85 * Math.pow(1 - age / 0.95, 1.3));

        if (age > 0.12) {
          const rx2 = 4 + (age - 0.12) * 42;
          const ry2 = rx2 * 0.27;
          const ringDist2 = Math.abs(Math.hypot(dx / rx2, dy / ry2) - 1) * ry2;
          lum = Math.max(lum, smoothstepJs(2.1, 0.4, ringDist2) * 0.65 * Math.pow(1 - (age - 0.12) / 0.83, 1.4));
        }

        if (age < 0.44 && dy <= 3) {
          const cProg = age / 0.44;
          const crownH = Math.sin(cProg * Math.PI) * 28;
          const wingW = 7 + cProg * 20;
          const cFade = 1 - cProg;
          const plumeL = sdSegmentJs(dx, dy, -3, 0, -wingW, -crownH);
          const plumeR = sdSegmentJs(dx, dy, 3, 0, wingW, -crownH);
          const plumeC = sdSegmentJs(dx, dy, 0, 0, 0, -crownH * 0.85);
          lum = Math.max(lum, smoothstepJs(3.2, 0.6, Math.min(plumeL, plumeR, plumeC)) * 0.92 * cFade);
        }
        return Math.min(1, lum);
      }

      function evalFishJs(px, py, fishAnim, heading, vySign) {
        if (!fish.active) {
          return 0;
        }
        const fdx = px - fish.x;
        const fdy = py - fish.y;
        if (Math.hypot(fdx, fdy) >= fishAnim.fishLen * 1.45) {
          return 0;
        }
        const c = Math.cos(heading);
        const s = Math.sin(heading);
        const localX = fdx * c + fdy * s;
        let localY = -fdx * s + fdy * c;
        if (fishAnim.dir < 0) {
          localY = -localY;
        }

        const prog = Math.min(1, Math.max(0, fishAnim.progress));
        const arcEnv = Math.sin(Math.min(1, Math.max(0, (prog - 0.08) / 0.84)) * Math.PI);
        const bendAngle = 1.35 * Math.pow(Math.max(arcEnv, 0), 1.15);
        const diveTuck = smoothstepJs(0.66, 0.96, prog);
        const breachBoost = Math.exp(-Math.abs(fish.y - fish.surfaceY) / 42) * Math.max(0, -vySign);

        const bodyLen = fishAnim.fishLen * 0.68 * (1 + 0.08 * diveTuck);
        const bodyH = fishAnim.fishLen * 0.24 * (1 - 0.06 * diveTuck);
        const tailFlare = 1.18 + (0.74 - 1.18) * diveTuck;
        const whipAmp = (0.68 + (0.22 - 0.68) * diveTuck) * (1 + 0.25 * breachBoost);

        let arcX = localX;
        let radialY = localY;
        if (bendAngle > 0.03) {
          const bendR = bodyLen / bendAngle;
          const dyCenter = bendR - localY;
          const theta = Math.atan2(localX, Math.max(dyCenter, 1));
          arcX = theta * bendR;
          radialY = bendR - Math.hypot(localX, dyCenter);
        }

        const nx = arcX / (bodyLen * 0.5);
        const whipWeight = smoothstepJs(0.45, -1.6, nx);
        const whip = Math.sin(fishAnim.swimFramePhase - nx * 2.4) * bodyH * whipAmp * whipWeight;
        const by = radialY - whip;

        let lum = 0;
        if (nx > -1.05 && nx < 1.08) {
          const t = Math.min(1, Math.max(0, (1 - nx) * 0.5));
          const halfH = bodyH * 0.56 * Math.pow(Math.max(t, 1e-4), 0.48) * Math.pow(Math.max(1e-4, 1 - t * 0.88), 0.72) * 2.15;
          const bodyMask = smoothstepJs(halfH + 1.5, halfH - 1.2, Math.abs(by)) * smoothstepJs(1.05, 0.92, nx) * smoothstepJs(-1.02, -0.82, nx);
          const bodyShade = 0.65 + 0.35 * Math.min(1, Math.max(0, 1 - Math.abs(by) / Math.max(halfH, 1)));
          lum = Math.max(lum, bodyMask * bodyShade);
        }
        if (nx < -0.75 && nx > -1.78) {
          const tx = Math.min(1, Math.max(0, (-0.78 - nx) / 0.94));
          const outerY = bodyH * 0.14 + (bodyH * 0.92 * tailFlare - bodyH * 0.14) * Math.pow(Math.max(tx, 1e-4), 0.82);
          const notchY = bodyH * 0.42 * tailFlare * smoothstepJs(0.25, 1, tx);
          const tailMask = smoothstepJs(outerY + 1.4, outerY - 1, Math.abs(by)) * smoothstepJs(notchY - 1, notchY + 1.4, Math.abs(by));
          lum = Math.max(lum, tailMask * 0.86);
        }
        if (nx > -0.34 && nx < 0.34 && by < -bodyH * 0.32) {
          const dx = (nx + 0.3) / 0.62;
          let topY = -bodyH * 0.44 + (-bodyH * 1.02 + bodyH * 0.44) * smoothstepJs(0, 0.45, dx);
          if (dx > 0.45) {
            topY = -bodyH * 1.02 + (-bodyH * 0.38 + bodyH * 1.02) * ((dx - 0.45) / 0.55);
          }
          const dorsalMask = smoothstepJs(topY - 1.4, topY + 1, by) * smoothstepJs(-0.34, -0.22, nx) * smoothstepJs(0.34, 0.22, nx);
          lum = Math.max(lum, dorsalMask * 0.84);
        }
        if (nx > 0.02 && nx < 0.44 && by > bodyH * 0.28) {
          const pnx = (nx - 0.05) / 0.37;
          const botY = bodyH * 0.4 + (bodyH * 0.84 - bodyH * 0.4) * (1 - Math.abs(pnx - 0.45) * 1.4);
          const pecMask = smoothstepJs(botY + 1.3, botY - 0.9, by) * smoothstepJs(0.02, 0.14, nx) * smoothstepJs(0.44, 0.32, nx);
          lum = Math.max(lum, pecMask * 0.72);
        }
        if (lum > 0 && py > fish.surfaceY) {
          lum *= smoothstepJs(fish.surfaceY + 26, fish.surfaceY - 2, py) * 0.34;
        }
        return lum;
      }

      function createSeededValue(horizontalIndex, verticalIndex, offset = 0) {
        const value = Math.sin(
          horizontalIndex * 12.9898 +
          verticalIndex * 78.233 +
          offset * 37.719
        ) * 43758.5453;
        return value - Math.floor(value);
      }

      function paintFallback(time) {
        if (!fallbackContext || !sourceAlphaGrid || !forms[toForm].alphaGrid) {
          return;
        }

        const gap = width < 760 ? config.fallbackMobileGap : config.fallbackDesktopGap;
        const toField = forms[toForm].alphaGrid;
        const mix = easeInOutCubic(blend);
        const morphing = blend < 1;
        const turbulence = morphing ? Math.max(0, 1 - Math.abs(blend - 0.5) / 0.24) : 0;
        const glitchSeed = Math.floor(time / 70);

        fallbackContext.fillStyle = theme.background;
        fallbackContext.fillRect(0, 0, width, height);
        fallbackContext.fillStyle = theme.frontHex;

        const centerX = formCenterX();
        const centerY = formCenterY();
        const radiusCss = formRadiusCss();
        const rippleOuter = radiusCss * config.formRipple.reach;
        const rippleInner = rippleOuter * (1 - config.formRipple.edge);
        const lampX = centerX;
        const lampY = centerY + LIGHTHOUSE_LAMP * radiusCss * LIGHTHOUSE_SCALE;
        const beamReach = radiusCss * beamConfig.reach;
        const coreReach = radiusCss * beamConfig.coreReach;

        updateFormWeights(time, mix, forms[toForm].id);
        const turn = reducedMotion ? 0.8 : time * 0.001 * beamConfig.speed;
        const towardViewer = Math.sin(turn);
        const facing = Math.max(0, towardViewer);
        const sweepAngle = Math.atan2(beamConfig.tilt, Math.cos(turn));
        const halfW = beamConfig.halfWidth * (1 + 0.9 * facing);
        const beamGain = beamWeight * Math.max(0, 0.24 + 0.76 * towardViewer) * beamConfig.gain;
        const coreGain = beamWeight * (beamConfig.lampGain + beamConfig.flareGain * facing * facing);
        const horizonY = height * config.water.horizon;
        const timeSec = reducedMotion ? 0 : time * 0.001;
        const forkAge = reducedMotion ? 1 : Math.max(0, (time - forkHoverStart) * 0.001);
        const fishHeading = fish.active ? Math.atan2(fish.vy, fish.vx) : 0;
        const fishAnim = computeFishAnim(time, radiusCss);
        const fishVySign = fish.active ? Math.max(-1, Math.min(1, fish.vy / 300)) : 0;

        for (let row = 0; row < maskHeight; row += 1) {
          const y = (row + 0.5) * gap;
          const rowBase = row * maskWidth;
          let rowShiftPx = 0;

          if (turbulence > 0 && createSeededValue(row, glitchSeed, 3) < config.glitchRows * turbulence) {
            rowShiftPx = (createSeededValue(row, glitchSeed, 4) - 0.5) * config.glitchThrow * turbulence;
          }
          const rowShift = Math.round(rowShiftPx / gap);

          for (let col = 0; col < maskWidth; col += 1) {
            const x = (col + 0.5) * gap;
            const sampleCol = Math.max(0, Math.min(maskWidth - 1, col + rowShift));
            const sampleCell = rowBase + sampleCol;
            const cell = rowBase + col;

            const texShapeVal = mix === 0
              ? sourceAlphaGrid[sampleCell]
              : mix === 1
                ? toField[sampleCell]
                : sourceAlphaGrid[sampleCell] + (toField[sampleCell] - sourceAlphaGrid[sampleCell]) * mix;

            const formX = x + rowShiftPx;
            const procSignal = signalWeight > 0.005 ? evalSignalJs(formX, y, centerX, centerY, radiusCss, timeSec, reducedMotion) * signalWeight : 0;
            const procEnvelope = envelopeWeight > 0.005 ? evalEnvelopeJs(formX, y, centerX, centerY, radiusCss, envelopeOpen) * envelopeWeight : 0;
            const procFork = forkWeight > 0.005 ? evalForkJs(formX, y, centerX, centerY, radiusCss, forkAge, reducedMotion) * forkWeight : 0;
            const procShapeVal = Math.max(procSignal, procEnvelope, procFork);
            const shapeVal = Math.max(texShapeVal, procShapeVal);

            const offsetX = x - centerX;
            const offsetY = y - centerY;
            const dist = Math.hypot(offsetX, offsetY);
            const zone = dist <= rippleInner ? 1 : dist >= rippleOuter ? 0 : 1 - (dist - rippleInner) / (rippleOuter - rippleInner);
            const smoothZone = zone * zone * (3 - 2 * zone);
            const rippleWave = 0.5 + 0.5 * Math.sin(offsetX * 0.032 + offsetY * 0.021 - timeSec * config.formRipple.speed);
            const formPulse = reducedMotion ? 1 : 1 - config.formRipple.shimmer * smoothZone * (1 - rippleWave);
            const procPulse = 1 - (1 - formPulse) * 0.28;
            const discShimmer = reducedMotion || shapeVal <= 0.04
              ? 0
              : rippleWave * config.formRipple.amplitude * smoothZone * Math.min(1, (shapeVal - 0.04) / 0.26);

            let beam = 0;
            let beamShaft = 0;
            if (beamWeight > 0.005) {
              const bx = x - lampX;
              const by = y - lampY;
              const bDist = Math.hypot(bx, by);
              const bAngle = Math.atan2(by, bx);
              let diff = Math.abs(bAngle - sweepAngle);
              if (diff > Math.PI) diff = Math.PI * 2 - diff;
              const across = Math.max(0, 1 - diff / halfW);
              const radial = Math.pow(Math.max(0, 1 - bDist / beamReach), 1.35);
              beamShaft = across * (0.35 + 0.65 * across) * radial * beamGain;
              const core = Math.pow(Math.max(0, 1 - bDist / coreReach), 1.6) * coreGain;
              beam = beamShaft + core;
            }

            const simH = waterHeight ? waterHeight[cell] : 0;
            const waterRippleGlow = Math.abs(simH) * 0.42;

            let crest = 0;
            if (y > horizonY) {
              const below = (y - horizonY) / height;
              const eased = Math.min(1, below / config.water.fadeIn);
              const seaFade = eased * eased * (3 - 2 * eased);
              const worldZ = 1 / (below + config.water.nearClip);
              const worldX = (x - width * 0.5) / height * worldZ * config.water.spread;
              let waveH = 0;
              for (const wv of swellWaves) {
                const k = Math.PI * 2 / wv.wavelength;
                const phase = (worldX * Math.cos(wv.angle) + worldZ * Math.sin(wv.angle)) * k - 1.05 * Math.sqrt(k) * timeSec;
                waveH += Math.sin(phase) * wv.amplitude;
              }
              const surface = simH + waveH * seaFade * (reducedMotion ? 0.45 : config.water.amplitude);
              crest = (surface > 0 ? Math.pow(surface, 1.55) * config.water.crestGain * seaFade : 0) * (1 + 0.55 * beamShaft);
            }

            let pointerLum = 0;
            if (pointer.active && !reducedMotion) {
              const pInf = Math.max(0, 1 - Math.hypot(x - pointer.followX, y - pointer.followY) / config.pointerRadius);
              if (pInf > 0) {
                const twinklePhase = createSeededValue(col, row, 9) * Math.PI * 2;
                const twinkle = 0.52 + 0.48 * Math.sin(timeSec * 7.2 + twinklePhase);
                pointerLum = pInf * pInf * 0.82 * twinkle;
              }
            }

            const fishLum = evalFishJs(x, y, fishAnim, fishHeading, fishVySign);

            const splashLum = Math.max(evalSplashJs(x, y, splashTakeoff, time), evalSplashJs(x, y, splashLanding, time));

            let dropletLum = 0;
            for (const d of droplets) {
              const dd = Math.hypot(x - d.x, y - d.y);
              if (dd < 3.2) {
                dropletLum = Math.max(dropletLum, (1 - dd / 3.2) * Math.max(0, 1 - d.age / d.life));
              }
            }

            const shapedForm = Math.max(texShapeVal * formPulse, procShapeVal * procPulse);
            const rawLum = (shapedForm + discShimmer + beam + crest + waterRippleGlow + pointerLum + fishLum + splashLum + dropletLum) *
              Math.min(
                0.22 + 0.78 * rectClearanceJs(x, y, linksRect, 6, 22),
                0.26 + 0.74 * rectClearanceJs(x, y, mottoRect, 6, 16)
              );
            const clamped = Math.min(1, Math.max(0, rawLum));
            const lum = Math.min(1, Math.pow(clamped, theme.lumGamma) * theme.lumScale);
            const threshold = BAYER_4X4[(row & 3) * 4 + (col & 3)];

            if (lum >= threshold) {
              fallbackContext.fillRect(col * gap, row * gap, gap, gap);
            }
          }
        }
      }

      function paint(time) {
        if (useWebGL) {
          paintWebGL(time);
        } else {
          paintFallback(time);
        }
        applyIdentityTransforms(time);
      }

      function loop(time) {
        const dt = lastPaint ? Math.min(0.05, Math.max(0, (time - lastPaint) / 1000)) : PHYSICS_STEP;
        lastPaint = time;

        advanceMorph(time);

        if (pointer.active && !reducedMotion) {
          const travelled = Math.hypot(pointer.x - lastPointerX, pointer.y - lastPointerY);
          if (travelled > 0.5) {
            disturbWater(pointer.x, pointer.y, config.water.pointerImpulse * Math.min(3, travelled / 6));
          }
          lastPointerX = pointer.x;
          lastPointerY = pointer.y;
        }

        physicsAccumulator = Math.min(physicsAccumulator + dt, PHYSICS_STEP * 3);
        while (physicsAccumulator >= PHYSICS_STEP) {
          const smoothing = config.pointerSmoothing;
          pointer.followX += (pointer.x - pointer.followX) * smoothing;
          pointer.followY += (pointer.y - pointer.followY) * smoothing;
          stepWater();
          updateDrag();
          stepIdentityPhysics();
          physicsAccumulator -= PHYSICS_STEP;
        }

        updateFish(time, dt);
        updateDroplets(dt);
        paint(time);

        animationFrame = requestAnimationFrame(loop);
      }

      function deactivatePointer() {
        if (!pointer.active) {
          return;
        }
        pointer.active = false;
      }

      // ---------------------------------------------------------------------------
      // Event Listeners
      // ---------------------------------------------------------------------------

      heading.addEventListener("pointerdown", (event) => {
        if (reducedMotion || event.button > 0) {
          return;
        }

        const character = draggableCharacterAt(event.clientX, event.clientY);
        if (!character) {
          return;
        }

        drag.active = true;
        drag.character = character;
        drag.pointerId = event.pointerId;
        drag.x = character.lagX;
        drag.y = character.lagY;
        drag.originX = event.clientX - drag.x;
        drag.originY = event.clientY - drag.y;
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        drag.vx = 0;
        drag.vy = 0;

        heading.setPointerCapture(event.pointerId);
        heading.classList.add("is-dragging");
        document.documentElement.dataset.drag = "held";
        event.preventDefault();
      });

      heading.addEventListener("pointermove", (event) => {
        if (!drag.active || event.pointerId !== drag.pointerId) {
          return;
        }

        limitDrag(event.clientX - drag.originX, event.clientY - drag.originY);
        drag.vx = event.clientX - drag.lastX;
        drag.vy = event.clientY - drag.lastY;
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
      });

      function releaseHeading() {
        if (!drag.active) {
          return;
        }

        drag.active = false;
        heading.classList.remove("is-dragging");
        document.documentElement.dataset.drag = "free";

        if (drag.pointerId !== null && heading.hasPointerCapture(drag.pointerId)) {
          heading.releasePointerCapture(drag.pointerId);
        }

        drag.pointerId = null;
      }

      heading.addEventListener("pointerup", releaseHeading);
      heading.addEventListener("pointercancel", releaseHeading);
      heading.addEventListener("lostpointercapture", releaseHeading);

      for (const link of document.querySelectorAll(".nav-link[data-form]")) {
        link.addEventListener("pointerenter", () => holdForm(link.dataset.form));
        link.addEventListener("focus", () => holdForm(link.dataset.form));
        link.addEventListener("pointerleave", scheduleRelease);
        link.addEventListener("blur", scheduleRelease);
      }

      themeToggle.addEventListener("click", () => {
        applyTheme(themeName === "dark" ? "paper" : "dark", true);
      });

      lightQuery.addEventListener("change", (event) => {
        if (readStoredTheme()) {
          return;
        }
        applyTheme(event.matches ? "paper" : "dark", false);
      });

      window.addEventListener("pointermove", (event) => {
        if (!pointer.active) {
          pointer.followX = event.clientX;
          pointer.followY = event.clientY;
          lastPointerX = event.clientX;
          lastPointerY = event.clientY;
        }

        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.active = true;
      }, { passive: true });

      document.addEventListener("pointerout", (event) => {
        if (!event.relatedTarget) {
          deactivatePointer();
          releaseForm();
        }
      });

      document.addEventListener("pointerup", (event) => {
        if (event.pointerType !== "mouse") {
          deactivatePointer();
          releaseForm();
        }
      });

      document.addEventListener("pointercancel", () => {
        deactivatePointer();
        releaseForm();
      });

      window.addEventListener("blur", () => {
        deactivatePointer();
        releaseForm();
      });

      window.addEventListener("resize", () => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(resize);
      }, { passive: true });

      window.addEventListener("scroll", measureUiSafeZones, { passive: true });

      document.addEventListener("visibilitychange", () => {
        cancelAnimationFrame(animationFrame);

        if (document.hidden) {
          releaseForm();
        } else if (!reducedMotion) {
          lastPaint = 0;
          physicsAccumulator = 0;
          animationFrame = requestAnimationFrame(loop);
        }
      });

      // ---------------------------------------------------------------------------
      // Bootstrap
      // ---------------------------------------------------------------------------

      attachCanvasListeners();
      useWebGL = initWebGL();
      if (!useWebGL) {
        console.warn("WebGL unavailable; falling back to Canvas 2D Bayer renderer.");
        fallbackContext = canvas.getContext("2d", { alpha: false });
      }

      themeToggle.setAttribute("aria-label", theme.label);
      document.documentElement.dataset.form = forms[toForm].id;
      wrapIdentityTextCharacters();
      resize();
      dwellUntil = performance.now() + config.dwellDuration;
      document.documentElement.dataset.fish = "idle";
      document.documentElement.dataset.drag = "free";
      fish.nextJumpAt = performance.now() + 2600;

      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          measureIdentityCharacters();
          measureUiSafeZones();
          paint(performance.now());
        });
      }

      if (!reducedMotion) {
        animationFrame = requestAnimationFrame(loop);
      }
    })();
