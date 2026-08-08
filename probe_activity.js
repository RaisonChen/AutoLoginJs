// 探测：哪些"非对话"操作会刷新 last_active_at（= 能保活）。
// 每个操作前后各读一次 last_active_at 对比。全程不发真实对话内容。
const fs = require('fs');
const path = require('path');
// 使用 Node 20+ 内置的全局 WebSocket，无需第三方依赖。

const sessRaw = fs.readFileSync(path.join(__dirname, 'session.json'), 'utf8').replace(/^\uFEFF/, '');
const sess = JSON.parse(sessRaw);
const HOST = sess.host || 'https://monkeycode-ai.com';
const HOSTNAME = HOST.replace(/^https?:\/\//, '');
const cookieHeader = (sess.cookies || []).map((c) => c.name + '=' + c.value).join('; ');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function get(pathname) {
  const r = await fetch(HOST + pathname, {
    method: 'GET',
    headers: { Cookie: cookieHeader, Origin: HOST, 'User-Agent': UA, Accept: 'application/json' },
    redirect: 'manual',
  });
  return { status: r.status, body: await r.text() };
}

let TASK_ID = null;
async function resolveTaskId() {
  const list = await get('/api/v1/users/tasks?page=1&size=10&status=pending%2Cprocessing');
  const m = list.body.match(/"id":"([0-9a-f-]{36})"/);
  return m ? m[1] : null;
}

async function readLastActive() {
  const d = await get('/api/v1/users/tasks/' + encodeURIComponent(TASK_ID));
  try {
    const j = JSON.parse(d.body);
    return j.data ? j.data.last_active_at : null;
  } catch (_) {
    return null;
  }
}

// 通用：连一条 WS，跑 handler(ws)，保持 holdMs 后关闭
function wsRun(pathAndQuery, holdMs, onOpen, onMsg) {
  return new Promise((resolve) => {
    const url = 'wss://' + HOSTNAME + pathAndQuery;
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: { Cookie: cookieHeader, Origin: HOST, 'User-Agent': UA },
      });
    } catch (ex) {
      resolve('构造异常:' + ex.message);
      return;
    }
    let opened = false;
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      resolve(opened ? 'ok(held ' + holdMs + 'ms)' : 'timeout-未握手');
    }, holdMs + 3000);
    ws.addEventListener('open', () => {
      opened = true;
      if (onOpen) { try { onOpen(ws); } catch (_) {} }
      setTimeout(() => {
        clearTimeout(timer);
        try { ws.close(); } catch (_) {}
        resolve('ok(held ' + holdMs + 'ms)');
      }, holdMs);
    });
    ws.addEventListener('message', (evt) => {
      const txt = typeof evt.data === 'string' ? evt.data : '';
      if (txt.indexOf('"type":"ping"') >= 0) {
        try { ws.send(JSON.stringify({ type: 'pong', data: null })); } catch (_) {}
      }
      if (onMsg) onMsg(txt);
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      resolve('ws错误:' + (e && e.message ? e.message : '连接失败'));
    });
  });
}

async function step(name, action) {
  const before = await readLastActive();
  const res = await action();
  await sleep(2500); // 给服务端时间落库
  const after = await readLastActive();
  const changed = before !== after;
  console.log(
    (changed ? '✅ 变化' : '⬜ 不变') + ' | ' + name +
    ' | before=' + before + ' after=' + after +
    (changed ? ' (+' + (after - before) + 's)' : '') +
    ' | 操作结果=' + res
  );
  return changed;
}

(async () => {
  TASK_ID = await resolveTaskId();
  if (!TASK_ID) { console.log('无活跃任务'); return; }
  console.log('任务=' + TASK_ID + '\n');

  // 1. 对照：纯 HTTP 刷新
  await step('HTTP 刷新(status+详情+user-inputs+wallet)', async () => {
    await get('/api/v1/users/status');
    await get('/api/v1/users/tasks/' + TASK_ID);
    await get('/api/v1/users/tasks/user-inputs?id=' + TASK_ID + '&limit=10');
    await get('/api/v1/users/wallet');
    return 'done';
  });

  // 2. 长连 WS attach（只读挂 8 秒，收心跳回 pong，不发内容）
  await step('长连 WS stream?mode=attach 挂8秒(只读)', async () => {
    return await wsRun('/api/v1/users/tasks/stream?id=' + TASK_ID + '&mode=attach', 8000);
  });

  // 3. 长连 WS stream?mode=new 挂8秒(不发任何帧)
  await step('长连 WS stream?mode=new 挂8秒(不发帧)', async () => {
    return await wsRun('/api/v1/users/tasks/stream?id=' + TASK_ID + '&mode=new', 8000);
  });

  // 4. control 通道 连上挂5秒(不发 call)
  await step('control 通道 挂5秒(不发call)', async () => {
    return await wsRun('/api/v1/users/tasks/control?id=' + TASK_ID, 5000);
  });

  // 5. control 通道 发只读 call: port_forward_list
  await step('control 发 call port_forward_list', async () => {
    return await wsRun('/api/v1/users/tasks/control?id=' + TASK_ID, 6000, (ws) => {
      const inner = JSON.stringify({ request_id: uuid() });
      ws.send(JSON.stringify({ type: 'call', kind: 'port_forward_list', data: b64(inner) }));
    });
  });

  // 6. control 通道 发只读 call: repo_file_list
  await step('control 发 call repo_file_list', async () => {
    return await wsRun('/api/v1/users/tasks/control?id=' + TASK_ID, 6000, (ws) => {
      const inner = JSON.stringify({ request_id: uuid() });
      ws.send(JSON.stringify({ type: 'call', kind: 'repo_file_list', data: b64(inner) }));
    });
  });

  console.log('\n完成。凡是标 ✅ 的操作能刷新 last_active_at，即可用来零对话保活。');
})();
