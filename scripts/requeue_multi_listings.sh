#!/bin/bash
export PGPASSWORD=cIOQWr8YhVkP8wsXrWDUFLeJ
export PAGER=cat
psql -h 127.0.0.1 -U whatsapp -d whatsapp_web -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS listing_index INTEGER DEFAULT 0;
ALTER TABLE normalized_messages ADD COLUMN IF NOT EXISTS listing_excerpt TEXT;

CREATE TEMP TABLE multi_msgs AS
SELECT m.id AS message_id
FROM whatsapp_messages m
WHERE m.message IS NOT NULL
  AND (
    (length(lower(m.message)) - length(replace(lower(m.message), 'yard', ''))) / 4 >= 3
    OR (length(lower(m.message)) - length(replace(lower(m.message), 'demand', ''))) / 6 >= 3
  )
  AND (SELECT COUNT(*) FROM normalized_messages n WHERE n.whatsapp_message_id = m.id) = 1;

SELECT COUNT(*) AS multi_single_row FROM multi_msgs;

DELETE FROM normalized_messages n
USING multi_msgs mm
WHERE n.whatsapp_message_id = mm.message_id;

SELECT COUNT(*) AS requeued_messages FROM multi_msgs;
SQL
echo DONE_RQ
