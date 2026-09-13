// Tiny DOM helpers. Views return HTML strings built with `html` (auto-escaped) and wire events
// through `data-action` attributes, so a re-render never leaks listeners.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Marks a string as already-safe HTML so `html` doesn't escape it. */
export class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}
export const raw = (value) => new Raw(String(value ?? ''));

function part(value) {
  if (value == null || value === false || value === true) return '';
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(part).join('');
  return esc(value);
}

/** Tagged template: interpolations are escaped unless wrapped in raw() or produced by html``. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => { out += part(value) + strings[i + 1]; });
  return new Raw(out);
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Disclosure groups remember whether they are open across re-renders, keyed by a stable id. */
const openDisclosures = new Set();

export function isOpen(key) { return openDisclosures.has(key); }

export function setOpen(key, open) {
  if (open) openDisclosures.add(key); else openDisclosures.delete(key);
}

export function disclosureAttrs(key) {
  return raw(`data-disclosure="${esc(key)}"${isOpen(key) ? ' open' : ''}`);
}

document.addEventListener('toggle', (event) => {
  const el = event.target;
  if (el instanceof HTMLDetailsElement && el.dataset.disclosure) setOpen(el.dataset.disclosure, el.open);
}, true);

/**
 * FLIP animation: call `measure()` before a re-render and the returned function after it.
 * Elements with the same data-flip id glide from their old spot to the new one.
 */
export function flip(root) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const before = new Map();
  if (!reduce) $$('[data-flip]', root).forEach((el) => before.set(el.dataset.flip, el.getBoundingClientRect()));
  return () => {
    if (reduce) return;
    $$('[data-flip]', root).forEach((el) => {
      const old = before.get(el.dataset.flip);
      const now = el.getBoundingClientRect();
      if (!old) {
        el.animate([{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'ease-out' });
        return;
      }
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 520, easing: 'cubic-bezier(.3,1.25,.5,1)' },
      );
    });
  };
}
