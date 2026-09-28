/**
 * Pakistan / Karachi locality gazetteer for typo-tolerant location search.
 * Static seed + runtime names learned from normalized_messages.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'at', 'of', 'for', 'and', 'or', 'near', 'to', 'on',
  'by', 'from', 'with', 'area', 'plot', 'house', 'flat', 'apartment', 'bangla',
  'bungalow', 'shop', 'office', 'main', 'new', 'old', 'town', 'city', 'road'
]);

/** Major Karachi + common Pakistan real-estate localities (canonical spellings). */
const SEED_LOCALITIES = [
  // Cities
  'karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'multan',
  'peshawar', 'hyderabad', 'sialkot', 'gujranwala', 'quetta',
  // Karachi core / DHA
  'dha', 'defence', 'defense', 'clifton', 'gizri', 'saddar', 'cantt',
  'korangi', 'malir', 'landhi', 'orangi', 'nazimabad', 'north nazimabad',
  'federal b area', 'fb area', 'gulshan', 'gulshan-e-iqbal', 'gulshan-e-johar',
  'gulistan-e-johar', 'bahria', 'bahria town', 'bahria heights', 'scheme 33', 'saadi garden',
  'johar', 'iqbal', 'liaquatabad', 'lyari', 'kemari', 'baldia', 'site',
  'shah faisal', 'pechs', 'tariq road', 'bahadurabad', 'gulberg',
  'askari', 'askari 4', 'askari 5', 'naya nazimabad', 'surjani', 'north karachi',
  'shadman', 'garden', 'soldier bazar', 'burns road', 'ii chundrigar',
  'bath island', 'do talwar', 'sea view', 'creek marina', 'dha city',
  // DHA streets / commercial (very common in listings)
  'bukhari', 'nishat', 'badar', 'bakar', 'abu bakar', 'badban', 'ittehad',
  'khayaban-e-ittehad', 'khayaban-e-hafiz',
  'khayaban-e-shahbaz', 'khayaban-e-muhafiz', 'khayaban-e-shaheen', 'khayaban-e-rahat',
  'khayaban-e-saadi',
  'khayaban-e-iqbal', 'khayaban-e-badar', 'khayaban-e-abu bakar', 'khayaban-e-badban',
  'khayaban-e-zahra', 'zahra',
  'khayaban-e-hilal', 'khayaban-e-sehar',
  'khayaban-e-qasim', 'khayaban-e-jami', 'khayaban-e-shujaat', 'khayaban-e-tanzeem',
  'khayaban-e-roomi', 'khayaban-e-saba', 'khayaban-e-rizwan',
  'rizwan', 'saba avenue', 'beach avenue', 'coastal avenue',
  'main central drive', 'central drive',
  'jami commercial', 'muslim commercial', 'khalid commercial', 'babar commercial',
  'ayubi commercial', 'badar commercial', 'nishat commercial', 'bukhari commercial',
  'tauheed commercial', 'toheed commercial', 'al murtaza', 'al-murtaza commercial',
  'e zone', 'd cutting', 'ghalib', 'ghazi', 'saadi', 'rahat', 'sehar', 'hilal',
  'shahbaz', 'muhafiz', 'roomi', 'qasim', 'jami', 'shujaat', 'creek lane',
  'creek vistas', 'emaar', 'emaar coral tower', 'emaar oceanfront', 'emaar panorama',
  'pearl tower', 'pearl towers', 'coral tower', 'peninsula', 'golf course',
  'hill park', 'civil lines', 'empire state', 'rufi estate', 'foundation estate',
  // Lahore / Islamabad common
  'dha lahore', 'bahria town lahore', 'johar town', 'model town', 'cantt lahore',
  'dha islamabad', 'bahria town islamabad', 'g-11', 'f-10', 'f-11', 'i-8', 'blue area',
  'bahria enclave', 'pwd', 'soan garden'
];

/** Explicit alias → canonical (covers common misspellings / alternate spellings). */
const ALIASES = Object.freeze({
  defense: 'defence',
  defance: 'defence',
  defancee: 'defence',
  difence: 'defence',
  clfton: 'clifton',
  cliffton: 'clifton',
  cliton: 'clifton',
  cliftton: 'clifton',
  gulshn: 'gulshan',
  gulshaniqbal: 'gulshan-e-iqbal',
  'gulshan iqbal': 'gulshan-e-iqbal',
  'gulshan e iqbal': 'gulshan-e-iqbal',
  gulshaneiqbal: 'gulshan-e-iqbal',
  'gulshan johar': 'gulshan-e-johar',
  'gulshan e johar': 'gulshan-e-johar',
  'gulistan johar': 'gulistan-e-johar',
  'gulistan e johar': 'gulistan-e-johar',
  'bahria twn': 'bahria town',
  bahriaa: 'bahria',
  bahriya: 'bahria',
  'north nazimabd': 'north nazimabad',
  nazimabd: 'nazimabad',
  korngi: 'korangi',
  korangi: 'korangi',
  maler: 'malir',
  gizree: 'gizri',
  gizry: 'gizri',
  // Khayaban family (typos + shorthand → canonical stem)
  khybn: 'khayaban',
  khaybn: 'khayaban',
  khayabn: 'khayaban',
  khayban: 'khayaban',
  khyaban: 'khayaban',
  khyabn: 'khayaban',
  khayaben: 'khayaban',
  khayabaan: 'khayaban',
  khayyaban: 'khayaban',
  khyyaban: 'khayaban',
  'khayaban ittehad': 'khayaban-e-ittehad',
  'khy ittehad': 'khayaban-e-ittehad',
  'khybn ittehad': 'khayaban-e-ittehad',
  'khaybn ittehad': 'khayaban-e-ittehad',
  'main central drive': 'main central drive',
  'central drive': 'main central drive',
  'main central': 'main central drive',
  'khy-e-rizwan': 'khayaban-e-rizwan',
  'khy e rizwan': 'khayaban-e-rizwan',
  'kh-e-rizwan': 'khayaban-e-rizwan',
  'kh e rizwan': 'khayaban-e-rizwan',
  'khayaban rizwan': 'khayaban-e-rizwan',
  'khayaban e rizwan': 'khayaban-e-rizwan',
  'khybn rizwan': 'khayaban-e-rizwan',
  rizwan: 'khayaban-e-rizwan',
  bukhri: 'bukhari',
  bukharii: 'bukhari',
  nishaat: 'nishat',
  nishaath: 'nishat',
  'dha city karachi': 'dha city',
  'defance phase': 'defence',
  'defense phase': 'defence'
});

/** Common misspellings of the word "khayaban" itself. */
const KHAYABAN_TYPOS = Object.freeze([
  'khayaban', 'khyaban', 'khybn', 'khaybn', 'khayabn', 'khayban',
  'khyabn', 'khayaben', 'khayabaan', 'khayyaban', 'khyyaban', 'khayybn'
]);

/**
 * True when a token is "khayaban" or a close typo / shorthand (khybn, khaybn, …).
 */
function isKhayabanFamilyToken(tok) {
  const t = String(tok || '')
    .toLowerCase()
    .replace(/[–—\-_/\\.,]+/g, '')
    .trim();
  if (!t || t.length < 4) return false;
  if (KHAYABAN_TYPOS.includes(t)) return true;
  if (t.startsWith('khayaban') || t.startsWith('khyaban')) return true;
  if (t[0] !== 'k') return false;
  if (t.length < 5 || t.length > 12) return false;
  return editDistance(t, 'khayaban') <= 3;
}

/** Word/typo forms of "khayaban" — safe to match in message text. */
function khayabanWordPatterns() {
  return [
    'khayaban',
    'khyaban',
    'khayaban-e',
    'khyaban-e',
    'khybn',
    'khaybn',
    'khayabn',
    'khayban',
    'khyabn',
    'khayaben',
    'khayaban e ittehad',
    'khayaban-e-ittehad'
  ];
}

/**
 * Short "kh-e-X" / "khy-e-X" forms (real Khayaban streets).
 * Use as Postgres ~* regex — requires a street name after e, not bare noise.
 */
function khayabanShortERegex() {
  return '(^|[^a-z0-9])(kh|khy)[[:space:]._-]*e[[:space:]._-]+[a-z]{2,}';
}

/**
 * Street names under the Khayaban corridor that often omit the word "khayaban".
 * Match these ONLY on city/area/vicinity — never on raw chat (too many false hits).
 */
function khayabanStreetPatterns() {
  return ['main central drive', 'central drive'];
}

/** Combined list for callers that still expect one array. */
function khayabanSearchPatterns() {
  return [...khayabanWordPatterns(), ...khayabanStreetPatterns()];
}

/**
 * Canonicalize free-text place strings before save / search
 * (khybn → khayaban, khy-e-X → khayaban-e-X, locality typos via gazetteer).
 */
function canonicalizePlaceText(text) {
  let out = String(text || '').trim();
  if (!out) return out;

  out = out.replace(/\b(khybn|khaybn|khayabn|khayban|khyaban|khyabn|khayaben|khayabaan|khayyaban|khyyaban)\b/gi, 'khayaban');
  out = out.replace(/\b(khy|kh)\s*[-.]?\s*e\s*[-.]?\s*/gi, 'khayaban-e-');
  out = correctLocalityTypos(out);
  return out;
}

/** Runtime extras from DB (lowercased). */
let extraLocalities = [];

function setExtraLocalities(names) {
  const cleaned = [];
  const seen = new Set();
  for (const raw of names || []) {
    const n = String(raw || '').trim().toLowerCase();
    if (n.length < 3 || n.length > 60) continue;
    if (/^\d+$/.test(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    cleaned.push(n);
  }
  extraLocalities = cleaned;
}

function getExtraLocalities() {
  return extraLocalities.slice();
}

function normalizePlaceKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[–—\-_/\\.,]+/g, ' ')
    .replace(/\be\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;
  const prev = new Array(m + 1);
  const cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= m; j++) prev[j] = cur[j];
  }
  return prev[m];
}

function maxEditFor(len) {
  if (len <= 5) return 1;
  if (len <= 8) return 2;
  if (len <= 12) return 3;
  return 4;
}

/** Build searchable index: key → canonical display name. */
function buildIndex() {
  const exact = new Map();
  const keys = [];

  const add = (canonical) => {
    const c = String(canonical || '').trim().toLowerCase();
    if (c.length < 3) return;
    const key = normalizePlaceKey(c);
    if (!key || key.length < 3) return;
    if (!exact.has(key)) {
      exact.set(key, c);
      keys.push(key);
    }
    // also index without spaces for "gulshaneiqbal"
    const compact = key.replace(/\s+/g, '');
    if (compact.length >= 4 && !exact.has(compact)) {
      exact.set(compact, c);
      keys.push(compact);
    }
  };

  for (const name of SEED_LOCALITIES) add(name);
  for (const name of extraLocalities) add(name);
  for (const [alias, canon] of Object.entries(ALIASES)) {
    const key = normalizePlaceKey(alias);
    exact.set(key, canon);
    keys.push(key);
    add(canon);
  }

  return { exact, keys: [...new Set(keys)] };
}

let cachedIndex = null;
let cachedExtraLen = -1;

function getIndex() {
  if (!cachedIndex || cachedExtraLen !== extraLocalities.length) {
    cachedIndex = buildIndex();
    cachedExtraLen = extraLocalities.length;
  }
  return cachedIndex;
}

/**
 * Find best locality for a phrase. Returns canonical name or null.
 */
function matchLocality(phrase) {
  const raw = String(phrase || '').trim().toLowerCase();
  if (raw.length < 3) return null;

  if (ALIASES[raw]) return ALIASES[raw];

  const { exact, keys } = getIndex();
  const key = normalizePlaceKey(raw);
  // "phase" is not a locality — compact index "phase5" used to fuzzy-match it to Phase 5.
  if (/^(phase|block|street|st|scheme|sector)$/.test(key)) return null;
  if (exact.has(key)) return exact.get(key);

  const compact = key.replace(/\s+/g, '');
  if (exact.has(compact)) return exact.get(compact);

  const maxD = maxEditFor(key.length);
  let best = null;
  let bestDist = Infinity;
  const keyTail = key.split(/\s+/).pop();
  const keyHasNum = /\d/.test(key);
  for (const k of keys) {
    if (Math.abs(k.length - key.length) > maxD) continue;
    // Prefer same starting letter to cut false positives (bahria ≠ baldia)
    if (k[0] !== key[0]) continue;
    if (keyHasNum !== /\d/.test(k)) continue;
    // For multi-word / khayaban names, last token must be very close (rizwan ≠ rahat)
    const kTail = k.split(/\s+/).pop();
    if (key.includes(' ') || key.length >= 10) {
      if (editDistance(keyTail, kTail) > 1) continue;
    }
    const d = editDistance(key, k);
    const rel = d / Math.max(key.length, k.length, 1);
    if (d > 0 && d <= maxD && rel <= 0.28 && d < bestDist) {
      best = exact.get(k);
      bestDist = d;
    }
  }
  return best;
}

/**
 * Correct typos in a free-text location query against Pakistan localities.
 * Tries longest n-grams first so "north nazimabd" → "north nazimabad".
 */
function correctLocalityTypos(text) {
  const input = String(text || '').trim();
  if (!input) return input;

  const spaced = input.replace(/[–—\-_/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = spaced.split(' ');
  if (!words.length) return input;

  const used = new Array(words.length).fill(false);
  const out = [];

  for (let i = 0; i < words.length; ) {
    if (used[i]) {
      i += 1;
      continue;
    }
    let matched = null;
    let matchLen = 0;
    const maxN = Math.min(4, words.length - i);
    for (let n = maxN; n >= 1; n -= 1) {
      const slice = words.slice(i, i + n);
      if (n === 1 && STOPWORDS.has(slice[0].toLowerCase())) break;
      // skip pure numbers / phase tokens here (handled elsewhere)
      if (n === 1 && /^\d+$/.test(slice[0])) break;
      const phrase = slice.join(' ');
      const hit = matchLocality(phrase);
      if (hit) {
        matched = hit;
        matchLen = n;
        break;
      }
    }
    if (matched) {
      out.push(matched);
      for (let k = 0; k < matchLen; k++) used[i + k] = true;
      i += matchLen;
    } else {
      out.push(words[i]);
      i += 1;
    }
  }

  return out.join(' ');
}

/**
 * Extra search variants for a resolved locality (hyphen/space/alias forms).
 */
function localityVariants(name) {
  const c = String(name || '').trim().toLowerCase();
  if (!c) return [];
  const set = new Set([c]);
  set.add(c.replace(/-/g, ' '));
  set.add(c.replace(/\s+/g, '-'));
  set.add(c.replace(/-/g, ''));
  set.add(normalizePlaceKey(c));
  if (c.includes('-e-')) {
    set.add(c.replace(/-e-/g, ' e '));
    set.add(c.replace(/-e-/g, ' '));
  }
  if (c === 'defence') set.add('defense');
  if (c === 'defense') set.add('defence');
  return [...set].filter(Boolean);
}

module.exports = {
  SEED_LOCALITIES,
  ALIASES,
  setExtraLocalities,
  getExtraLocalities,
  matchLocality,
  correctLocalityTypos,
  localityVariants,
  normalizePlaceKey,
  editDistance,
  isKhayabanFamilyToken,
  khayabanSearchPatterns,
  khayabanWordPatterns,
  khayabanStreetPatterns,
  khayabanShortERegex,
  canonicalizePlaceText
};
