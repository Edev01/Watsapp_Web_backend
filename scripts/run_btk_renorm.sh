#!/bin/bash
cd /home/omer/whatsapp_scrapper_backend || exit 1
{
  echo "==== user 4 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node scripts/renormalize.js --user 4 --btk --apply --force --no-backup --concurrency 3
  echo "==== user 3 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node scripts/renormalize.js --user 3 --btk --apply --force --no-backup --concurrency 1
  echo "==== done $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >> /tmp/btk_renorm.log 2>&1 &
echo STARTED_PID $!
