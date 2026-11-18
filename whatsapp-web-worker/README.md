# WhatsApp Web Worker

Real WhatsApp Web scrape via `whatsapp-web.js` (Chromium).

- **Live**: every new message in monitored chats → existing `/api/scraped-chats/messages`
- **Hourly**: last **6 hours** of messages per monitored chat (configurable)
- **Pilot**: `WEB_USER_IDS=4` (Danish)

This is a **second linked device** alongside (or instead of) the Baileys worker. Scan QR once in Linked Devices.

## Contabo setup

```bash
# deps
sudo apt-get update
sudo apt-get install -y chromium-browser fonts-liberation

cd /home/omer/whatsapp-web-worker
cp .env.example .env
# edit BACKEND_API_URL, WEB_USER_IDS=4, optional PROXY_URL (sticky), PUPPETEER_EXECUTABLE_PATH

npm install
# if chromium path unknown:
# which chromium-browser || which google-chrome || which chromium

pm2 start src/index.js --name wa-web-worker
pm2 save
```

Health: `curl http://127.0.0.1:4200/health`  
Manual backfill: `curl -X POST http://127.0.0.1:4200/backfill`

## Proxy

Use a **sticky** IP only (`PROXY_URL=http://user:pass@host:port`). Rotating residential increases ban risk.
