const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('./config');
const backend = require('./backendClient');
const log = require('./logger');
const { mapMessage, chatIdFromMessage } = require('./messageMapper');

function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    const hostPort = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    return {
      hostPort,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || '')
    };
  } catch (err) {
    log.warn({ err: err.message }, 'invalid PROXY_URL');
    return null;
  }
}

class WebSession {
  constructor(userId) {
    this.userId = userId;
    this.client = null;
    this.ready = false;
    this.monitored = new Map();
    this._monitorTimer = null;
    this._healthTimer = null;
    this._backfilling = false;
    this._livePosted = 0;
    this._backfillPosted = 0;
    this._stopping = false;
    this._restarting = false;
    this._restartTimer = null;
    this._backfillTimer = null;
    this._proxyAuthDone = false;
  }

  buildClient() {
    const sessionPath = path.join(config.sessionsDir, `user_${this.userId}`);
    const proxy = parseProxy(config.proxyUrl);

    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check'
    ];
    if (proxy?.hostPort) {
      puppeteerArgs.push(`--proxy-server=${proxy.hostPort}`);
    }

    const puppeteerOpts = {
      headless: true,
      args: puppeteerArgs
    };
    if (config.puppeteerExecutablePath) {
      puppeteerOpts.executablePath = config.puppeteerExecutablePath;
    }

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: `portal_${this.userId}`,
        dataPath: sessionPath
      }),
      puppeteer: puppeteerOpts,
      webVersionCache: { type: 'none' }
    });

    const isCurrent = () => client === this.client;

    client.on('qr', async (qr) => {
      if (!isCurrent()) return;
      try {
        await this.ensureProxyAuth(proxy);
        // Post the raw pairing string (same as Baileys). The portal renders it with
        // QRCodeSVG — a data:image URL here freezes/crashes the browser.
        await backend.postQr(this.userId, qr);
        log.info({ userId: this.userId, qrLen: String(qr || '').length }, 'QR posted — scan Linked Devices (WhatsApp Web)');
      } catch (err) {
        log.error({ userId: this.userId, err: err.message }, 'postQr failed');
      }
    });

    client.on('authenticated', () => {
      if (!isCurrent()) return;
      log.info({ userId: this.userId }, 'authenticated');
    });

    client.on('ready', async () => {
      if (!isCurrent()) return;
      this.ready = true;
      const wid = client.info?.wid?._serialized || null;
      log.info({ userId: this.userId, wid }, 'WhatsApp Web ready');
      try {
        await backend.postQrStatus(this.userId, 'WhatsApp Web linked', wid);
      } catch (err) {
        log.warn({ err: err.message }, 'postQrStatus failed');
      }
      await this.refreshMonitored();
      this.reportHealth().catch(() => {});
      // Let WhatsApp Web finish its post-login navigation before touching chats.
      this.scheduleBackfill('ready', client);
      if (this._monitorTimer) clearInterval(this._monitorTimer);
      this._monitorTimer = setInterval(
        () => this.refreshMonitored().catch(() => {}),
        config.monitoredPollMs
      );
      if (this._healthTimer) clearInterval(this._healthTimer);
      this._healthTimer = setInterval(
        () => this.reportHealth().catch(() => {}),
        60_000
      );
    });

    client.on('auth_failure', (msg) => {
      if (!isCurrent()) return;
      this.ready = false;
      log.error({ userId: this.userId, msg }, 'auth_failure');
      this.reportHealth().catch(() => {});
    });

    client.on('disconnected', (reason) => {
      // destroy() on a replaced client also emits this. Ignore it so one logout
      // cannot start a second browser and kill the session that just linked.
      if (!isCurrent()) return;
      this.ready = false;
      log.warn({ userId: this.userId, reason }, 'disconnected');
      this.reportHealth().catch(() => {});
      if (this._stopping || this._restarting) return;
      this.scheduleRestart();
    });

    client.on('message', (msg) => this.onLiveMessage(msg));
    client.on('message_create', (msg) => {
      if (msg.fromMe) this.onLiveMessage(msg);
    });

    // Attach proxy auth as soon as puppeteer page exists
    if (proxy?.username) {
      const tryAuth = () => this.ensureProxyAuth(proxy);
      client.on('loading_screen', tryAuth);
      const poll = setInterval(() => {
        tryAuth().then((ok) => {
          if (ok) clearInterval(poll);
        });
      }, 400);
      setTimeout(() => clearInterval(poll), 90_000);
    }

    return client;
  }

  async ensureProxyAuth(proxy) {
    if (!proxy?.username || this._proxyAuthDone) return this._proxyAuthDone;
    const page = this.client?.pupPage;
    if (!page) return false;
    try {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password
      });
      this._proxyAuthDone = true;
      log.info({ userId: this.userId }, 'proxy auth attached');
      return true;
    } catch (err) {
      log.warn({ err: err.message }, 'proxy auth failed');
      return false;
    }
  }

  scheduleRestart() {
    if (this._restartTimer || this._restarting || this._stopping) return;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.restart().catch((err) =>
        log.error({ userId: this.userId, err: err.message }, 'restart failed')
      );
    }, 5000);
  }

  scheduleBackfill(reason, client) {
    if (this._backfillTimer) clearTimeout(this._backfillTimer);
    this._backfillTimer = setTimeout(() => {
      this._backfillTimer = null;
      if (client !== this.client || !this.ready || this._restarting) return;
      this.runBackfill(reason).catch((err) =>
        log.error({ userId: this.userId, err: err.message }, 'backfill failed')
      );
    }, 20000);
  }

  async start() {
    this._stopping = false;
    this._proxyAuthDone = false;
    this.client = this.buildClient();
    await this.client.initialize();
  }

  async restart() {
    if (this._stopping || this._restarting) return;
    this._restarting = true;
    if (this._backfillTimer) {
      clearTimeout(this._backfillTimer);
      this._backfillTimer = null;
    }
    log.info({ userId: this.userId }, 'restarting session');
    const old = this.client;
    this.client = null;
    this.ready = false;
    try {
      if (old) await old.destroy();
    } catch (_) {}
    try {
      await this.start();
    } finally {
      this._restarting = false;
    }
  }

  async refreshMonitored() {
    const rows = await backend.getMonitored(this.userId);
    const next = new Map();
    for (const row of rows) {
      const jid = String(row.chat_jid || row.jid || row.chatId || '').trim();
      if (!jid) continue;
      const name = row.chat_name || row.name || jid;
      next.set(jid, { jid, name });
    }
    this.monitored = next;
    log.info({ userId: this.userId, count: next.size }, 'monitored refreshed');
  }

  isMonitored(jid) {
    if (!jid) return false;
    if (this.monitored.has(jid)) return true;
    const head = String(jid).split('@')[0];
    for (const key of this.monitored.keys()) {
      if (key.split('@')[0] === head) return true;
    }
    return false;
  }

  monitoredMeta(jid) {
    if (this.monitored.has(jid)) return this.monitored.get(jid);
    const head = String(jid).split('@')[0];
    for (const [key, meta] of this.monitored) {
      if (key.split('@')[0] === head) return meta;
    }
    return { jid, name: jid };
  }

  async onLiveMessage(msg) {
    if (!this.ready) return;
    try {
      const chatId = chatIdFromMessage(msg);
      if (!this.isMonitored(chatId)) return;
      const mapped = mapMessage(msg);
      if (!mapped) return;
      const meta = this.monitoredMeta(chatId);
      await backend.postMessages(this.userId, {
        chatId: meta.jid,
        chatName: meta.name,
        messages: [mapped]
      });
      this._livePosted += 1;
      log.debug({ userId: this.userId, chatId: meta.jid, id: mapped.id }, 'live posted');
    } catch (err) {
      log.warn({ userId: this.userId, err: err.message }, 'live post failed');
    }
  }

  async runBackfill(reason = 'cron') {
    if (!this.ready || this._backfilling) {
      log.info({ userId: this.userId, reason, ready: this.ready }, 'backfill skipped');
      return;
    }
    this._backfilling = true;
    const sinceSec = Math.floor((Date.now() - config.backfillHours * 3600 * 1000) / 1000);
    let chatsDone = 0;
    let msgsPosted = 0;

    log.info(
      {
        userId: this.userId,
        reason,
        hours: config.backfillHours,
        monitored: this.monitored.size,
        fetchLimit: config.backfillFetchLimit
      },
      'backfill start'
    );

    try {
      await this.refreshMonitored();
      for (const meta of this.monitored.values()) {
        try {
          const chat = await this.client.getChatById(meta.jid);
          if (!chat) {
            log.warn({ jid: meta.jid }, 'chat not found in Web store');
            continue;
          }
          const raw = await chat.fetchMessages({ limit: config.backfillFetchLimit });
          const batch = [];
          for (const m of raw) {
            const ts = Number(m.timestamp) || 0;
            if (ts < sinceSec) continue;
            const mapped = mapMessage(m);
            if (mapped) batch.push(mapped);
          }
          if (batch.length) {
            for (let i = 0; i < batch.length; i += 40) {
              const slice = batch.slice(i, i + 40);
              await backend.postMessages(this.userId, {
                chatId: meta.jid,
                chatName: meta.name,
                messages: slice
              });
              msgsPosted += slice.length;
            }
          }
          chatsDone += 1;
          log.info(
            { userId: this.userId, jid: meta.jid, fetched: raw.length, kept: batch.length },
            'backfill chat'
          );
        } catch (err) {
          log.warn(
            { userId: this.userId, jid: meta.jid, err: err.message },
            'backfill chat failed'
          );
        }
      }
      this._backfillPosted += msgsPosted;
      log.info({ userId: this.userId, reason, chatsDone, msgsPosted }, 'backfill done');
      await this.reportHealth({
        lastBackfill: { reason, chatsDone, msgsPosted, at: new Date().toISOString() }
      });
    } finally {
      this._backfilling = false;
    }
  }

  async reportHealth(extra = {}) {
    try {
      const status = this.ready ? 'ready' : 'offline';
      await backend.postScrapeHealth(this.userId, {
        status,
        workerStatus: status,
        scrapeOk: this.ready === true,
        ready: this.ready,
        engine: 'whatsapp-web',
        monitored: this.monitored.size,
        livePosted: this._livePosted,
        backfillPosted: this._backfillPosted,
        proxy: !!config.proxyUrl,
        warning: this.ready ? null : 'WhatsApp Web session is down — scan the QR to link again',
        ...extra
      });
    } catch (_) {}
  }

  async stop() {
    this._stopping = true;
    if (this._restartTimer) clearTimeout(this._restartTimer);
    if (this._backfillTimer) clearTimeout(this._backfillTimer);
    if (this._monitorTimer) clearInterval(this._monitorTimer);
    if (this._healthTimer) clearInterval(this._healthTimer);
    this.ready = false;
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (_) {}
    }
  }
}

module.exports = { WebSession };
