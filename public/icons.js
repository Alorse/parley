// Inline SVG icon set: thin stroke, round caps, currentColor. Every icon is
// a 24x24 viewBox string so it can be dropped straight into innerHTML.
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

const RAW_ICONS = {
  mic: `<path ${STROKE} d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6.5a3.5 3.5 0 0 0-7 0v5A3.5 3.5 0 0 0 12 15Z"/><path ${STROKE} d="M6 11a6 6 0 0 0 12 0"/><path ${STROKE} d="M12 17v3.2"/><path ${STROKE} d="M9 20.2h6"/>`,

  settings: `<circle cx="12" cy="12" r="1.6" ${STROKE}/><path ${STROKE} d="M5 8h14M5 12h14M5 16h14"/><circle cx="9" cy="8" r="1.6" ${STROKE}/><circle cx="15" cy="12" r="1.6" ${STROKE}/><circle cx="9" cy="16" r="1.6" ${STROKE}/>`,

  waveform: `<path ${STROKE} d="M2 12h2M6 8v8M10 4v16M14 8v8M18 6v12M22 12h-2"/>`,

  grid: `<rect x="4" y="4" width="7" height="7" rx="1.6" ${STROKE}/><rect x="13" y="4" width="7" height="7" rx="1.6" ${STROKE}/><rect x="4" y="13" width="7" height="7" rx="1.6" ${STROKE}/><rect x="13" y="13" width="7" height="7" rx="1.6" ${STROKE}/>`,

  book: `<path ${STROKE} d="M12 6.5c-1.6-1.2-4-1.6-6.5-1.2v13c2.5-.4 4.9 0 6.5 1.2M12 6.5c1.6-1.2 4-1.6 6.5-1.2v13c-2.5-.4-4.9 0-6.5 1.2M12 6.5v13"/>`,

  bubble: `<path ${STROKE} d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-7Z"/><path ${STROKE} d="M8 8.5h8M8 11.5h5"/>`,

  hangup: `<path ${STROKE} d="M4.5 13.5c4-4.4 11-4.4 15 0l-2.2 2.6a1.4 1.4 0 0 1-1.7.3l-2-1a1.4 1.4 0 0 0-1.6.3l-.7.8a10.7 10.7 0 0 1-4.3-4.3l.8-.7a1.4 1.4 0 0 0 .3-1.6l-1-2a1.4 1.4 0 0 1 .3-1.7L4.5 13.5Z" transform="rotate(135 12 12)"/>`,

  arrowUpRight: `<path ${STROKE} d="M7 17 17 7M9 7h8v8"/>`,

  search: `<circle cx="10.5" cy="10.5" r="6" ${STROKE}/><path ${STROKE} d="M20 20l-4.8-4.8"/>`,

  keyboard: `<rect x="3" y="6" width="18" height="12" rx="2" ${STROKE}/><path ${STROKE} d="M6.5 10h.01M9.5 10h.01M12.5 10h.01M15.5 10h.01M17.5 10h.01M6.5 13.5h11"/>`,

  sparkles: `<path ${STROKE} d="M12 4v3M12 17v3M4 12h3M17 12h3M6.5 6.5l2 2M15.5 15.5l2 2M17.5 6.5l-2 2M8.5 15.5l-2 2"/><path ${STROKE} d="M12 8l1.2 2.8L16 12l-2.8 1.2L12 16l-1.2-2.8L8 12l2.8-1.2L12 8Z"/>`,

  sun: `<circle cx="12" cy="12" r="4" ${STROKE}/><path ${STROKE} d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>`,

  tree: `<path ${STROKE} d="M12 3c-3 3-5 5.5-5 8.5A5 5 0 0 0 12 16a5 5 0 0 0 5-4.5C17 8.5 15 6 12 3Z"/><path ${STROKE} d="M12 16v5"/>`,

  cup: `<path ${STROKE} d="M5 8h11v6a5.5 5.5 0 0 1-5.5 5.5h0A5.5 5.5 0 0 1 5 14V8Z"/><path ${STROKE} d="M16 9.5h1.5a2.5 2.5 0 0 1 0 5H16"/><path ${STROKE} d="M8 3.5c-.7.8-.7 1.4 0 2.2M11.5 3.5c-.7.8-.7 1.4 0 2.2"/>`,

  utensils: `<path ${STROKE} d="M7 3v6.5a2 2 0 0 0 2 2v9.5M7 3v6.5M9.5 3v6.5M7 9.5H9.5"/><path ${STROKE} d="M16.5 3c-1.4 1.8-2 3.7-2 6.5 0 2 1 3 2 3.3V21"/>`,

  clock: `<circle cx="12" cy="12" r="8" ${STROKE}/><path ${STROKE} d="M12 8v4.3l3 1.7"/>`,

  check: `<path ${STROKE} d="M5 12.5l4.5 4.5L19 7.5"/>`,

  briefcase: `<rect x="3" y="7.5" width="18" height="11.5" rx="2" ${STROKE}/><path ${STROKE} d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5"/><path ${STROKE} d="M3 12.5h18"/>`,

  plane: `<path ${STROKE} d="M12 3l1.6 5.4 6.4 3-6.4 1.2-1.6 5.4-1.6-5.4-6.4-1.2 6.4-3z"/>`,

  key: `<circle cx="8" cy="8" r="3.5" ${STROKE}/><path ${STROKE} d="M10.5 10.5 19 19M15.5 15.5l2-2M18 18l2-2"/>`,

  phone: `<path ${STROKE} d="M6.5 4h3l1.5 4-2 1.5a10.5 10.5 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z"/>`,

  calendar: `<rect x="4" y="5.5" width="16" height="15" rx="2" ${STROKE}/><path ${STROKE} d="M4 10h16M8 3.5v3M16 3.5v3"/><path ${STROKE} d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/>`,
};

export function iconMarkup(name) {
  const body = RAW_ICONS[name];
  if (!body) return '';
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

export const ICON_NAMES = Object.keys(RAW_ICONS);
