// Stroke icons standing in for the SF Symbols the iPhone app uses. 24px grid, currentColor.

const P = {
  bird: '<path d="M12 3c-3.3 0-5.5 2.8-5.5 6.5V15c0 3.3 2.5 6 5.5 6s5.5-2.7 5.5-6V9.5C17.5 5.8 15.3 3 12 3z"/><path d="M9.2 10.5h.01M14.8 10.5h.01"/><path d="M10.8 12.6 12 14l1.2-1.4z"/>',
  checklist: '<path d="M4 6l1.5 1.5L8 5"/><path d="M4 12l1.5 1.5L8 11"/><path d="M4 18l1.5 1.5L8 17"/><path d="M11 6h9M11 12h9M11 18h9"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  calendarPlus: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 8v4.5l3 2"/>',
  speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  speakerOff: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  micOff: '<path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3"/><path d="M5.5 11a6.5 6.5 0 0 0 11 4.7M18.5 11c0 .6-.1 1.2-.2 1.8M12 17.5V21M3 3l18 18"/>',
  waveform: '<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronDown: '<path d="M5 9l7 7 7-7"/>',
  sparkle: '<path d="M12 3l1.8 5.4c.3.9 1 1.6 1.8 1.8L21 12l-5.4 1.8c-.9.3-1.6 1-1.8 1.8L12 21l-1.8-5.4c-.3-.9-1-1.6-1.8-1.8L3 12l5.4-1.8c.9-.3 1.6-1 1.8-1.8z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  circleDotted: '<circle cx="12" cy="12" r="8" stroke-dasharray="2.2 2.8"/>',
  hourglass: '<path d="M6.5 3h11M6.5 21h11M7.5 3c0 5 9 5 9 9s-9 4-9 9M16.5 3c0 5-9 5-9 9s9 4 9 9"/>',
  graduation: '<path d="M2.5 9.5 12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5V16c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-4.5M21.5 9.5v5"/>',
  timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V10M10 2.5h4"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.8 2.8L16.2 9.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
  warning: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  leaf: '<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19c3-4 6-7 10-9"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  refresh: '<path d="M4.5 10A7.5 7.5 0 0 1 18 6.8L20 9"/><path d="M20 4v5h-5"/><path d="M19.5 14A7.5 7.5 0 0 1 6 17.2L4 15"/><path d="M4 20v-5h5"/>',
  doc: '<path d="M6.5 3h7l4.5 4.5V21h-11.5z"/><path d="M13.5 3v4.5H18M9.5 12.5h5M9.5 16h5"/>',
  bag: '<path d="M5 8h14l-1 12.5H6z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
  fork: '<path d="M7 3v6a2 2 0 0 0 4 0V3M9 3v18M16.5 21V3c-2 1-3 3.5-3 7h3"/>',
  dollar: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.4-.8-1.4-1.3-2.5-1.3-1.5 0-2.6.8-2.6 2s1.1 1.7 2.6 2.1 2.6.9 2.6 2.1-1.1 2-2.6 2c-1.1 0-2.1-.5-2.5-1.3M12 6.5v11"/>',
  briefcase: '<rect x="3.5" y="7.5" width="17" height="12" rx="2.5"/><path d="M9 7.5V5.5h6v2M3.5 12.5h17"/>',
  people: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.5-3 2.7-5 5.5-5s5 2 5.5 5"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M16 14c2.5 0 4 1.7 4.5 4.5"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  plusCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  snowflake: '<path d="M12 2.5v19M3.8 7.3l16.4 9.4M3.8 16.7l16.4-9.4M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5"/>',
  drive: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5 13 7.5 5h9L19 13M7 16.5h.01"/>',
  bubble: '<path d="M4 5.5h16v11H10l-4.5 3.5v-3.5H4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M8 9.5h8M8 12h8M8 14.5h5"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M3 10h18M7 14.5h3"/>',
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.8h.01"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M4.5 19.5h15"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V7.5A1.5 1.5 0 0 1 5.5 6H11"/>',
  list: '<path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01"/>',
  arrowTurn: '<path d="M6 4v8a3 3 0 0 0 3 3h10"/><path d="M15 11l4 4-4 4"/>',
  ellipsis: '<path d="M5.5 12h.01M12 12h.01M18.5 12h.01" stroke-width="3"/>',
  ellipsisV: '<path d="M12 5.5h.01M12 12h.01M12 18.5h.01" stroke-width="3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  clockAlert: '<path d="M20 11.5A8.5 8.5 0 1 0 11.5 20"/><path d="M11.5 7.5V12l2.5 1.5M18 15v3M18 20.5h.01"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  deferArrow: '<path d="M4 12a8 8 0 1 1 2.3 5.7"/><path d="M4 18v-5h5"/>',
  minus: '<path d="M6 12h12"/>',
  tag: '<path d="M3.5 12.5V4h8.5l8.5 8.5-8.5 8.5z"/><path d="M8 8.5h.01"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="m9 21 2.5-6.5L14 16v5M10 9l3-1.5 2.5 3 3 1M11.5 14.5 12.5 9 8 11v3.5"/>',
  stack: '<path d="M12 3.5 21 8l-9 4.5L3 8z"/><path d="M3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  chart: '<path d="M4 4v16h16"/><path d="M7 15.5l4-5 3.5 3L20 6.5"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>',
  branch: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-5 3-12 6.5"/>',
  wifiOff: '<path d="M3 3l18 18M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4-2.2M19 12.5a10 10 0 0 0-3.4-2M2 9a15 15 0 0 1 4-2.6M22 9a15 15 0 0 0-9.5-3.9M12 19.5h.01"/>',
  flag: '<path d="M5.5 21V4M5.5 4.5h11l-2 4 2 4h-11"/>',
};

/** Inline SVG string. `name` must be one of the keys above. */
export function icon(name, size = 16, extraClass = '') {
  const body = P[name] || P.tag;
  return `<svg class="icon ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** SF-symbol-equivalent per task category (TimelineStyle.symbol / PlanVisuals.symbol). */
export function categoryIcon(category) {
  switch (category) {
    case 'class': return 'graduation';
    case 'assignment': return 'doc';
    case 'errand': return 'bag';
    case 'meal': return 'fork';
    case 'money': return 'dollar';
    case 'work': return 'briefcase';
    case 'club':
    case 'social': return 'people';
    case 'rest': return 'moon';
    default: return 'checklist';
  }
}
