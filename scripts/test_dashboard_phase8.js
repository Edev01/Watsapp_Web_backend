#!/usr/bin/env node
(async () => {
  const body = {
    limit: 30,
    offset: 0,
    query: 'phase VIII',
    sortBy: 'Newest First',
    status: 'AVAILABLE',
    userId: 4,
    user_id: 4
  };
  const res = await fetch('http://127.0.0.1:3000/api/dashboard-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '4' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  console.log(
    JSON.stringify(
      {
        httpStatus: res.status,
        count: json.count,
        totalMatched: json.totalMatched,
        totalReturned: json.totalReturned,
        uniqueInPool: json.uniqueInPool,
        limit: json.limit,
        offset: json.offset,
        resultsLen: (json.results || []).length,
        firstIds: (json.results || []).slice(0, 5).map((r) => r.id)
      },
      null,
      2
    )
  );

  const page2 = await fetch('http://127.0.0.1:3000/api/dashboard-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': '4' },
    body: JSON.stringify({ ...body, offset: 30 })
  });
  const j2 = await page2.json();
  console.log(
    JSON.stringify(
      {
        page2_totalReturned: j2.totalReturned,
        page2_resultsLen: (j2.results || []).length,
        page2_firstIds: (j2.results || []).slice(0, 3).map((r) => r.id)
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
