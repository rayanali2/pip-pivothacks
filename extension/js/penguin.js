// Port of ios/Pip/Pip/Views/PenguinView.swift: the same figure and states (idle breathing and blinks,
// listening ring, thinking sway, speaking bob with the beak opening on each word, ready check).
// Drawn on a 140-unit canvas for a figure of size 100, exactly the app's proportions.

const NS = 'http://www.w3.org/2000/svg';
const INK = '#21263A';
const ACCENT = '#5763B3';
const MIST = '#ECEEFA';
const POSITIVE = '#306E57';
const BEAK = '#D99C63';
const LOWER_BEAK = '#C28252';
const MOUTH = '#6B3338';
const BELLY = '#FCFAF2';
const BLUSH = 'rgba(230,181,168,.65)';

const PERIOD = { listening: 0.9, speaking: 0.42, idle: 2.4, thinking: 1.6 };
const CAPTION = { idle: 'Hold to talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function arcPath(cx, cy, r, from, to) {
  const a = from * 2 * Math.PI;
  const b = to * 2 * Math.PI;
  const x1 = cx + r * Math.cos(a); const y1 = cy + r * Math.sin(a);
  const x2 = cx + r * Math.cos(b); const y2 = cy + r * Math.sin(b);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export class Penguin {
  constructor() {
    this.state = 'idle';
    this.ready = false;
    this.beakOpen = 0;
    this.blink = 0;
    this.stateStart = performance.now();
    this.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.root = document.createElement('div');
    this.root.className = 'penguin';
    this.root.setAttribute('role', 'img');
    this.build();
    this.update();
    this.scheduleBlink();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  build() {
    const svg = el('svg', { viewBox: '0 0 140 140', width: '100%', height: '100%', 'aria-hidden': 'true' });
    this.svg = svg;
    el('circle', { cx: 70, cy: 70, r: 59, fill: MIST }, svg);
    this.ring = el('circle', { cx: 70, cy: 70, r: 59, fill: 'none', stroke: ACCENT, 'stroke-width': 2.5 }, svg);
    this.dashed = el('circle', { cx: 70, cy: 70, r: 65, fill: 'none', stroke: ACCENT, 'stroke-opacity': 0.4, 'stroke-width': 2, 'stroke-dasharray': '4 6' }, svg);
    this.shadow = el('ellipse', { cx: 70, cy: 119, rx: 35, ry: 5, fill: INK, 'fill-opacity': 0.09 }, svg);

    this.figure = el('g', {}, svg);
    const f = this.figure;
    this.arcs = el('g', { fill: 'none', stroke: ACCENT, 'stroke-linecap': 'round', 'stroke-width': 2 }, f);
    this.arcPaths = [0, 1, 2].map((i) => el('path', { d: arcPath(34, 58, 7 + 5 * i, 0.47, 0.63) }, this.arcs));
    el('rect', { x: -10, y: -5, width: 20, height: 10, rx: 5, fill: BEAK, transform: 'translate(52.5 114) rotate(-12)' }, f);
    el('rect', { x: -10, y: -5, width: 20, height: 10, rx: 5, fill: BEAK, transform: 'translate(87.5 114) rotate(12)' }, f);
    this.leftFlipper = el('ellipse', { rx: 7.1, ry: 19.1, fill: INK, stroke: '#fff', 'stroke-width': 1.8 }, f);
    this.rightFlipper = el('ellipse', { rx: 7.1, ry: 19.1, fill: INK, stroke: '#fff', 'stroke-width': 1.8 }, f);
    el('ellipse', { cx: 70, cy: 70, rx: 37.75, ry: 44.25, fill: INK, stroke: '#fff', 'stroke-width': 2.5 }, f);
    el('ellipse', { cx: 70, cy: 76, rx: 30.5, ry: 36, fill: BELLY }, f);
    el('ellipse', { cx: 70, cy: 40, rx: 6.5, ry: 6, fill: INK }, f);
    this.eyes = [58.25, 81.75].map((cx) => el('rect', { x: cx - 2.25, width: 4.5, rx: 2.25, fill: INK }, f));
    [50, 90].forEach((cx) => el('ellipse', { cx, cy: 71.5, rx: 4.5, ry: 2.25, fill: BLUSH }, f));
    this.mouth = el('ellipse', { cx: 70, cy: 76, rx: 3.5, ry: 3.5, fill: MOUTH }, f);
    this.lowerBeak = el('rect', { x: 66.75, width: 6.5, height: 3.2, rx: 1.6, fill: LOWER_BEAK }, f);
    el('rect', { x: -6, y: -4, width: 12, height: 8, rx: 2.5, fill: BEAK, transform: 'translate(70 71.5) rotate(45)' }, f);
    el('rect', { x: 51, y: 86.75, width: 38, height: 6.5, rx: 3.25, fill: ACCENT, 'fill-opacity': 0.75 }, f);
    el('rect', { x: -3.75, y: -8, width: 7.5, height: 16, rx: 3, fill: ACCENT, transform: 'translate(82 95) rotate(-12)' }, f);

    this.bubble = el('g', { transform: 'translate(110 30)' }, svg);
    el('rect', { x: -15, y: -10, width: 30, height: 20, rx: 10, fill: '#fff' }, this.bubble);
    [-6, 0, 6].forEach((dx) => el('circle', { cx: dx, cy: 0, r: 1.9, fill: ACCENT }, this.bubble));

    this.check = el('g', { transform: 'translate(116 36)' }, svg);
    el('circle', { r: 10, fill: POSITIVE }, this.check);
    el('path', { d: 'M-4.5 0.3l3 3 6-6', fill: 'none', stroke: '#fff', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, this.check);

    this.root.appendChild(svg);
  }

  set(state, ready = false) {
    if (state !== this.state) this.stateStart = performance.now();
    this.state = state;
    this.ready = ready;
    const label = ready && state === 'idle' ? 'your next step is ready' : CAPTION[state];
    this.root.setAttribute('aria-label', `UniMate the penguin, ${label}`);
  }

  /** One spoken word: the beak drops open and closes about 0.12 s later. */
  word() {
    if (this.state !== 'speaking') return;
    this.beakTarget = 1;
    clearTimeout(this.beakTimer);
    this.beakTimer = setTimeout(() => { this.beakTarget = 0; }, 120);
  }

  scheduleBlink() {
    this.blinkTimer = setTimeout(() => {
      if (this.state === 'idle') {
        this.blink = 1;
        setTimeout(() => { this.blink = 0; }, 130);
      }
      this.scheduleBlink();
    }, 3500 + Math.random() * 1000);
  }

  /** 0…1 swing of the current state's loop, eased like SwiftUI's easeInOut toggles. */
  swing(now) {
    const period = PERIOD[this.state];
    if (this.reduceMotion && this.state !== 'listening') return 0;
    const t = (now - this.stateStart) / 1000 / period;
    return (1 - Math.cos(t * Math.PI)) / 2;
  }

  loop(now) {
    if (!this.root.isConnected && this.detachedSince && now - this.detachedSince > 60000) {
      clearTimeout(this.blinkTimer);
      return;
    }
    this.detachedSince = this.root.isConnected ? null : (this.detachedSince || now);
    const target = this.beakTarget || 0;
    this.beakOpen += (target - this.beakOpen) * (this.reduceMotion ? 1 : 0.45);
    this.update(now);
    requestAnimationFrame(this.loop);
  }

  update(now = performance.now()) {
    const s = this.state;
    const up = this.swing(now);
    const listening = s === 'listening';
    const speaking = s === 'speaking';
    const ready = this.ready || speaking;

    this.ring.style.display = listening ? '' : 'none';
    this.dashed.style.display = listening ? '' : 'none';
    if (listening) {
      const scale = this.reduceMotion ? 1 : 1 + 0.1 * up;
      this.ring.setAttribute('transform', `translate(70 70) scale(${scale}) translate(-70 -70)`);
      this.ring.setAttribute('stroke-opacity', (0.3 - 0.22 * up).toFixed(3));
    }

    const tilt = listening ? -7 : s === 'thinking' ? (this.reduceMotion ? 5 : 2 + 6 * up) : 0;
    const breathe = s === 'idle' ? 1 + 0.018 * up : 1;
    const bob = speaking ? -2.5 * up : 0;
    this.figure.setAttribute('transform',
      `translate(0 ${bob}) rotate(${tilt} 70 70) translate(0 120) scale(1 ${breathe}) translate(0 -120)`);
    this.shadow.setAttribute('transform', `translate(70 119) scale(${speaking ? 1 - 0.1 * up : 1}) translate(-70 -119)`);

    this.leftFlipper.setAttribute('transform', `translate(35 ${listening ? 60 : 79}) rotate(${listening ? 65 : 24})`);
    const wave = speaking ? -16 * up : 0;
    this.rightFlipper.setAttribute('transform', `translate(105 ${ready ? 60 : 79}) rotate(${ready ? -65 : -24}) rotate(${wave} 0 -20)`);

    const eyeHeight = this.blink && s === 'idle' ? 1.2 : ready ? 4.5 : 7;
    this.eyes.forEach((eye) => { eye.setAttribute('y', 60 - eyeHeight / 2); eye.setAttribute('height', eyeHeight); });

    const open = speaking ? this.beakOpen : 0;
    this.mouth.setAttribute('transform', `translate(70 72.5) scale(1 ${0.1 + 0.9 * open}) translate(-70 -72.5)`);
    this.lowerBeak.setAttribute('y', 70 + 3 + 7 * open - 1.6);

    this.arcs.style.display = speaking ? '' : 'none';
    this.arcPaths.forEach((p, i) => p.setAttribute('stroke-opacity', ((0.25 + 0.55 * open) * (1 - i * 0.3)).toFixed(3)));

    this.bubble.style.display = s === 'thinking' ? '' : 'none';
    this.check.style.display = this.ready && !listening && s !== 'thinking' ? '' : 'none';
  }
}

/** One persistent penguin per slot key, so its animation survives view re-renders. */
const penguins = new Map();

export function penguinFor(key) {
  if (!penguins.has(key)) penguins.set(key, new Penguin());
  return penguins.get(key);
}

export function allPenguins() { return [...penguins.values()]; }
