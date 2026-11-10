// Sound with no files: short notes made by Web Audio. A browser starts audio
// only after a click or a key in the page, so the context is made on the
// first sound, which follows one (the Start button). For recorded sounds,
// import the file (`import hit from "../../public/hit.mp3"`, a data URL) and
// play it with `new Audio(hit)`, or `fetch` it for an AudioBuffer.

let ctx: AudioContext | null = null;
let muted = false;

function audio(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
  } catch {
    return null;
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** One note: `freq` Hz for `seconds`, sliding to `to` Hz when given. */
function tone(freq: number, seconds: number, type: OscillatorType = "sine", volume = 0.12, to?: number, delay = 0) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + seconds);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + seconds);
}

export const sound = {
  coin: () => {
    tone(988, 0.08, "square", 0.06);
    tone(1319, 0.14, "square", 0.06, undefined, 0.07);
  },
  jump: () => tone(280, 0.2, "triangle", 0.12, 560),
  start: () => tone(440, 0.18, "sine", 0.12, 880),
  over: () => tone(392, 0.5, "sawtooth", 0.06, 98),
  /** Mute or unmute; returns whether it is now muted. */
  toggle: () => (muted = !muted),
};
