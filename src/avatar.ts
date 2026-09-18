import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { playPianoPhrase, stopPianoPhrase } from './pianoSong';
import { pianoOn } from './settings';

export type Expression = 'neutral'|'happy'|'excited'|'sad'|'surprised'|'thinking'|'annoyed'|'blush';
export type Gesture = 'none'|'wave'|'nod'|'shrug'|'piano';
export type Theme = 'auto'|'day'|'night';
// bump on every push — shown in ?debug=1 overlay so screenshots prove the build
export const BUILD = 'air-dbg14';

// Renderer runs NoToneMapping + a soft light rig so on-screen colors match the
// stylized flat materials she was authored with in Blender (clothes are unlit,
// skin/hair are near-lambert; the exporter's metallic=1 defaults blew out under ACES).
const DAY_BG = new THREE.Color('#ece9e3');
const NIGHT_BG = new THREE.Color('#131418');
const DAY_GROUND = new THREE.Color('#e8e5df');
const NIGHT_GROUND = new THREE.Color('#1d1f26');
// studio floor: a step darker than the bg so the horizon reads. Same color as
// the bg is invisible (that was the dbg8 no-op) — this tone grounds the disc.
const DAY_FLOOR = new THREE.Color('#dbd7cd');
const NIGHT_FLOOR = new THREE.Color('#0e0f13');
const DAY_KEY = new THREE.Color('#fff6ee');
const NIGHT_KEY = new THREE.Color('#9fb4ff');

// wander targets stay on the ground disc (r=1.7) and inside the camera frame
const WANDER_X = 1.05, WANDER_Z_MIN = -0.35, WANDER_Z_MAX = 0.65;
const WANDER_R = 0.95; // max radius from stage center — keeps feet on the disc
// piano ensemble staging, measured against the piano clip's seated pose
// (flipped 180° so she plays the KEYBOARD side: keys just west of her seat,
// case extending west behind them). Everything below is in app/world meters.
const SIT = { x: 0.35, z: 0.02, rotY: -Math.PI / 2 };
const PIANO_REL = { x: -0.0948, z: 1.0407, rotY: 3.2087 }; // piano root in her sit frame
const PIANO_POS = (() => {
  const c = Math.cos(SIT.rotY), s = Math.sin(SIT.rotY);
  return {
    x: SIT.x + PIANO_REL.x * c + PIANO_REL.z * s,
    z: SIT.z - PIANO_REL.x * s + PIANO_REL.z * c,
  };
})();
const PIANO_ROT = SIT.rotY + PIANO_REL.rotY;
// deliberate piano shot (user-approved): from the back side of the piano,
// elevated over the case — keys + case edge in the foreground, zoom on her
// face as she plays
const PIANO_CAM_POS = new THREE.Vector3(SIT.x - 2.0, 1.62, SIT.z + 0.28);
const PIANO_CAM_LOOK = new THREE.Vector3(SIT.x + 0.1, 1.42, SIT.z + 0.02);
// measured world footprint of the placed prop (+margin) — walk paths route
// around this box instead of straight through it
const PIANO_BOX = { minX: -1.75, maxX: 0.55, minZ: -1.0, maxZ: 1.25 };

function inPianoBox(x: number, z: number){
  return x > PIANO_BOX.minX && x < PIANO_BOX.maxX && z > PIANO_BOX.minZ && z < PIANO_BOX.maxZ;
}
function segHitsPiano(sx: number, sz: number, tx: number, tz: number){
  if(inPianoBox(sx, sz) || inPianoBox(tx, tz)) return true;
  const dx = tx - sx, dz = tz - sz;
  let t0 = 0, t1 = 1;
  const slabs: [number, number, number, number][] = [
    [sx, dx, PIANO_BOX.minX, PIANO_BOX.maxX],
    [sz, dz, PIANO_BOX.minZ, PIANO_BOX.maxZ],
  ];
  for(const [p, d, lo, hi] of slabs){
    if(Math.abs(d) < 1e-6){ if(p < lo || p > hi) return false; }
    else {
      let a = (lo - p) / d, b = (hi - p) / d;
      if(a > b){ const t = a; a = b; b = t; }
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if(t0 > t1) return false;
    }
  }
  return true;
}
function pianoCornerDetour(sx: number, sz: number, tx: number, tz: number){
  let bx = PIANO_BOX.maxX, bz = PIANO_BOX.maxZ, best = Infinity;
  for(const cx of [PIANO_BOX.minX, PIANO_BOX.maxX]){
    for(const cz of [PIANO_BOX.minZ, PIANO_BOX.maxZ]){
      // keep detours on the visible disc
      const len = Math.hypot(cx, cz);
      const k = len > 1.6 ? 1.6/len : 1;
      const cost = Math.hypot(cx - sx, cz - sz) + Math.hypot(tx - cx*k, tz - cz*k);
      if(cost < best){ best = cost; bx = cx*k; bz = cz*k; }
    }
  }
  return { x: bx, z: bz };
}

// Mixamo clips ship in the FBX import frame (cm-scale armature node); Saphira
// plays in meters. Verified 3mm vs Blender ground truth: bake the armature
// node's world matrix into Hips tracks, cm->m on the rest, play the rest
// verbatim. three.js has no rest/pose split — hierarchy + locals is everything.
function convertClipForSaphira(gltf: any): THREE.AnimationClip[] {
  const clip = (gltf.animations as THREE.AnimationClip[])[0];
  if (!clip) return [];
  let armNode: THREE.Object3D | null = null;
  const bones: THREE.Object3D[] = [];
  gltf.scene.traverse((o: THREE.Object3D) => { if (o.type === 'Bone') bones.push(o); });
  if (!bones.length) return [clip];
  let top: THREE.Object3D = bones[0];
  while (top.parent && top.parent !== gltf.scene) top = top.parent;
  armNode = top;
  armNode.updateWorldMatrix(true, false);
  const M = armNode.matrixWorld.clone();
  const Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3();
  M.decompose(P, Q, S);
  const out: THREE.AnimationClip[] = [];
  // NOTE: track names from GLTFLoader are already colon-stripped (mixamorigHips)
  for (const t of clip.tracks as any[]) {
    const dot = t.name.lastIndexOf('.');
    const bone = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
    const nt = t.clone();
    if (/Hips/.test(bone)) {
      const n = t.values.length / (prop === 'quaternion' ? 4 : 3);
      for (let i = 0; i < n; i++) {
        if (prop === 'position') {
          const v = new THREE.Vector3(t.values[i * 3], t.values[i * 3 + 1], t.values[i * 3 + 2]).applyMatrix4(M);
          nt.values[i * 3] = v.x; nt.values[i * 3 + 1] = v.y; nt.values[i * 3 + 2] = v.z;
        } else if (prop === 'quaternion') {
          const q = new THREE.Quaternion(t.values[i * 4], t.values[i * 4 + 1], t.values[i * 4 + 2], t.values[i * 4 + 3]);
          q.premultiply(Q).normalize();
          nt.values[i * 4] = q.x; nt.values[i * 4 + 1] = q.y; nt.values[i * 4 + 2] = q.z; nt.values[i * 4 + 3] = q.w;
        }
      }
    } else if (prop === 'position') {
      for (let i = 0; i < nt.values.length; i++) nt.values[i] *= 0.01;
    }
    out.push(nt);
  }
  return [new THREE.AnimationClip(clip.name, -1, out as any)];
}

// expression -> mood glow color (null = no tint, just the theme light)
const MOODS: Record<Expression, string | null> = {
  neutral: null, happy: '#ffcf5c', excited: '#ff7ab8', sad: '#6b9dff',
  surprised: '#c39bff', thinking: '#8fd0c5', annoyed: '#ff6b5e', blush: '#ff9eb0',
};

function shortAngle(a:number){ return Math.atan2(Math.sin(a), Math.cos(a)); }

export class SaphiraAvatar {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  private raf = 0;
  private clock = new THREE.Clock();
  private root: THREE.Group;
  private model: THREE.Group | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private acts = new Map<string, THREE.AnimationAction>();
  private base: 'idle'|'talk' = 'idle';
  private oneShot: THREE.AnimationAction | null = null;
  private faceMode = false;
  private homePos = new THREE.Vector3();
  private homeLook = new THREE.Vector3();
  private facePos = new THREE.Vector3();
  private faceLook = new THREE.Vector3();
  private lookCur = new THREE.Vector3(0, 1, 0);
  private lookGoalTmp = new THREE.Vector3();
  private camGoalTmp = new THREE.Vector3();
  private framed = false;
  private onFinish = (e:any)=>{
    if(this.oneShot && e.action===this.oneShot){
      const was = this.oneShot.getClip().name.toLowerCase();
      this.oneShot=null;
      this.toBase(0.35);
      // piano ring-out: the phrase's last notes keep decaying while she gets
      // up — don't stopPianoPhrase here, the song cleans itself up
      if(was==='piano' && this.staging){
        this.staging='';
        // step out from the bench toward the user (standing put puts her legs
        // through where the bench was), clear of the prop footprint
        this.hasVia=false;
        this.wanderTarget.set(SIT.x + 0.08, 0, SIT.z + 1.25);
        const w=this.acts.get('wander') ?? this.acts.get('walk');
        if(w){ w.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.4).play(); this.wanderMode='walk'; }
        else this.wanderMode='turnBack';
      }
    }
  };
  private talking=false;
  private lookX=0; private lookY=0;
  // ponytail: no pointer on iPad — random gaze targets keep her looking around
  // like she follows the mouse on desktop; desktop joins in after 4s idle
  private lastPointer=0; private gazeX=0; private gazeY=0; private gazeUntil=0;
  private baseY=0;
  private modelH=2.2;
  private headY=1.9;
  private walkSpeed=0.55;
  private lightKey!: THREE.DirectionalLight;
  private lightFill!: THREE.DirectionalLight;
  private lightRim!: THREE.DirectionalLight;
  private ambient!: THREE.AmbientLight;
  private moodLight!: THREE.PointLight;
  private moodTarget = new THREE.Color('#ffffff');
  private moodAmt = 0; // 0 = neutral theme light, 1 = full mood glow
  private baseBg = new THREE.Color('#ece9e3'); // theme bg before mood tint
  private ground!: THREE.Mesh;
  private groundMat!: THREE.MeshStandardMaterial;
  private shadow!: THREE.Mesh;
  private canvas: HTMLCanvasElement;
  private theme: Theme = (localStorage.getItem('saphira_theme') as Theme) || 'auto';
  private blend = 0; // 0 = day, 1 = night
  private themeTimer: number | null = null;
  private blendTarget = 0;

  // rig hooks for the procedural "life" layer
  private headBone: THREE.Object3D | null = null;
  private neckBone: THREE.Object3D | null = null;
  private spineBone: THREE.Object3D | null = null;
  private hipsBone: THREE.Object3D | null = null;
  private hipsBindX = 0; private hipsBindZ = 0;
  private footBones: THREE.Object3D[] = [];
  private footBindY: number[] = [];
  private footTmp = new THREE.Vector3();
  private lastLift = 0;
  private lidBone: THREE.Object3D | null = null;
  private animated = new Set<string>(); // node names driven by baked clips
  private headBaseQ = new THREE.Quaternion();
  private neckBaseQ = new THREE.Quaternion();
  private spineBaseQ = new THREE.Quaternion();
  private lidBaseQ = new THREE.Quaternion();
  private track = { yaw:0, pitch:0, tilt:0 };
  private glanceUntil = 0; private glanceYaw = 0;
  private tiltUntil = 0; private tiltAmt = 0;
  private breathT = Math.random()*10;
  private blinkAt = 3; private blinkT = -1;

  // wandering
  private wanderMode: 'none'|'walk'|'turnBack' = 'none';
  private wanderTarget = new THREE.Vector3();
  private lifeTimer: number | null = null;

  // piano: clip loads async, gated by the ready flag.
  // staging walks her to the bench; cleared when the piano clip finishes.
  private pianoReady = false;
  private staging: '' | 'piano-walk' | 'piano-turn' | 'piano-play' = '';
  private lastPiano = Date.now();      // auto-piano cooldown stamp
  private pianoEndTimer: number | null = null;
  private pianoRequested = false;      // explicit request: survives conversation
  private pianoEveryMs = 5*60*1000;    // settings: cooldown between performances
  private pianoLenS = 30;              // settings: performance length in seconds
  // intermediate waypoint when a walk path would cross the piano footprint
  private via = new THREE.Vector3();
  private hasVia = false;

  // ponytail: legacy = iPad Air 1 / iOS 12 — WebGL1 + 1GB RAM, kill the expensive bits but keep her look
  private isLegacy = false;
  private legacyFpsAcc = 0;
  private zoom = 1; // >1 = closer. Settings slider, multiplies on top of the legacy idle crop.
  constructor(canvas: HTMLCanvasElement, zoom = 1){
    (window as any).__saphiraAvatar = this;
    this.canvas=canvas;
    this.zoom = this.clampZoom(zoom);
    this.isLegacy = this.detectLegacy();
    if(this.isLegacy) try{ document.documentElement.classList.add('legacy'); }catch{}
    this.scene = new THREE.Scene();
    // background is the CSS photo layer (see .stage in style.css) — the canvas
    // renders transparent so the image shows through; no fog to tint it
    this.scene.background = null;
    this.scene.fog = null;
    const w = canvas.clientWidth||800, h=canvas.clientHeight||800;
    this.camera = new THREE.PerspectiveCamera(34, w/h, 0.1, 100);
    this.camera.position.set(0, 1.1, 4.6);
    const isLow = window.matchMedia('(max-width: 768px)').matches || this.isLegacy;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !isLow && !this.isLegacy, alpha:true, powerPreference:'low-power' });
    // ponytail: iPad Air caps at 1× — 1.6× would 2.5× fill rate and OOM
    const dprCap = this.isLegacy ? 1 : (isLow?1.25:1.6);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, dprCap));
    this.renderer.setSize(w,h,false);
    (this.renderer as any).outputColorSpace = (THREE as any).SRGBColorSpace || (THREE as any).NoColorSpace;
    // AgX needs WebGL2 — iPad Air 1 is WebGL1 only, fall back to NoToneMapping
    // (materials stay readable because most are toneMapped=false below)
    const hasWebGL2 = !!document.createElement('canvas').getContext('webgl2');
    if(this.isLegacy || !hasWebGL2){
      this.renderer.toneMapping = THREE.NoToneMapping;
    } else {
      this.renderer.toneMapping = THREE.AgXToneMapping ?? THREE.NoToneMapping;
    }
    this.renderer.toneMappingExposure = 1.0;
    if(this.isLegacy){
      // extra safety: clamp anisotropy + disable shadows (none used now, but future-proof)
      try{ (this.renderer as any).capabilities.getMaxAnisotropy = ()=>1; }catch{}
    }

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.addLights();
    this.addGround();
    this.blend = this.resolved()==='night' ? 1 : 0;
    this.blendTarget = this.blend;
    document.documentElement.dataset.theme = this.resolved();
    this.applyTheme(this.blend);
    this.loadModel();
    this.themeTimer = window.setInterval(()=>{ if(this.theme==='auto') this.applyTarget(); }, 60000);
    window.addEventListener('resize', ()=> this.resize());
    canvas.addEventListener('pointermove', e=>{
      const r=canvas.getBoundingClientRect();
      this.lookX = ((e.clientX - r.left)/r.width -0.5)*1.0;
      this.lookY = ((e.clientY - r.top)/r.height -0.5)*0.55;
      this.lastPointer = performance.now()/1000;
    });
    this.animate();
  }

  private detectLegacy(): boolean {
    try{
      // test escape hatch: ?legacy=1 forces the Air path (UA can't be spoofed easily)
      try{ if(new URLSearchParams(location.search).has('legacy')) return true; }catch{}
      const ua = navigator.userAgent||'';
      const isIOS12 = /OS 12_|CPU OS 12_/.test(ua) || /iPad.*OS 12_/.test(ua);
      const lowMem = (navigator as any).deviceMemory && (navigator as any).deviceMemory <= 2;
      const fewCores = typeof navigator.hardwareConcurrency==='number' && navigator.hardwareConcurrency <= 2;
      const noWebGL2 = !document.createElement('canvas').getContext('webgl2');
      // iPad Air 1 = A7 / 1GB / no WebGL2 — any one of these triggers the lean path
      return isIOS12 || (noWebGL2 && (lowMem || fewCores)) || /iPad.*AppleWebKit.*Version\/12\./.test(ua);
    }catch{ return false; }
  }

  // ---- theme ----
  getTheme(): Theme { return this.theme; }  setTheme(m: Theme){
    this.theme=m;
    localStorage.setItem('saphira_theme', m);
    document.documentElement.dataset.theme = this.resolved();
    this.applyTarget();
  }
  resolved(): 'day'|'night'{
    if(this.theme==='day') return 'day';
    if(this.theme==='night') return 'night';
    const h=new Date().getHours();
    return (h>=7 && h<19) ? 'day' : 'night';
  }
  // ---- zoom (settings slider) ----
  private clampZoom(z: number){
    const n = Number(z);
    if(!isFinite(n)) return 1;
    return Math.min(1.6, Math.max(0.7, n));
  }
  setZoom(z: number){
    this.zoom = this.clampZoom(z);
    this.fitCamera();
  }
  private applyTarget(){
    const t = this.resolved()==='night' ? 1 : 0;
    // snap dataset for CSS, blend animates canvas smoothly
    document.documentElement.dataset.theme = this.resolved();
    this.blendTarget=t;
  }
  private applyTheme(b: number){
    if(this.scene.background) (this.scene.background as THREE.Color).copy(DAY_BG).lerp(NIGHT_BG, b);
    this.baseBg.copy(DAY_BG).lerp(NIGHT_BG, b);
    this.groundMat.color.copy(DAY_GROUND).lerp(NIGHT_GROUND, b);
    this.ambient.intensity = 0.72 - b*0.34;   // 0.72 day -> 0.38 night
    this.lightKey.intensity = 0.55 - b*0.39;  // 0.55 -> 0.16
    this.lightKey.color.copy(DAY_KEY).lerp(NIGHT_KEY, b);
    this.lightFill.intensity = 0.28 - b*0.18; // 0.28 -> 0.10
    this.lightRim.intensity = 0.18 + b*0.16;  // 0.18 -> 0.34
  }

  private addLights(){
    this.ambient = new THREE.AmbientLight(0xffffff, 0.72);
    this.scene.add(this.ambient);
    this.lightKey = new THREE.DirectionalLight(0xfff6ee, 0.55);
    this.lightKey.position.set(2.2, 3.2, 3);
    this.scene.add(this.lightKey);
    this.lightFill = new THREE.DirectionalLight(0xdfe6ff, 0.28);
    this.lightFill.position.set(-2, 1.2, -1);
    this.scene.add(this.lightFill);
    this.lightRim = new THREE.DirectionalLight(0xffffff, 0.18);
    this.lightRim.position.set(0, 2, -3);
    this.scene.add(this.lightRim);
    // mood glow: tinted halo washing over her, pulsing in the animate loop
    this.moodLight = new THREE.PointLight(0xffffff, 0, 9);
    this.moodLight.position.set(1.6, 2.4, 2.2);
    this.scene.add(this.moodLight);
  }
  private addGround(){
    // ponytail: the backdrop is the CSS photo layer behind the transparent
    // canvas — only the rug disc + contact shadow render under her feet
    // ponytail: 32/28 segs is overkill on A7 — 20 segs looks same at distance
    const segs = this.isLegacy ? 20 : 32;
    const shSegs = this.isLegacy ? 16 : 28;
    // ponytail: disc r=1.7 — wander corners (±1.05, 0.65) walked off the old r=1.1
    // disc and she read as sunk below the floor
    const g = new THREE.CircleGeometry(1.7, segs);
    this.groundMat = new THREE.MeshStandardMaterial({ color:0xe8e5df, roughness:0.95 });
    this.ground = new THREE.Mesh(g, this.groundMat);
    this.ground.rotation.x = -Math.PI/2;
    this.ground.position.y = 0;
    this.scene.add(this.ground);
    const sh = new THREE.Mesh(new THREE.CircleGeometry(0.85, shSegs), new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:0.12 }));
    sh.rotation.x = -Math.PI/2; sh.position.y = 0.005; this.scene.add(sh);
    this.shadow = sh;
  }

  // bind-pose bounds measured from base positions — Box3.setFromObject
  // mis-measures SkinnedMesh (bone-dependent boxes), so do it manually.
  private measure(obj: THREE.Object3D): THREE.Box3{
    obj.updateMatrixWorld(true);
    const box=new THREE.Box3();
    const v=new THREE.Vector3();
    obj.traverse((o:any)=>{
      if(!o.isMesh) return;
      const pos=o.geometry?.attributes?.position;
      if(!pos) return;
      for(let i=0;i<pos.count;i++){
        v.fromBufferAttribute(pos,i).applyMatrix4(o.matrixWorld);
        box.expandByPoint(v);
      }
    });
    return box;
  }

  private loadModel(){
    const loader = new GLTFLoader();
    const url = '/model/ai_ohto.glb';
    loader.load(url, (gltf)=>{
      const obj = gltf.scene;
      // normalize: scale to target height first, then ground + center
      const box0 = this.measure(obj);
      const size0 = new THREE.Vector3(); box0.getSize(size0);
      const h0 = Math.max(size0.y, 0.001);
      const s = 2.2 / h0;
      obj.scale.setScalar(s);
      const box1 = this.measure(obj);
      const c1 = new THREE.Vector3(); box1.getCenter(c1);
      obj.position.x -= c1.x;
      obj.position.z -= c1.z;
      obj.position.y -= box1.min.y; // feet on ground y=0
      obj.traverse((o:any)=>{
        if(o.isMesh){
          if(o.material){
            const mats = Array.isArray(o.material)? o.material : [o.material];
            mats.forEach((m:any)=>{
              if(m.map){
                m.map.colorSpace = THREE.SRGBColorSpace;
                // ponytail: legacy caps anisotropic filtering — free 10% VRAM/bandwidth
                if(this.isLegacy){ try{ m.map.anisotropy = 1; m.map.minFilter = THREE.LinearFilter; }catch{} }
              }
              if(m.emissiveMap){
                m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
                if(this.isLegacy){ try{ m.emissiveMap.anisotropy = 1; m.emissiveMap.minFilter = THREE.LinearFilter; }catch{} }
              }
              // exporter leaves metallic=1 defaults on skin/hair/eyes; that turns
              // the light rig into blowout. Flat stylized shading instead.
              if(m.isMeshStandardMaterial){
                m.metalness = 0;
                m.roughness = Math.max(m.roughness ?? 1, 0.92);
                m.envMapIntensity = 0;
                // Pure Mixamo mats are flat gray 0.8 with no emissive — make them
                // self-lit so she shows in both day and night, without reusing
                // any old Saphira textures.
                if(m.color && m.emissive && m.emissive.r===0 && m.emissive.g===0 && m.emissive.b===0 && !m.emissiveMap && m.color.r>0.5){
                  m.emissive.copy(m.color);
                  m.emissiveIntensity = 0.35;
                }
                const nm = (m.name||'').toLowerCase();
                // 'skin matrial' (face+limbs) ships black-base + full-white
                // emissiveMap, which blows the limbs out to flat glowing white.
                // Skin-tone base + tamed emissive keeps the face decals readable
                // while letting diffuse light model the arms and legs.
                if(nm.includes('skin matrial')){
                  m.color.set('#f9e7da');
                  m.emissive.set('#f9e7da');
                  m.emissiveIntensity = 0.5;
                  // cel colors are authored, not lit: AgX desaturates them gray
                  m.toneMapped = false;
                }
                // 'yellow clouth' (hoodie) is black-base lit only by its
                // sunflower emissiveMap — flat, no fold shading. A yellow base
                // restores diffuse depth; the map still provides the flower.
                if(nm.includes('yellow clouth')){
                  m.color.set('#f2d230');
                  m.emissive.set('#ffffff');
                  m.emissiveIntensity = 0.55;
                  m.toneMapped = false;
                }
                // other skin parts (neck, thighs) share the same pale tone —
                // keep them raw too so all skin matches under AgX
                if(nm.includes('skin sharder')){
                  m.toneMapped = false;
                }
                // eyes were flat glowing white (emissive=1, tonemapped) — no
                // iris contrast and harsh under AgX. Non-emissive glossy white
                // gives a proper highlight.
                if(nm.includes('eye whithu') || nm.includes('eye brow')){
                  if(nm.includes('whithu')){
                    m.color.set('#ffffff');
                    m.emissive.set('#000000');
                    m.emissiveIntensity = 0;
                    m.roughness = 0.32;
                    m.toneMapped = false;
                  } else {
                    // brow: keep dark but kill the faint emissive lift
                    m.emissive.set('#000000');
                    m.emissiveIntensity = 0;
                    m.roughness = 0.85;
                    m.toneMapped = false;
                  }
                  m.metalness = 0;
                }
                // hair clips / hair: keep but ensure not washed
                if(nm.includes('hair')){
                  m.toneMapped = false;
                }
              }
              m.side = THREE.DoubleSide;
              m.needsUpdate = true;
            });
          }
          o.frustumCulled = false;
        }
      });
      this.model = obj;
      this.root.add(obj);
      // baked clips: idle/talk/wander loop, others one-shots (Mixamo rig)
      try{
        const clips=((gltf as any).animations || []) as THREE.AnimationClip[];
        if(clips.length){
          this.mixer=new THREE.AnimationMixer(obj);
          this.mixer.addEventListener('finished', this.onFinish);
          for(const c of clips){
            const a=this.mixer.clipAction(c);
            const n=c.name.toLowerCase();
            if(n==='idle' || n==='talk' || n==='wander'){ a.setLoop(THREE.LoopRepeat, Infinity); }
            else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished=true; }
            this.acts.set(n, a);
          }
          this.acts.get('idle')?.play();
          // which nodes do the clips drive? procedural layer must not fight them
          for(const c of clips){
            for(const t of (c as any).tracks) this.animated.add(String(t.name).split('.').slice(0,-1).join('.'));
          }
          const w = this.acts.get('wander') ?? this.acts.get('walk');
          // ponytail: brisk strolls — stride at full rate so feet match ground speed
          if(w) this.walkSpeed = this.isLegacy ? 0.45 : 0.6;
          for(const k of ['wander','walk']){ const a=this.acts.get(k); if(a) a.timeScale = this.isLegacy ? 0.8 : 1.0; }
          const yw=this.acts.get('yawn'); if(yw) yw.timeScale = 0.95;
          const rs=this.acts.get('raise'); if(rs) rs.timeScale = 1.0;
        }
      }catch{ this.mixer=null; }
      // rig hooks for head tracking / blinking / breathing
      // Mixamo skeleton uses mixamorig:Head/Neck/Spine; custom rig used head/neck/spine/lid
      const findBone = (names: string[])=>{
        for(const n of names){ const b=obj.getObjectByName(n); if(b) return b as THREE.Object3D; }
        // GLTFLoader strips ':' from node names (mixamorig:Hips -> mixamorigHips),
        // so fall back to a colon-insensitive + case-insensitive match
        const norm = (s:string)=> String(s).toLowerCase().replace(/:/g,'');
        const want = new Set(names.map(norm));
        let found: THREE.Object3D | null = null;
        obj.traverse((o:any)=>{ if(!found && o.name && want.has(norm(o.name))) found=o as THREE.Object3D; });
        return found;
      };
      this.headBone = findBone(['mixamorig:Head','Head','head']) ?? null;
      this.neckBone = findBone(['mixamorig:Neck','Neck','neck']) ?? null;
      this.spineBone = findBone(['mixamorig:Spine','mixamorig:Spine1','Spine','spine']) ?? null;
      this.hipsBone = findBone(['mixamorig:Hips','Hips','hips']) ?? null;
      if(this.hipsBone){ this.hipsBindX = this.hipsBone.position.x; this.hipsBindZ = this.hipsBone.position.z; }
      // sampled in Blender (foot minZ, rest=0.017): idle/nod grounded, but every
      // Mixamo clip carries its own root height — talk/walk/wander/wave/raise sit
      // ~1.3 below bind (head-only above the disc), yawn ~2.5 (fully submerged).
      // Record ankle/toe bind heights; the animate loop lifts each clip back up.
      this.footBones = ['mixamorig:LeftFoot','mixamorig:RightFoot','mixamorig:LeftToeBase','mixamorig:RightToeBase']
        .map(n=>findBone([n])).filter((b):b is THREE.Object3D=>!!b);
      try{
        this.model.updateMatrixWorld(true);
        this.footBindY = this.footBones.map(b=>b.getWorldPosition(new THREE.Vector3()).y);
      }catch{ this.footBindY = []; }
      this.lidBone = findBone(['lid','mixamorig:HeadTop_End']) ?? null;
      // lid on Mixamo is just a tip bone — don't use it for blinking if it's not a lid
      if(this.lidBone && this.lidBone.name.includes('HeadTop')) this.lidBone=null;
      this.headBaseQ = this.headBone? this.headBone.quaternion.clone() : this.headBaseQ;
      this.neckBaseQ = this.neckBone? this.neckBone.quaternion.clone() : this.neckBaseQ;
      this.spineBaseQ = this.spineBone? this.spineBone.quaternion.clone() : this.spineBaseQ;
      this.lidBaseQ = this.lidBone? this.lidBone.quaternion.clone() : this.lidBaseQ;
      this.baseY = obj.position.y;
      const box2 = this.measure(obj);
      const size2 = new THREE.Vector3(); box2.getSize(size2);
      this.modelH = size2.y;
      this.blendTarget = this.resolved()==='night' ? 1 : 0;
      // spawn east of the piano's keyboard — the flipped grand's keybed passes
      // through the old origin spot, and she mustn't idle inside it
      this.model.position.set(0.55, this.model.position.y, 0.35);
      this.fitCamera();
      this.scheduleLife();
      // ---- piano clip: Mixamo anim GLB converted at runtime ----
      const registerClips = (gltf:any)=>{
        if(!this.mixer) return;
        for(const c of convertClipForSaphira(gltf)){
          const a=this.mixer.clipAction(c);
          a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished=true;
          this.acts.set(c.name.toLowerCase(), a);
        }
      };
      loader.load('/model/anim_piano.glb', (gltf:any)=>{ registerClips(gltf); }, undefined, ()=>{});
      // ---- grand piano prop (placement measured against her seated pose) ----
      loader.load('/model/piano.glb', (gltf:any)=>{
        const p = gltf.scene as THREE.Group;
        p.position.set(PIANO_POS.x, 0, PIANO_POS.z);
        p.rotation.y = PIANO_ROT;
        p.traverse((o:any)=>{
          if(o.isMesh){
            const mats = Array.isArray(o.material)? o.material : [o.material];
            mats.forEach((m:any)=>{ if(m.isMeshStandardMaterial){ m.metalness=0; m.envMapIntensity=0; } });
          }
        });
        // no bench: she performs behind the case, hidden by the camera shot
        for(const n of ['Piano_BenchFrame','Piano_BenchCushion']){
          const b = p.getObjectByName(n); if(b) p.remove(b);
        }
        this.scene.add(p);
        this.pianoReady = true;
      }, undefined, ()=>{});
      window.dispatchEvent(new CustomEvent('saphira:load', {detail:{pct:100, done:true}}));
    }, (e:any)=>{
      if(e.lengthComputable){
        const pct=Math.round(e.loaded/e.total*100);
        window.dispatchEvent(new CustomEvent('saphira:load', {detail:{pct}}));
      }
    }, (err:any)=>{
      const msg=(err?.message||err?.target?.statusText||String(err||'load failed')).slice(0,120);
      console.error('[Saphira] model load failed', err);
      window.dispatchEvent(new CustomEvent('saphira:load', {detail:{pct:100, error:true, message:msg}}));
    });
  }

  private fitCamera(){
    if(!this.model) return;
    const H=this.modelH, W=1.0; // approx width incl. arms
    const vTan=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2));
    const aspect=this.camera.aspect||1;
    // reserve bottom 26% of screen for the input dock
    const usable=0.74;
    const distV=(H/2)/(vTan*usable);
    const distH=(W/2)/(vTan*aspect);
    const dist=Math.max(distV,distH)*1.0;
    const cy=H*(this.isLegacy ? 0.60 : 0.52); // legacy idle crops to torso-up so her face reads at dpr 1
    const homeDist = dist*(this.isLegacy ? 0.62 : 1.0)/this.zoom;
    this.homePos.set(0, cy+0.06, homeDist);
    this.homeLook.set(0, cy, 0);
    // face closeup: the rig's bone world positions sit in a crumpled bind
    // space (skinning compensates), so frame on the rendered proportions —
    // head center ≈ 0.85 of body height
    const faceY = this.baseY + H*0.85;
    this.facePos.set(0, faceY+0.02, dist*0.52/this.zoom);
    this.faceLook.set(0, faceY, 0);
    if(!this.faceMode){
      this.camera.position.copy(this.homePos);
      this.lookCur.copy(this.homeLook);
      this.camera.lookAt(this.lookCur);
    }
    this.framed=true;
  }

  // ---- life scheduling: wander, gestures, glances ----
  private scheduleLife(delay?: number){
    if(this.lifeTimer) window.clearTimeout(this.lifeTimer);
    this.lifeTimer = window.setTimeout(()=> this.lifeTick(), delay ?? (6500 + Math.random()*6500));
  }
  private lifeTick(){
    if(document.hidden){ this.scheduleLife(9000); return; }
    const idle = this.wanderMode==='none' && !this.busy && !this.talking;
    if(idle){
      const r=Math.random();
      // walks + hand raises + yawns + a rare piano piece (cooldown: once per
      // 5 min). Dance/laugh (wave/wave_small) never play on their own — only
      // on explicit chat request via playGest.
      if(r<0.38){ this.startWander(); }
      else if(r<0.56){ this.playOnce('raise'); }
      else if(r<0.72){ this.playOnce('yawn'); }
      else if(r<0.82 && this.pianoReady && Date.now()-this.lastPiano > this.pianoEveryMs){ this.startPiano(); }
      else if(r<0.94){ this.startGlance(); }
      else {
        this.tiltAmt = (Math.random()<0.5?-1:1)*0.09;
        this.tiltUntil = performance.now()/1000 + 2.2 + Math.random()*1.5;
      }
    }
    this.scheduleLife();
  }
  // pick a wander target that isn't inside the piano zone, plus a waypoint
  // when the straight path there would cross the prop footprint
  private setVia(tx:number, tz:number){
    const p=this.model!.position;
    const sIn = inPianoBox(p.x, p.z), tIn = inPianoBox(tx, tz);
    if(sIn && !tIn){
      // standing within the footprint margin (home is inside it) — step out
      // through the nearest edge first, then the coast is clear
      const cx = Math.min(Math.max(p.x, PIANO_BOX.minX + 0.1), PIANO_BOX.maxX - 0.1);
      const cz = Math.min(Math.max(p.z, PIANO_BOX.minZ + 0.1), PIANO_BOX.maxZ - 0.1);
      const opts = [
        { d: PIANO_BOX.maxX + 0.1 - p.x, x: PIANO_BOX.maxX + 0.1, z: cz },
        { d: p.x - (PIANO_BOX.minX - 0.1), x: PIANO_BOX.minX - 0.1, z: cz },
        { d: PIANO_BOX.maxZ + 0.1 - p.z, x: cx, z: PIANO_BOX.maxZ + 0.1 },
        { d: p.z - (PIANO_BOX.minZ - 0.1), x: cx, z: PIANO_BOX.minZ - 0.1 },
      ].sort((a, b) => a.d - b.d)[0];
      this.via.set(opts.x, 0, opts.z);
      this.hasVia = true;
    } else if(!sIn && segHitsPiano(p.x, p.z, tx, tz)){
      const c = pianoCornerDetour(p.x, p.z, tx, tz);
      this.via.set(c.x, 0, c.z);
      this.hasVia = true;
    } else this.hasVia = false;
  }
  private startWander(){
    if(!this.model || !this.acts.has('wander')) return;
    const p=this.model.position;
    let tx=0, tz=0, ok=false;
    // first pass wants a proper stroll; the relaxed second pass just keeps
    // her stepping when the crescent offers no far spot (mid-park position)
    for(const minD of [0.5, 0.3]){
      for(let tries=0; tries<8 && !ok; tries++){
        // the grand owns the whole west half of the stage, so sample the free
        // east crescent — the old ±x sampler rejected every target it picked
        // (negative-x lands inside the piano box, and her spawn |x|>0.5 forced
        // exactly that side), which is why she stood still forever
        tx = 0.58 + Math.random()*0.45;
        tz = WANDER_Z_MIN + Math.random()*(WANDER_Z_MAX-WANDER_Z_MIN);
        // clamp onto the disc so she never steps off the edge
        const tr = Math.hypot(tx, tz);
        if(tr > WANDER_R){ tx *= WANDER_R/tr; tz *= WANDER_R/tr; }
        if(inPianoBox(tx, tz)) continue;
        if(Math.hypot(tx-p.x, tz-p.z) < minD) continue; // too close — the walk must read
        ok = true;
      }
      if(ok) break;
    }
    if(!ok) return; // nowhere worth stepping this round — stay put
    this.wanderTarget.set(tx, 0, tz);
    this.setVia(tx, tz);
    const a=this.acts.get('wander') ?? this.acts.get('walk');
    if(!a) return;
    a.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.35).play();
    this.wanderMode='walk';
  }
  private startGlance(){
    this.glanceYaw = (Math.random()<0.5?-1:1)*(0.25+Math.random()*0.3);
    this.glanceUntil = performance.now()/1000 + 1.2 + Math.random()*1.6;
  }
  // walk to the bench, settle facing the keys, then play for ~15s.
  // Autonomous plays are rare: once per 5 minutes (explicit requests bypass).
  private startPiano(force=false){
    if(!this.pianoReady || !!this.staging || !this.acts.has('piano')) return;
    if(!pianoOn()) return;                      // piano toggled off in settings
    if(!force && Date.now()-this.lastPiano < this.pianoEveryMs) return; // cooldown
    this.pianoRequested = force;   // explicit requests survive conversation
    // she might be mid-yawn — brush it aside, the walk takes over
    this.oneShot?.fadeOut(0.3);
    this.oneShot=null;
    this.staging='piano-walk';
    this.wanderTarget.set(SIT.x, 0, SIT.z);
    this.setVia(SIT.x, SIT.z);
    const a=this.acts.get('wander') ?? this.acts.get('walk');
    if(!a){ this.staging=''; return; }
    a.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.35).play();
    this.wanderMode='walk';
  }
  // cut a performance short (settings toggle flipped off mid-play)
  stopPiano(){ this.endPiano(); }
  setPianoEvery(min:number){ this.pianoEveryMs = Math.max(1, Math.min(60, min||5))*60*1000; }
  setPianoLength(sec:number){ this.pianoLenS = Math.max(10, Math.min(120, sec||30)); }
  private endPiano(){
    if(this.pianoEndTimer){ window.clearTimeout(this.pianoEndTimer); this.pianoEndTimer=null; }
    if(this.oneShot && this.oneShot.getClip().name.toLowerCase()==='piano'){
      this.oneShot=null;
      this.toBase(0.4);
      this.pianoRequested=false;
      this.staging='';
      this.hasVia=false;
      // step out from in front of the keys toward the user, clear of the prop
      this.wanderTarget.set(SIT.x + 0.08, 0, SIT.z + 1.25);
      const w=this.acts.get('wander') ?? this.acts.get('walk');
      if(w){ w.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.4).play(); this.wanderMode='walk'; }
      else this.wanderMode='turnBack';
    } else {
      this.staging='';
      this.pianoRequested=false;
    }
  }

  // Chat replies never trigger body-language clips: this set has no true
  // wave/nod/shrug — 'wave' is a 6s hip-hop dance, 'nod' is a 19s angry
  // arms-crossed loop, 'wave_small' is a 10s laugh. Any of them hijacks her
  // mid-conversation (Gemini says gesture:"wave" on plain greetings), so
  // normal replies stay on talk/idle + head tracking. The dance plays only on
  // explicit user request via playGest('wave') from the chat handler.
  setExpression(_expr: Expression, _intensity=0.7, _gesture: Gesture='none'){
    /* quiet by default */
    // ...but the mood glow always follows the feeling
    const c = MOODS[_expr];
    if(c){ this.moodTarget.set(c); this.moodAmt = 0.35 + 0.65*_intensity; }
    else this.moodAmt = 0;
  }
  // expose for UI debug / manual triggers
  playGest(name: string){
    if(name==='piano'){ this.startPiano(true); return; }
    this.playOnce(name);
  }
  listGestures(){ return [...this.acts.keys()]; }
  // one-line state for the ?debug=1 overlay
  debugInfo(){
    const my = this.model ? this.model.position.y.toFixed(2) : 'no-model';
    const one = this.oneShot ? (this.oneShot.getClip().name) : '-';
    return `build ${BUILD} | acts [${[...this.acts.keys()].join(',')}] | feet ${this.footBones.length} lift ${this.lastLift.toFixed(2)} y ${my} baseY ${this.baseY.toFixed(2)} mode ${this.wanderMode} one:${one}${this.talking?'/talking':''}`;
  }
  get busy(){ return this.oneShot!==null; }
  setTalking(on:boolean){
    this.talking=on;
    // an autonomous walk to the piano yields to the conversation; an explicit
    // one ("play piano") continues — she plays while her reply speaks
    if(on && this.staging==='piano-walk' && !this.pianoRequested){
      this.staging='';
      this.hasVia=false;
    }
    if(on && this.wanderMode!=='none' && this.staging!=='piano-walk'){
      // stop mid-step and turn to face the user; zoom waits until she faces us
      (this.acts.get('wander') ?? this.acts.get('walk'))?.fadeOut(0.3);
      this.wanderMode='turnBack';
    }
    this.faceMode = on && this.wanderMode==='none';
    const want = (on && this.acts.has('talk')) ? 'talk' : 'idle';
    if(this.mixer && want!==this.base){
      this.acts.get(this.base)?.fadeOut(0.7);
      this.base=want as 'idle'|'talk';
      this.toBase(0.7);
    }
  }
  private baseAction(){ return this.acts.get(this.base) ?? this.acts.get('idle'); }
  private toBase(dur=0.4){
    const b=this.baseAction();
    if(!b) return;
    b.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(dur).play();
  }
  private playOnce(name:string){
    if(!this.mixer) return;
    const a=this.acts.get(name);
    if(!a || this.oneShot===a) return;
    this.oneShot?.fadeOut(0.2);
    this.baseAction()?.fadeOut(0.25);
    this.oneShot=a;
    a.reset().setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished=true;
    a.fadeIn(0.25).play();
  }

  // procedural layer: head tracking, blinking, breathing — applied after the
  // mixer so it adds on top of the baked clips instead of fighting them.
  private applyLife(dt:number){
    if(!this.model) return;
    this.breathT += dt;
    const nowS = performance.now()/1000;
    // no mouse lately (always true on touch) — drift the gaze between random
    // screen points instead of staring dead ahead
    if(nowS - this.lastPointer > 4){
      if(nowS > this.gazeUntil){
        this.gazeX = (Math.random()*2-1)*0.5;
        this.gazeY = (Math.random()*2-1)*0.28;
        this.gazeUntil = nowS + 1.8 + Math.random()*2.5;
      }
      const gk = 1 - Math.exp(-1.8*dt);
      this.lookX += (this.gazeX - this.lookX)*gk;
      this.lookY += (this.gazeY - this.lookY)*gk;
    }
    const k = 1 - Math.exp(-6*dt);
    const gYaw = THREE.MathUtils.clamp(this.lookX*1.1, -0.55, 0.55) + (nowS<this.glanceUntil ? this.glanceYaw : 0);
    const gPitch = THREE.MathUtils.clamp(-this.lookY*0.9, -0.35, 0.3);
    const gTilt = nowS<this.tiltUntil ? this.tiltAmt : 0;
    this.track.yaw += (gYaw-this.track.yaw)*k;
    this.track.pitch += (gPitch-this.track.pitch)*k;
    this.track.tilt += (gTilt-this.track.tilt)*k;
    const e=new THREE.Euler(); const q=new THREE.Quaternion();
    const driven=(o:THREE.Object3D|null)=> !!o && this.animated.has(o.name.replace(/:/g,''));
    if(this.headBone){
      e.set(this.track.pitch, this.track.yaw, this.track.tilt, 'YXZ');
      q.setFromEuler(e);
      if(driven(this.headBone)) this.headBone.quaternion.multiply(q);
      else this.headBone.quaternion.copy(this.headBaseQ).multiply(q);
    }
    if(this.neckBone){
      e.set(this.track.pitch*0.4, this.track.yaw*0.4, 0, 'YXZ');
      q.setFromEuler(e);
      if(driven(this.neckBone)) this.neckBone.quaternion.multiply(q);
      else this.neckBone.quaternion.copy(this.neckBaseQ).multiply(q);
    }
    if(this.spineBone){
      e.set(Math.sin(this.breathT*1.9)*0.02, 0, 0, 'YXZ');
      q.setFromEuler(e);
      if(driven(this.spineBone)) this.spineBone.quaternion.multiply(q);
      else this.spineBone.quaternion.copy(this.spineBaseQ).multiply(q);
    }
    // blink: 0.22s close-open cycle, next one in 2-6.5s
    if(this.blinkT<0 && this.clock.elapsedTime>this.blinkAt) this.blinkT=0;
    if(this.lidBone){
      if(this.blinkT>=0){
        this.blinkT+=dt;
        const D=0.22;
        if(this.blinkT>=D){ this.blinkT=-1; this.blinkAt=this.clock.elapsedTime+2+Math.random()*4.5; }
        else {
          const amt=Math.sin(Math.PI*(this.blinkT/D))*0.6;
          e.set(amt,0,0,'YXZ'); q.setFromEuler(e);
          if(driven(this.lidBone)) this.lidBone.quaternion.multiply(q);
          else this.lidBone.quaternion.copy(this.lidBaseQ).multiply(q);
        }
      } else if(!driven(this.lidBone)) this.lidBone.quaternion.copy(this.lidBaseQ);
    }
  }

  private animate = ()=>{
    this.raf=requestAnimationFrame(this.animate);
    // ponytail: legacy throttles to ~30fps — single getDelta per frame (double call froze mixer on Air)
    const rawDt = this.clock.getDelta();
    if(this.isLegacy){
      this.legacyFpsAcc += rawDt;
      if(this.legacyFpsAcc < 1/30){ return; }
    }
    const dt=Math.min(this.isLegacy ? this.legacyFpsAcc : rawDt, 0.05);
    if(this.isLegacy) this.legacyFpsAcc = 0;
    const t=this.clock.elapsedTime;
    if(this.model){
      this.model.position.y = this.baseY;
      // shadow travels with her — a static shadow left behind read as sinking
      if(this.shadow){ this.shadow.position.x = this.model.position.x; this.shadow.position.z = this.model.position.z; }
      this.root.rotation.y = Math.sin(t*0.18)*0.05 + this.lookX*0.10;
      this.root.rotation.x = this.lookY*0.04;
    }
    if(this.mixer) this.mixer.update(dt);
    // pin baked Hips XZ on every clip — Wander's circle plus the dance/yawn/
    // raise root drift all walked her across and off the disc; our own
    // steering moves model.position, so no clip legitimately needs Hips XZ.
    // Hips Y stays free (crouch/bob life + foot clamp own the vertical).
    if(this.hipsBone && this.model){
      this.hipsBone.position.x = this.hipsBindX;
      this.hipsBone.position.z = this.hipsBindZ;
    }
    // foot clamp: lift so the lowest ankle/toe sits at its bind height, sole on
    // the disc. Planted feet don't move in a crouch, so idle sway keeps its life.
    if(this.model && this.footBones.length && this.footBindY.length===this.footBones.length){
      try{
        let lift = 0;
        for(let i=0;i<this.footBones.length;i++){
          this.footBones[i].getWorldPosition(this.footTmp);
          const need = this.footBindY[i] + 0.01 - this.footTmp.y;
          if(need > lift) lift = need;
        }
        this.model.position.y = this.baseY + Math.max(0, Math.min(lift, 3.0));
        this.lastLift = Math.max(0, Math.min(lift, 3.0));
      }catch{}
    } else if(this.model){
      this.lastLift = -1; // clamp inactive (bones missing) — visible in ?debug=1
    }
    this.applyLife(dt);
    // wandering: walk to target, then turn back to face the user
    if(this.model && this.wanderMode!=='none'){
      const p=this.model.position;
      if(this.wanderMode==='walk'){
        const gx = this.hasVia ? this.via.x : this.wanderTarget.x;
        const gz = this.hasVia ? this.via.z : this.wanderTarget.z;
        const dx=gx-p.x, dz=gz-p.z;
        const d=Math.hypot(dx,dz);
        const face=Math.atan2(dx,dz);
        this.model.rotation.y += shortAngle(face-this.model.rotation.y)*Math.min(1, dt*4);
        if(d>0.05){
          const step=Math.min(d, this.walkSpeed*dt);
          p.x += dx/d*step; p.z += dz/d*step;
        } else if(this.hasVia){
          this.hasVia=false; // rounded the piano corner — carry on to the target
        } else if(this.staging==='piano-walk'){
          // arrived at the bench — stop walking, turn toward the keys
          this.staging='piano-turn';
          this.wanderMode='none';
          (this.acts.get('wander') ?? this.acts.get('walk'))?.fadeOut(0.3);
        } else {
          this.wanderMode='turnBack';
          this.hasVia=false;
          (this.acts.get('wander') ?? this.acts.get('walk'))?.fadeOut(0.3);
        }
      } else {
        this.model.rotation.y += shortAngle(0-this.model.rotation.y)*Math.min(1, dt*6);
        if(Math.abs(shortAngle(this.model.rotation.y))<0.06){
          this.model.rotation.y=0;
          this.wanderMode='none';
          if(this.talking) this.faceMode=true; // now facing the user — zoom in
        }
      }
    }
    // piano staging: settle onto the bench mark facing the keys, then play
    if(this.model && this.staging==='piano-turn'){
      const dr = shortAngle(SIT.rotY - this.model.rotation.y);
      this.model.rotation.y += dr*Math.min(1, dt*5);
      if(Math.abs(dr)<0.05){
        this.model.rotation.y = SIT.rotY;
        this.model.position.x = SIT.x; this.model.position.z = SIT.z;
        this.staging='piano-play';
        this.lastPiano = Date.now(); // cooldown counts from performance start
        // stretch the 9.5s clip into a ~30s performance (slow, dreamy
        // playing — hidden by the camera shot anyway)
        const pa=this.acts.get('piano');
        if(pa){ pa.timeScale = 9.533/this.pianoLenS; }
        this.playOnce('piano');
        playPianoPhrase();
        this.pianoEndTimer = window.setTimeout(()=> this.endPiano(), this.pianoLenS*1000 + 150);
      }
    }
    // smooth camera dolly, following her wherever she stands on the stage
    if(this.framed){
      const m=this.model? this.model.position : {x:0,z:0};
      const k = 1 - Math.exp(-2.5*dt);
      if(this.staging==='piano-play'){
        // fixed 3/4 shot on the bench — no follow, no gaze parallax
        this.camera.position.lerp(PIANO_CAM_POS, k);
        this.lookCur.lerp(PIANO_CAM_LOOK, k);
      } else {
        const gp=this.faceMode?this.facePos:this.homePos;
        const gl=this.faceMode?this.faceLook:this.homeLook;
        this.camGoalTmp.set(gp.x+m.x, gp.y, gp.z+m.z);
        this.camera.position.lerp(this.camGoalTmp, k);
        this.lookGoalTmp.set(gl.x+m.x, gl.y, gl.z+m.z);
        this.lookGoalTmp.x += this.lookX*0.12;
        this.lookCur.lerp(this.lookGoalTmp, k);
      }
      this.camera.lookAt(this.lookCur);
    }
    if(Math.abs(this.blend-this.blendTarget)>0.0005){
      this.blend += (this.blendTarget-this.blend)*Math.min(1, dt*1.5);
      this.applyTheme(this.blend);
    }
    // mood glow: on legacy the PointLight breathe is too heavy — snap instead
    if(this.isLegacy){
      if(this.moodAmt>0.01){
        this.moodLight.color.copy(this.moodTarget);
        this.moodLight.intensity = this.moodAmt*5;
        if(this.scene.background) (this.scene.background as THREE.Color).copy(this.baseBg).lerp(this.moodTarget, 0.02*this.moodAmt);
      } else if(this.moodLight.intensity>0.01){
        this.moodLight.intensity *= 0.92;
        if(this.moodLight.intensity<0.02) this.moodLight.intensity=0;
      }
    } else if(this.moodAmt>0.01 || this.moodLight.intensity>0.01){
      const mk = 1 - Math.exp(-3*dt);
      this.moodLight.color.lerp(this.moodTarget, mk);
      const breathe = 0.5 + 0.5*Math.sin(t*2.2);
      this.moodLight.intensity += ((this.moodAmt*(4+breathe*3)) - this.moodLight.intensity)*mk;
      if(this.moodAmt>0.01){
        if(this.scene.background) (this.scene.background as THREE.Color).copy(this.baseBg).lerp(this.moodTarget, 0.025*this.moodAmt);
      } else if(this.scene.background){
        (this.scene.background as THREE.Color).copy(this.baseBg);
      }
    }
    this.renderer.render(this.scene, this.camera);
  };

  resize(){
    const w=this.canvas.clientWidth||800, h=this.canvas.clientHeight||800;
    this.camera.aspect=w/h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w,h,false);
    this.fitCamera();
  }
  dispose(){
    cancelAnimationFrame(this.raf);
    if(this.themeTimer) clearInterval(this.themeTimer);
    if(this.lifeTimer) clearTimeout(this.lifeTimer);
    this.renderer.dispose();
  }
}
