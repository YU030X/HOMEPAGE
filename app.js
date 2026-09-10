    (() => {
      const canvas = document.getElementById("field");
      const context = canvas.getContext("2d", { alpha: false });
      const heading = document.getElementById("name");
      const themeToggle = document.getElementById("theme-toggle");
      const lightQuery = window.matchMedia("(prefers-color-scheme: light)");
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const identityCharacters = [];
      const draggableCharacters = [];
      // followX/followY lag behind the real pointer; the field reads those, so a jittery
      // hand does not produce a jittery page.
      const pointer = { x: -1000, y: -1000, followX: -1000, followY: -1000, active: false };

      const THEME_STORAGE_KEY = "yu030x-theme";

      // Dark ink on a light field reads stronger than light ink on a dark field at the
      // same alpha, so paper scales the whole particle ramp down instead of inverting it.
      const themes = {
        dark: {
          background: "#050606",
          particle: "237, 237, 231",
          alphaScale: 1,
          alphaCap: 0.94,
          label: "Switch to paper theme"
        },
        paper: {
          background: "#eae6dc",
          particle: "35, 36, 33",
          alphaScale: 0.74,
          alphaCap: 0.76,
          label: "Switch to dark theme"
        }
      };

      const config = {
        framesPerSecond: 60,
        desktopGap: 9,
        mobileGap: 10,
        pointerRadius: 52,
        pointerDisplacement: 4,
        // The lit disc around the cursor is what a shaken mouse shakes: it covers about
        // a hundred cells and used to snap to the pointer every frame. Easing it into
        // place turns a flicker into a glow that follows.
        // About 140ms of lag. Past this the jitter barely improves and the glow starts
        // to feel detached from the hand.
        pointerSmoothing: 0.35,
        maximumPixelRatio: 1.5,
        // Both lines ride a swell of their own. The phase runs along each line's x, so
        // the lift travels through the text rather than heaving it as one block. The
        // two are deliberately out of step: matching speeds make them look welded
        // together.
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
          // Damped spring back to where the letter belongs, seeded by the flick you let
          // go with. A plain tween would land dead; the overshoot is what sells weight.
          spring: 0.13,
          damping: 0.82,
          followStiffness: 0.34,
          // A shoved letter drifts home lazily. Give it the same stiffness as the held
          // one and it fights back hard enough to be interpenetrated and popped out
          // the wrong side of its neighbour.
          returnStiffness: 0.1,
          followDamping: 0.66,
          // Soft limit, via tanh: near the origin the letter tracks the pointer almost
          // exactly, and the further you pull the harder it resists, never passing this.
          maxRange: 84,
          // Stretch comes from how fast the letter is having to catch up.
          stretchPerPixel: 0.055,
          maxStretch: 0.72,
          // Letters are treated as ellipses. Packing under 1 leaves a gap at rest, so
          // a letter has to actually be shoved into its neighbour before anything moves.
          collisionPacking: 0.82,
          collisionBounce: 0.2,
          collisionPasses: 3
        },
        dwellDuration: 3900,
        morphDuration: 1050,
        glitchRows: 0.2,
        glitchThrow: 30,
        // A travelling wave through the form's own disc. Without it the shape is a
        // stamp that only moves because the water rocks it.
        formRipple: {
          frequencyX: 0.032,
          frequencyY: 0.021,
          speed: 0.00756,
          amplitude: 0.22,
          reach: 1.18,
          edge: 0.22,
          shimmer: 0.36
        },
        // Fine enough that a step is smaller than what 8-bit compositing can show, so
        // the cache costs nothing in gradation. Coarse steps flatten the particle
        // breathing into visible jumps and the field stops shimmering.
        alphaSteps: 256,
        water: {
          tension: 0.42,
          damping: 0.978,
          // Pulls the surface back to the rest level. The tension term only pulls a
          // cell toward its neighbours, so it has no idea where "level" is: a whole
          // region pushed down together simply stays down. Every disturbance on this
          // page pushes one way only, so without this the swept area sank for good and
          // stopped drawing crests.
          levelling: 0.012,
          // Nothing should reach this, but it makes divergence impossible rather than
          // merely unlikely if the tension is ever tuned past its stable range.
          maxHeight: 2.5,
          pointerImpulse: 0.055,
          pointerReach: 2,
          formSplash: 0.42,
          rippleLift: 6,
          // The sea occupies the lower half and is projected, not flat: screen rows are
          // unprojected to world coordinates before the wave phase is taken, so crests
          // bunch up and shrink toward the horizon the way a real sea does.
          horizon: 0.52,
          depthScale: 1,
          nearClip: 0.019,
          spread: 1.7,
          // Screen displacement at one world unit of distance. Everything is divided by
          // depth, so near swell heaves and distant swell barely stirs.
          lift: 30,
          drift: 20,
          fadeIn: 0.09,
          // Crests are squared before lighting. A linear ramp lights a scattered third
          // of the cells along a crest, which reads as blotches; squaring tightens the
          // peaks and empties the troughs so the swell resolves into ridges.
          crestGain: 1.15,
          amplitude: 0.9
        }
      };

      // The tower is drawn at this scale, and the beam is cast from this point in the
      // tower's own coordinates. Both have to move together or the light detaches from
      // the lamp room.
      const LIGHTHOUSE_SCALE = 1.34;
      const LIGHTHOUSE_LAMP = -0.89;

      // Where the form stands. Was previously repeated in three places; moving it means
      // moving the mask, the ripple disc and the beam's lamp together or they detach.
      const FORM_CENTER_X = 0.63;
      const FORM_CENTER_X_NARROW = 0.7;
      const FORM_CENTER_Y = 0.46;

      function formCenterX() {
        return width * (width < 760 ? FORM_CENTER_X_NARROW : FORM_CENTER_X);
      }

      // A lighthouse turns in a horizontal plane, so from the side the shaft swings
      // left and right and flares when it comes round to face you. Rotating the shaft
      // through screen angles instead sends it off the top of the page for half of
      // every turn and buries it in the sea for the other half.
      const beamConfig = {
        // Radians per second. Slow enough to read as a sweep rather than a strobe.
        speed: 0.62,
        halfWidth: 0.115,
        reach: 3.1,
        // Has to clear the "bright particle" threshold along most of its length. At a
        // lower gain the beam only lights a scattered fraction of the cells and reads
        // as haze around the tower instead of a shaft of light.
        gain: 1.3,
        // How far the shaft dips below horizontal. Shallow, so it runs a long way over
        // the water before it reaches the sea and gets lost in the crests.
        tilt: 0.22,
        // The lamp itself, and the bloom when the beam points at the viewer.
        lampGain: 0.85,
        flareGain: 1.5,
        coreReach: 0.34
      };

      const fishConfig = {
        minDelay: 9000,
        maxDelay: 22000,
        gravity: 1450,
        riseMin: 85,
        riseMax: 170,
        driftMin: 45,
        driftMax: 140,
        length: 0.3,
        angles: 16,
        dropletMax: 44,
        dropletPerSplash: 10,
        dropletSpeed: 175,
        dropletGravity: 900,
        dropletLife: 1100,
        splashImpulse: 0.5
      };

      // Wavelengths are world units now, not pixels. One dominant swell rolling toward
      // the viewer, a near-parallel companion, and a little cross chop; three equally
      // weighted directions would interfere into blobs instead of reading as a sea.
      const swellWaves = [
        { angle: 1.4, wavelength: 2.3, amplitude: 1 },
        { angle: 1.13, wavelength: 1.35, amplitude: 0.42 },
        { angle: 0.42, wavelength: 0.62, amplitude: 0.18 }
      ];

      // Every form is stroked into a one-pixel-per-cell mask and cached as an intensity
      // grid, so morphing is a lerp between two arrays and shape complexity costs
      // nothing at frame time. Ambient forms cycle; the rest belong to a link.
      const forms = [
        { id: "lighthouse", ambient: true, draw: drawLighthouse },
        { id: "book", ambient: false, draw: drawBook },
        { id: "chevron", ambient: false, draw: drawChevron },
        { id: "fork", ambient: false, draw: drawFork }
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
      let columns = 0;
      let rows = 0;
      let animationFrame = 0;
      let lastPaint = 0;
      let resizeFrame = 0;
      let themeName = themes[document.documentElement.dataset.theme] ? document.documentElement.dataset.theme : "dark";
      let theme = themes[themeName];

      // Per-cell constants, lifted out of the paint loop. Recomputing these every frame
      // cost tens of thousands of Math.sin calls for values that never change.
      let sampleField = null;
      let breathingPhaseField = null;
      let particleStyles = null;
      let rasterKey = "";

      // The surface is two things added together: an analytic swell that never decays,
      // and a simulated layer that carries whatever gets dropped into it.
      let waterHeight = null;
      let waterVelocity = null;
      let swellEnvelope = null;
      let crestEnvelope = null;
      let ripplePhaseSin = null;
      let ripplePhaseCos = null;
      let rippleZone = null;

      // Angle and falloff from the lamp, tabulated once so the rotating beam costs a
      // subtract and a compare per cell instead of an atan2.
      let beamAngleField = null;
      let beamFalloffField = null;
      let beamCoreField = null;
      let beamWeight = 0;
      let sourceBeamWeight = 0;

      let fishSprites = [];
      let fishSpriteSize = 0;
      const fish = { active: false, x: 0, y: 0, vx: 0, vy: 0, surfaceY: 0, nextJumpAt: 0 };
      const droplets = [];

      // Which letter is being dragged, where it has been pulled to, and how fast it was
      // moving when let go. Only one letter moves at a time.
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
      let swellPhaseSin = [];
      let swellPhaseCos = [];
      let lastPointerX = 0;
      let lastPointerY = 0;

      // The morph reads from a buffer rather than a second form index, so a morph that
      // is interrupted can carry on from the field actually on screen.
      let sourceField = null;
      let toForm = 0;
      let morphStart = -Infinity;
      let blend = 1;
      let dwellUntil = 0;
      let ambientCursor = 0;
      let heldForm = null;

      function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      }

      function currentGap() {
        return width < 760 ? config.mobileGap : config.desktopGap;
      }

      // The ambient forms are solid silhouettes rather than outlines. An outline turns
      // every stroke of a recognisable object into a hollow double line, and at this
      // grid resolution the object stops being readable.
      //
      // Each one is given the waterline in its own coordinates so it can sit on the
      // sea rather than float at an arbitrary height.

      // A signal tower, which is what the page calls itself. The banding is what makes
      // a lighthouse read instantly, so it is punched back out of the tower.
      //
      // The beam is not drawn here. It rotates, and forms are rasterised once per
      // resize, so it lives in the paint loop instead. LIGHTHOUSE_LAMP is where the
      // two have to agree.
      function drawLighthouse(ctx, radius, waterline) {
        const r = radius * LIGHTHOUSE_SCALE;
        const base = waterline;

        // There is no headroom left above the form centre, so the tower is made to
        // look like a tower by narrowing rather than by growing. A wide short cone
        // reads as a traffic bollard.
        ctx.beginPath();
        ctx.moveTo(-0.27 * r, base);
        ctx.lineTo(-0.14 * r, -0.7 * r);
        ctx.lineTo(0.14 * r, -0.7 * r);
        ctx.lineTo(0.27 * r, base);
        ctx.closePath();
        ctx.fill();

        // Do not erase the bands completely: disconnected blocks read as a stack of
        // boxes at this resolution. Partial erasure keeps the taper continuous.
        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = 0.72;

        for (const band of [-0.52, -0.24, 0.04]) {
          ctx.beginPath();
          ctx.rect(-0.3 * r, band * r, 0.6 * r, 0.085 * r);
          ctx.fill();
        }

        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;

        // Balcony slab, rail and posts. The slab overhangs the tower, which is what
        // separates the lamp room from the shaft.
        ctx.beginPath();
        ctx.rect(-0.24 * r, -0.78 * r, 0.48 * r, 0.08 * r);
        ctx.fill();

        ctx.lineWidth = 0.04 * r;
        ctx.beginPath();
        ctx.moveTo(-0.24 * r, -0.86 * r);
        ctx.lineTo(0.24 * r, -0.86 * r);
        ctx.moveTo(-0.2 * r, -0.86 * r);
        ctx.lineTo(-0.2 * r, -0.78 * r);
        ctx.moveTo(0.2 * r, -0.86 * r);
        ctx.lineTo(0.2 * r, -0.78 * r);
        ctx.stroke();

        ctx.beginPath();
        ctx.rect(-0.15 * r, -1 * r, 0.3 * r, 0.22 * r);
        ctx.fill();

        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = 0.72;
        ctx.beginPath();
        ctx.rect(-0.06 * r, -0.95 * r, 0.12 * r, 0.11 * r);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;

        ctx.beginPath();
        ctx.moveTo(-0.21 * r, -1 * r);
        ctx.lineTo(0, -1.15 * r);
        ctx.lineTo(0.21 * r, -1 * r);
        ctx.closePath();
        ctx.fill();

        // The rock it stands on, wider than the tower so the tower reads as slender.
        ctx.beginPath();
        ctx.moveTo(-0.5 * r, base);
        ctx.quadraticCurveTo(-0.3 * r, base - 0.19 * r, 0, base - 0.13 * r);
        ctx.quadraticCurveTo(0.3 * r, base - 0.19 * r, 0.5 * r, base);
        ctx.closePath();
        ctx.fill();
      }

      // An open book for the blog. Stroked like the other link forms: a filled book
      // collapses into a blob at this grid resolution, while the cover curve and the
      // spine stay readable. The page tops bow upward away from the spine, which is
      // what separates an open book from a folded card.
      function drawBook(ctx, radius) {
        const r = radius;
        const outerX = r * 0.88;
        const spineTop = -r * 0.5;
        const spineBottom = r * 0.64;

        ctx.lineWidth = 2.4;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        // Cover: two page blocks curving out of the spine.
        ctx.beginPath();
        ctx.moveTo(0, spineTop);
        ctx.quadraticCurveTo(-r * 0.45, -r * 0.72, -outerX, -r * 0.54);
        ctx.lineTo(-outerX, r * 0.42);
        ctx.quadraticCurveTo(-r * 0.45, r * 0.24, 0, spineBottom);
        ctx.moveTo(0, spineTop);
        ctx.quadraticCurveTo(r * 0.45, -r * 0.72, outerX, -r * 0.54);
        ctx.lineTo(outerX, r * 0.42);
        ctx.quadraticCurveTo(r * 0.45, r * 0.24, 0, spineBottom);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, spineTop);
        ctx.lineTo(0, spineBottom);
        ctx.stroke();

        // Lines of type, kept short of the cover edges and tilted with the page bow.
        ctx.lineWidth = 1.7;

        for (const fraction of [-0.28, -0.08, 0.12]) {
          const y = r * fraction;
          ctx.beginPath();
          ctx.moveTo(-r * 0.68, y);
          ctx.lineTo(-r * 0.16, y - r * 0.04);
          ctx.moveTo(r * 0.16, y - r * 0.04);
          ctx.lineTo(r * 0.68, y);
          ctx.stroke();
        }
      }

      // Echoes the ">" that marks the focused link.
      function drawChevron(ctx, radius) {
        ctx.lineWidth = 2.2;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";

        ctx.beginPath();
        ctx.moveTo(-radius * 0.42, -radius * 0.78);
        ctx.lineTo(radius * 0.52, 0);
        ctx.lineTo(-radius * 0.42, radius * 0.78);
        ctx.stroke();

        ctx.globalAlpha = 0.42;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-radius * 0.98, -radius * 0.52);
        ctx.lineTo(-radius * 0.35, 0);
        ctx.lineTo(-radius * 0.98, radius * 0.52);
        ctx.stroke();
      }

      function drawFork(ctx, radius) {
        const trunkX = -radius * 0.4;
        const branchX = radius * 0.44;
        const topNodeY = -radius * 0.62;
        const bottomNodeY = radius * 0.68;
        const junctionY = radius * 0.18;
        const nodeRadius = Math.max(3.8, radius * 0.085);

        // The two upper hollow nodes share one baseline. Paths stop at each node's
        // edge so the connector never fills or crosses the empty centres.
        ctx.lineWidth = 2.8;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        ctx.beginPath();
        ctx.moveTo(trunkX, bottomNodeY - nodeRadius);
        ctx.lineTo(trunkX, topNodeY + nodeRadius);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(trunkX, junctionY);
        ctx.bezierCurveTo(
          trunkX,
          -radius * 0.12,
          branchX,
          -radius * 0.12,
          branchX,
          topNodeY + nodeRadius
        );
        ctx.stroke();

        for (const node of [[trunkX, topNodeY], [branchX, topNodeY], [trunkX, bottomNodeY]]) {
          ctx.beginPath();
          ctx.arc(node[0], node[1], nodeRadius, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      function buildParticleStyles() {
        particleStyles = new Array(config.alphaSteps + 1);

        for (let step = 0; step <= config.alphaSteps; step += 1) {
          const alpha = theme.alphaCap * step / config.alphaSteps;
          particleStyles[step] = `rgba(${theme.particle}, ${alpha.toFixed(4)})`;
        }
      }

      function buildCellConstants() {
        const cells = columns * rows;
        sampleField = new Float32Array(cells);
        breathingPhaseField = new Float32Array(cells);

        for (let row = 0; row < rows; row += 1) {
          const rowBase = row * columns;

          for (let column = 0; column < columns; column += 1) {
            sampleField[rowBase + column] = createSeededValue(column, row, 1);
            breathingPhaseField[rowBase + column] = createSeededValue(column, row, 2) * Math.PI * 2;
          }
        }
      }

      // Each swell is a plane wave sin(phase - wt). Splitting it with the angle sum
      // identity lets the per-cell phase be tabulated once, so the paint loop needs no
      // trigonometry at all: three swells would otherwise cost millions of sin calls a
      // second, which is the whole frame budget.
      function buildSwellTables() {
        const cells = columns * rows;
        const gap = currentGap();
        const sea = config.water;
        const horizonY = height * sea.horizon;
        const viewX = width * 0.5;

        swellPhaseSin = [];
        swellPhaseCos = [];
        swellEnvelope = new Float32Array(cells);
        crestEnvelope = new Float32Array(cells);

        // Unproject a screen cell onto the water plane. Rows just under the horizon map
        // to great distances, which is what compresses the crests up there.
        const worldDepthAt = (y) => sea.depthScale / ((y - horizonY) / height + sea.nearClip);

        for (const wave of swellWaves) {
          const waveNumber = Math.PI * 2 / wave.wavelength;
          const directionX = Math.cos(wave.angle);
          const directionZ = Math.sin(wave.angle);
          const sinTable = new Float32Array(cells);
          const cosTable = new Float32Array(cells);

          for (let row = 0; row < rows; row += 1) {
            const y = gap / 2 + row * gap;
            const rowBase = row * columns;

            if (y <= horizonY) {
              cosTable.fill(1, rowBase, rowBase + columns);
              continue;
            }

            const worldZ = worldDepthAt(y);

            for (let column = 0; column < columns; column += 1) {
              const x = gap / 2 + column * gap;
              const worldX = (x - viewX) / height * worldZ * sea.spread;
              const phase = (worldX * directionX + worldZ * directionZ) * waveNumber;

              sinTable[rowBase + column] = Math.sin(phase);
              cosTable[rowBase + column] = Math.cos(phase);
            }
          }

          wave.waveNumber = waveNumber;
          wave.directionX = directionX;
          wave.directionZ = directionZ;
          // Deep water disperses as w proportional to sqrt(k), so long swells outrun
          // short chop and the three layers keep sliding out of phase with each other.
          wave.angularSpeed = 1.05 * Math.sqrt(waveNumber);
          swellPhaseSin.push(sinTable);
          swellPhaseCos.push(cosTable);
        }

        for (let row = 0; row < rows; row += 1) {
          const y = gap / 2 + row * gap;
          const start = row * columns;
          const end = start + columns;

          if (y <= horizonY) {
            continue;
          }

          const belowHorizon = (y - horizonY) / height;
          const eased = Math.min(1, belowHorizon / sea.fadeIn);
          const fade = eased * eased * (3 - 2 * eased);
          const worldZ = worldDepthAt(y);

          // Brightness follows the fade only; screen displacement also divides by depth
          // so distant swell stays small no matter how hard the near swell heaves.
          crestEnvelope.fill(fade, start, end);
          swellEnvelope.fill(fade / worldZ, start, end);
        }

        waterHeight = new Float32Array(cells);
        waterVelocity = new Float32Array(cells);
      }

      // Spatial phase of the form ripple, plus how strongly each cell belongs to the
      // form's own disc. Same angle sum trick as the swell, so the paint loop stays
      // free of trigonometry.
      function buildRippleTables() {
        const cells = columns * rows;
        const gap = currentGap();
        const ripple = config.formRipple;
        const centerX = formCenterX();
        const centerY = height * FORM_CENTER_Y;
        const radius = Math.min(width, height) * (width < 760 ? 0.24 : 0.29);
        const outer = radius * ripple.reach;
        const inner = outer * (1 - ripple.edge);

        ripplePhaseSin = new Float32Array(cells);
        ripplePhaseCos = new Float32Array(cells);
        rippleZone = new Float32Array(cells);

        for (let row = 0; row < rows; row += 1) {
          const y = gap / 2 + row * gap;
          const rowBase = row * columns;

          for (let column = 0; column < columns; column += 1) {
            const x = gap / 2 + column * gap;
            const cell = rowBase + column;
            const offsetX = x - centerX;
            const offsetY = y - centerY;
            const phase = offsetX * ripple.frequencyX + offsetY * ripple.frequencyY;

            ripplePhaseSin[cell] = Math.sin(phase);
            ripplePhaseCos[cell] = Math.cos(phase);

            const distance = Math.hypot(offsetX, offsetY);
            const falloff = distance <= inner
              ? 1
              : distance >= outer
                ? 0
                : 1 - (distance - inner) / (outer - inner);

            rippleZone[cell] = falloff * falloff * (3 - 2 * falloff);
          }
        }
      }

      // Height and velocity per cell, each cell pulled toward the average of its four
      // neighbours. Edges read themselves, which reflects a ripple instead of eating it.
      function stepWater() {
        if (reducedMotion || !waterHeight) {
          return;
        }

        const { tension, damping, levelling, maxHeight } = config.water;

        for (let row = 0; row < rows; row += 1) {
          const rowBase = row * columns;
          const aboveBase = row > 0 ? rowBase - columns : rowBase;
          const belowBase = row < rows - 1 ? rowBase + columns : rowBase;

          for (let column = 0; column < columns; column += 1) {
            const cell = rowBase + column;
            const left = column > 0 ? cell - 1 : cell;
            const right = column < columns - 1 ? cell + 1 : cell;
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
        if (reducedMotion || !waterHeight) {
          return;
        }

        const gap = currentGap();
        const centerColumn = Math.round((x - gap / 2) / gap);
        const centerRow = Math.round((y - gap / 2) / gap);
        const reach = config.water.pointerReach;

        for (let row = centerRow - reach; row <= centerRow + reach; row += 1) {
          if (row < 0 || row >= rows) {
            continue;
          }

          for (let column = centerColumn - reach; column <= centerColumn + reach; column += 1) {
            if (column < 0 || column >= columns) {
              continue;
            }

            const distance = Math.hypot(column - centerColumn, row - centerRow);

            if (distance > reach) {
              continue;
            }

            const falloff = 1 - distance / (reach + 1);
            waterVelocity[row * columns + column] -= strength * falloff * falloff;
          }
        }
      }

      // A new form arrives by landing in the water rather than cross-fading in.
      function splashForm(index) {
        if (reducedMotion || !waterHeight) {
          return;
        }

        const field = forms[index].field;
        const strength = config.water.formSplash;

        for (let cell = 0; cell < waterHeight.length; cell += 1) {
          waterHeight[cell] += field[cell] * strength;
        }
      }

      // Angle from the lamp to every cell, plus how far the light carries. Tabulating
      // the angle is what keeps a rotating beam affordable: the paint loop only has to
      // subtract the current sweep angle and compare.
      function buildBeamTables() {
        const cells = columns * rows;
        const gap = currentGap();
        const centerX = formCenterX() / gap;
        const centerY = (height * FORM_CENTER_Y) / gap;
        const radius = Math.min(width, height) * (width < 760 ? 0.24 : 0.29) / gap;
        const lampX = centerX;
        const lampY = centerY + LIGHTHOUSE_LAMP * radius * LIGHTHOUSE_SCALE;
        const reach = radius * beamConfig.reach;
        const coreReach = radius * beamConfig.coreReach;

        beamAngleField = new Float32Array(cells);
        beamFalloffField = new Float32Array(cells);
        beamCoreField = new Float32Array(cells);

        for (let row = 0; row < rows; row += 1) {
          const rowBase = row * columns;

          for (let column = 0; column < columns; column += 1) {
            const cell = rowBase + column;
            const offsetX = column + 0.5 - lampX;
            const offsetY = row + 0.5 - lampY;
            const distance = Math.hypot(offsetX, offsetY);

            beamAngleField[cell] = Math.atan2(offsetY, offsetX);
            beamFalloffField[cell] = Math.max(0, 1 - distance / reach);
            beamCoreField[cell] = Math.max(0, 1 - distance / coreReach);
          }
        }
      }

      // Sixteen pre-rotated stamps. The fish turns as it arcs, and re-rasterising a
      // rotated path every frame would cost far more than 24KB of sprites.
      function buildFishSprites() {
        const gap = currentGap();
        const radius = Math.min(width, height) * (width < 760 ? 0.24 : 0.29) / gap;
        const length = Math.max(5, radius * fishConfig.length);
        const size = Math.ceil(length * 1.25) | 1;
        const half = size / 2;

        const sprite = document.createElement("canvas");
        sprite.width = size;
        sprite.height = size;
        const spriteContext = sprite.getContext("2d", { willReadFrequently: true });

        fishSpriteSize = size;
        fishSprites = [];

        for (let step = 0; step < fishConfig.angles; step += 1) {
          const angle = (step / fishConfig.angles) * Math.PI * 2;

          spriteContext.setTransform(1, 0, 0, 1, 0, 0);
          spriteContext.clearRect(0, 0, size, size);
          spriteContext.fillStyle = "#ffffff";
          spriteContext.translate(half, half);
          spriteContext.rotate(angle);

          const bodyLength = length * 0.62;
          const bodyHeight = length * 0.26;

          spriteContext.beginPath();
          spriteContext.ellipse(bodyLength * 0.1, 0, bodyLength * 0.5, bodyHeight * 0.5, 0, 0, Math.PI * 2);
          spriteContext.fill();

          spriteContext.beginPath();
          spriteContext.moveTo(-bodyLength * 0.34, 0);
          spriteContext.lineTo(-bodyLength * 0.78, -bodyHeight * 0.72);
          spriteContext.lineTo(-bodyLength * 0.62, 0);
          spriteContext.lineTo(-bodyLength * 0.78, bodyHeight * 0.72);
          spriteContext.closePath();
          spriteContext.fill();

          spriteContext.beginPath();
          spriteContext.moveTo(-bodyLength * 0.02, -bodyHeight * 0.42);
          spriteContext.lineTo(bodyLength * 0.12, -bodyHeight * 0.95);
          spriteContext.lineTo(bodyLength * 0.24, -bodyHeight * 0.4);
          spriteContext.closePath();
          spriteContext.fill();

          const alpha = spriteContext.getImageData(0, 0, size, size).data;
          const field = new Float32Array(size * size);

          for (let cell = 0; cell < field.length; cell += 1) {
            field[cell] = alpha[cell * 4 + 3] / 255;
          }

          fishSprites.push(field);
        }
      }

      function spawnDroplets(x, y, upward) {
        if (reducedMotion) {
          return;
        }

        for (let index = 0; index < fishConfig.dropletPerSplash; index += 1) {
          if (droplets.length >= fishConfig.dropletMax) {
            break;
          }

          const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.1;
          const speed = fishConfig.dropletSpeed * (0.35 + Math.random() * 0.65) * upward;

          droplets.push({
            x: x + (Math.random() - 0.5) * 10,
            y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: fishConfig.dropletLife * (0.5 + Math.random() * 0.5),
            age: 0
          });
        }
      }

      function scheduleFish(time) {
        fish.nextJumpAt = time + fishConfig.minDelay + Math.random() * (fishConfig.maxDelay - fishConfig.minDelay);
      }

      function launchFish(time) {
        const horizonY = height * config.water.horizon;
        const surfaceY = horizonY + (height - horizonY) * (0.34 + Math.random() * 0.5);
        const rise = fishConfig.riseMin + Math.random() * (fishConfig.riseMax - fishConfig.riseMin);
        const direction = Math.random() < 0.5 ? -1 : 1;

        fish.active = true;
        fish.surfaceY = surfaceY;
        fish.x = width * (0.12 + Math.random() * 0.76);
        fish.y = surfaceY;
        fish.vy = -Math.sqrt(2 * fishConfig.gravity * rise);
        fish.vx = direction * (fishConfig.driftMin + Math.random() * (fishConfig.driftMax - fishConfig.driftMin));

        // Written on transitions only. Cheap, and it gives the tests something to
        // assert against for behaviour that no screenshot can show.
        document.documentElement.dataset.fish = "airborne";
        spawnDroplets(fish.x, surfaceY, 1);
        disturbWater(fish.x, surfaceY, fishConfig.splashImpulse);
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

        fish.vy += fishConfig.gravity * deltaSeconds;
        fish.x += fish.vx * deltaSeconds;
        fish.y += fish.vy * deltaSeconds;

        if (fish.vy > 0 && fish.y >= fish.surfaceY) {
          fish.active = false;
          document.documentElement.dataset.fish = "idle";
          spawnDroplets(fish.x, fish.surfaceY, 0.85);
          disturbWater(fish.x, fish.surfaceY, fishConfig.splashImpulse * 1.15);
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

      function rasterizeForms() {
        const gap = currentGap();
        const centerX = formCenterX() / gap;
        const centerY = (height * FORM_CENTER_Y) / gap;
        const radius = Math.min(width, height) * (width < 760 ? 0.24 : 0.29) / gap;
        // Where the sea starts, in each form's own coordinates, so a form can stand on
        // the water instead of floating at an arbitrary height.
        const waterline = (height * config.water.horizon) / gap - centerY;

        maskCanvas.width = columns;
        maskCanvas.height = rows;

        for (const form of forms) {
          maskContext.setTransform(1, 0, 0, 1, 0, 0);
          maskContext.clearRect(0, 0, columns, rows);
          maskContext.globalAlpha = 1;
          maskContext.globalCompositeOperation = "source-over";
          maskContext.strokeStyle = "#ffffff";
          maskContext.fillStyle = "#ffffff";
          maskContext.lineWidth = 1;
          maskContext.lineCap = "butt";
          maskContext.lineJoin = "miter";
          maskContext.translate(centerX, centerY);
          form.draw(maskContext, radius, waterline);

          const alpha = maskContext.getImageData(0, 0, columns, rows).data;
          const field = new Float32Array(columns * rows);

          for (let cell = 0; cell < field.length; cell += 1) {
            field[cell] = alpha[cell * 4 + 3] / 255;
          }

          form.field = field;
        }

        // A resize reshapes every grid, so any morph in flight is abandoned rather
        // than carried across two incompatible cell layouts.
        sourceField = Float32Array.from(forms[toForm].field);
        sourceBeamWeight = forms[toForm].id === "lighthouse" ? 1 : 0;
        beamWeight = sourceBeamWeight;
        blend = 1;
      }

      function setForm(index, time) {
        if (index === toForm || !sourceField) {
          return;
        }

        // Freeze what is on screen into the morph origin. Without this an interrupted
        // morph would restart from a target it never reached and the field would jump.
        const previousTarget = forms[toForm].field;
        const settled = easeInOutCubic(blend);

        if (settled >= 1) {
          sourceField.set(previousTarget);
        } else if (settled > 0) {
          for (let cell = 0; cell < sourceField.length; cell += 1) {
            sourceField[cell] += (previousTarget[cell] - sourceField[cell]) * settled;
          }
        }

        // The beam has to fade with the tower it belongs to, and an interrupted morph
        // has to carry the beam from whatever it is showing now, same as the field.
        sourceBeamWeight = beamWeight;
        toForm = index;
        morphStart = time;
        blend = reducedMotion ? 1 : 0;
        document.documentElement.dataset.form = forms[index].id;
        splashForm(index);

        if (reducedMotion) {
          sourceField.set(forms[toForm].field);
          paint(performance.now());
        }
      }

      function advanceMorph(time) {
        if (blend < 1) {
          blend = Math.min(1, (time - morphStart) / config.morphDuration);

          if (blend >= 1) {
            sourceField.set(forms[toForm].field);
            sourceBeamWeight = forms[toForm].id === "lighthouse" ? 1 : 0;
            dwellUntil = time + config.dwellDuration;
          }

          return;
        }

        if (heldForm !== null || reducedMotion) {
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

        // A fresh hold cancels any release still waiting out its grace period, so
        // crossing from one link straight onto the next morphs form-to-form instead
        // of flashing the lighthouse in between.
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

      // pointerleave on one link fires before pointerenter on the next. Releasing
      // immediately would snap the field back to the lighthouse for a beat between
      // adjacent hovers, so the release waits a short grace period; a new hold (or
      // an outright pointer exit) cancels or pre-empts it.
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
        buildParticleStyles();

        if (persist) {
          try {
            localStorage.setItem(THEME_STORAGE_KEY, name);
          } catch (error) {
            // Storage can be unavailable; the theme still applies for this visit.
          }
        }

        // Repainted directly because the loop does not run under reduced motion.
        paint(performance.now());
      }

      function createSeededValue(horizontalIndex, verticalIndex, offset = 0) {
        const value = Math.sin(
          horizontalIndex * 12.9898 +
          verticalIndex * 78.233 +
          offset * 37.719
        ) * 43758.5453;

        return value - Math.floor(value);
      }

      function wrapIdentityTextCharacters() {
        // Both lines drift; only the name can be grabbed and pulled out of shape.
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

      // getBoundingClientRect() reports the transformed box, so measuring during the
      // paint loop would feed each character's own displacement back into its input.
      // Centres are stored document-relative to survive scrolling on narrow layouts.
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

      // Letters shove each other aside. Only a handful of bodies, so every pair is
      // tested; the ellipse test is done in a normalised space where both radii become
      // one, which keeps tall thin glyphs from behaving like big circles.
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

              // Letters must not swap places. If a dragged letter has been carried past
              // its neighbour's centre the separation normal flips, and the neighbour
              // gets ejected out of the wrong side of the word.
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

              // A held letter does not give ground; the pointer owns it.
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

      // Released, the letter springs back to where it belongs, carrying whatever speed
      // it was let go with. Held, the pointer owns its position outright.
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

      // Pulled past maxRange the letter keeps moving but gives less and less, so the
      // limit is felt as resistance rather than as hitting a wall.
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

      // Every character carries two things: a standing drift of its own, and a lagged
      // chase after wherever the name has been dragged. They are summed into one
      // transform, and the string is only written when it actually changes.
      function updateIdentityCharacters(time) {
        if (reducedMotion) {
          resetIdentityTextTransforms();
          return;
        }

        const settings = config.drag;

        // Springs first, then collisions, so a letter shoved this frame is not undone
        // by its own spring before it is drawn.
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

        for (const character of identityCharacters) {
          let offsetX = character.lagX;
          let offsetY = character.lagY;
          let rotation = 0;
          let stretch = 0;
          let stretchAngle = 0;

          // Purely visual: the drift is not fed back into lagX/lagY, so collisions and
          // the drag spring stay unaware of it and cannot be shaken loose by it.
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
            // Scaling along an arbitrary axis: rotate the axis onto x, scale, rotate
            // back. Squashing the other way keeps the glyph from just getting fatter.
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

      function resize() {
        width = window.innerWidth;
        height = window.innerHeight;

        const gap = currentGap();
        columns = Math.max(1, Math.ceil((width - gap / 2) / gap));
        rows = Math.max(1, Math.ceil((height - gap / 2) / gap));

        const maximumPixelRatio = width < 760 ? 1 : config.maximumPixelRatio;
        const devicePixelRatio = Math.min(window.devicePixelRatio || 1, maximumPixelRatio);

        canvas.width = Math.round(width * devicePixelRatio);
        canvas.height = Math.round(height * devicePixelRatio);
        context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

        // Rasterising every form redraws a CJK glyph and reads back six bitmaps, so it
        // is skipped when a resize event does not actually change the grid.
        const nextRasterKey = `${columns}x${rows}x${Math.round(width)}x${Math.round(height)}`;

        if (nextRasterKey !== rasterKey) {
          rasterKey = nextRasterKey;
          buildCellConstants();
          buildSwellTables();
          buildRippleTables();
          buildBeamTables();
          buildFishSprites();
          rasterizeForms();
        }

        measureIdentityCharacters();
        paint(performance.now());
      }

      function paint(time) {
        context.fillStyle = theme.background;
        context.fillRect(0, 0, width, height);

        const gap = currentGap();
        const toField = forms[toForm].field;

        if (!sourceField || !toField || !sampleField || !particleStyles) {
          return;
        }

        const mix = easeInOutCubic(blend);
        const morphing = blend < 1;
        // Peaks at the halfway point of a morph and is zero outside it.
        const turbulence = morphing ? Math.max(0, 1 - Math.abs(blend - 0.5) / 0.24) : 0;
        const glitchSeed = Math.floor(time / 70);
        const backgroundThreshold = 0.045 + turbulence * 0.05;

        // The pointer reaches only a handful of cells, so its window is resolved once
        // per frame instead of running the distance test on all of them.
        const pointerLive = pointer.active && !reducedMotion;
        const pointerFirstColumn = pointerLive ? Math.floor((pointer.followX - config.pointerRadius - gap / 2) / gap) : 1;
        const pointerLastColumn = pointerLive ? Math.ceil((pointer.followX + config.pointerRadius - gap / 2) / gap) : 0;
        const pointerFirstRow = pointerLive ? Math.floor((pointer.followY - config.pointerRadius - gap / 2) / gap) : 1;
        const pointerLastRow = pointerLive ? Math.ceil((pointer.followY + config.pointerRadius - gap / 2) / gap) : 0;

        const alphaSteps = config.alphaSteps;
        const alphaCap = theme.alphaCap;
        const alphaScale = theme.alphaScale;
        let activeStyleStep = -1;

        // One pair of trig calls per swell for the whole frame. Everything the cells
        // need after this is a multiply and an add against the tabulated phase.
        const water = config.water;
        const swellCount = swellPhaseSin.length;
        const swellClockCos = [];
        const swellClockSin = [];
        for (let wave = 0; wave < swellCount; wave += 1) {
          const angle = swellWaves[wave].angularSpeed * time * 0.001;
          swellClockCos.push(Math.cos(angle));
          swellClockSin.push(Math.sin(angle));
        }

        const seaAmplitude = reducedMotion ? 0 : water.amplitude;

        // The sweep angle keeps advancing whether or not the tower is on screen, so the
        // light is already mid-rotation when the lighthouse morphs in.
        beamWeight = sourceBeamWeight + ((forms[toForm].id === "lighthouse" ? 1 : 0) - sourceBeamWeight) * mix;
        const beamLive = beamWeight > 0.01 && beamAngleField !== null;

        // The lamp turns in a horizontal plane. Only its horizontal component maps to a
        // screen direction; the component pointing at the viewer becomes a bloom.
        const turn = reducedMotion ? 0.8 : time * 0.001 * beamConfig.speed;
        const towardViewer = Math.sin(turn);
        const facing = Math.max(0, towardViewer);
        const sweepAngle = Math.atan2(beamConfig.tilt, Math.cos(turn));
        const beamHalfWidth = beamConfig.halfWidth * (1 + 0.85 * facing);
        const beamGain = beamConfig.gain * beamWeight * Math.max(0, 0.22 + 0.78 * towardViewer);
        const beamCoreGain = beamWeight * (beamConfig.lampGain + beamConfig.flareGain * facing * facing);

        const ripple = config.formRipple;
        const rippleAngle = reducedMotion ? 0 : time * ripple.speed;
        const rippleClockCos = Math.cos(rippleAngle);
        const rippleClockSin = Math.sin(rippleAngle);
        const rippleAmplitude = reducedMotion ? 0 : ripple.amplitude;
        const shimmer = reducedMotion ? 0 : ripple.shimmer;

        for (let row = 0; row < rows; row += 1) {
          const y = gap / 2 + row * gap;
          const rowBase = row * columns;

          let rowShift = 0;

          if (turbulence > 0 && createSeededValue(row, glitchSeed, 3) < config.glitchRows * turbulence) {
            rowShift = (createSeededValue(row, glitchSeed, 4) - 0.5) * config.glitchThrow * turbulence;
          }

          const rowInPointerRange = row >= pointerFirstRow && row <= pointerLastRow;

          for (let column = 0; column < columns; column += 1) {
            const x = gap / 2 + column * gap;
            const cell = rowBase + column;
            const shapeValue = mix === 0
              ? sourceField[cell]
              : mix === 1
                ? toField[cell]
                : sourceField[cell] + (toField[cell] - sourceField[cell]) * mix;

            let pointerInfluence = 0;
            let pointerOffsetX = 0;
            let pointerOffsetY = 0;

            if (rowInPointerRange && column >= pointerFirstColumn && column <= pointerLastColumn) {
              const toPointerX = x - pointer.followX;
              const toPointerY = y - pointer.followY;
              const distance = Math.hypot(toPointerX, toPointerY);

              if (distance < config.pointerRadius) {
                const safeDistance = Math.max(distance, 0.001);
                pointerInfluence = 1 - distance / config.pointerRadius;

                const displacement = pointerInfluence * pointerInfluence * config.pointerDisplacement;
                pointerOffsetX = toPointerX / safeDistance * displacement;
                pointerOffsetY = toPointerY / safeDistance * displacement;
              }
            }

            let surface = waterHeight[cell];
            let driftX = 0;
            let driftY = 0;

            const seaFade = crestEnvelope[cell];

            if (seaAmplitude > 0 && seaFade > 0) {
              let waveHeight = 0;
              let alongWaveX = 0;

              for (let wave = 0; wave < swellCount; wave += 1) {
                const phaseSin = swellPhaseSin[wave][cell];
                const phaseCos = swellPhaseCos[wave][cell];
                const clockCos = swellClockCos[wave];
                const clockSin = swellClockSin[wave];
                const swellWave = swellWaves[wave];
                const reach = swellWave.amplitude * seaAmplitude;

                waveHeight += (phaseSin * clockCos - phaseCos * clockSin) * reach;

                // Gerstner: cells slide toward the crests as well as rising with them,
                // which is what makes a dot grid read as water rather than a ripple map.
                alongWaveX += (phaseCos * clockCos + phaseSin * clockSin) * reach * swellWave.directionX;
              }

              // swellEnvelope already carries the 1/depth term, so the near swell
              // heaves across many pixels while the far swell barely stirs.
              const perspective = swellEnvelope[cell];

              surface += waveHeight * seaFade;
              driftX += alongWaveX * perspective * water.drift;
              driftY -= waveHeight * perspective * water.lift;
            }

            // sin(phase - wt) from the tabulated phase, reused twice: it fills the
            // form's disc with a travelling ripple and makes the form's own outline
            // pulse as that ripple passes through it.
            const rippleWave = 0.5 + 0.5 * (
              ripplePhaseSin[cell] * rippleClockCos - ripplePhaseCos[cell] * rippleClockSin
            );
            const zone = rippleZone[cell];
            const formPulse = 1 - shimmer * zone + shimmer * zone * rippleWave;

            let beam = 0;

            if (beamLive) {
              const falloff = beamFalloffField[cell];

              if (falloff > 0) {
                let offset = beamAngleField[cell] - sweepAngle;

                if (offset > Math.PI) {
                  offset -= Math.PI * 2;
                } else if (offset < -Math.PI) {
                  offset += Math.PI * 2;
                }

                if (offset < 0) {
                  offset = -offset;
                }

                if (offset < beamHalfWidth) {
                  // Blend of linear and squared falloff: pure squared pinches the beam
                  // down to a thin bright line with nothing either side of it.
                  const across = 1 - offset / beamHalfWidth;
                  beam = across * (0.42 + 0.58 * across) * falloff * beamGain;
                }
              }

              beam += beamCoreField[cell] * beamCoreGain;
            }

            const crest = surface > 0 ? surface * surface * water.crestGain * seaFade : 0;
            const sample = sampleField[cell];
            const backgroundParticle = sample < backgroundThreshold;
            const intensity =
              shapeValue * formPulse +
              rippleWave * rippleAmplitude * zone +
              beam +
              crest;
            const brightFormParticle = intensity > 0.42 && sample < Math.min(0.94, intensity);
            const dimFormParticle = sample < intensity * 0.4;

            if (!backgroundParticle && !brightFormParticle && !dimFormParticle && pointerInfluence === 0) {
              continue;
            }

            const breathing = reducedMotion
              ? 0.5
              : 0.5 + 0.5 * Math.sin(time * 0.00065 + breathingPhaseField[cell]);
            let alpha = backgroundParticle ? 0.07 + breathing * 0.07 : 0;
            let particleSize = 1;

            if (dimFormParticle) {
              alpha = Math.max(alpha, 0.22 + intensity * 0.18);
            }

            if (brightFormParticle) {
              alpha = Math.max(alpha, 0.72 + breathing * 0.16);
              particleSize = 2;
            }

            if (pointerInfluence > 0) {
              alpha = Math.max(alpha, 0.18 + pointerInfluence * 0.66);
              particleSize += pointerInfluence * 0.8;
            }

            // Quantising alpha lets the colour strings be reused. Building one per
            // particle meant thousands of string allocations and CSS colour parses a
            // frame, which is the bulk of what the fill actually costs.
            const scaledAlpha = alpha * alphaScale;
            const styleStep = scaledAlpha >= alphaCap
              ? alphaSteps
              : (scaledAlpha / alphaCap * alphaSteps + 0.5) | 0;

            if (styleStep !== activeStyleStep) {
              activeStyleStep = styleStep;
              context.fillStyle = particleStyles[styleStep];
            }

            context.fillRect(
              x + pointerOffsetX + rowShift + driftX - particleSize / 2,
              y + pointerOffsetY + driftY - waterHeight[cell] * water.rippleLift - particleSize / 2,
              particleSize,
              particleSize
            );
          }
        }

        paintFish(gap);
        paintDroplets(gap);
        updateIdentityCharacters(time);
      }

      // Snapped to the same grid as everything else, otherwise the fish reads as a
      // smooth sprite pasted on top of a dot field.
      function paintFish(gap) {
        if (!fish.active || !fishSprites.length) {
          return;
        }

        const heading = Math.atan2(fish.vy, fish.vx);
        const wrapped = ((Math.round(heading / (Math.PI * 2) * fishConfig.angles) % fishConfig.angles) + fishConfig.angles) % fishConfig.angles;
        const field = fishSprites[wrapped];
        const size = fishSpriteSize;
        const half = (size - 1) / 2;
        const originColumn = Math.round((fish.x - gap / 2) / gap) - half;
        const originRow = Math.round((fish.y - gap / 2) / gap) - half;

        context.fillStyle = particleStyles[config.alphaSteps];

        for (let row = 0; row < size; row += 1) {
          const targetRow = originRow + row;

          if (targetRow < 0 || targetRow >= rows) {
            continue;
          }

          for (let column = 0; column < size; column += 1) {
            const targetColumn = originColumn + column;

            if (targetColumn < 0 || targetColumn >= columns) {
              continue;
            }

            if (field[row * size + column] < 0.45) {
              continue;
            }

            context.fillRect(gap / 2 + targetColumn * gap - 1, gap / 2 + targetRow * gap - 1, 2, 2);
          }
        }
      }

      function paintDroplets(gap) {
        if (!droplets.length) {
          return;
        }

        const steps = config.alphaSteps;

        for (const droplet of droplets) {
          const remaining = 1 - droplet.age / droplet.life;

          if (remaining <= 0) {
            continue;
          }

          const column = Math.round((droplet.x - gap / 2) / gap);
          const row = Math.round((droplet.y - gap / 2) / gap);

          if (column < 0 || column >= columns || row < 0 || row >= rows) {
            continue;
          }

          context.fillStyle = particleStyles[Math.max(1, Math.round(remaining * steps))];
          context.fillRect(gap / 2 + column * gap - 0.8, gap / 2 + row * gap - 0.8, 1.7, 1.7);
        }
      }

      function loop(time) {
        if (time - lastPaint >= 1000 / config.framesPerSecond) {
          advanceMorph(time);

          // A moving pointer drags a wake; a resting one leaves the surface alone.
          if (pointer.active && !reducedMotion) {
            const travelled = Math.hypot(pointer.x - lastPointerX, pointer.y - lastPointerY);

            if (travelled > 0.5) {
              disturbWater(pointer.x, pointer.y, config.water.pointerImpulse * Math.min(3, travelled / 6));
            }

            lastPointerX = pointer.x;
            lastPointerY = pointer.y;
          }

          // Clamped so a backgrounded tab does not resume with the fish teleported.
          const deltaSeconds = Math.min(0.05, (time - lastPaint) / 1000) || 1 / config.framesPerSecond;

          const smoothing = config.pointerSmoothing;
          pointer.followX += (pointer.x - pointer.followX) * smoothing;
          pointer.followY += (pointer.y - pointer.followY) * smoothing;

          stepWater();
          updateDrag();
          updateFish(time, deltaSeconds);
          updateDroplets(deltaSeconds);
          paint(time);
          lastPaint = time;
        }

        animationFrame = requestAnimationFrame(loop);
      }

      function deactivatePointer() {
        if (!pointer.active) {
          return;
        }

        pointer.active = false;
      }

      // Pointer capture keeps the grab alive when the cursor outruns the glyphs, which
      // it will, because the characters deliberately lag behind it.
      heading.addEventListener("pointerdown", (event) => {
        if (reducedMotion || event.button > 0) {
          return;
        }

        // Nearest letter rather than the event target, so the gaps between glyphs are
        // not dead zones.
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

      function releaseHeading(event) {
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

      // Only follow the system while the visitor has not picked a theme themselves.
      lightQuery.addEventListener("change", (event) => {
        if (readStoredTheme()) {
          return;
        }

        applyTheme(event.matches ? "paper" : "dark", false);
      });

      window.addEventListener("pointermove", (event) => {
        // Arriving from off-screen, snap rather than sweeping the glow across the page.
        if (!pointer.active) {
          pointer.followX = event.clientX;
          pointer.followY = event.clientY;
        }

        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.active = true;
      }, { passive: true });

      // pointerleave does not bubble, so a window-level listener never sees the cursor
      // leaving the viewport. A null relatedTarget on pointerout is the reliable signal.
      // The held form is released here too: leaving the window from on top of a link
      // never fires that link's pointerleave, which used to pin the field on the
      // link's form until it was hovered again.
      document.addEventListener("pointerout", (event) => {
        if (!event.relatedTarget) {
          deactivatePointer();
          releaseForm();
        }
      });

      // Touch contact ends without a trailing pointermove, which would otherwise park
      // the field at the last touched position forever. A tap that opens a link also
      // never fires pointerleave, so the held form is released with it.
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

      // Switching apps while hovering a link (a mailto handler opening, alt-tab)
      // fires no pointer events at all. Blur is the last chance to let the form go.
      window.addEventListener("blur", () => {
        deactivatePointer();
        releaseForm();
      });

      window.addEventListener("resize", () => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(resize);
      }, { passive: true });

      document.addEventListener("visibilitychange", () => {
        cancelAnimationFrame(animationFrame);

        if (document.hidden) {
          // A link that navigates away (blog, GitHub) backgrounds the tab with the
          // pointer still "on" it; without this the field is stuck on that link's
          // form when the visitor comes back.
          releaseForm();
        } else if (!reducedMotion) {
          lastPaint = 0;
          animationFrame = requestAnimationFrame(loop);
        }
      });

      themeToggle.setAttribute("aria-label", theme.label);
      document.documentElement.dataset.form = forms[toForm].id;
      buildParticleStyles();
      wrapIdentityTextCharacters();
      resize();
      dwellUntil = performance.now() + config.dwellDuration;
      document.documentElement.dataset.fish = "idle";
      document.documentElement.dataset.drag = "free";
      scheduleFish(performance.now());

      if (document.fonts && document.fonts.ready) {
        // The CJK glyph can shape differently once fonts settle, so its mask is rebuilt
        // one time after load rather than on a guess.
        document.fonts.ready.then(() => {
          rasterizeForms();
          measureIdentityCharacters();
          paint(performance.now());
        });
      }

      if (!reducedMotion) {
        animationFrame = requestAnimationFrame(loop);
      }
    })();
