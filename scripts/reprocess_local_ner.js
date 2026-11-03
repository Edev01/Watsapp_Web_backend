#!/usr/bin/env node
/**
 * Local NER + gazetteer reprocess is no longer part of normalization.
 * Use scripts/renormalize.js (scraped message → LLM → saved fields).
 */
console.error('Local NER reprocess is removed.');
console.error('Normalization is scraped message → LLM → saved fields.');
console.error('Use: node scripts/renormalize.js --user <id> --apply');
process.exit(1);
