/**
 * Exact OpenAI Chat Completions hit log + running counter.
 * One row (and +1) per HTTP request that left this process for api.openai.com.
 */

function maxHitsPerMessage() {
  const n = Number(process.env.MAX_OPENAI_HITS_PER_MESSAGE);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

async function countHitsForMessage(messageId) {
  if (messageId == null) return 0;
  try {
    const db = require('../../db');
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM openai_api_hits WHERE message_id = $1`,
      [Number(messageId)]
    );
    return rows[0]?.n || 0;
  } catch (err) {
    console.warn('[openai] hit count failed:', err.message);
    return 0;
  }
}

async function recordOpenAiHit({
  messageId = null,
  userId = null,
  model = null,
  ok = false,
  httpStatus = null,
  attempt = 1
} = {}) {
  try {
    const db = require('../../db');
    const { rows } = await db.query(
      `WITH ins AS (
         INSERT INTO openai_api_hits
           (hit_at, message_id, user_id, model, ok, http_status, attempt)
         VALUES (NOW(), $1, $2, $3, $4, $5, $6)
         RETURNING hit_at
       ),
       upd AS (
         UPDATE openai_api_counter
            SET total_hits = total_hits + 1,
                last_hit_at = (SELECT hit_at FROM ins)
          WHERE id = 1
         RETURNING total_hits, last_hit_at
       )
       SELECT total_hits, last_hit_at FROM upd`,
      [
        messageId == null ? null : Number(messageId),
        userId == null ? null : Number(userId),
        model || null,
        Boolean(ok),
        httpStatus == null ? null : Number(httpStatus),
        attempt == null ? 1 : Number(attempt)
      ]
    );
    const n = rows[0] && rows[0].total_hits;
    const at = rows[0] && rows[0].last_hit_at;
    const when = at ? new Date(at).toISOString() : new Date().toISOString();
    console.info(
      `[openai] api hit #${n} at ${when} message=${messageId || '-'} model=${model || '-'} ok=${ok} status=${httpStatus == null ? '-' : httpStatus}`
    );
    return rows[0] || null;
  } catch (err) {
    console.warn('[openai] hit counter failed:', err.message);
    return null;
  }
}

module.exports = { recordOpenAiHit, countHitsForMessage, maxHitsPerMessage };
