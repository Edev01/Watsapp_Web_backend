
require('dotenv').config();
const db = require('./db');
(async () => {
  const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%qr%'`);
  console.log('tables', tables.rows.map(r => r.table_name));
  for (const t of tables.rows.map(r => r.table_name)) {
    const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [t]);
    console.log(t, cols.rows.map(c => c.column_name).join(','));
  }
  // common shapes
  for (const sql of [
    `SELECT * FROM qr_codes WHERE user_id=4 ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    `SELECT * FROM qr_sessions WHERE user_id=4 ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    `SELECT user_id, status, updated_at, LEFT(COALESCE(qr,''),30) AS q FROM whatsapp_qr WHERE user_id=4`,
  ]) {
    try {
      const r = await db.query(sql);
      console.log('OK', sql.split(' FROM ')[1].split(' ')[0], JSON.stringify(r.rows[0] && Object.fromEntries(Object.entries(r.rows[0]).map(([k,v]) => [k, typeof v==='string' && v.length>80 ? v.slice(0,40)+'…len'+v.length : v])), null, 2));
    } catch (e) {
      console.log('skip', e.message.split('\n')[0]);
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
