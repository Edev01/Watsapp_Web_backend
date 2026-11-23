
require("dotenv").config();
const db = require("../db");
(async () => {
  // Clean polluted DHA area chips
  const cleaned = await db.query(`
    UPDATE google_phase_area_sets s
    SET area_names = COALESCE((
      SELECT array_agg(a ORDER BY ordinality)
      FROM unnest(s.area_names) WITH ORDINALITY AS t(a, ordinality)
      WHERE LOWER(a) !~ '(bahria|btk|precinct)'
        AND LOWER(TRIM(a)) !~ '^(tower|estate|area|commercial|comm|street|st|lane|road|western)$'
    ), '{}'::text[]),
    updated_at = NOW()
    WHERE EXISTS (
      SELECT 1 FROM unnest(s.area_names) a
      WHERE LOWER(a) ~ '(bahria|btk|precinct)'
         OR LOWER(TRIM(a)) ~ '^(tower|estate|area|commercial|comm|street|st|lane|road|western)$'
    )
    RETURNING phase_number, cardinality(area_names) AS n
  `);
  console.log("cleaned_phase_sets", cleaned.rows);

  // Requeue a Taqi multi-offer that only saved 1 listing
  const id = 42482;
  await db.query("DELETE FROM normalized_messages WHERE whatsapp_message_id=$1", [id]);
  await db.query("DELETE FROM normalize_claims WHERE whatsapp_message_id=$1", [id]).catch(()=>null);
  await db.query(`INSERT INTO normalize_jobs (user_id, status, model_used, embed, batch_size, processed_this_run, started_at, updated_at)
    VALUES (4,'queued','gpt-4o-mini',true,50,0,NOW(),NOW())
    ON CONFLICT (user_id) DO UPDATE SET status='queued', last_error=NULL, updated_at=NOW()`);
  try { require("../ai/pipelineWorker").wakePipeline(4); } catch(_) {}
  console.log("requeued", id);
  process.exit(0);
})().catch(e=>{console.error(e); process.exit(1);});
