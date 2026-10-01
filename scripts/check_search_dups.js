#!/usr/bin/env node
const queries = [
  'sahil', 'emaar', 'zamzama', 'street 10', 'dha pahse 7',
  'clifton', 'bukhari', 'phase 8', 'badar', 'khayaban-e-rizwan'
];

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[*_`~#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

(async () => {
  let fail = 0;
  for (const q of queries) {
    const res = await fetch('http://127.0.0.1:3000/api/properties/filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': '4' },
      body: JSON.stringify({ userId: 4, filters: { location: q, limit: 50 }, limit: 50 })
    });
    const json = await res.json();
    const props = (json.data && json.data.properties) || [];
    const fps = props
      .map((p) => norm(p.listingExcerpt || p.summary || ''))
      .filter((f) => f.length >= 24);
    const counts = new Map();
    for (const f of fps) counts.set(f, (counts.get(f) || 0) + 1);
    const dups = [...counts.values()].filter((v) => v > 1).length;
    const ids = props.map((p) => p.id);
    const idDup = ids.length - new Set(ids).size;
    if (dups || idDup) fail += 1;
    console.log(
      dups || idDup ? 'FAIL' : 'OK  ',
      JSON.stringify(q),
      'hits=' + props.length,
      'content_dups=' + dups,
      'id_dups=' + idDup
    );
  }
  console.log(fail ? 'SEARCH_FAIL' : 'SEARCH_PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
