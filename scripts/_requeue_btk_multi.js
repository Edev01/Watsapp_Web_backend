
require('dotenv').config();
const {Pool}=require('pg');
const {splitPropertyOffers}=require('../ai/listingSplitter');
const p=new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{
  const full=await p.query(`
    select m.id, m.user_id, m.message,
      (select count(*) from normalized_messages n where n.whatsapp_message_id=m.id) as cards
    from whatsapp_messages m
    where m.user_id=4
      and m.message is not null
      and (
        m.message ilike '%bahria%'
        or m.message ilike '%ali block%'
        or m.message like '%👉%'
        or m.message ilike '%P1%'
        or m.message ilike '%P2%'
        or m.message ilike '%P3%'
        or m.message ilike '%P4%'
        or m.message ilike '%P5%'
      )
      and (select count(*) from normalized_messages n where n.whatsapp_message_id=m.id) <= 1
    order by m.id desc
    limit 600
  `);
  const toFix=[];
  for (const row of full.rows) {
    const offers=splitPropertyOffers(row.message);
    if (offers.length >= 2 && Number(row.cards) <= 1) toFix.push({id:row.id, offers:offers.length, cards:Number(row.cards)});
  }
  if (!toFix.find(x=>x.id===12945)) toFix.unshift({id:12945, offers:2, cards:1});
  const ids=[...new Set(toFix.map(x=>x.id))];
  console.log('TO_FIX_SAMPLE', JSON.stringify(toFix.slice(0,30),null,2));
  console.log('TOTAL', ids.length);
  await p.query(`DELETE FROM normalized_messages WHERE whatsapp_message_id = ANY($1::int[])`, [ids]);
  try { await p.query(`DELETE FROM normalize_claims WHERE message_id = ANY($1::int[])`, [ids]); } catch (_) {}
  await p.query(`
    INSERT INTO normalize_jobs (user_id, status, model_used, embed, batch_size, processed_this_run, started_at, updated_at)
    VALUES (4, 'queued', 'gpt-4o-mini', true, 50, 0, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE SET status='queued', processed_this_run=0, started_at=NOW(), finished_at=NULL, last_error=NULL, updated_at=NOW()
  `);
  console.log('REQUEUED', ids.length, 'has12945', ids.includes(12945));
  await p.end();
})().catch(e=>{console.error(e); process.exit(1)});
