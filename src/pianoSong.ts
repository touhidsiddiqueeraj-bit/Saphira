// ponytail: zero-asset music box — synthesized sine+harmonic plucks, no samples,
// no downloads, nothing for the Air to fetch. Original tunes, no copyright.
import { pianoOn } from './settings';

let ctx: AudioContext | null = null;
let live: AudioScheduledSourceNode[] = [];
let timer: number | null = null;

function ensure(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx.state === 'suspended' ? null : ctx;
  } catch { return null; }
}
// unlock on first tap anywhere (iOS suspends AudioContext until a gesture)
try {
  const unlock = () => { try { ensure(); } catch {} };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('touchstart', unlock, {passive:true});
  window.addEventListener('touchend', unlock);
  window.addEventListener('keydown', unlock);
} catch {}

// three original tunes, each spread over the ~15s performance — one is picked
// at random per sitting so she doesn't play the same thing every time
const MELODIES: { notes: number[]; steps: number[] }[] = [
  // lullaby (A-minor pentatonic)
  { notes: [440, 523.25, 587.33, 659.25, 523.25, 440, 392, 440, 523.25, 587.33, 659.25, 783.99, 659.25, 523.25,
            523.25, 587.33, 659.25, 783.99, 880, 783.99, 659.25, 587.33, 523.25, 440, 392, 440],
    steps: [0, 1.05, 2.1, 3.15, 4.35, 5.4, 6.6, 7.65, 8.7, 9.75, 10.8, 12.0, 13.05, 14.1,
            15.3, 16.2, 17.1, 18.15, 19.35, 20.4, 21.45, 22.5, 23.7, 24.75, 25.8, 27.0] },
  // nocturne (low, sparse, E-minor colors)
  { notes: [164.81, 196, 246.94, 293.66, 329.63, 392, 329.63, 246.94, 196, 246.94, 329.63, 392, 440, 392, 329.63, 246.94,
            329.63, 392, 493.88, 440, 392, 329.63, 293.66, 246.94, 220, 196],
    steps: [0, 0.9, 1.9, 2.9, 4.0, 4.9, 5.9, 7.0, 8.1, 9.0, 10.0, 11.1, 12.0, 12.9, 13.9, 14.7,
            15.8, 16.9, 17.9, 18.9, 20.0, 21.0, 22.1, 23.2, 24.6, 26.0] },
  // music-box waltz (bright, G-major pentatonic)
  { notes: [783.99, 659.25, 587.33, 659.25, 783.99, 880, 783.99, 659.25, 587.33, 523.25, 587.33, 659.25, 783.99, 659.25, 523.25, 440,
            659.25, 783.99, 880, 1046.5, 880, 783.99, 659.25, 587.33, 523.25, 587.33, 659.25, 523.25],
    steps: [0, 0.75, 1.5, 2.25, 3.4, 4.15, 4.9, 5.65, 6.9, 7.65, 8.4, 9.15, 10.3, 11.05, 12.2, 13.3,
            14.4, 15.15, 15.9, 16.65, 17.9, 18.65, 19.4, 20.65, 21.9, 22.65, 23.4, 24.9] },
];

function pluck(c: AudioContext, t: number, freq: number) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
  const o1 = c.createOscillator();
  o1.type = 'sine'; o1.frequency.value = freq;
  const o2 = c.createOscillator();
  o2.type = 'sine'; o2.frequency.value = freq * 3;
  const g2 = c.createGain(); g2.gain.value = 0.18;
  o1.connect(g); o2.connect(g2); g2.connect(g);
  g.connect(master(c));
  o1.start(t); o2.start(t); o1.stop(t + 3); o2.stop(t + 3);
  live.push(o1, o2);
}

let masterGain: GainNode | null = null;
function master(c: AudioContext): GainNode {
  if (!masterGain) {
    masterGain = c.createGain();
    masterGain.gain.value = 0.45; // clearly audible over the room (0.14 read as silent on the Air)
    masterGain.connect(c.destination);
  }
  return masterGain;
}

export function playPianoPhrase() {
  if (!pianoOn()) return; // piano muted in settings — she plays silently
  const c = ensure();
  if (!c) return;
  stopPianoPhrase();
  const m = MELODIES[Math.floor(Math.random() * MELODIES.length)];
  const t0 = c.currentTime + 0.15;
  let last = 0;
  for (let i = 0; i < m.notes.length; i++) { pluck(c, t0 + m.steps[i], m.notes[i]); last = m.steps[i]; }
  // let the final plucks ring out, then clean up
  timer = window.setTimeout(stopPianoPhrase, (last + 2.6) * 1000);
}

export function stopPianoPhrase() {
  if (timer) { window.clearTimeout(timer); timer = null; }
  for (const n of live) { try { n.stop(); } catch {} try { n.disconnect(); } catch {} }
  live = [];
}
