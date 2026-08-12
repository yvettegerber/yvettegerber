/*
 * Ocean / Flower animated banner scene.
 * Vanilla JS + Canvas2D. Scoped entirely to #ocnflScene on index.html —
 * touches nothing else on the page.
 *
 * Layer order per frame (back to front):
 *   1. background ocean gradient
 *   2. distant wave layers
 *   3. main foreground wave
 *   4. crest foam (behind flowers)
 *   5. foam particles / spray (back sub-layer, behind flowers)
 *   6. flowers
 *   7. foreground foam particles / spray (in front of flowers, for occlusion)
 *   8. grain / pixelation
 *
 * There is no fixed-length "clip" that loops — the scene is a continuous
 * procedural simulation (time-driven wave functions + a randomized
 * calm/build/crest/crash/dissolve cycle), so there is never a reset point
 * to hide. That satisfies "seamless loop" more robustly than a clip would.
 */
(function () {
	'use strict';

	var container = document.getElementById('ocnflScene');
	if (!container) return;

	var canvas = document.getElementById('ocnflCanvas');
	var ctx = canvas.getContext('2d');

	// ------------------------------------------------------------------
	// CONFIGURATION — tune the look here.
	// ------------------------------------------------------------------
	var CONFIG = {
		// Overall
		animationSpeed: 1.0,      // global multiplier for all motion/timing
		pixelScale: 0.5,          // internal render resolution vs. display size (lower = more pixelated)
		grainIntensity: 0.06,     // 0-1, opacity of the grain/noise overlay
		grainTileSize: 64,        // px (internal) size of the regenerated grain tile

		// Ocean
		oceanColorTop: '#0F0F17',
		oceanColorBottom: '#363E41',
		horizonY: 0.13,           // 0-1 fraction down the canvas
		horizonJitter: 0.006,

		waveLayers: [
			{ speed: 0.35, amplitude: 0.020, wavelength: 1.6, phase: 0.0, yBase: 0.30, colorTop: '#16181E', colorBottom: '#232B33' },
			{ speed: 0.55, amplitude: 0.028, wavelength: 1.05, phase: 2.1, yBase: 0.46, colorTop: '#232B33', colorBottom: '#363E41' },
			{ speed: 0.80, amplitude: 0.038, wavelength: 0.72, phase: 4.4, yBase: 0.62, colorTop: '#363E41', colorBottom: '#687372' }
		],

		// Main foreground wave (the one that builds/crests/crashes)
		mainWave: { speed: 0.9, wavelength: 0.85, phase: 1.2, yBase: 0.74 },
		mainWaveCalmAmplitude: 0.022,
		mainWaveCrestAmplitude: 0.085,

		// Cycle timing (ms, before animationSpeed scaling); randomized within range each time a state is entered
		cycleDurations: {
			calm: [7000, 12000],
			build: [4500, 7500],
			crest: [1200, 2000],
			crash: [1600, 2400],
			dissolve: [4000, 6500]
		},

		// Foam
		foamColorPalette: ['#E0DBB8', '#D2D0B2', '#C8C2A6', '#A8A792', '#989E92'],
		foamBaseParticles: 26,     // roughly-active particle count while calm
		foamCrashParticles: 140,   // roughly-active particle count during crash
		foamParticlePoolSize: 260, // hard cap, object pool
		foamParticleMinSize: 1,
		foamParticleMaxSize: 4.5,
		foamParticleSpeed: 1.0,
		foamRoughness: 0.018,     // jaggedness of the crest-foam edge

		// Flowers
		flowerRedPalette: ['#A32A26', '#A6463C', '#9E2A25', '#A32221'],
		flowerMinPerCycle: 1,
		flowerMaxPerCycle: 4,
		flowerChancePerCycle: 0.7, // not every crash produces flowers
		flowerBaseSize: 0.11,      // fraction of canvas height
		flowerSizeVariance: 0.35,
		flowerEmergenceHeight: 0.16, // how far above the foam line a fully-emerged flower rises (fraction of canvas height)
		flowerSway: 0.012,
		flowerDurationScale: 1.0   // multiplier on how long each flower stays visible
	};

	// ------------------------------------------------------------------
	// SMALL UTILITIES
	// ------------------------------------------------------------------
	function rand(min, max) { return min + Math.random() * (max - min); }
	function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
	function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
	function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

	function hexToRgb(hex) {
		var h = hex.replace('#', '');
		return {
			r: parseInt(h.substring(0, 2), 16),
			g: parseInt(h.substring(2, 4), 16),
			b: parseInt(h.substring(4, 6), 16)
		};
	}
	function rgba(hex, a) {
		var c = hexToRgb(hex);
		return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
	}
	function lerpColor(hexA, hexB, t) {
		var a = hexToRgb(hexA), b = hexToRgb(hexB);
		var r = Math.round(a.r + (b.r - a.r) * t);
		var g = Math.round(a.g + (b.g - a.g) * t);
		var bl = Math.round(a.b + (b.b - a.b) * t);
		return 'rgb(' + r + ',' + g + ',' + bl + ')';
	}

	// Cheap organic "not a perfect sine" wave: sum of a few incommensurate harmonics.
	function organicWave(xNorm, t, layer) {
		var k = xNorm * layer.wavelength * Math.PI * 2;
		var a = Math.sin(k + t * layer.speed + layer.phase);
		var b = Math.sin(k * 1.73 - t * layer.speed * 0.63 + layer.phase * 1.31) * 0.42;
		var c = Math.sin(k * 0.31 + t * layer.speed * 0.21 + layer.phase * 0.71) * 0.55;
		return (a + b + c) / 1.97;
	}

	// ------------------------------------------------------------------
	// STATE
	// ------------------------------------------------------------------
	var displayW = 0, displayH = 0;   // CSS px
	var bufW = 0, bufH = 0;           // internal render buffer px
	var buffer = document.createElement('canvas');
	var bctx = buffer.getContext('2d');

	var grainTile = document.createElement('canvas');
	var gctx = grainTile.getContext('2d');
	grainTile.width = CONFIG.grainTileSize;
	grainTile.height = CONFIG.grainTileSize;

	var startTime = performance.now();
	var lastFrameTime = startTime;
	var simTime = 0; // seconds, advances only while running

	var running = false;
	var rafId = null;

	// Wave-cycle state machine
	var cycle = {
		state: 'calm',
		timer: 0,
		duration: rand.apply(null, CONFIG.cycleDurations.calm),
		mainWaveAmp: CONFIG.mainWaveCalmAmplitude,
		foamAmount: 0.08,      // 0-1 visual intensity of crest foam
		spawnRateMul: 1.0      // multiplier on foam particle spawn rate
	};

	// ------------------------------------------------------------------
	// FOAM PARTICLES (object pool)
	// ------------------------------------------------------------------
	function makeParticle() {
		return { active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1, color: '#E0DBB8', alpha: 1, layer: 'back' };
	}
	var particles = [];
	for (var i = 0; i < CONFIG.foamParticlePoolSize; i++) particles.push(makeParticle());

	function spawnFoamParticle(xNorm, yNorm, opts) {
		for (var i = 0; i < particles.length; i++) {
			var p = particles[i];
			if (p.active) continue;
			p.active = true;
			p.x = xNorm;
			p.y = yNorm;
			var ang = rand(-Math.PI * 0.85, -Math.PI * 0.15);
			var speed = rand(0.05, 0.22) * CONFIG.foamParticleSpeed * (opts && opts.energetic ? 1.8 : 1);
			p.vx = Math.cos(ang) * speed * 0.4;
			p.vy = Math.sin(ang) * speed;
			p.maxLife = rand(0.6, 1.6) * (opts && opts.energetic ? 0.8 : 1.3);
			p.life = p.maxLife;
			p.size = rand(CONFIG.foamParticleMinSize, CONFIG.foamParticleMaxSize) * (opts && opts.energetic ? rand(0.8, 1.3) : 1);
			p.color = pick(CONFIG.foamColorPalette);
			p.alpha = rand(0.5, 0.95);
			p.layer = (opts && opts.layer) || (Math.random() < 0.5 ? 'back' : 'front');
			return p;
		}
		return null;
	}

	function updateParticles(dt) {
		var gravity = 0.35;
		for (var i = 0; i < particles.length; i++) {
			var p = particles[i];
			if (!p.active) continue;
			p.life -= dt;
			if (p.life <= 0) { p.active = false; continue; }
			p.vy += gravity * dt;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.alpha = clamp(p.life / p.maxLife, 0, 1) * 0.9;
		}
	}

	// ------------------------------------------------------------------
	// FLOWERS
	// ------------------------------------------------------------------
	var flowers = [];
	var flowersSpawnedThisCycle = false;

	function spawnFlowerBurst() {
		if (Math.random() > CONFIG.flowerChancePerCycle) return;
		var count = Math.round(rand(CONFIG.flowerMinPerCycle, CONFIG.flowerMaxPerCycle + 0.999));
		count = clamp(count, CONFIG.flowerMinPerCycle, CONFIG.flowerMaxPerCycle);
		for (var i = 0; i < count; i++) {
			flowers.push({
				xNorm: rand(0.12, 0.88),
				scale: CONFIG.flowerBaseSize * (1 + rand(-CONFIG.flowerSizeVariance, CONFIG.flowerSizeVariance)),
				rotation: rand(-0.18, 0.18),
				swayPhase: rand(0, Math.PI * 2),
				swaySpeed: rand(0.6, 1.1),
				color: pick(CONFIG.flowerRedPalette),
				colorVariant: rand(-0.08, 0.08),
				delay: rand(0, 0.5) * CONFIG.flowerDurationScale,     // seconds before this flower starts emerging
				riseDur: rand(1.2, 2.0) * CONFIG.flowerDurationScale,
				holdDur: rand(1.0, 2.2) * CONFIG.flowerDurationScale,
				fadeDur: rand(1.6, 2.6) * CONFIG.flowerDurationScale,
				age: 0,
				seed: Math.random() * 1000
			});
		}
	}

	function updateFlowers(dt) {
		for (var i = flowers.length - 1; i >= 0; i--) {
			var f = flowers[i];
			f.age += dt;
			var total = f.delay + f.riseDur + f.holdDur + f.fadeDur;
			if (f.age > total) { flowers.splice(i, 1); continue; }

			var t = f.age - f.delay;
			if (t < 0) { f.progress = 0; continue; }
			if (t < f.riseDur) {
				f.progress = easeOutCubic(t / f.riseDur);
			} else if (t < f.riseDur + f.holdDur) {
				f.progress = 1;
			} else {
				var ft = (t - f.riseDur - f.holdDur) / f.fadeDur;
				f.progress = 1 - easeInOut(clamp(ft, 0, 1));
			}
		}
	}

	// Stylized lily: 3 outer + 3 inner recurved, pointed petals around a darker throat.
	function drawLily(c, x, y, scale, rotation, progress, colorHex, seed) {
		if (progress <= 0.001 || scale <= 0) return;
		c.save();
		c.translate(x, y);
		c.rotate(rotation);
		var s = scale;
		var petalColorOuter = colorHex;
		var petalColorInner = lerpColor(colorHex, '#3A1210', 0.35);
		var throatColor = lerpColor(colorHex, '#1A0908', 0.6);

		// Each petal unfurls out of the foam on its own staggered schedule so the
		// flower reads as growing outward rather than fading into place.
		function petal(angle, length, width, ring, staggerOffset) {
			var localT = clamp((progress - staggerOffset) / (1 - staggerOffset), 0, 1);
			var grow = easeOutCubic(localT);
			if (grow <= 0.001) return;
			c.save();
			c.rotate(angle);
			var jitter = 0.9 + 0.2 * Math.sin(seed + angle * 3);
			var len = length * s * jitter * grow;
			var wid = width * s * jitter * (0.4 + 0.6 * grow);
			c.beginPath();
			c.moveTo(0, 0);
			// recurved pointed petal: bows out then curves back toward a sharp tip
			c.bezierCurveTo(wid * 0.9, -len * 0.35, wid * 0.55, -len * 0.85, 0, -len);
			c.bezierCurveTo(-wid * 0.55, -len * 0.85, -wid * 0.9, -len * 0.35, 0, 0);
			c.closePath();
			var grad = c.createLinearGradient(0, 0, 0, -len);
			grad.addColorStop(0, throatColor);
			grad.addColorStop(0.45, ring === 'inner' ? petalColorInner : petalColorOuter);
			grad.addColorStop(1, ring === 'inner' ? petalColorInner : lerpColor(petalColorOuter, '#C8C2A6', 0.12));
			c.fillStyle = grad;
			c.globalAlpha = Math.min(progress * 1.6, 1);
			c.fill();
			c.restore();
		}

		// inner ring (3 petals), drawn first so outer ring overlaps their base
		var innerAngles = [0, Math.PI * 2 / 3, Math.PI * 4 / 3];
		for (var i = 0; i < 3; i++) petal(innerAngles[i] + rotation * 0.2, 0.72, 0.34, 'inner', i * 0.06);
		// outer ring (3 petals), offset by 60deg, slightly longer, emerge a beat later
		var outerAngles = [Math.PI / 3, Math.PI, Math.PI * 5 / 3];
		for (var j = 0; j < 3; j++) petal(outerAngles[j], 0.92, 0.4, 'outer', 0.12 + j * 0.06);

		// darker throat/center
		c.beginPath();
		c.globalAlpha = Math.min(progress * 1.6, 1);
		c.fillStyle = throatColor;
		c.arc(0, 0, s * 0.11 * easeOutCubic(clamp(progress / 0.3, 0, 1)), 0, Math.PI * 2);
		c.fill();

		c.restore();
	}

	// ------------------------------------------------------------------
	// GRAIN
	// ------------------------------------------------------------------
	function regenerateGrainTile() {
		var w = grainTile.width, h = grainTile.height;
		var img = gctx.createImageData(w, h);
		var d = img.data;
		for (var i = 0; i < d.length; i += 4) {
			var v = 200 + Math.random() * 55; // light-toned speckle
			var a = Math.random() < 0.5 ? Math.random() * 40 : 0;
			d[i] = v; d[i + 1] = v; d[i + 2] = v * 0.92; d[i + 3] = a;
		}
		gctx.putImageData(img, 0, 0);
	}

	function drawGrain() {
		var pattern = bctx.createPattern(grainTile, 'repeat');
		bctx.save();
		bctx.globalAlpha = CONFIG.grainIntensity;
		bctx.globalCompositeOperation = 'overlay';
		bctx.translate(Math.random() * grainTile.width, Math.random() * grainTile.height);
		bctx.fillStyle = pattern;
		bctx.fillRect(-grainTile.width, -grainTile.height, bufW + grainTile.width * 2, bufH + grainTile.height * 2);
		bctx.restore();
	}

	// ------------------------------------------------------------------
	// RENDERING
	// ------------------------------------------------------------------
	function drawOcean(t) {
		var grad = bctx.createLinearGradient(0, 0, 0, bufH);
		grad.addColorStop(0, CONFIG.oceanColorTop);
		grad.addColorStop(1, CONFIG.oceanColorBottom);
		bctx.fillStyle = grad;
		bctx.fillRect(0, 0, bufW, bufH);

		// subtle irregular horizon
		bctx.beginPath();
		bctx.moveTo(0, CONFIG.horizonY * bufH);
		var steps = 24;
		for (var i = 0; i <= steps; i++) {
			var xn = i / steps;
			var y = (CONFIG.horizonY + organicWave(xn, t, { wavelength: 2.2, speed: 0.05, phase: 0 }) * CONFIG.horizonJitter) * bufH;
			bctx.lineTo(xn * bufW, y);
		}
		bctx.lineTo(bufW, 0);
		bctx.lineTo(0, 0);
		bctx.closePath();
		bctx.fillStyle = rgba(CONFIG.oceanColorTop, 0.55);
		bctx.fill();
	}

	function waveLineY(layer, xNorm, t, ampOverride) {
		var amp = (ampOverride !== undefined ? ampOverride : layer.amplitude);
		return (layer.yBase + organicWave(xNorm, t, layer) * amp) * bufH;
	}

	function drawWaveLayer(layer, t) {
		bctx.beginPath();
		bctx.moveTo(0, bufH);
		bctx.lineTo(0, waveLineY(layer, 0, t));
		var steps = 40;
		for (var i = 0; i <= steps; i++) {
			var xn = i / steps;
			bctx.lineTo(xn * bufW, waveLineY(layer, xn, t));
		}
		bctx.lineTo(bufW, bufH);
		bctx.closePath();
		var grad = bctx.createLinearGradient(0, layer.yBase * bufH, 0, bufH);
		grad.addColorStop(0, layer.colorTop);
		grad.addColorStop(1, layer.colorBottom);
		bctx.fillStyle = grad;
		bctx.fill();
	}

	function mainWaveY(xNorm, t) {
		return waveLineY(CONFIG.mainWave, xNorm, t, cycle.mainWaveAmp);
	}

	function drawMainWave(t) {
		bctx.beginPath();
		bctx.moveTo(0, bufH);
		var steps = 48;
		for (var i = 0; i <= steps; i++) {
			var xn = i / steps;
			bctx.lineTo(xn * bufW, mainWaveY(xn, t));
		}
		bctx.lineTo(bufW, bufH);
		bctx.closePath();
		var grad = bctx.createLinearGradient(0, CONFIG.mainWave.yBase * bufH * 0.7, 0, bufH);
		grad.addColorStop(0, '#232B33');
		grad.addColorStop(1, '#687372');
		bctx.fillStyle = grad;
		bctx.fill();
	}

	function drawCrestFoam(t) {
		if (cycle.foamAmount <= 0.01) return;
		bctx.beginPath();
		var steps = 56;
		var pts = [];
		for (var i = 0; i <= steps; i++) {
			var xn = i / steps;
			var baseY = mainWaveY(xn, t);
			var jag = organicWave(xn, t * 1.6, { wavelength: 6, speed: 0.4, phase: xn * 13.1 }) * CONFIG.foamRoughness * bufH;
			pts.push([xn * bufW, baseY - Math.abs(jag) * cycle.foamAmount * 1.4]);
		}
		bctx.moveTo(pts[0][0], pts[0][1] + 6);
		for (i = 0; i < pts.length; i++) bctx.lineTo(pts[i][0], pts[i][1]);
		for (i = pts.length - 1; i >= 0; i--) bctx.lineTo(pts[i][0], pts[i][1] + bufH * 0.05 * cycle.foamAmount + 6);
		bctx.closePath();
		bctx.fillStyle = rgba(pick(CONFIG.foamColorPalette), 0.35 + 0.45 * cycle.foamAmount);
		bctx.fill();
	}

	function drawParticles(layerName) {
		for (var i = 0; i < particles.length; i++) {
			var p = particles[i];
			if (!p.active || p.layer !== layerName) continue;
			bctx.fillStyle = rgba(p.color, p.alpha);
			var sz = p.size * (bufH / 300);
			bctx.fillRect(p.x * bufW - sz / 2, p.y * bufH - sz / 2, sz, sz);
		}
	}

	function drawFlowers() {
		var baseSubmerge = CONFIG.flowerEmergenceHeight * 0.35; // how far below the foam line the flower starts, before it grows/rises out
		for (var i = 0; i < flowers.length; i++) {
			var f = flowers[i];
			if (f.progress <= 0) continue;
			var sway = Math.sin(simTime * f.swaySpeed + f.swayPhase) * CONFIG.flowerSway;
			var xNorm = f.xNorm + sway;
			var foamY = mainWaveY(xNorm, simTime);
			var riseY = foamY + baseSubmerge * bufH * (1 - f.progress) - CONFIG.flowerEmergenceHeight * bufH * f.progress;
			drawLily(bctx, xNorm * bufW, riseY, f.scale * bufH, f.rotation + sway * 0.6, f.progress, f.color, f.seed);
		}
	}

	function render(t) {
		bctx.clearRect(0, 0, bufW, bufH);

		drawOcean(t);
		for (var i = 0; i < CONFIG.waveLayers.length; i++) drawWaveLayer(CONFIG.waveLayers[i], t);
		drawMainWave(t);
		drawCrestFoam(t);
		drawParticles('back');
		drawFlowers();
		drawParticles('front');
		regenerateGrainTile();
		drawGrain();

		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, displayW, displayH);
		ctx.drawImage(buffer, 0, 0, bufW, bufH, 0, 0, displayW, displayH);
	}

	// ------------------------------------------------------------------
	// WAVE CYCLE STATE MACHINE
	// ------------------------------------------------------------------
	function enterState(name) {
		cycle.state = name;
		cycle.timer = 0;
		var range = CONFIG.cycleDurations[name];
		cycle.duration = rand(range[0], range[1]);

		if (name === 'calm') {
			flowersSpawnedThisCycle = false;
		}
		if (name === 'crash' && !flowersSpawnedThisCycle) {
			spawnFlowerBurst();
			flowersSpawnedThisCycle = true;
		}
	}

	function updateCycle(dtMs) {
		cycle.timer += dtMs;
		var p = clamp(cycle.timer / cycle.duration, 0, 1);

		switch (cycle.state) {
			case 'calm':
				cycle.mainWaveAmp = CONFIG.mainWaveCalmAmplitude;
				cycle.foamAmount = 0.06 + 0.03 * Math.sin(simTime * 0.4);
				cycle.spawnRateMul = 1.0;
				break;
			case 'build':
				cycle.mainWaveAmp = CONFIG.mainWaveCalmAmplitude + (CONFIG.mainWaveCrestAmplitude - CONFIG.mainWaveCalmAmplitude) * easeInOut(p);
				cycle.foamAmount = 0.06 + 0.25 * p;
				cycle.spawnRateMul = 1.2;
				break;
			case 'crest':
				cycle.mainWaveAmp = CONFIG.mainWaveCrestAmplitude;
				cycle.foamAmount = 0.35 + 0.4 * p;
				cycle.spawnRateMul = 2.0;
				break;
			case 'crash':
				cycle.mainWaveAmp = CONFIG.mainWaveCrestAmplitude * (1 - 0.3 * p);
				cycle.foamAmount = 0.9;
				cycle.spawnRateMul = 4.0;
				break;
			case 'dissolve':
				cycle.mainWaveAmp = CONFIG.mainWaveCrestAmplitude * 0.7 * (1 - easeInOut(p)) + CONFIG.mainWaveCalmAmplitude * easeInOut(p);
				cycle.foamAmount = 0.9 * (1 - easeInOut(p));
				cycle.spawnRateMul = 1.5 * (1 - p) + 0.6;
				break;
		}

		if (cycle.timer >= cycle.duration) {
			var order = ['calm', 'build', 'crest', 'crash', 'dissolve'];
			var next = order[(order.indexOf(cycle.state) + 1) % order.length];
			enterState(next);
		}
	}

	// ------------------------------------------------------------------
	// SPAWNING FOAM PARTICLES EACH FRAME (rate driven by cycle state)
	// ------------------------------------------------------------------
	var spawnAccumulator = 0;
	function spawnFoamForFrame(dt) {
		var baseRate = 14; // particles/sec at spawnRateMul == 1
		spawnAccumulator += dt * baseRate * cycle.spawnRateMul;
		while (spawnAccumulator >= 1) {
			spawnAccumulator -= 1;
			var xNorm, yNorm, opts;
			// Bias roughly a third of spawns toward any emerging flower and force
			// them to the front layer, so foam visibly crosses over the petals'
			// base rather than the flowers just floating above a foam line.
			if (flowers.length > 0 && Math.random() < 0.35) {
				var target = flowers[(Math.random() * flowers.length) | 0];
				xNorm = clamp(target.xNorm + rand(-0.045, 0.045), 0.02, 0.98);
				yNorm = mainWaveY(xNorm, simTime) / bufH + rand(-0.006, 0.02);
				opts = { energetic: true, layer: 'front' };
			} else {
				xNorm = rand(0.05, 0.95);
				yNorm = mainWaveY(xNorm, simTime) / bufH + rand(-0.01, 0.01);
				opts = { energetic: cycle.state === 'crash' || cycle.state === 'crest' };
			}
			spawnFoamParticle(xNorm, yNorm, opts);
		}
	}

	// ------------------------------------------------------------------
	// MAIN LOOP
	// ------------------------------------------------------------------
	function frame(now) {
		if (!running) return;
		var dtMs = Math.min(now - lastFrameTime, 66); // clamp to avoid huge jumps on tab-switch
		lastFrameTime = now;
		var dt = (dtMs / 1000) * CONFIG.animationSpeed;
		simTime += dt;

		updateCycle(dtMs * CONFIG.animationSpeed);
		spawnFoamForFrame(dt);
		updateParticles(dt);
		updateFlowers(dt);
		render(simTime);

		rafId = requestAnimationFrame(frame);
	}

	function start() {
		if (running) return;
		running = true;
		lastFrameTime = performance.now();
		rafId = requestAnimationFrame(frame);
	}
	function stop() {
		running = false;
		if (rafId) cancelAnimationFrame(rafId);
		rafId = null;
	}

	// ------------------------------------------------------------------
	// RESIZE HANDLING
	// ------------------------------------------------------------------
	function resize() {
		var rect = container.getBoundingClientRect();
		displayW = Math.max(1, Math.round(rect.width));
		displayH = Math.max(1, Math.round(rect.height));
		canvas.width = displayW;
		canvas.height = displayH;

		bufW = Math.max(80, Math.round(displayW * CONFIG.pixelScale));
		bufH = Math.max(40, Math.round(displayH * CONFIG.pixelScale));
		buffer.width = bufW;
		buffer.height = bufH;
	}

	var resizeObserver = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(resize) : null;
	if (resizeObserver) resizeObserver.observe(container);
	window.addEventListener('resize', resize);

	// Pause when scrolled out of view / tab hidden — saves CPU/GPU.
	if (typeof IntersectionObserver !== 'undefined') {
		var io = new IntersectionObserver(function (entries) {
			entries[0].isIntersecting ? start() : stop();
		}, { threshold: 0.01 });
		io.observe(container);
	} else {
		start();
	}
	document.addEventListener('visibilitychange', function () {
		if (document.hidden) stop(); else if (!running) start();
	});

	// ------------------------------------------------------------------
	// INIT
	// ------------------------------------------------------------------
	resize();
	enterState('calm');
	render(0);
	start();
})();
