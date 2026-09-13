// Runs inside the current tab. Keep this function self-contained: Chrome serializes
// it before execution, so it cannot close over extension state.
function extractPipPageContext() {
  const raw = (document.body?.innerText || '').replace(/\u00a0/g, ' ');
  const lines = raw.split(/\n+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const signal = /\b(?:due|deadline|exam|midterm|final|quiz|test|assignment|project|lab|lecture|tutorial|class|office hours|submit|submission|presentation|reading|week\s+\d+|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{1,2}[/:.-]\d{1,2}(?:[/:.-]\d{2,4})?|\d{1,2}:\d{2}\s*(?:am|pm)?)\b/i;
  const picked = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!signal.test(lines[i])) continue;
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j += 1) {
      const line = lines[j];
      if (!seen.has(line)) { seen.add(line); picked.push(line); }
    }
  }
  let text = (picked.length ? picked : lines).join('\n');
  if (text.length > 4200) text = text.slice(0, 4200);
  return { title: document.title || 'Current tab', url: location.href, text, matchedLines: picked.length, totalCharacters: raw.length };
}
globalThis.extractPipPageContext = extractPipPageContext;
