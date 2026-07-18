'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const notify = require('../trigger/notify');

function tmpFile() {
  return path.join(os.tmpdir(), `lw-notify-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
}

test('buildNotifyText summarizes only the wrapup windows', () => {
  const result = {
    windows: [
      { window: 'five_hour', util: 40, level: 85 }, // a warn window, ignored
      { window: 'seven_day', util: 99, level: 'wrapup' },
    ],
  };
  const { title, message } = notify.buildNotifyText(result);
  assert.match(title, /wrapping up/i);
  assert.match(message, /weekly 99%/);
  assert.doesNotMatch(message, /five_hour|40%/); // the warn window is not mentioned
});

test('buildNotifyText falls back gracefully with no wrapup windows', () => {
  const { title, message } = notify.buildNotifyText({ windows: [] });
  assert.ok(title.length > 0);
  assert.match(message, /near the usage cliff/);
});

test('dispatch writes a JSON line when LIMIT_WRAPUP_NOTIFY_FILE is set (no toast)', () => {
  const file = tmpFile();
  const prev = process.env.LIMIT_WRAPUP_NOTIFY_FILE;
  process.env.LIMIT_WRAPUP_NOTIFY_FILE = file;
  try {
    const ok = notify.dispatch('Title here', 'Message here');
    assert.equal(ok, true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.title, 'Title here');
    assert.equal(rec.message, 'Message here');
    assert.equal(typeof rec.ts, 'number');
  } finally {
    if (prev === undefined) delete process.env.LIMIT_WRAPUP_NOTIFY_FILE;
    else process.env.LIMIT_WRAPUP_NOTIFY_FILE = prev;
    try { fs.unlinkSync(file); } catch {}
  }
});

test('LIMIT_WRAPUP_NO_NOTIFY suppresses dispatch entirely', () => {
  const file = tmpFile();
  const prevFile = process.env.LIMIT_WRAPUP_NOTIFY_FILE;
  const prevNo = process.env.LIMIT_WRAPUP_NO_NOTIFY;
  process.env.LIMIT_WRAPUP_NOTIFY_FILE = file;
  process.env.LIMIT_WRAPUP_NO_NOTIFY = '1';
  try {
    const ok = notify.dispatch('t', 'm');
    assert.equal(ok, false);
    assert.equal(fs.existsSync(file), false); // nothing written
  } finally {
    if (prevFile === undefined) delete process.env.LIMIT_WRAPUP_NOTIFY_FILE;
    else process.env.LIMIT_WRAPUP_NOTIFY_FILE = prevFile;
    if (prevNo === undefined) delete process.env.LIMIT_WRAPUP_NO_NOTIFY;
    else process.env.LIMIT_WRAPUP_NO_NOTIFY = prevNo;
    try { fs.unlinkSync(file); } catch {}
  }
});

test('dispatch never throws on bad input', () => {
  assert.doesNotThrow(() => notify.dispatch(undefined, null));
  assert.doesNotThrow(() => notify.dispatch({}, []));
});
