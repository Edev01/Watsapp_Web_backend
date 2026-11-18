const http = require('http');
const cron = require('node-cron');
const config = require('./config');
const log = require('./logger');
const { WebSession } = require('./webSession');

const sessions = new Map(); // userId -> WebSession

async function main() {
  log.info(
    {
      backend: config.backendApiUrl,
      userIds: config.userIds,
      backfillHours: config.backfillHours,
      backfillCron: config.backfillCron,
      proxy: !!config.proxyUrl,
      sessionsDir: config.sessionsDir
    },
    'whatsapp-web-worker starting'
  );

  if (!config.userIds.length) {
    log.error('WEB_USER_IDS empty — set e.g. WEB_USER_IDS=4');
    process.exit(1);
  }

  for (const userId of config.userIds) {
    const session = new WebSession(userId);
    sessions.set(userId, session);
    session.start().catch((err) => {
      log.error({ userId, err: err.message }, 'session start failed');
    });
  }

  if (!cron.validate(config.backfillCron)) {
    log.error({ cron: config.backfillCron }, 'invalid BACKFILL_CRON');
  } else {
    cron.schedule(config.backfillCron, () => {
      for (const session of sessions.values()) {
        session.runBackfill('cron').catch((err) =>
          log.error({ userId: session.userId, err: err.message }, 'cron backfill failed')
        );
      }
    });
    log.info({ cron: config.backfillCron }, 'hourly backfill scheduled');
  }

  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const body = {
        ok: true,
        engine: 'whatsapp-web',
        users: [...sessions.values()].map((s) => ({
          userId: s.userId,
          ready: s.ready,
          monitored: s.monitored.size,
          livePosted: s._livePosted,
          backfillPosted: s._backfillPosted
        }))
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.url?.startsWith('/backfill') && req.method === 'POST') {
      const results = [];
      for (const session of sessions.values()) {
        try {
          await session.runBackfill('manual');
          results.push({ userId: session.userId, ok: true });
        } catch (err) {
          results.push({ userId: session.userId, ok: false, error: err.message });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  server.listen(config.port, () => {
    log.info({ port: config.port }, 'health server listening');
  });

  const shutdown = async (sig) => {
    log.info({ sig }, 'shutting down');
    for (const session of sessions.values()) {
      await session.stop();
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error({ err: err.message, stack: err.stack }, 'fatal');
  process.exit(1);
});
