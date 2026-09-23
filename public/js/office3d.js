// Bureau virtuel 3D (Three.js) : 6 postes de travail, un personnage par agent IA.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#ffdbac', '#8d5524', '#f1c27d'];
const HAIR = ['#2d1b0e', '#b5651d', '#111111', '#6b4423', '#1a1a1a', '#d4a373'];

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...opts });
function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function buildDesk(color) {
  const g = new THREE.Group();
  const wood = mat('#c8a27a', { roughness: 0.6 });
  const metal = mat('#475569', { metalness: 0.6, roughness: 0.4 });
  g.add(box(2.6, 0.1, 1.3, wood, 0, 1.05, 0));
  for (const [x, z] of [[-1.2, -0.55], [1.2, -0.55], [-1.2, 0.55], [1.2, 0.55]]) g.add(box(0.08, 1.0, 0.08, metal, x, 0.5, z));
  // Écran
  g.add(box(0.1, 0.45, 0.1, metal, 0, 1.3, -0.35));
  g.add(box(1.3, 0.8, 0.06, mat('#0f172a'), 0, 1.75, -0.4));
  const screenMat = new THREE.MeshStandardMaterial({ color: '#0b1220', emissive: new THREE.Color(color), emissiveIntensity: 0.25 });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.7), screenMat);
  screen.position.set(0, 1.75, -0.365);
  g.add(screen);
  // Clavier, tasse, dossiers
  g.add(box(0.8, 0.03, 0.28, mat('#1e293b'), 0, 1.12, 0.05));
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.16, 16), mat(color));
  mug.position.set(0.9, 1.18, 0.1); mug.castShadow = true; g.add(mug);
  g.add(box(0.35, 0.12, 0.45, mat('#e2e8f0'), -0.95, 1.16, -0.1));
  // Chaise
  const chair = new THREE.Group();
  const fabric = mat('#1f2937');
  chair.add(box(0.8, 0.1, 0.8, fabric, 0, 0.6, 0));
  chair.add(box(0.8, 0.9, 0.1, fabric, 0, 1.05, 0.4));
  chair.add(box(0.08, 0.55, 0.08, metal, 0, 0.3, 0));
  chair.position.set(0, 0, 1.05);
  g.add(chair);
  return { group: g, screen: screenMat };
}

function buildPerson(color, i) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.55, 6, 16), mat(color, { roughness: 0.5 }));
  body.position.y = 1.35; body.castShadow = true;
  const head = new THREE.Group();
  const skin = new THREE.Mesh(new THREE.SphereGeometry(0.27, 24, 24), mat(SKIN[i % SKIN.length], { roughness: 0.8 }));
  skin.castShadow = true;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.285, 24, 24, 0, Math.PI * 2, 0, Math.PI / 2.1), mat(HAIR[i % HAIR.length]));
  hair.rotation.x = 0.25;
  const eyeMat = mat('#0f172a');
  const e1 = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), eyeMat); e1.position.set(-0.09, 0.03, -0.24);
  const e2 = e1.clone(); e2.position.x = 0.09;
  head.add(skin, hair, e1, e2);
  head.position.y = 2.05;
  const armMat = mat(color, { roughness: 0.5 });
  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.45, 4, 8), armMat);
  armL.position.set(-0.38, 1.45, -0.15); armL.rotation.x = -1.1; armL.castShadow = true;
  const armR = armL.clone(); armR.position.x = 0.38;
  g.add(body, head, armL, armR);
  return { group: g, head, armL, armR, body };
}

export function createOffice(container, agents, { onSelect, companyName = 'Mon Garage' } = {}) {
  const width = () => container.clientWidth;
  const height = () => container.clientHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width(), height());
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(width(), height());
  Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0f172a');
  scene.fog = new THREE.Fog('#0f172a', 30, 60);

  const camera = new THREE.PerspectiveCamera(45, width() / height(), 0.1, 200);
  const HOME = { pos: new THREE.Vector3(0, 15, 19), target: new THREE.Vector3(0, 0.8, 0) };
  camera.position.copy(HOME.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.target);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2.2;
  controls.minDistance = 5; controls.maxDistance = 35;

  // Lumières
  scene.add(new THREE.HemisphereLight('#dbeafe', '#1e293b', 0.9));
  const sun = new THREE.DirectionalLight('#fff7ed', 2.2);
  sun.position.set(8, 16, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16 });
  scene.add(sun);
  const warm = new THREE.PointLight('#fbbf24', 12, 20); warm.position.set(0, 6, 0); scene.add(warm);

  // Sol parquet
  const floorTex = canvasTexture(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#8b6b4a'; ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 4; x++) {
      const l = 40 + Math.random() * 14;
      ctx.fillStyle = `hsl(28, 35%, ${l}%)`;
      ctx.fillRect(x * 128 + (y % 2) * 64, y * 32, 126, 30);
    }
  });
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(4, 3);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 24), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.8 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(floor);
  // Tapis central
  const rug = new THREE.Mesh(new THREE.CircleGeometry(3.6, 48), mat('#1e3a8a', { roughness: 1 }));
  rug.rotation.x = -Math.PI / 2; rug.position.y = 0.01; rug.receiveShadow = true;
  scene.add(rug);

  // Murs + fenêtres + écran d'entreprise
  const wallMat = mat('#e2e8f0');
  const back = box(30, 5, 0.3, wallMat, 0, 2.5, -12); scene.add(back);
  const left = box(0.3, 5, 24, wallMat, -15, 2.5, 0); scene.add(left);
  const glass = new THREE.MeshStandardMaterial({ color: '#93c5fd', emissive: '#60a5fa', emissiveIntensity: 0.6, transparent: true, opacity: 0.85 });
  for (const z of [-7, -1, 5]) { const w = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4), glass); w.position.set(-14.8, 2.8, z); w.rotation.y = Math.PI / 2; scene.add(w); }
  const brandTex = canvasTexture(1024, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#1d4ed8'); g.addColorStop(1, '#0891b2');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 84px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`🔧 ${companyName}`, w / 2, h / 2 - 20);
    ctx.font = '36px system-ui, sans-serif'; ctx.globalAlpha = 0.8; ctx.fillText('Bureau virtuel · Équipe IA', w / 2, h / 2 + 60);
  });
  const brand = new THREE.Mesh(new THREE.PlaneGeometry(10, 2.5), new THREE.MeshStandardMaterial({ map: brandTex, emissive: '#ffffff', emissiveMap: brandTex, emissiveIntensity: 0.5 }));
  brand.position.set(0, 3, -11.84); scene.add(brand);

  // Table de réunion
  const table = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.1, 48), mat('#f8fafc', { roughness: 0.3 }));
  table.position.y = 1; table.castShadow = true; table.receiveShadow = true; scene.add(table);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.5, 1, 16), mat('#334155')); foot.position.y = 0.5; scene.add(foot);
  const holo = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1), new THREE.MeshStandardMaterial({ color: '#22d3ee', emissive: '#06b6d4', emissiveIntensity: 1.2, wireframe: true }));
  holo.position.y = 1.9; scene.add(holo);

  // Plantes
  const plant = (x, z) => {
    const g = new THREE.Group();
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.28, 0.6, 16), mat('#f1f5f9')); pot.position.y = 0.3;
    const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), mat('#16a34a', { flatShading: true })); leaves.position.y = 1.2; leaves.scale.y = 1.3;
    pot.castShadow = leaves.castShadow = true;
    g.add(pot, leaves); g.position.set(x, 0, z); scene.add(g);
  };
  plant(-13, -10); plant(13, -10); plant(-13, 10); plant(13, 10);
  // Machine à café
  scene.add(box(0.9, 1.1, 0.7, mat('#334155'), 12.5, 0.55, -4), box(0.6, 0.6, 0.5, mat('#111827'), 12.5, 1.4, -4));

  // Agents
  const clickables = [];
  const agentObjs = {};
  agents.forEach((a, i) => {
    // Repère local : +z pointe vers le centre de la pièce. Le bureau est côté centre,
    // l'agent assis derrière regarde son écran (et donc le centre).
    const group = new THREE.Group();
    group.position.set(a.desk.x, 0, a.desk.z);
    group.lookAt(0, 0, 0);
    const desk = buildDesk(a.color);
    desk.group.rotation.y = Math.PI;
    desk.group.position.z = 0.6;
    const person = buildPerson(a.color, i);
    person.group.rotation.y = Math.PI;
    person.group.position.z = -0.45;
    group.add(desk.group, person.group);
    // Anneau de statut au sol
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.05, 8, 64), new THREE.MeshStandardMaterial({ color: a.color, emissive: a.color, emissiveIntensity: 0.6 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.03;
    group.add(ring);
    // Étiquette HTML
    const el = document.createElement('div');
    el.className = 'office-label';
    el.style.setProperty('--c', a.color);
    el.innerHTML = `<div class="bubble" hidden>💭 réfléchit…</div><div class="n">${a.emoji} ${a.name}<span class="dot" hidden></span></div><div class="r">${a.role}</div>`;
    el.addEventListener('click', () => onSelect?.(a.id));
    const label = new CSS2DObject(el);
    label.position.set(0, 3.1, 0);
    group.add(label);
    scene.add(group);
    group.traverse((o) => { if (o.isMesh) { o.userData.agentId = a.id; clickables.push(o); } });
    agentObjs[a.id] = { group, person, desk, ring, el, working: false, phase: i * 1.3 };
  });

  // Interaction
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
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 6) { const id = pick(e); if (id) onSelect?.(id); }
    downAt = null;
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    const id = pick(e);
    if (id !== hovered) {
      if (hovered) agentObjs[hovered].person.body.material.emissive.set('#000000');
      hovered = id;
      if (id) agentObjs[id].person.body.material.emissive.set('#333333');
      renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
    }
  });

  // Caméra animée
  let camAnim = null;
  const flyTo = (pos, target) => { camAnim = { t: 0, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), pos, target }; };
  const focus = (id) => {
    if (!id) return flyTo(HOME.pos.clone(), HOME.target.clone());
    const g = agentObjs[id].group.position;
    const dir = g.clone().setY(0).normalize();
    flyTo(g.clone().add(dir.multiplyScalar(-5.5)).setY(5.5).add(new THREE.Vector3(3, 0, 0)), g.clone().setY(1.6).add(new THREE.Vector3(2, 0, 0)));
  };

  const clock = new THREE.Clock();
  let raf;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const t = clock.getElapsedTime();
    holo.rotation.y = t * 0.6; holo.rotation.x = t * 0.3;
    holo.position.y = 1.9 + Math.sin(t * 1.5) * 0.08;
    for (const o of Object.values(agentObjs)) {
      const p = o.person;
      const speed = o.working ? 14 : 1.6;
      p.head.rotation.y = Math.sin(t * 0.5 + o.phase) * (o.working ? 0.05 : 0.35);
      p.head.position.y = 2.05 + Math.sin(t * 2 + o.phase) * 0.02;
      p.armL.rotation.x = -1.1 + Math.sin(t * speed + o.phase) * (o.working ? 0.12 : 0.03);
      p.armR.rotation.x = -1.1 + Math.cos(t * speed + o.phase) * (o.working ? 0.12 : 0.03);
      o.desk.screen.emissiveIntensity = o.working ? 0.8 + Math.sin(t * 10) * 0.3 : 0.25;
      o.ring.material.emissiveIntensity = o.working ? 1 + Math.sin(t * 5) * 0.6 : 0.4;
      o.ring.scale.setScalar(o.working ? 1 + Math.sin(t * 5) * 0.03 : 1);
    }
    if (camAnim) {
      camAnim.t = Math.min(1, camAnim.t + 0.025);
      const k = 1 - Math.pow(1 - camAnim.t, 3);
      camera.position.lerpVectors(camAnim.fromPos, camAnim.pos, k);
      controls.target.lerpVectors(camAnim.fromTarget, camAnim.target, k);
      if (camAnim.t >= 1) camAnim = null;
    }
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  };
  tick();

  const ro = new ResizeObserver(() => {
    camera.aspect = width() / height();
    camera.updateProjectionMatrix();
    renderer.setSize(width(), height());
    labelRenderer.setSize(width(), height());
  });
  ro.observe(container);

  return {
    update(states) {
      for (const s of states) {
        const o = agentObjs[s.id];
        if (!o) continue;
        o.working = !!s.working;
        o.el.querySelector('.bubble').hidden = !s.working;
        const dot = o.el.querySelector('.dot');
        dot.hidden = !s.unread;
        dot.textContent = s.unread || '';
      }
    },
    focus,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); }); });
      container.innerHTML = '';
    },
  };
}
