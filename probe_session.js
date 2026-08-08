'use strict';

/**
 * 临时只读/观察探测脚本。
 *
 *   node probe_session.js            只读：dump 一次任务详情 + user-inputs（拿空闲基线）
 *   node probe_session.js watch      发一条真实对话，并：
 *                                      (a) 打印 stream 通道收到的每一帧类型（找“会话进行中/结束”信号）
 *                                      (b) 每 3 秒 dump 一次 status + stats + 最新 seq（对比字段变化）
 *
 * 目的：找出真正的“会话级”判断依据——
 *   - 判断“会话是否还在跑”（用来决定要不要 user-cancel）
 *   - 判断“本次会话是否发送/回复成功”
 * 只观察，不改主程序逻辑。watch 模式会真实消耗一轮对话。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const BaseUrl = 'https://monkeycode-ai.com';
const Host = 'monkeycode-ai.com';
const WsStreamPath = '/api/v1/users/tasks/stream';
const SessionFile = path.join(__dirname, 'session.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

function nowStamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' + p3(d.getMilliseconds());
}

function loadCookie() {
  let text = fs.readFileSync(SessionFile, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const obj = JSON.parse(text);
  const parts = [];
  if (Array.isArray(obj.cookies)) {
    for (const c of obj.cookies) {
      if (c && typeof c.name === 'string' && typeof c.value === 'string') parts.push(c.name + '=' + c.value);
    }
  }
  return parts.join('; ');
}

function get(urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      BaseUrl + urlPath,
      { method: 'GET', headers: { Cookie: cookie, 'User-Agent': UA, Accept: 'application/json', Origin: BaseUrl, Referer: BaseUrl + '/' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function firstTaskId(tasksBody) {
  const obj = JSON.parse(tasksBody);
  const arr = Array.isArray(obj.tasks) ? obj.tasks : obj.data && Array.isArray(obj.data.tasks) ? obj.data.tasks : Array.isArray(obj.data) ? obj.data : [];
  return arr.length ? arr[0].id : null;
}

function pretty(body) {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch (_) { return body; }
}

const base64Utf8 = (s) => Buffer.from(s, 'utf8').toString('base64');

// 摘出关注字段：任务顶层 status + stats + VM status + 最新 user-input seq。
async function snapshot(taskId, cookie) {
  const d = await get('/api/v1/users/tasks/' + taskId, cookie);
  let status = '?', vm = '?', stats = {};
  try {
    const t = JSON.parse(d.body).data || {};
    status = t.status;
    vm = t.virtualmachine ? t.virtualmachine.status : '?';
    stats = t.stats || {};
  } catch (_) {}
  const ui = await get('/api/v1/users/tasks/user-inputs?id=' + taskId + '&limit=1', cookie);
  let seq = '?';
  try { const it = (JSON.parse(ui.body).data || {}).items || []; if (it.length) seq = it[0].seq; } catch (_) {}
  return { status, vm, seq, stats };
}

function fmtSnap(s) {
  return 'status=' + s.status + ' vm=' + s.vm + ' seq=' + s.seq
    + ' llm_requests=' + (s.stats.llm_requests) + ' out_tokens=' + (s.stats.output_tokens) + ' total=' + (s.stats.total_tokens);
}

async function readOnly() {
  const cookie = loadCookie();
  const tasks = await get('/api/v1/users/tasks?page=1&size=24', cookie);
  const taskId = firstTaskId(tasks.body);
  console.log('=== taskId =', taskId, '===\n');
  const detail = await get('/api/v1/users/tasks/' + taskId, cookie);
  console.log('--- GET /tasks/{id} (status=' + detail.status + ') ---');
  console.log(pretty(detail.body));
  const inputs = await get('/api/v1/users/tasks/user-inputs?id=' + taskId + '&limit=5', cookie);
  console.log('\n--- GET /tasks/user-inputs (status=' + inputs.status + ') ---');
  console.log(pretty(inputs.body));
}

async function watch() {
  const cookie = loadCookie();
  const tasks = await get('/api/v1/users/tasks?page=1&size=24', cookie);
  const taskId = firstTaskId(tasks.body);
  console.log('=== watch taskId =', taskId, '===');

  const before = await snapshot(taskId, cookie);
  console.log('[' + nowStamp() + '] 基线   ' + fmtSnap(before));

  const content = '一句话确认：HTTP 状态码 200 表示请求成功，对吗？只回 1 或 0。';
  const url = 'wss://' + Host + WsStreamPath + '?id=' + encodeURIComponent(taskId) + '&mode=new';
  const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: BaseUrl, 'User-Agent': UA } });

  // 每 3 秒 dump 一次 REST 快照。
  let ticks = 0;
  const poll = setInterval(async () => {
    ticks++;
    try { const s = await snapshot(taskId, cookie); console.log('[' + nowStamp() + '] poll#' + ticks + ' ' + fmtSnap(s)); } catch (_) {}
    if (ticks >= 14) finish();
  }, 3000);

  let finished = false;
  function finish() {
    if (finished) return; finished = true;
    clearInterval(poll);
    try { ws.close(); } catch (_) {}
    console.log('[' + nowStamp() + '] 观察结束。');
    process.exit(0);
  }

  ws.addEventListener('open', () => {
    console.log('[' + nowStamp() + '] WS open，发送 user-input ...');
    const inner = JSON.stringify({ content: base64Utf8(content), attachments: [] });
    ws.send(JSON.stringify({ type: 'user-input', data: base64Utf8(inner) }));
  });

  ws.addEventListener('message', (evt) => {
    const txt = typeof evt.data === 'string' ? evt.data : '(binary)';
    // 只打印帧的 type 字段（避免刷屏），并回应心跳。
    let type = '?';
    try { const o = JSON.parse(txt); type = o.type; if (o.type === 'ping') ws.send(JSON.stringify({ type: 'pong', data: null })); } catch (_) {}
    const preview = txt.length > 160 ? txt.slice(0, 160) + '…' : txt;
    console.log('[' + nowStamp() + '] WS帧 type=' + type + '  ' + preview);
  });

  ws.addEventListener('error', (e) => console.log('[' + nowStamp() + '] WS error ' + (e && e.message ? e.message : '')));
  ws.addEventListener('close', (e) => console.log('[' + nowStamp() + '] WS close code=' + (e && e.code)));

  // 安全兜底：最多观察 50 秒。
  setTimeout(finish, 50000);
}

const mode = process.argv[2];
(mode === 'watch' ? watch() : readOnly()).catch((e) => {
  console.error('ERR', e && e.message ? e.message : e);
  process.exit(1);
});
