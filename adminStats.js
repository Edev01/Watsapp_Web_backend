/**
 * Admin user + OpenAI usage queries (PKT months).
 */
function currentPktYearMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date());
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  return { year, month };
}

function monthRangePkt(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  const start = `${y}-${String(m).padStart(2, '0')}-01 00:00:00+05`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const end = `${nextY}-${String(nextM).padStart(2, '0')}-01 00:00:00+05`;
  return { start, end, year: y, month: m };
}

function monthLabel(year, month) {
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pktYmd(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function isYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function pktDayStart(ymd) {
  return `${ymd} 00:00:00+05`;
}

function addDaysYmd(ymd, delta) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + Number(delta)));
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

function inclusiveDays(from, to) {
  const [fy, fm, fd] = String(from).split('-').map(Number);
  const [ty, tm, td] = String(to).split('-').map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86400000) + 1;
}

function formatPktRangeLabel(from, to) {
  const fmt = (ymd) => new Date(`${ymd}T00:00:00+05:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Karachi'
  });
  if (from === to) return fmt(from);
  return `${fmt(from)} – ${fmt(to)}`;
}

function parseYearMonth(query = {}) {
  return parseUsageQuery(query);
}

function parseUsageQuery(query = {}) {
  const now = currentPktYearMonth();
  const today = pktYmd();
  const fromRaw = String(query.from || query.start || '').slice(0, 10);
  const toRaw = String(query.to || query.end || '').slice(0, 10);
  if (isYmd(fromRaw) || isYmd(toRaw)) {
    let from = isYmd(fromRaw) ? fromRaw : toRaw;
    let to = isYmd(toRaw) ? toRaw : (isYmd(fromRaw) ? today : fromRaw);
    if (from > to) {
      const swap = from;
      from = to;
      to = swap;
    }
    const days = inclusiveDays(from, to);
    if (days > 1100) {
      from = addDaysYmd(to, -1099);
    }
    return {
      all: false,
      custom: true,
      from,
      to,
      start: pktDayStart(from),
      end: pktDayStart(addDaysYmd(to, 1)),
      year: now.year,
      month: now.month,
      rangeLabel: formatPktRangeLabel(from, to)
    };
  }
  const allFlag = String(query.all || query.scope || query.month || '').toLowerCase();
  const all = allFlag === 'all' || allFlag === '1' || allFlag === 'true' || allFlag === 'yes';
  if (all) {
    return { all: true, custom: false, year: now.year, month: now.month, rangeLabel: 'All time' };
  }
  const year = query.year != null && query.year !== '' ? Number(query.year) : now.year;
  const month = query.month != null && query.month !== '' ? Number(query.month) : now.month;
  const range = monthRangePkt(year, month) || monthRangePkt(now.year, now.month);
  return {
    all: false,
    custom: false,
    ...range,
    year: range.year,
    month: range.month,
    rangeLabel: monthLabel(range.year, range.month)
  };
}

async function listUsers(db) {
  const { rows } = await db.query(`
    SELECT
      u.id,
      u.email,
      u.role,
      u.name,
      u.phone_number,
      u.created_at,
      u.is_first_login,
      u.bound_whatsapp_jid,
      u.bound_whatsapp_phone,
      COALESCE(msg.n, 0)::int AS message_count,
      COALESCE(norm.n, 0)::int AS normalized_count,
      COALESCE(listn.n, 0)::int AS listing_count,
      COALESCE(hits.n, 0)::int AS api_hits,
      COALESCE(chats.n, 0)::int AS chat_count,
      COALESCE(mon.n, 0)::int AS monitored_chats,
      s.status AS billing_status,
      s.last_paid_at,
      s.grace_until,
      s.current_period_end,
      s.amount_pkr
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n FROM whatsapp_messages m WHERE m.user_id = u.id
    ) msg ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT m.id)::int AS n
        FROM whatsapp_messages m
        JOIN normalized_messages n ON n.whatsapp_message_id = m.id
       WHERE m.user_id = u.id
    ) norm ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n
        FROM normalized_messages n
        JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
       WHERE m.user_id = u.id AND n.is_property IS TRUE
    ) listn ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n FROM openai_api_hits h WHERE h.user_id = u.id
    ) hits ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n FROM whatsapp_chats c WHERE c.user_id = u.id
    ) chats ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n FROM whatsapp_chats c WHERE c.user_id = u.id AND c.is_monitored IS TRUE
    ) mon ON TRUE
    ORDER BY u.id ASC
  `);
  const { daysRemaining, hasAccess, GRACE_DAYS } = require('./billing');
  return rows.map((row) => {
    const sub = {
      status: row.billing_status || 'unpaid',
      grace_until: row.grace_until,
      current_period_end: row.current_period_end
    };
    const allowed = String(row.role || '').toLowerCase() === 'admin'
      ? true
      : hasAccess(sub);
    return {
      ...row,
      days_left: String(row.role || '').toLowerCase() === 'admin'
        ? null
        : daysRemaining(sub),
      allowed,
      paywall: !allowed,
      grace_days: GRACE_DAYS
    };
  });
}

async function usageSummary(db, {
  userId = null,
  year,
  month,
  all = false,
  custom = false,
  start = null,
  end = null,
  from = null,
  to = null,
  rangeLabel = null
} = {}) {
  const params = [];
  const where = [];
  if (userId != null) {
    params.push(Number(userId));
    where.push(`user_id = $${params.length}`);
  }
  if (!all) {
    const range = start && end ? { start, end } : monthRangePkt(year, month);
    if (range) {
      params.push(range.start, range.end);
      where.push(`hit_at >= $${params.length - 1}::timestamptz AND hit_at < $${params.length}::timestamptz`);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const hits = await db.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS ok
       FROM openai_api_hits
       ${whereSql}`,
    params
  );

  const byParams = [...params];
  const days = custom && from && to ? inclusiveDays(from, to) : null;
  const grain = custom && days != null && days <= 62 ? 'day' : 'month';
  const byQuery = grain === 'day'
    ? `SELECT
          to_char((hit_at AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM-DD') AS bucket,
          count(*)::int AS hits,
          count(*) FILTER (WHERE ok)::int AS ok
         FROM openai_api_hits
         ${whereSql}
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT 62`
    : `SELECT
          EXTRACT(YEAR FROM hit_at AT TIME ZONE 'Asia/Karachi')::int AS year,
          EXTRACT(MONTH FROM hit_at AT TIME ZONE 'Asia/Karachi')::int AS month,
          count(*)::int AS hits,
          count(*) FILTER (WHERE ok)::int AS ok
         FROM openai_api_hits
         ${whereSql}
        GROUP BY 1, 2
        ORDER BY 1 DESC, 2 DESC
        LIMIT 24`;
  const byRange = await db.query(byQuery, byParams);

  const histParams = [];
  const histWhere = [];
  if (userId != null) {
    histParams.push(Number(userId));
    histWhere.push(`user_id = $${histParams.length}`);
  }
  const histSql = histWhere.length ? `WHERE ${histWhere.join(' AND ')}` : '';
  const history = await db.query(
    `SELECT
        EXTRACT(YEAR FROM hit_at AT TIME ZONE 'Asia/Karachi')::int AS year,
        EXTRACT(MONTH FROM hit_at AT TIME ZONE 'Asia/Karachi')::int AS month,
        count(*)::int AS hits,
        count(*) FILTER (WHERE ok)::int AS ok
       FROM openai_api_hits
       ${histSql}
      GROUP BY 1, 2
      ORDER BY 1 DESC, 2 DESC
      LIMIT 24`,
    histParams
  );

  const allTimeParams = userId != null ? [Number(userId)] : [];
  const allTimeWhere = userId != null ? 'WHERE user_id = $1' : '';
  const allTime = await db.query(
    `SELECT count(*)::int AS n FROM openai_api_hits ${allTimeWhere}`,
    allTimeParams
  );

  const now = currentPktYearMonth();
  const currentRange = monthRangePkt(now.year, now.month);
  const currentParams = [];
  const currentWhere = [`hit_at >= $1::timestamptz`, `hit_at < $2::timestamptz`];
  currentParams.push(currentRange.start, currentRange.end);
  if (userId != null) {
    currentParams.push(Number(userId));
    currentWhere.push(`user_id = $${currentParams.length}`);
  }
  const current = await db.query(
    `SELECT count(*)::int AS n FROM openai_api_hits WHERE ${currentWhere.join(' AND ')}`,
    currentParams
  );

  const breakdown = byRange.rows.map((r) => {
    if (grain === 'day') {
      return {
        grain: 'day',
        key: r.bucket,
        label: formatPktRangeLabel(r.bucket, r.bucket),
        hits: r.hits,
        ok: r.ok
      };
    }
    return {
      grain: 'month',
      year: r.year,
      month: r.month,
      key: `${r.year}-${pad2(r.month)}`,
      label: monthLabel(r.year, r.month),
      hits: r.hits,
      ok: r.ok
    };
  });

  const label = rangeLabel
    || (all ? 'All time' : (custom ? formatPktRangeLabel(from, to) : monthLabel(year, month)));

  return {
    year: all || custom ? null : year,
    month: all || custom ? null : month,
    from: custom ? from : null,
    to: custom ? to : null,
    monthLabel: label,
    rangeLabel: label,
    all,
    custom: Boolean(custom),
    grain,
    hits: hits.rows[0]?.n || 0,
    okHits: hits.rows[0]?.ok || 0,
    allTime: allTime.rows[0]?.n || 0,
    currentMonth: current.rows[0]?.n || 0,
    currentMonthLabel: monthLabel(now.year, now.month),
    byPeriod: breakdown,
    byMonth: history.rows.map((r) => ({
      grain: 'month',
      year: r.year,
      month: r.month,
      key: `${r.year}-${pad2(r.month)}`,
      label: monthLabel(r.year, r.month),
      hits: r.hits,
      ok: r.ok
    }))
  };
}

async function getUserDetail(db, userId, query = {}) {
  const id = Number(userId);
  const { rows } = await db.query(
    `SELECT id, email, role, name, phone_number, created_at, is_first_login,
            bound_whatsapp_jid, bound_whatsapp_phone
       FROM users WHERE id = $1`,
    [id]
  );
  if (!rows[0]) return null;

  const counts = await db.query(
    `SELECT
       (SELECT count(*)::int FROM whatsapp_messages m WHERE m.user_id = $1) AS message_count,
       (SELECT count(DISTINCT m.id)::int
          FROM whatsapp_messages m
          JOIN normalized_messages n ON n.whatsapp_message_id = m.id
         WHERE m.user_id = $1) AS normalized_count,
       (SELECT count(*)::int
          FROM whatsapp_messages m
         WHERE m.user_id = $1
           AND NOT EXISTS (SELECT 1 FROM normalized_messages n WHERE n.whatsapp_message_id = m.id)
       ) AS pending_count,
       (SELECT count(*)::int
          FROM normalized_messages n
          JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
         WHERE m.user_id = $1 AND n.is_property IS TRUE) AS listing_count,
       (SELECT count(*)::int FROM openai_api_hits h WHERE h.user_id = $1) AS api_hits,
       (SELECT count(*)::int FROM whatsapp_chats c WHERE c.user_id = $1) AS chat_count,
       (SELECT count(*)::int FROM whatsapp_chats c WHERE c.user_id = $1 AND c.is_monitored IS TRUE) AS monitored_chats,
       (SELECT MAX(created_at) FROM whatsapp_messages m WHERE m.user_id = $1) AS last_message_at,
       (SELECT MAX(hit_at) FROM openai_api_hits h WHERE h.user_id = $1) AS last_api_hit_at`,
    [id]
  );

  const parsed = parseUsageQuery(query);
  const usage = await usageSummary(db, {
    userId: id,
    ...parsed
  });

  let billing = null;
  try {
    const { getSubscription, ensureSubscription, publicBilling } = require('./billing');
    const sub = (await getSubscription(db, id)) || (await ensureSubscription(db, rows[0], {
      existingFree: String(rows[0].role).toLowerCase() === 'admin'
    }));
    billing = publicBilling(sub);
  } catch (_) { /* subscriptions table may not exist yet */ }

  return {
    user: rows[0],
    counts: counts.rows[0] || {},
    usage,
    billing
  };
}

module.exports = {
  currentPktYearMonth,
  parseYearMonth,
  parseUsageQuery,
  pktYmd,
  listUsers,
  getUserDetail,
  usageSummary
};
