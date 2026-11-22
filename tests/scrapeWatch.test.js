const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyScrape } = require('../scrapeWatch');

const now = new Date('2026-11-20T10:00:00Z'); // 15:00 PKT

test('connected with a recent save is healthy', () => {
  const result = classifyScrape({
    monitored: 6,
    scrapeOk: true,
    workerStatus: 'ready',
    lastHeartbeatAt: new Date(now.getTime() - 30 * 1000),
    lastMessageAt: new Date(now.getTime() - 20 * 60 * 1000)
  }, now);
  assert.equal(result, null);
});

test('missing heartbeat is worker down', () => {
  const result = classifyScrape({
    monitored: 2,
    scrapeOk: true,
    workerStatus: 'ready',
    lastHeartbeatAt: new Date(now.getTime() - 10 * 60 * 1000),
    lastMessageAt: new Date(now.getTime() - 5 * 60 * 1000)
  }, now);
  assert.equal(result.reason, 'worker_down');
});

test('not ready is not linked', () => {
  const result = classifyScrape({
    monitored: 2,
    scrapeOk: false,
    workerStatus: 'offline',
    lastHeartbeatAt: new Date(now.getTime() - 20 * 1000),
    lastMessageAt: new Date(now.getTime() - 60 * 1000)
  }, now);
  assert.equal(result.reason, 'not_linked');
});

test('connected but nothing saved for 3 hours during the day is a stall', () => {
  const result = classifyScrape({
    monitored: 6,
    scrapeOk: true,
    workerStatus: 'ready',
    lastHeartbeatAt: new Date(now.getTime() - 20 * 1000),
    lastMessageAt: new Date(now.getTime() - 4 * 60 * 60 * 1000)
  }, now);
  assert.equal(result.reason, 'not_saving');
});

test('overnight silence while connected does not alert', () => {
  const night = new Date('2026-11-20T21:30:00Z'); // 02:30 PKT
  const result = classifyScrape({
    monitored: 6,
    scrapeOk: true,
    workerStatus: 'ready',
    lastHeartbeatAt: new Date(night.getTime() - 20 * 1000),
    lastMessageAt: new Date(night.getTime() - 6 * 60 * 60 * 1000)
  }, night);
  assert.equal(result, null);
});

test('a user with no monitored groups is ignored', () => {
  const result = classifyScrape({
    monitored: 0,
    scrapeOk: false,
    workerStatus: 'offline',
    lastHeartbeatAt: null,
    lastMessageAt: null
  }, now);
  assert.equal(result, null);
});
