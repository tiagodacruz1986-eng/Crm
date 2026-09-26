// Bureau IA « Neural Core » (Three.js) : cerveau holographique en particules posé sur une puce,
// filaments d'énergie, et les 6 agents en nœuds lumineux reliés au cerveau par des faisceaux.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const BRAIN_Y = 3.7;
const RING = 7.2;
const CYAN = new THREE.Color('#7dd3fc');

// Générateur pseudo-aléatoire stable (même cerveau à chaque ouverture)
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const glowTexture = () => canvasTexture(64, 64, (ctx, w) => {
  const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
});

// ---------- Forme du cerveau : deux hémisphères plissés + cervelet + tronc ----------
function brainPoints(count, rand) {
  const pts = [];
  const folds = (x, y, z) => 1 + 0.07 * Math.sin(x * 7.1 + Math.sin(z * 5.3) * 1.6) * Math.cos(y * 6.2 + z * 2.1) + 0.035 * Math.sin(z * 13 + y * 9);
  while (pts.length < count) {
    const u = rand() * 2 - 1, th = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    let dx = r * Math.cos(th), dy = u, dz = r * Math.sin(th);
    const part = rand();
    let p;
    if (part < 0.86) {
      // Hémisphères (axe avant-arrière = z), scissure centrale
      const side = dx >= 0 ? 1 : -1;
      if (Math.abs(dx) < 0.12) continue;
      const f = folds(dx, dy, dz);
      const depth = 0.82 + rand() * 0.18; // quelques points à l'intérieur pour le volume
      p = new THREE.Vector3(side * 0.07 + dx * 0.95 * f * depth, dy * 0.92 * f * depth, dz * 1.35 * f * depth);
      if (p.y < -0.45) p.y = -0.45 + (p.y + 0.45) * 0.35; // base aplatie
      p.y += 0.12 * Math.cos(dz * 1.2);
    } else if (part < 0.96) {
      // Cervelet
      const f = 1 + 0.05 * Math.sin(dy * 30);
      p = new THREE.Vector3(dx * 0.62 * f, -0.55 + dy * 0.3 * f, -0.95 + dz * 0.45 * f);
    } else {
      // Tronc cérébral
      const h = rand();
      const a = rand() * Math.PI * 2;
      const rr = 0.2 - h * 0.06;
      p = new THREE.Vector3(Math.cos(a) * rr, -0.5 - h * 1.05, -0.35 - h * 0.15 + Math.sin(a) * rr);
    }
    pts.push(p);
  }
  return pts;
}

// Réseau « plexus » : relie les points proches
function plexus(points, maxDist, maxLinks) {
  const pos = [];
  const links = new Array(points.length).fill(0);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length && links[i] < maxLinks; j++) {
      if (links[j] >= maxLinks) continue;
      if (points[i].distanceToSquared(points[j]) < maxDist * maxDist) {
        pos.push(points[i].x, points[i].y, points[i].z, points[j].x, points[j].y, points[j].z);
        links[i]++; links[j]++;
      }
    }
  }
  return new Float32Array(pos);
}

const POINT_VS = `
  attribute float aRand;
  uniform float uTime, uSize, uPulse, uPixel;
  varying float vRand; varying float vWave; varying float vY;
  void main() {
    vRand = aRand; vY = position.y;
    vWave = sin(position.y * 3.0 + position.z * 1.5 - uTime * 2.2 + aRand * 6.2831);
    vec4 mv = modelViewMatrix * vec4(position * (1.0 + uPulse * 0.035 * vWave), 1.0);
    gl_PointSize = uSize * (0.55 + aRand * 0.9) * (1.0 + uPulse * 0.6 * max(vWave, 0.0)) * uPixel * (22.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const POINT_FS = `
  uniform sampler2D uTex; uniform vec3 uColor, uAccent; uniform float uMix, uTime, uScan;
  varying float vRand; varying float vWave; varying float vY;
  void main() {
    vec4 t = texture2D(uTex, gl_PointCoord);
    float scan = smoothstep(0.12, 0.0, abs(vY - uScan));
    vec3 c = mix(uColor, uAccent, uMix * (0.45 + 0.55 * vWave));
    float tw = 0.55 + 0.45 * sin(uTime * (1.0 + vRand * 3.0) + vRand * 40.0);
    gl_FragColor = vec4(c * (0.75 + scan * 1.8), t.a * (0.22 + 0.5 * tw));
  }`;

// Faisceau agent → cerveau : impulsions qui circulent
const BEAM_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
const BEAM_FS = `
  uniform float uTime, uActive; uniform vec3 uColor; varying vec2 vUv;
  void main() {
    float f = fract(vUv.x * 2.0 - uTime * (0.35 + uActive * 1.4));
    float pulse = smoothstep(0.0, 0.08, f) * smoothstep(0.3, 0.08, f);
    float a = 0.10 + pulse * (0.35 + uActive * 0.9);
    gl_FragColor = vec4(uColor * (1.0 + uActive * 1.5), a);
  }`;

// Colonne de lumière entre la puce et le cerveau
const COLUMN_FS = `
  uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
  void main() {
    float a = pow(vUv.y, 1.8) * 0.22 * (0.8 + 0.2 * sin(uTime * 3.0 + vUv.y * 20.0));
    gl_FragColor = vec4(uColor * 1.4, a);
  }`;

export function createOffice(container, agents, { onSelect } = {}) {
  const width = () => container.clientWidth;
  const height = () => container.clientHeight;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const rand = rng(20260926);

  const renderer = new THREE.WebGLRenderer({ antialias: !small, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, small ? 1.5 : 2));
  renderer.setSize(width(), height());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(width(), height());
  Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none', zIndex: '2' });
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#02040b');
  scene.fog = new THREE.FogExp2('#02040b', 0.028);

  const camera = new THREE.PerspectiveCamera(42, width() / height(), 0.1, 200);
  const HOME = { pos: new THREE.Vector3(0, 6.2, 17), target: new THREE.Vector3(0, 2.6, 0) };
  const fitHome = () => {
    const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
    // En portrait (téléphone) on accepte que l'anneau déborde un peu : le cerveau reste lisible
    const reach = camera.aspect < 0.8 ? RING * 0.62 : RING + 2.6;
    const dist = Math.max(camera.aspect < 0.8 ? 13 : 17, reach / Math.tan(hfov / 2));
    HOME.pos.set(0, 6.2 * dist / 17, dist);
  };
  fitHome();
  camera.position.copy(HOME.pos);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.target);
  controls.enableDamping = true;
  controls.minDistance = 5;
  controls.maxDistance = 40;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  scene.add(new THREE.AmbientLight('#1e293b', 1.5));
  const key = new THREE.PointLight('#60a5fa', 40, 30); key.position.set(0, BRAIN_Y, 0); scene.add(key);

  const tex = glowTexture();
  const disposables = [tex];

  // ---------- Poussière d'étoiles ----------
  {
    const n = small ? 700 : 1800;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 14 + rand() * 50, a = rand() * Math.PI * 2;
      pos.set([Math.cos(a) * r, rand() * 30 - 4, Math.sin(a) * r], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.12, map: tex, color: '#93c5fd', transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending })));
  }

  // ---------- Sol : circuits imprimés lumineux ----------
  const circuits = canvasTexture(1024, 1024, (ctx, w) => {
    const c = w / 2;
    ctx.lineCap = 'round';
    for (let i = 0; i < 220; i++) {
      let x = c + (rand() - 0.5) * 180, y = c + (rand() - 0.5) * 180;
      const ang = Math.floor(rand() * 8) * Math.PI / 4;
      ctx.strokeStyle = rand() < 0.8 ? 'rgba(56,189,248,.9)' : 'rgba(251,191,36,.8)';
      ctx.lineWidth = rand() < 0.2 ? 2.4 : 1.2;
      ctx.beginPath(); ctx.moveTo(x, y);
      let a = ang;
      for (let s = 0; s < 4; s++) {
        const len = 30 + rand() * 120;
        x += Math.cos(a) * len; y += Math.sin(a) * len;
        ctx.lineTo(x, y);
        a += (rand() < 0.5 ? 1 : -1) * Math.PI / 4;
      }
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'destination-in';
    const m = ctx.createRadialGradient(c, c, 60, c, c, c);
    m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = m; ctx.fillRect(0, 0, w, w);
  });
  disposables.push(circuits);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), new THREE.MeshBasicMaterial({ map: circuits, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const floorGrid = new THREE.PolarGridHelper(16, 24, 10, 96, '#0c2a44', '#0a1c30');
  floorGrid.position.y = -0.01;
  scene.add(floorGrid);

  // ---------- La puce ----------
  const chip = new THREE.Group();
  const chipTop = canvasTexture(256, 256, (ctx, w) => {
    ctx.fillStyle = '#060b16'; ctx.fillRect(0, 0, w, w);
    for (let x = 18; x < w - 10; x += 12) for (let y = 18; y < w - 10; y += 12) {
      ctx.fillStyle = rand() < 0.18 ? 'rgba(125,211,252,.95)' : 'rgba(56,189,248,.28)';
      ctx.fillRect(x, y, 3, 3);
    }
  });
  disposables.push(chipTop);
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.28, 2.6), [
    ...Array(2).fill(new THREE.MeshStandardMaterial({ color: '#0b1222', metalness: 0.8, roughness: 0.3 })),
    new THREE.MeshBasicMaterial({ map: chipTop }),
    ...Array(3).fill(new THREE.MeshStandardMaterial({ color: '#0b1222', metalness: 0.8, roughness: 0.3 })),
  ]);
  body.position.y = 0.3;
  chip.add(body);
  const edgeGold = new THREE.MeshBasicMaterial({ color: '#fbbf24' });
  const edgeBlue = new THREE.MeshBasicMaterial({ color: '#e0f2fe' });
  for (const [w, d, x, z] of [[2.7, 0.05, 0, 1.33], [2.7, 0.05, 0, -1.33], [0.05, 2.7, 1.33, 0], [0.05, 2.7, -1.33, 0]]) {
    const e = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), edgeGold); e.position.set(x, 0.18, z); chip.add(e);
    const e2 = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 0.03, d * 0.98), edgeBlue); e2.position.set(x * 0.98, 0.46, z * 0.98); chip.add(e2);
  }
  // Broches
  const pin = new THREE.BoxGeometry(0.06, 0.04, 0.3);
  const pinMat = new THREE.MeshBasicMaterial({ color: '#38bdf8' });
  for (let i = -8; i <= 8; i++) for (const s of [-1, 1]) {
    const a = new THREE.Mesh(pin, pinMat); a.position.set(i * 0.15, 0.1, s * 1.5); chip.add(a);
    const b = new THREE.Mesh(pin, pinMat); b.rotation.y = Math.PI / 2; b.position.set(s * 1.5, 0.1, i * 0.15); chip.add(b);
  }
  const chipGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: '#38bdf8', transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
  chipGlow.scale.set(5, 5, 1); chipGlow.position.y = 0.4;
  chip.add(chipGlow);
  scene.add(chip);

  // Colonne de lumière + particules qui montent vers le cerveau
  const columnMat = new THREE.ShaderMaterial({ vertexShader: BEAM_VS, fragmentShader: COLUMN_FS, uniforms: { uTime: { value: 0 }, uColor: { value: CYAN.clone() } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.75, BRAIN_Y - 1.4, 40, 1, true), columnMat);
  column.position.y = 0.45 + (BRAIN_Y - 1.4) / 2;
  scene.add(column);
  const riseN = small ? 120 : 320;
  const risePos = new Float32Array(riseN * 3);
  const riseSeed = [];
  for (let i = 0; i < riseN; i++) { const a = rand() * Math.PI * 2, r = rand() * 0.9; riseSeed.push([a, r, rand()]); }
  const riseGeo = new THREE.BufferGeometry(); riseGeo.setAttribute('position', new THREE.BufferAttribute(risePos, 3));
  const rise = new THREE.Points(riseGeo, new THREE.PointsMaterial({ size: 0.09, map: tex, color: '#bae6fd', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(rise);

  // ---------- Le cerveau ----------
  const brain = new THREE.Group();
  brain.position.y = BRAIN_Y;
  brain.scale.setScalar(1.7);
  scene.add(brain);
  const pts = brainPoints(small ? 3200 : 7000, rand);
  const bGeo = new THREE.BufferGeometry().setFromPoints(pts);
  bGeo.setAttribute('aRand', new THREE.BufferAttribute(new Float32Array(pts.map(() => rand())), 1));
  const brainUniforms = {
    uTime: { value: 0 }, uSize: { value: small ? 1.7 : 0.85 }, uPulse: { value: 0 }, uPixel: { value: renderer.getPixelRatio() },
    uTex: { value: tex }, uColor: { value: new THREE.Color('#6cc4ff') }, uAccent: { value: new THREE.Color('#e879f9') }, uMix: { value: 0 }, uScan: { value: 0 },
  };
  brain.add(new THREE.Points(bGeo, new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: brainUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  // Réseau de neurones à la surface
  const nodes = pts.filter(() => rand() < (small ? 0.07 : 0.06));
  const lineMat = new THREE.LineBasicMaterial({ color: '#60a5fa', transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false });
  const lGeo = new THREE.BufferGeometry(); lGeo.setAttribute('position', new THREE.BufferAttribute(plexus(nodes, 0.42, 3), 3));
  brain.add(new THREE.LineSegments(lGeo, lineMat));
  // Maillage extérieur (le filet qui enveloppe le cerveau)
  const shell = [];
  for (let i = 0; i < (small ? 90 : 170); i++) {
    const u = rand() * 2 - 1, th = rand() * Math.PI * 2, r = Math.sqrt(1 - u * u), k = 1.25 + rand() * 0.55;
    shell.push(new THREE.Vector3(r * Math.cos(th) * 1.25 * k, u * 1.1 * k - 0.1, r * Math.sin(th) * 1.5 * k));
  }
  const shellMat = new THREE.LineBasicMaterial({ color: '#bae6fd', transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false });
  const sGeo = new THREE.BufferGeometry(); sGeo.setAttribute('position', new THREE.BufferAttribute(plexus(shell, 0.95, 4), 3));
  const shellLines = new THREE.LineSegments(sGeo, shellMat);
  brain.add(shellLines);
  const sPts = new THREE.BufferGeometry().setFromPoints(shell);
  brain.add(new THREE.Points(sPts, new THREE.PointsMaterial({ size: 0.1, map: tex, color: '#e0f2fe', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: '#1d4ed8', transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.scale.set(6.5, 5, 1);
  brain.add(halo);

  // ---------- Filaments d'énergie (boucles cyan → ambre) ----------
  const filaments = new THREE.Group();
  filaments.position.y = BRAIN_Y;
  scene.add(filaments);
  const fil = [];
  for (let i = 0; i < (small ? 10 : 18); i++) {
    const r = 2.8 + rand() * 1.8, ex = 0.5 + rand() * 0.6, wob = rand() * 0.4, ph = rand() * 6.28;
    const curve = [];
    for (let s = 0; s <= 160; s++) {
      const a = (s / 160) * Math.PI * 2;
      const rr = r * (1 + wob * Math.sin(a * 3 + ph) * 0.3);
      curve.push(new THREE.Vector3(Math.cos(a) * rr, Math.sin(a * 2 + ph) * 0.35, Math.sin(a) * rr * ex));
    }
    const g = new THREE.BufferGeometry().setFromPoints(curve);
    const colors = new Float32Array(curve.length * 3);
    const c1 = new THREE.Color(rand() < 0.5 ? '#22d3ee' : '#2dd4bf'), c2 = new THREE.Color(rand() < 0.6 ? '#fbbf24' : '#e879f9'), c = new THREE.Color();
    curve.forEach((_, k) => { c.lerpColors(c1, c2, 0.5 + 0.5 * Math.sin((k / curve.length) * Math.PI * 2 + ph)); colors.set([c.r, c.g, c.b], k * 3); });
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.07 + rand() * 0.16, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
    filaments.add(line);
    fil.push({ line, sx: (rand() - 0.5) * 0.25, sy: (rand() - 0.5) * 0.3 });
  }
  // Traînée de lumière horizontale
  const streak = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: '#fde68a', transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
  streak.scale.set(22, 0.35, 1); streak.position.y = BRAIN_Y - 0.1;
  scene.add(streak);

  // ---------- Les agents ----------
  const agentObjs = {};
  const clickables = [];
  const n = agents.length;
  agents.forEach((a, i) => {
    const ang = (i / n) * Math.PI * 2 + Math.PI / 2 + Math.PI / n;
    const group = new THREE.Group();
    group.position.set(Math.cos(ang) * RING, 1.6, Math.sin(ang) * RING);
    const color = new THREE.Color(a.color);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 2), new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.9) }));
    const cage = new THREE.Mesh(new THREE.IcosahedronGeometry(0.78, 1), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.015, 6, 96), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
    orbit.rotation.x = Math.PI / 2.4;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(2.3, 2.3, 1);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 12), new THREE.MeshBasicMaterial({ visible: false }));
    group.add(core, cage, orbit, glow, hit);
    // Socle lumineux au sol
    const pad = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    pad.rotation.x = -Math.PI / 2; pad.position.set(group.position.x, 0.02, group.position.z);
    const padGlow = new THREE.Mesh(new THREE.CircleGeometry(1.6, 48), new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }));
    padGlow.rotation.x = -Math.PI / 2; padGlow.position.set(group.position.x, 0.015, group.position.z);
    scene.add(pad, padGlow);
    // Faisceau courbe vers le cerveau
    const start = group.position.clone();
    const end = new THREE.Vector3(0, BRAIN_Y - 0.2, 0).add(start.clone().setY(0).normalize().multiplyScalar(1.6));
    const mid = start.clone().lerp(end, 0.5).setY(Math.max(start.y, end.y) + 1.6);
    const beamMat = new THREE.ShaderMaterial({ vertexShader: BEAM_VS, fragmentShader: BEAM_FS, uniforms: { uTime: { value: 0 }, uActive: { value: 0 }, uColor: { value: color } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const beam = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(start, mid, end), 64, 0.035, 6, false), beamMat);
    scene.add(beam);
    // Étiquette
    const el = document.createElement('div');
    el.className = 'node-label';
    el.style.setProperty('--c', a.color);
    el.innerHTML = `<div class="state" hidden></div><div class="n"><span class="e">${a.emoji}</span>${a.name}<span class="dot" hidden></span></div><div class="r">${a.role}</div>`;
    el.addEventListener('click', () => onSelect?.(a.id));
    const label = new CSS2DObject(el);
    label.position.set(0, 1.55, 0);
    group.add(label);
    scene.add(group);
    hit.userData.agentId = a.id;
    clickables.push(hit);
    agentObjs[a.id] = { group, core, cage, orbit, glow, pad, beamMat, el, color, working: false, mode: null, phase: i * 1.1, baseY: 1.6, hover: 0 };
  });

  // ---------- Interaction ----------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered = null;
  const pick = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(clickables, false)[0]?.object.userData.agentId || null;
  };
  let downAt = null;
  const onDown = (e) => { downAt = [e.clientX, e.clientY]; };
  const onUp = (e) => {
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 6) { const id = pick(e); if (id) onSelect?.(id); }
    downAt = null;
  };
  const onMove = (e) => {
    if (e.pointerType === 'touch') return;
    hovered = pick(e);
    renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab';
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointermove', onMove);

  // ---------- Caméra ----------
  let focused = null;
  let camAnim = null;
  const flyTo = (pos, target) => { camAnim = { t: 0, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), pos, target }; };
  const focus = (id) => {
    focused = id;
    if (!id) { controls.autoRotate = true; return flyTo(HOME.pos.clone(), HOME.target.clone()); }
    controls.autoRotate = false;
    const p = agentObjs[id].group.position;
    const out = p.clone().setY(0).normalize();
    const side = new THREE.Vector3(-out.z, 0, out.x); // décale pour laisser la place au panneau de droite
    const narrow = width() < 760;
    // Vue depuis l'extérieur : l'agent au premier plan, le cerveau derrière lui
    const target = p.clone().lerp(new THREE.Vector3(0, BRAIN_Y - 0.4, 0), 0.6).add(side.clone().multiplyScalar(narrow ? 0 : -2.6));
    flyTo(p.clone().add(out.multiplyScalar(narrow ? 11 : 9.5)).setY(5.2).add(side.multiplyScalar(narrow ? 0 : -1.2)), target);
  };

  let composer = null;
  if (!small) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(width(), height()), 0.62, 0.45, 0.22));
    composer.addPass(new OutputPass());
  }

  // Activité : un agent écoute, réfléchit ou parle → le cerveau prend sa couleur et s'anime
  let activity = { id: null, mode: null };
  let level = 0;
  const accent = new THREE.Color('#e879f9');

  const clock = new THREE.Clock();
  let raf;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    const busy = activity.mode || Object.values(agentObjs).some((o) => o.working);
    const target = activity.mode === 'speaking' ? 0.7 + level * 0.8 + Math.max(0, Math.sin(t * 9)) * 0.4 : activity.mode === 'listening' ? 0.35 + level * 1.2 : busy ? 0.55 : 0.12;
    brainUniforms.uPulse.value += (target - brainUniforms.uPulse.value) * 0.08;
    brainUniforms.uTime.value = t;
    brainUniforms.uScan.value = Math.sin(t * 0.8) * 1.2;
    const mixTarget = activity.id ? 0.85 : busy ? 0.4 : 0;
    brainUniforms.uMix.value += (mixTarget - brainUniforms.uMix.value) * 0.05;
    if (activity.id && agentObjs[activity.id]) accent.lerp(agentObjs[activity.id].color, 0.06); else accent.lerp(new THREE.Color('#e879f9'), 0.02);
    brainUniforms.uAccent.value.copy(accent);
    brain.rotation.y = Math.PI / 2 + Math.sin(t * (busy ? 0.6 : 0.18)) * 0.7; // profil, léger balancement
    brain.position.y = BRAIN_Y + Math.sin(t * 0.9) * 0.08;
    shellLines.rotation.y = -t * 0.05;
    halo.material.opacity = 0.1 + brainUniforms.uPulse.value * 0.22;
    key.intensity = 30 + brainUniforms.uPulse.value * 40;
    filaments.rotation.y = t * 0.08;
    for (const f of fil) { f.line.rotation.x += f.sx * dt; f.line.rotation.z += f.sy * dt; }
    streak.material.opacity = 0.14 + Math.sin(t * 1.3) * 0.05 + brainUniforms.uPulse.value * 0.12;
    columnMat.uniforms.uTime.value = t;
    chipGlow.material.opacity = 0.2 + Math.sin(t * 2) * 0.05 + brainUniforms.uPulse.value * 0.15;
    const rp = rise.geometry.attributes.position;
    riseSeed.forEach(([a, r, off], i) => {
      const k = (off + t * (0.18 + brainUniforms.uPulse.value * 0.3)) % 1;
      const rr = r * (1 - k * 0.75);
      rp.setXYZ(i, Math.cos(a + t * 0.5) * rr, 0.5 + k * (BRAIN_Y - 1.6), Math.sin(a + t * 0.5) * rr);
    });
    rp.needsUpdate = true;
    for (const [id, o] of Object.entries(agentObjs)) {
      const active = o.working || activity.id === id;
      const hover = hovered === id || focused === id;
      o.hover += ((hover ? 1 : 0) - o.hover) * 0.12;
      o.group.position.y = o.baseY + Math.sin(t * 1.2 + o.phase) * 0.12;
      o.cage.rotation.y = t * (active ? 1.6 : 0.4) + o.phase;
      o.cage.rotation.x = t * 0.3;
      o.orbit.rotation.z = t * (active ? 2.5 : 0.8);
      const s = 1 + o.hover * 0.18 + (active ? Math.sin(t * 6) * 0.06 : 0);
      o.core.scale.setScalar(s);
      o.cage.scale.setScalar(s);
      o.glow.material.opacity = 0.32 + o.hover * 0.3 + (active ? 0.2 + Math.sin(t * 6) * 0.12 : 0);
      o.pad.material.opacity = 0.5 + o.hover * 0.5;
      o.beamMat.uniforms.uTime.value = t + o.phase;
      const act = active ? 1 : o.hover * 0.5;
      o.beamMat.uniforms.uActive.value += (act - o.beamMat.uniforms.uActive.value) * 0.08;
    }
    if (camAnim) {
      camAnim.t = Math.min(1, camAnim.t + 0.022);
      const k = 1 - Math.pow(1 - camAnim.t, 3);
      camera.position.lerpVectors(camAnim.fromPos, camAnim.pos, k);
      controls.target.lerpVectors(camAnim.fromTarget, camAnim.target, k);
      if (camAnim.t >= 1) camAnim = null;
    }
    controls.update();
    if (composer) composer.render(); else renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  };
  tick();

  const ro = new ResizeObserver(() => {
    if (!width() || !height()) return;
    camera.aspect = width() / height();
    camera.updateProjectionMatrix();
    fitHome();
    if (!focused && !camAnim) camera.position.copy(HOME.pos);
    renderer.setSize(width(), height());
    composer?.setSize(width(), height());
    labelRenderer.setSize(width(), height());
  });
  ro.observe(container);

  const STATE_TEXT = { listening: '🎙️ écoute…', thinking: '💭 réfléchit…', speaking: '🔊 parle…' };
  const refreshLabel = (id) => {
    const o = agentObjs[id];
    const mode = activity.id === id && activity.mode ? activity.mode : o.working ? 'thinking' : null;
    const st = o.el.querySelector('.state');
    st.hidden = !mode;
    st.textContent = STATE_TEXT[mode] || '';
    o.el.classList.toggle('active', Boolean(mode));
    o.el.classList.toggle('focused', focused === id);
  };

  return {
    update(states) {
      for (const s of states) {
        const o = agentObjs[s.id];
        if (!o) continue;
        o.working = Boolean(s.working);
        const dot = o.el.querySelector('.dot');
        dot.hidden = !s.unread;
        dot.textContent = s.unread || '';
        refreshLabel(s.id);
      }
    },
    focus(id) { focus(id); Object.keys(agentObjs).forEach(refreshLabel); },
    /** mode : 'listening' | 'thinking' | 'speaking' | null */
    setActivity(id, mode) {
      const prev = activity.id;
      activity = { id: mode ? id : null, mode: mode || null };
      [prev, id].filter((x) => x && agentObjs[x]).forEach(refreshLabel);
    },
    /** Niveau sonore 0..1 (micro ou voix) pour faire vibrer le cerveau */
    setLevel(v) { level = Math.max(0, Math.min(1, v)); },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      composer?.dispose?.();
      renderer.dispose();
      scene.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
      disposables.forEach((d) => d.dispose());
      container.innerHTML = '';
    },
  };
}
