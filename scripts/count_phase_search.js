#!/usr/bin/env node
const q = process.argv[2] || 'phase VIII';
const limit = parseInt(process.argv[3] || '500', 10);

(async () => {
  const res = await fetch('http://127.0.0.1:3000/api/properties/filter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '4' },
    body: JSON.stringify({
      userId: 4,
      filters: { location: q, limit },
      limit
    })
  });
  const json = await res.json();
  const data = json.data || {};
  const props = data.properties || [];
  console.log(
    JSON.stringify(
      {
        query: q,
        httpStatus: res.status,
        returned: props.length,
        totalMatched: data.totalMatched ?? data.total ?? null,
        totalReturned: data.totalReturned ?? null,
        sample: props.slice(0, 5).map((x) => ({
          id: x.id,
          area: x.area,
          vicinity: x.vicinity
        }))
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
