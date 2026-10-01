#!/usr/bin/env python3
"""
Find duplicate WhatsApp / listing rows, copy losers into `trash`, then delete them.

Usage:
  python3 scripts/purge_duplicates.py              # dry-run (default)
  python3 scripts/purge_duplicates.py --apply      # trash + delete
  python3 scripts/purge_duplicates.py --apply --user-id 4
  python3 scripts/purge_duplicates.py --stats      # trash table summary only

Cron (apply mode):
  */30 * * * * cd /home/omer/whatsapp_scrapper_backend && /usr/bin/python3 scripts/purge_duplicates.py --apply >> logs/purge_duplicates.log 2>&1
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except ImportError:
    # Minimal .env loader
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("psycopg2 required: pip3 install --user psycopg2-binary", file=sys.stderr)
    sys.exit(1)


# --- fingerprint helpers (mirror contentFingerprint.js) ---

_PUNCT_RE = re.compile(r"[^\w\s./-]+", re.UNICODE)
_MD_RE = re.compile(r"[*_`~#>|]+")
_WS_RE = re.compile(r"\s+")


def collapse_repeated_text(raw: str) -> str:
    t = _WS_RE.sub(" ", str(raw or "")).strip()
    if len(t) < 40:
        return t
    half = len(t) // 2
    if half >= 20 and t[:half].strip() == t[half:].strip():
        return t[:half].strip()
    no_punct = _WS_RE.sub(" ", re.sub(r"[.,!?;:]+", " ", t)).strip()
    h2 = len(no_punct) // 2
    if h2 >= 20 and no_punct[:h2].strip() == no_punct[h2:].strip():
        return no_punct[:h2].strip()
    return t


def normalize_fingerprint_text(s: str) -> str:
    t = collapse_repeated_text(s).lower()
    t = _MD_RE.sub(" ", t)
    t = _PUNCT_RE.sub(" ", t)
    return _WS_RE.sub(" ", t).strip()


def message_content_fingerprint(text: str, min_len: int = 40, max_len: int = 220) -> Optional[str]:
    n = normalize_fingerprint_text(text)
    if len(n) < min_len:
        return None
    return n[:max_len]


def listing_content_fingerprint(
    row: Dict[str, Any], min_len: int = 24, max_len: int = 220
) -> Optional[str]:
    excerpt = normalize_fingerprint_text(row.get("listing_excerpt") or "")
    summary = normalize_fingerprint_text(row.get("summary") or "")
    raw = normalize_fingerprint_text(
        row.get("raw_message") or row.get("message") or ""
    )
    body = ""
    for candidate in (raw, excerpt, summary):
        if len(candidate) >= min_len and len(candidate) >= len(body):
            body = candidate
    if not body or len(body) < min_len:
        return None
    purpose = str(row.get("purpose") or "").lower().strip()
    return f"{body[:max_len]}|{purpose}"


def user_message_fp(user_id: int, text: str) -> Optional[str]:
    base = message_content_fingerprint(text)
    if not base:
        return None
    return f"u{int(user_id or 0)}|{base}"


def user_listing_fp(user_id: int, row: Dict[str, Any]) -> Optional[str]:
    base = listing_content_fingerprint(row)
    if not base:
        return None
    return f"u{int(user_id or 0)}|{base}"


def short_key(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:16]


# --- DB ---

ENSURE_TRASH_SQL = """
CREATE TABLE IF NOT EXISTS trash (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL,
  source_table TEXT NOT NULL,
  original_id INTEGER NOT NULL,
  user_id INTEGER,
  dup_reason TEXT NOT NULL,
  dup_key TEXT,
  kept_id INTEGER,
  payload JSONB NOT NULL,
  trashed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trash_run ON trash (run_id);
CREATE INDEX IF NOT EXISTS idx_trash_source_orig ON trash (source_table, original_id);
CREATE INDEX IF NOT EXISTS idx_trash_trashed_at ON trash (trashed_at DESC);
"""


def connect():
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL missing", file=sys.stderr)
        sys.exit(1)
    # Local / Contabo Postgres usually no SSL; Neon/cloud may need it
    kwargs: Dict[str, Any] = {"dsn": url}
    if "localhost" in url or "127.0.0.1" in url or "194.233." in url:
        kwargs["sslmode"] = "prefer"
    return psycopg2.connect(**kwargs)


def row_to_json(row: Dict[str, Any]) -> str:
    def default(o):
        if isinstance(o, datetime):
            return o.isoformat()
        if isinstance(o, uuid.UUID):
            return str(o)
        return str(o)

    return json.dumps(row, default=default, ensure_ascii=False)


def insert_trash(
    cur,
    run_id: str,
    source_table: str,
    original_id: int,
    user_id: Optional[int],
    dup_reason: str,
    dup_key: Optional[str],
    kept_id: Optional[int],
    payload: Dict[str, Any],
) -> None:
    cur.execute(
        """
        INSERT INTO trash (run_id, source_table, original_id, user_id, dup_reason, dup_key, kept_id, payload)
        VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s::jsonb)
        """,
        (
            run_id,
            source_table,
            original_id,
            user_id,
            dup_reason,
            dup_key,
            kept_id,
            row_to_json(payload),
        ),
    )


# --- find duplicates ---

def find_message_body_dups(
    cur, user_id: Optional[int]
) -> List[Tuple[Dict[str, Any], int, str]]:
    """
    Returns list of (loser_row, kept_id, dup_key).
    Keep highest id per user+body fingerprint.
    """
    params: List[Any] = []
    filt = ""
    if user_id is not None:
        params.append(user_id)
        filt = "WHERE user_id = %s"

    cur.execute(
        f"""
        SELECT id, user_id, chat_jid, sender, timestamp, message, from_me,
               seq_in_chat, content_fingerprint, sender_phone, created_at
        FROM whatsapp_messages
        {filt}
        ORDER BY id DESC
        """,
        params,
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    keep: Dict[str, int] = {}
    losers: List[Tuple[Dict[str, Any], int, str]] = []
    for r in rows:
        fp = r.get("content_fingerprint") or user_message_fp(r["user_id"], r.get("message") or "")
        if not fp:
            continue
        key = short_key(fp)
        if fp in keep:
            losers.append((r, keep[fp], f"message_body:{key}"))
        else:
            keep[fp] = r["id"]
    return losers


def find_listing_content_dups(
    cur, user_id: Optional[int]
) -> List[Tuple[Dict[str, Any], int, str]]:
    """
    Duplicate property cards (normalized_messages) by listing fingerprint.
    Keep highest n.id.
    """
    params: List[Any] = []
    filt = ""
    if user_id is not None:
        params.append(user_id)
        filt = "AND m.user_id = %s"

    cur.execute(
        f"""
        SELECT n.id, n.whatsapp_message_id, n.listing_index, n.is_property, n.purpose,
               n.city, n.area, n.vicinity, n.size, n.price, n.property_type, n.summary,
               n.listing_excerpt, n.content_fingerprint, n.property_status,
               n.place_tags, n.created_at AS n_created_at,
               m.user_id, m.message AS raw_message, m.chat_jid, m.sender, m.timestamp
        FROM normalized_messages n
        JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
        WHERE n.is_property IS TRUE
          {filt}
        ORDER BY n.id DESC
        """,
        params,
    )
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    keep: Dict[str, int] = {}
    losers: List[Tuple[Dict[str, Any], int, str]] = []
    for r in rows:
        fp = r.get("content_fingerprint") or user_listing_fp(r["user_id"], r)
        if not fp:
            continue
        key = short_key(fp)
        if fp in keep:
            losers.append((r, keep[fp], f"listing_content:{key}"))
        else:
            keep[fp] = r["id"]
    return losers


def print_stats(cur) -> None:
    cur.execute(
        """
        SELECT source_table, dup_reason, COUNT(*)::int AS n,
               MIN(trashed_at) AS first_at, MAX(trashed_at) AS last_at
        FROM trash
        GROUP BY source_table, dup_reason
        ORDER BY source_table, dup_reason
        """
    )
    rows = cur.fetchall()
    cur.execute("SELECT COUNT(*)::int FROM trash")
    total = cur.fetchone()[0]
    print(json.dumps({"trash_total": total, "by_reason": [
        {"source_table": a, "dup_reason": b, "count": c, "first_at": str(d), "last_at": str(e)}
        for a, b, c, d, e in rows
    ]}, indent=2, default=str))


def apply_purge(
    conn,
    *,
    apply: bool,
    user_id: Optional[int],
    limit: Optional[int],
) -> Dict[str, Any]:
    run_id = str(uuid.uuid4())
    started = datetime.now(timezone.utc).isoformat()
    cur = conn.cursor()
    cur.execute(ENSURE_TRASH_SQL)
    conn.commit()

    msg_losers = find_message_body_dups(cur, user_id)
    listing_losers = find_listing_content_dups(cur, user_id)

    if limit is not None:
        msg_losers = msg_losers[:limit]
        listing_losers = listing_losers[:limit]

    summary: Dict[str, Any] = {
        "run_id": run_id,
        "started_at": started,
        "apply": apply,
        "user_id": user_id,
        "message_body_dups_found": len(msg_losers),
        "listing_content_dups_found": len(listing_losers),
        "trashed_messages": 0,
        "trashed_listings": 0,
        "deleted_messages": 0,
        "deleted_listings": 0,
        "samples": {
            "messages": [
                {
                    "id": r["id"],
                    "kept_id": kept,
                    "user_id": r.get("user_id"),
                    "preview": str(r.get("message") or "")[:100].replace("\n", " "),
                }
                for r, kept, _ in msg_losers[:5]
            ],
            "listings": [
                {
                    "id": r["id"],
                    "kept_id": kept,
                    "user_id": r.get("user_id"),
                    "area": r.get("area"),
                    "preview": str(r.get("raw_message") or r.get("summary") or "")[:100].replace(
                        "\n", " "
                    ),
                }
                for r, kept, _ in listing_losers[:5]
            ],
        },
    }

    if not apply:
        print(json.dumps(summary, indent=2, default=str))
        print("DRY_RUN — pass --apply to trash + delete")
        return summary

    # 1) Listings first (depend on messages)
    for r, kept_id, dup_key in listing_losers:
        insert_trash(
            cur,
            run_id,
            "normalized_messages",
            r["id"],
            r.get("user_id"),
            "listing_content",
            dup_key,
            kept_id,
            r,
        )
        summary["trashed_listings"] += 1

    listing_ids = [r["id"] for r, _, _ in listing_losers]
    for i in range(0, len(listing_ids), 500):
        batch = listing_ids[i : i + 500]
        # Drop private fav/comments pointing at doomed cards
        cur.execute(
            "DELETE FROM property_favourites WHERE property_id = ANY(%s::int[])",
            (batch,),
        )
        cur.execute(
            "DELETE FROM property_comments WHERE property_id = ANY(%s::int[])",
            (batch,),
        )
        cur.execute(
            "DELETE FROM normalized_messages WHERE id = ANY(%s::int[])",
            (batch,),
        )
        summary["deleted_listings"] += cur.rowcount or 0

    # 2) Messages — only delete if no remaining normalized rows reference them
    for r, kept_id, dup_key in msg_losers:
        insert_trash(
            cur,
            run_id,
            "whatsapp_messages",
            r["id"],
            r.get("user_id"),
            "message_body",
            dup_key,
            kept_id,
            r,
        )
        summary["trashed_messages"] += 1

    msg_ids = [r["id"] for r, _, _ in msg_losers]
    for i in range(0, len(msg_ids), 500):
        batch = msg_ids[i : i + 500]
        # Trash + delete any leftover normalized children of these messages
        cur.execute(
            """
            SELECT n.id, n.whatsapp_message_id, n.listing_index, n.is_property, n.purpose,
                   n.city, n.area, n.vicinity, n.size, n.price, n.property_type, n.summary,
                   n.listing_excerpt, n.content_fingerprint, n.property_status, n.place_tags,
                   m.user_id, m.message AS raw_message
            FROM normalized_messages n
            JOIN whatsapp_messages m ON m.id = n.whatsapp_message_id
            WHERE n.whatsapp_message_id = ANY(%s::int[])
            """,
            (batch,),
        )
        cols = [d[0] for d in cur.description]
        child_rows = [dict(zip(cols, row)) for row in cur.fetchall()]
        child_ids = []
        for child in child_rows:
            insert_trash(
                cur,
                run_id,
                "normalized_messages",
                child["id"],
                child.get("user_id"),
                "orphan_of_dup_message",
                f"parent_msg:{child['whatsapp_message_id']}",
                None,
                child,
            )
            child_ids.append(child["id"])
            summary["trashed_listings"] += 1
        if child_ids:
            cur.execute(
                "DELETE FROM property_favourites WHERE property_id = ANY(%s::int[])",
                (child_ids,),
            )
            cur.execute(
                "DELETE FROM property_comments WHERE property_id = ANY(%s::int[])",
                (child_ids,),
            )
            cur.execute(
                "DELETE FROM normalized_messages WHERE id = ANY(%s::int[])",
                (child_ids,),
            )
            summary["deleted_listings"] += cur.rowcount or 0

        cur.execute(
            "DELETE FROM whatsapp_messages WHERE id = ANY(%s::int[])",
            (batch,),
        )
        summary["deleted_messages"] += cur.rowcount or 0

    conn.commit()
    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    print(json.dumps(summary, indent=2, default=str))
    print("PURGE_COMPLETE")
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description="Purge duplicate messages/listings into trash")
    ap.add_argument("--apply", action="store_true", help="Actually trash + delete (default is dry-run)")
    ap.add_argument("--user-id", type=int, default=None, help="Limit to one user_id")
    ap.add_argument("--limit", type=int, default=None, help="Max losers per category (debug)")
    ap.add_argument("--stats", action="store_true", help="Print trash table stats only")
    args = ap.parse_args()

    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute(ENSURE_TRASH_SQL)
        conn.commit()

        if args.stats:
            print_stats(cur)
            return 0

        apply_purge(conn, apply=args.apply, user_id=args.user_id, limit=args.limit)
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
