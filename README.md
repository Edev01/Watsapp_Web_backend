# WhatsApp Web Backend

Node.js & Express backend for WhatsApp Web message scraping, multi-tenant QR code management, real estate property parsing, realtor data isolation, and **in-process AI normalization** (Together AI + Ollama embeddings).

## Features
- Multi-tenant client data isolation (`user_id` scoping for QR codes, chats, and messages).
- Socket.IO real-time QR code broadcasting.
- Real estate listing normalization via Together AI (replaces the separate Python ML server).
- Background pipeline worker with job locks, retries, and graceful shutdown.
- RESTful API endpoints for WhatsApp chats, realtors list, and message history.

## AI pipeline (production)

Set in `.env` (see `.env.example`):

```env
AI_PIPELINE=local
LLM_BASE_URL=https://api.together.ai/v1
LLM_API_KEY=...
DEFAULT_MODEL=openai/gpt-oss-20b
NORMALIZE_MODEL=openai/gpt-oss-20b
EMBEDDING_BASE_URL=http://localhost:11434/v1
EMBEDDING_MODEL=nomic-embed-text
```

- `POST /api/normalize/trigger` — queues a job and wakes the local worker (non-blocking)
- `GET /api/normalize/status` — progress for the logged-in user
- `GET /api/pipeline-status` — worker stats
- `GET /health` — DB + AI config + pipeline

### Cutover from Python ML server

1. Deploy this backend with the env vars above.
2. Confirm `GET /health` shows `llmConfigured: true` and `pipeline.workerStarted: true`.
3. Trigger normalize from the portal; jobs should move `queued → running → completed` without `AI_BOT_URL`.
4. Unset `AI_BOT_URL` and shut down the Python/uvicorn ML host.
5. Keep Ollama reachable for embeddings (or expect normalize to finish with an embed note in `last_error` if Ollama is down).

`AI_PIPELINE=remote` still supports the legacy Python bot via `AI_BOT_URL` if you need a rollback.

## Run

```bash
cp .env.example .env   # fill secrets
npm install
npm start
```
