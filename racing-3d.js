import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

const TOTAL_LAPS = 3;
/** Ширина полотна (м), больше — проще обгонять */
const ROAD_W = 26;
/** Масштаб трассы: длина петли в world-units, больше — шире кольцо */
const TRACK_SCALE = 2.15;
/**
 * Скорости в `cars` — относительные; множитель приводит du/dt к удобному темпу круга
 * (трасса длиннее → без PACE круги были бы слишком редкими).
 */
const PACE = 95;
/** Одинаковый потолок скорости для всех (относит. ед.) */
const MAX_SPEED = 0.7;
const CRUISE_FR = 0.88;

const LABELS = ["Ты", "Красный", "Оранжевый", "Зелёный"];
const COLORS = [0x3d8bfd, 0xe74c3c, 0xf39c12, 0x2ecc71];

let scene, camera, renderer;
let trackCurve, trackLength;
let roadMesh, roadMarkingTex, ground, curbGroup, decorGroup;
let startLineGroup;
/** Таблица s→u для равных отрезков по длине трассы (бордюры, декор) */
let arcTable = null;
let carGroups = [];
let skyTexture;
let camSmPos = new THREE.Vector3(0, 16, 40);
let camSmTarget = new THREE.Vector3(0, 0, 0);
let camInited = false;
let latSmooth = 0;
let cars = [];

const keys = new Set();
let gameState = "menu";
let timeRace = 0;
let lastTime = 0;
let cdStartMs = 0;

const ui = {
  lap: null,
  place: null,
  time: null,
  best: null,
  overlay: null,
  overlayText: null,
  countdown: null,
};

/**
 * Трасса как дорога: петля = прямые + дуги 90° (прямоугольник со скруглёнными углами).
 * u≈0 в середине нижней прямой (старт/фин).
 */
function makeTrackPoints() {
  const s = TRACK_SCALE / 2.15;
  const W = 380 * s;
  const H = 255 * s;
  const r = 62 * s;
  const segs = 8;
  const arcSeg = 18;
  const out = [];
  const hAt = (x, z) =>
    0.1 * Math.sin(0.0038 * (x + z * 0.7)) + 0.04 * Math.sin(0.0022 * (x * 0.6 - z));
  const pushArc = (cx, cz, a0, a1) => {
    for (let k = 0; k <= arcSeg; k++) {
      const tt = k / arcSeg;
      const ang = a0 + (a1 - a0) * tt;
      const x = cx + r * Math.cos(ang);
      const z = cz + r * Math.sin(ang);
      out.push(new THREE.Vector3(x, hAt(x, z), z));
    }
  };
  const pushLine = (x0, z0, x1, z1) => {
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      out.push(new THREE.Vector3(x, hAt(x, z), z));
    }
  };
  const hw = W * 0.5;
  const hh = H * 0.5;
  const xL = -hw + r;
  const xR = hw - r;
  const cBRz = -hh + r;
  const cTRz = hh - r;
  // CCW: старт (0, -hh) → вправо
  pushLine(0, -hh, xR, -hh);
  pushArc(xR, cBRz, -Math.PI / 2, 0);
  pushLine(hw, -hh + r, hw, hh - r);
  pushArc(xR, cTRz, 0, Math.PI / 2);
  pushLine(xL, hh, xR, hh);
  pushArc(xL, cTRz, Math.PI / 2, Math.PI);
  pushLine(-hw, hh - r, -hw, -hh + r);
  pushArc(xL, cBRz, Math.PI, (3 * Math.PI) / 2);
  pushLine(xL, -hh, 0, -hh);
  if (out.length > 2 && out[0].distanceToSquared(out[out.length - 1]) < 1e-4) {
    out.pop();
  }
  return out;
}

/**
 * Ровный асфальт + белые кромки и прерывистая ось (V 0…1 — поперёк полотна)
 */
function makeRoadMarkingTexture() {
  const w = 512;
  const h = 128;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#3d3d45";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#e6e6ea";
  g.fillRect(w * 0.018, h * 0.36, w * 0.012, h * 0.28);
  g.fillRect(w * (1 - 0.03), h * 0.36, w * 0.012, h * 0.28);
  g.fillStyle = "#f2f2f6";
  const gap = 28;
  const dash = 18;
  for (let x = 0; x < w; x += gap + dash) {
    g.fillRect(x, h * 0.45, Math.min(dash, w - x), h * 0.1);
  }
  const t = new THREE.CanvasTexture(c);
  if (t.colorSpace) t.colorSpace = "srgb";
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  return t;
}

function buildArcLengthTable(curve) {
  const STEPS = 4096;
  const uarr = new Float32Array(STEPS);
  const lens = new Float32Array(STEPS);
  let acc = 0;
  let prev = curve.getPointAt(0);
  for (let i = 0; i < STEPS; i++) {
    const u = i / (STEPS - 1);
    uarr[i] = u;
    const p = curve.getPointAt(u);
    if (i > 0) acc += p.distanceTo(prev);
    lens[i] = acc;
    prev = p;
  }
  return { uarr, lens, total: acc };
}

function uAtArcLength(table, distAlong) {
  const L = table.total;
  if (L < 1e-4) return 0;
  let s = distAlong % L;
  if (s < 0) s += L;
  let lo = 0;
  let hi = table.lens.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (table.lens[mid] < s) lo = mid;
    else hi = mid;
  }
  const i = lo;
  const d0 = table.lens[i];
  const d1 = table.lens[i + 1];
  const u0 = table.uarr[i];
  const u1 = table.uarr[i + 1];
  const span = d1 - d0;
  const tt = span > 1e-8 ? (s - d0) / span : 0;
  return u0 * (1 - tt) + u1 * tt;
}

let roadURepeat = 1;

function buildRoadGeometry(curve, markTex) {
  const N = 300;
  const up = new THREE.Vector3(0, 1, 0);
  const positions = [];
  const uvs = [];
  const half = ROAD_W * 0.5;
  const len = curve.getLength();
  roadURepeat = Math.max(18, len / 6.2);
  markTex.repeat.set(roadURepeat, 1);
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    t.y = 0;
    if (t.lengthSq() < 1e-6) t.set(1, 0, 0);
    t.normalize();
    const b = new THREE.Vector3().crossVectors(up, t);
    b.normalize();
    const hLift = 0.06;
    const l = p.clone().add(b.clone().multiplyScalar(-half));
    const r = p.clone().add(b.clone().multiplyScalar(half));
    l.y += hLift;
    r.y += hLift;
    const uvL = (i / N) * roadURepeat;
    positions.push(l.x, l.y, l.z);
    uvs.push(uvL, 0);
    positions.push(r.x, r.y, r.z);
    uvs.push(uvL, 1);
  }
  const indices = [];
  for (let i = 0; i < N; i++) {
    const a = i * 2;
    const a1 = a + 1;
    const b0 = a + 2;
    const b1 = a + 3;
    indices.push(a, a1, b1, a, b1, b0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Бордюры с равным шагом по длине дуги (не «сборка» в поворотах)
 */
function buildCurbMeshes(curve, table) {
  const L = table.total;
  const stepM = 0.95;
  const nSeg = Math.max(1, Math.floor(L / stepM));
  const g = new THREE.Group();
  const up = new THREE.Vector3(0, 1, 0);
  const half = ROAD_W * 0.5;
  const wC = 0.52;
  const hC = 0.26;
  const off = 0.02;
  const matA = new THREE.MeshStandardMaterial({ color: 0xc41e1e, roughness: 0.5 });
  const matB = new THREE.MeshStandardMaterial({ color: 0xededed, roughness: 0.48 });
  const segLen = L / nSeg;
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1;
    for (let j = 0; j < nSeg; j++) {
      const sMid = (j + 0.5) * segLen;
      const u = uAtArcLength(table, sMid);
      const p = curve.getPointAt(u);
      let t = curve.getTangentAt(u);
      if (t.lengthSq() < 1e-10) t.set(0, 0, 1);
      t.normalize();
      let outward = new THREE.Vector3().crossVectors(up, t);
      if (outward.lengthSq() < 1e-8) outward = new THREE.Vector3(0, 0, 1).cross(t);
      outward.normalize();
      if (sign < 0) outward.negate();
      const nUp = t.clone().cross(outward).normalize();
      if (nUp.y < 0) nUp.negate();
      const pEdge = p
        .clone()
        .add(outward.clone().multiplyScalar(half + off + wC * 0.5));
      pEdge.add(nUp.clone().multiplyScalar(0.04 + hC * 0.5));
      const m = (j + side) % 2 ? matA : matB;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(wC, hC, segLen * 0.99),
        m
      );
      box.position.copy(pEdge);
      const mx = new THREE.Matrix4();
      mx.makeBasis(outward, nUp, t);
      box.setRotationFromMatrix(mx);
      g.add(box);
    }
  }
  return g;
}

function buildTrackDecor(curve, table) {
  const g = new THREE.Group();
  const L = table.total;
  const up = new THREE.Vector3(0, 1, 0);
  const half = ROAD_W * 0.5;
  const wood = new THREE.MeshStandardMaterial({ color: 0x3d2818, roughness: 0.85 });
  const leaf = new THREE.MeshStandardMaterial({ color: 0x1e4a1e, roughness: 0.8 });
  const post = new THREE.MeshStandardMaterial({ color: 0x66666e, metalness: 0.2, roughness: 0.6 });
  for (let s = 14; s < L - 10; s += 24) {
    const u = uAtArcLength(table, s);
    const p = curve.getPointAt(u);
    let t = curve.getTangentAt(u);
    t.normalize();
    const rgt = new THREE.Vector3().crossVectors(up, t);
    if (rgt.lengthSq() < 1e-8) rgt.set(1, 0, 0);
    rgt.normalize();
    // Ёлки только вдоль трассы: две строгие линии по обеим сторонам.
    for (const side of [-1, 1]) {
      const d = half + 6.2;
      const px = p.x + rgt.x * d * side;
      const pz = p.z + rgt.z * d * side;
      const py = p.y;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 1.6, 6), wood);
      const crown = new THREE.Mesh(new THREE.ConeGeometry(1.4, 2.6, 7), leaf);
      trunk.position.set(px, py + 0.8, pz);
      crown.position.set(px, py + 2.1, pz);
      g.add(trunk, crown);
    }
  }
  for (let s = 8; s < L; s += 35) {
    const u = uAtArcLength(table, s + 5);
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    t.normalize();
    const rgt = new THREE.Vector3().crossVectors(up, t);
    if (rgt.lengthSq() < 1e-8) rgt.set(0, 0, 1);
    rgt.normalize();
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.75, 1.0),
      post
    );
    const o = s % 70 < 35 ? 1 : -1;
    const d = half + 1.4;
    bar.position.set(
      p.x + rgt.x * d * o,
      p.y + 0.38,
      p.z + rgt.z * d * o
    );
    const yaw = Math.atan2(t.x, t.z);
    bar.rotation.y = yaw;
    g.add(bar);
  }
  g.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return g;
}

/**
 * Старт/финиш — поперечная линия на полотне (шахматка), лежит на наклоне трассы
 */
function createStartLineOnRoad(curve) {
  const u0 = 0;
  const p0 = curve.getPointAt(u0);
  const t0 = curve.getTangentAt(u0);
  if (t0.lengthSq() < 1e-8) t0.set(0, 0, 1);
  t0.normalize();
  const up0 = new THREE.Vector3(0, 1, 0);
  const b0 = new THREE.Vector3().crossVectors(up0, t0);
  b0.normalize();
  const nrm = t0.clone().cross(b0).normalize();
  const g = new THREE.Group();
  const nStrip = 24;
  const fullW = ROAD_W * 0.985;
  const oneW = fullW / nStrip;
  const along = 0.75;
  const hBlock = 0.1;
  const wh = new THREE.MeshStandardMaterial({ color: 0xf0f0f5, roughness: 0.45 });
  const bl = new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.5 });
  const mBasis = new THREE.Matrix4();
  mBasis.makeBasis(b0, nrm, t0);
  const quat = new THREE.Quaternion().setFromRotationMatrix(mBasis);
  const lift = nrm.clone().multiplyScalar(0.12);
  for (let k = 0; k < nStrip; k++) {
    const pad = 0.96;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(oneW * pad, hBlock, along),
      k % 2 ? bl : wh
    );
    const cx = (k - (nStrip - 1) / 2) * oneW;
    const center = p0.clone().add(b0.clone().multiplyScalar(cx));
    center.add(lift);
    mesh.position.copy(center);
    mesh.quaternion.copy(quat);
    g.add(mesh);
  }
  g.userData = { p0: p0.clone(), t0: t0.clone(), b0: b0.clone() };
  return g;
}

function makeCarGroup(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.3,
    roughness: 0.55,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x191919, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 4.2), mat);
  body.position.y = 0.55;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 2), mat);
  cabin.position.set(0, 1, -0.2);
  const w = 0.38;
  const wh = 0.22;
  for (const [x, z] of [
    [-0.7, 1.3],
    [0.7, 1.3],
    [-0.7, -1.3],
    [0.7, -1.3],
  ]) {
    const wmesh = new THREE.Mesh(new THREE.BoxGeometry(w, wh, 0.45), dark);
    wmesh.position.set(x, 0.22, z);
    g.add(wmesh);
  }
  g.add(body, cabin);
  return g;
}

function placeCarOnTrack(group, u, lat, curve) {
  const p = curve.getPointAt(u);
  let t = curve.getTangentAt(u);
  if (t.lengthSq() < 1e-10) t.set(0, 0, 1);
  t.normalize();
  const upV = new THREE.Vector3(0, 1, 0);
  let right = new THREE.Vector3().crossVectors(upV, t);
  if (right.lengthSq() < 1e-8) {
    right = new THREE.Vector3(0, 0, 1).cross(t);
  }
  right.normalize();
  const n = t.clone().cross(right).normalize();
  if (n.y < 0) n.negate();
  const pos = p
    .clone()
    .add(right.clone().multiplyScalar(lat * ROAD_W * 0.42));
  pos.add(n.clone().multiplyScalar(0.12));
  group.position.copy(pos);
  const m = new THREE.Matrix4();
  m.makeBasis(right, n, t);
  group.setRotationFromMatrix(m);
  // Визуальный «руль»: лёгкий увод носа в сторону поворота.
  const steer = group.userData?.steer || 0;
  group.rotateOnWorldAxis(n, -steer * 0.26);
}

function init() {
  scene = new THREE.Scene();
  const skyBase = 0x9db4c4;
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 256;
  const c2 = canvas.getContext("2d");
  const gsky = c2.createLinearGradient(0, 0, 0, 256);
  gsky.addColorStop(0, "#3d5266");
  gsky.addColorStop(0.35, "#5c7894");
  gsky.addColorStop(0.65, "#8aa8bc");
  gsky.addColorStop(0.9, "#9eb4c0");
  gsky.addColorStop(1, "#a8b8c4");
  c2.fillStyle = gsky;
  c2.fillRect(0, 0, 4, 256);
  skyTexture = new THREE.CanvasTexture(canvas);
  if ("colorSpace" in skyTexture) skyTexture.colorSpace = "srgb";
  scene.background = skyTexture;
  scene.fog = new THREE.Fog(skyBase, 80, 720);

  camera = new THREE.PerspectiveCamera(58, 1, 0.1, 2500);
  camera.position.set(0, 24, 60);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x7a8fa0, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (renderer.outputColorSpace !== undefined) {
    renderer.outputColorSpace = "srgb";
  }
  const el = document.getElementById("viewport");
  el.appendChild(renderer.domElement);
  onResize();
  window.addEventListener("resize", onResize);

  const hemi = new THREE.HemisphereLight(0x9ac0e8, 0x3a5a2a, 0.55);
  const sun = new THREE.DirectionalLight(0xf5f0e4, 0.9);
  sun.position.set(120, 200, 180);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 2;
  sun.shadow.camera.far = 900;
  sun.shadow.camera.left = -420;
  sun.shadow.camera.right = 420;
  sun.shadow.camera.top = 420;
  sun.shadow.camera.bottom = -420;
  scene.add(hemi, sun);
  const amb = new THREE.AmbientLight(0x404550, 0.35);
  scene.add(amb);

  const points = makeTrackPoints();
  trackCurve = new THREE.CatmullRomCurve3(points, true, "centripetal");
  trackLength = trackCurve.getLength();
  arcTable = buildArcLengthTable(trackCurve);

  roadMarkingTex = makeRoadMarkingTexture();
  const roadGeo = buildRoadGeometry(trackCurve, roadMarkingTex);
  const roadMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: roadMarkingTex,
    roughness: 0.88,
    metalness: 0.04,
  });
  roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  roadMesh.castShadow = false;
  scene.add(roadMesh);

  curbGroup = buildCurbMeshes(trackCurve, arcTable);
  scene.add(curbGroup);
  decorGroup = buildTrackDecor(trackCurve, arcTable);
  scene.add(decorGroup);

  ground = new THREE.Mesh(
    new THREE.PlaneGeometry(5000, 5000),
    new THREE.MeshStandardMaterial({
      color: 0x2d4a32,
      roughness: 0.95,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.2;
  ground.receiveShadow = true;
  scene.add(ground);

  startLineGroup = createStartLineOnRoad(trackCurve);
  scene.add(startLineGroup);

  for (let i = 0; i < 4; i++) {
    const g = makeCarGroup(COLORS[i]);
    g.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    carGroups.push(g);
    scene.add(g);
  }

  resetCarData();

  ui.lap = document.getElementById("lap-3d");
  ui.place = document.getElementById("place-3d");
  ui.time = document.getElementById("time-3d");
  ui.best = document.getElementById("best-3d");
  ui.overlay = document.getElementById("overlay-3d");
  ui.overlayText = document.getElementById("overlay-text-3d");
  ui.countdown = document.getElementById("countdown");

  const bestT = localStorage.getItem("race3dBest");
  if (bestT && ui.best) {
    const v = parseFloat(bestT, 10);
    if (!Number.isNaN(v)) ui.best.textContent = `Лучш. время: ${formatTime(v)}`;
  }

  document.getElementById("btn-3d").addEventListener("click", startFromMenu);
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && e.target === document.body) e.preventDefault();
    keys.add(e.code);
  });
  document.addEventListener("keyup", (e) => {
    keys.delete(e.code);
  });
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function progressScore(c) {
  return c.lap + c.u;
}

function rankCars() {
  const ord = cars.map((c, i) => ({ c, i })).sort(
    (a, b) => progressScore(b.c) - progressScore(a.c)
  );
  return ord.findIndex((x) => x.i === 0) + 1;
}

function resetCarData() {
  const latSpread = [0, -0.4, 0.4, -0.22];
  const uStart = 0.03;
  cars = [0, 1, 2, 3].map((i) => ({
    isPlayer: i === 0,
    u: uStart,
    lat: latSpread[i],
    lap: 0,
    speed: MAX_SPEED * 0.78,
    maxV: MAX_SPEED,
    label: LABELS[i],
    phase: i * 1.7,
    steer: 0,
  }));
  for (let i = 0; i < 4; i++) {
    carGroups[i].userData.steer = cars[i].steer;
    placeCarOnTrack(carGroups[i], cars[i].u, cars[i].lat, trackCurve);
  }
}

function onResize() {
  if (!camera || !renderer) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

const tmpCam = new THREE.Vector3();
const tmpLook = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);

function updateChaseCamera(dt) {
  const p0 = cars[0];
  latSmooth = THREE.MathUtils.lerp(latSmooth, p0.lat, 1 - Math.exp(-4.5 * dt));
  const uEye = p0.u;
  const uA = (p0.u + 0.03) % 1;
  const p = trackCurve.getPointAt(uEye);
  const t = trackCurve.getTangentAt(uEye);
  t.y = 0;
  if (t.lengthSq() < 1e-8) t.set(0, 0, 1);
  t.normalize();
  const b = new THREE.Vector3().crossVectors(worldUp, t);
  b.normalize();
  const tLA = trackCurve.getTangentAt(uA);
  tLA.y = 0;
  tLA.normalize();
  const pA = trackCurve.getPointAt(uA);
  const off = b.clone().multiplyScalar(latSmooth * ROAD_W * 0.42);
  const pos = p.clone().add(off);
  pos.y = p.y + 0.12;
  const dist = 32;
  const hCam = 9.5;
  tmpCam
    .copy(t)
    .multiplyScalar(-dist)
    .add(pos);
  tmpCam.y = pos.y + hCam;
  const offA = b
    .clone()
    .multiplyScalar(latSmooth * ROAD_W * 0.42);
  tmpLook.copy(pA).add(offA);
  tmpLook.add(tLA.clone().multiplyScalar(9));
  tmpLook.y = pA.y + 1.2 + offA.y * 0.1;
  if (!camInited) {
    camSmPos.copy(tmpCam);
    camSmTarget.copy(tmpLook);
    camInited = true;
  } else {
    const kPos = 1 - Math.exp(-2.0 * dt);
    const kLk = 1 - Math.exp(-2.6 * dt);
    camSmPos.lerp(tmpCam, kPos);
    camSmTarget.lerp(tmpLook, kLk);
  }
  camera.position.copy(camSmPos);
  camera.lookAt(camSmTarget);
}

function updatePlayer(dt) {
  const c = cars[0];
  const steer = 1.0 * dt;
  let steerInput = 0;
  if (keys.has("ArrowLeft") || keys.has("KeyA")) c.lat -= steer;
  if (keys.has("ArrowLeft") || keys.has("KeyA")) steerInput -= 1;
  if (keys.has("ArrowRight") || keys.has("KeyD")) c.lat += steer;
  if (keys.has("ArrowRight") || keys.has("KeyD")) steerInput += 1;
  c.lat = THREE.MathUtils.clamp(c.lat, -0.95, 0.95);
  const acc = 0.5 * dt;
  const brk = 0.45 * dt;
  if (keys.has("ArrowUp") || keys.has("KeyW")) c.speed += acc;
  if (keys.has("ArrowDown") || keys.has("KeyS")) c.speed -= brk;
  if (Math.abs(c.lat) > 0.9) c.speed -= 0.28 * dt;
  c.speed = THREE.MathUtils.clamp(c.speed, 0.15, c.maxV);
  const cruise = c.maxV * CRUISE_FR;
  if (Math.abs(c.lat) < 0.7 && !keys.has("ArrowUp") && !keys.has("KeyW")) {
    c.speed = THREE.MathUtils.lerp(c.speed, cruise, 1 - Math.exp(-2.0 * dt));
  }
  c.steer = THREE.MathUtils.lerp(c.steer, steerInput, 1 - Math.exp(-10 * dt));
}

function updateAI(i, tSec) {
  const c = cars[i];
  const prevLat = c.lat;
  const wave =
    0.32 * Math.sin(tSec * 0.4 + c.phase) + 0.1 * Math.sin(tSec * 0.75 + 0.2);
  c.lat = THREE.MathUtils.lerp(
    c.lat,
    THREE.MathUtils.clamp(wave, -0.6, 0.6),
    0.1
  );
  const wobble = 0.5 + 0.5 * Math.sin(tSec * 0.38 + c.phase * 1.5);
  const targetV = c.maxV * (0.94 + 0.06 * wobble);
  c.speed = THREE.MathUtils.lerp(c.speed, targetV, 0.12);
  c.steer = THREE.MathUtils.clamp((c.lat - prevLat) * 22, -1, 1);
}

function advanceCar(c, du) {
  c.u += du;
  while (c.u >= 1) {
    c.lap += 1;
    c.u -= 1;
  }
}

function tick(tMs) {
  if (lastTime === 0) lastTime = tMs;
  const dt = Math.min(0.1, (tMs - lastTime) / 1000);
  lastTime = tMs;

  if (gameState === "countdown" && ui.countdown) {
    const el = tMs - cdStartMs;
    const seg = 0.75;
    const i = Math.floor(el / 1000 / seg);
    const words = ["3", "2", "1", "Вперёд!"];
    if (i < words.length) {
      ui.countdown.textContent = words[i];
    } else {
      ui.countdown.classList.add("hidden");
      gameState = "racing";
      lastTime = tMs;
    }
  }

  if (gameState === "racing") {
    timeRace += dt;
    updatePlayer(dt);
    for (let i = 1; i < 4; i++) {
      updateAI(i, tMs * 0.001);
    }
    const f = PACE / trackLength;
    for (let i = 0; i < 4; i++) {
      const c = cars[i];
      advanceCar(c, c.speed * dt * f);
      carGroups[i].userData.steer = c.steer;
      placeCarOnTrack(carGroups[i], c.u, c.lat, trackCurve);
    }
    if (cars[0].lap >= TOTAL_LAPS) {
      gameState = "finished";
      const place = rankCars();
      const best = parseFloat(localStorage.getItem("race3dBest") || "99999", 10);
      if (timeRace < best) {
        localStorage.setItem("race3dBest", String(timeRace));
        if (ui.best) ui.best.textContent = `Лучш. время: ${formatTime(timeRace)}`;
      }
      ui.overlayText.innerHTML = `<strong>Финиш!</strong><br>Место: ${place} из 4<br>Время: ${formatTime(
        timeRace
      )}<br><br>${
        place === 1
          ? "Победа!"
          : "Можно быстрее — попробуй ещё раз."
      }`;
      ui.overlay.classList.remove("hidden");
      const btn = document.getElementById("btn-3d");
      btn.textContent = "Снова";
    }
  }

  updateChaseCamera(dt);

  if (ui.lap && gameState === "racing") {
    const cur = Math.min(cars[0].lap + 1, TOTAL_LAPS);
    ui.lap.textContent = `Круг: ${cur} / ${TOTAL_LAPS}`;
  }
  if (ui.time && gameState === "racing")
    ui.time.textContent = `Время: ${formatTime(timeRace)}`;
  if (ui.place && (gameState === "racing" || gameState === "countdown")) {
    ui.place.textContent = `Место: ${rankCars()}`;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function startFromMenu() {
  if (ui.overlayText) ui.overlayText.innerHTML = "";
  camInited = false;
  latSmooth = 0;
  resetCarData();
  timeRace = 0;
  lastTime = 0;
  gameState = "countdown";
  cdStartMs = performance.now();
  if (ui.countdown) {
    ui.countdown.classList.remove("hidden");
    ui.countdown.textContent = "3";
  }
  if (ui.overlay) ui.overlay.classList.add("hidden");
  if (ui.lap) ui.lap.textContent = `Круг: 1 / ${TOTAL_LAPS}`;
  if (ui.time) ui.time.textContent = "Время: 0:00.00";
  const btn = document.getElementById("btn-3d");
  if (btn) btn.textContent = "Снова";
}

init();
requestAnimationFrame(tick);
