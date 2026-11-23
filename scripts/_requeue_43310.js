
require("dotenv").config();
const db = require("../db");
(async () => {
  const id = 43310;
  await db.query("DELETE FROM normalized_messages WHERE whatsapp_message_id=$1", [id]);
  await db.query("DELETE FROM normalize_claims WHERE whatsapp_message_id=$1", [id]).catch(() => null);
  await db.query(
    `INSERT INTO normalize_jobs (user_id, status, model_used, embed, batch_size, processed_this_run, started_at, updated_at)
     VALUES (4, 'queued', 'gpt-4o-mini', true, 50, 0, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET status='queued', last_error=NULL, updated_at=NOW()`
  );
  // wake pipeline if helper exists
  try {
    const { wakePipeline } = require("../ai/pipelineWorker");
    if (typeof wakePipeline === "function") wakePipeline(4);
  } catch (_) {}
  console.log("requeued", id);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
