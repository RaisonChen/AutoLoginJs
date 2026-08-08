// 休眠阈值观测：不发对话，只定时 GET 任务详情，
// 记录 last_active_at / vm.status / Hibernated condition，直到检测到休眠。
// 用法：node watch_idle.js [轮询间隔分钟，默认5] [taskId 可选]
const fs = require('fs');
const path = require('path');

const sessRaw = fs.readFileSync(path.join(__dirname, 'session.json'), 'utf8').replace(/^\uFEFF/, '');
const sess = JSON.parse(sessRaw);
const HOST = sess.host || 'https://monkeycode-ai.com';
const cookieHeader = (sess.cookies || []).map((c) => c.name + '=' + c.value).join('; ');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const intervalMin = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 5;
let taskId = process.argv[3] || null;

function ts(sec) {
  return new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false });
}
function nowStr() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

async function get(pathname) {
  try {
    const r = await fetch(HOST + pathname, {
      method: 'GET',
      headers: { Cookie: cookieHeader, Origin: HOST, 'User-Agent': UA, Accept: 'application/json' },
      redirect: 'manual',
    });
    return { status: r.status, body: await r.text() };
  } catch (ex) {
    return { status: 0, body: 'ERR:' + (ex && ex.message ? ex.message : ex) };
  }
}

async function resolveTaskId() {
  const list = await get('/api/v1/users/tasks?page=1&size=10&status=pending%2Cprocessing');
  const m = list.body.match(/"id":"([0-9a-f-]{36})"/);
  return m ? m[1] : null;
}

function extract(dj) {
  const d = dj.data || {};
  const vm = d.virtualmachine || {};
  let hib = null;
  const conds = vm.conditions || [];
  for (const c of conds) {
    if (c.type === 'Hibernated') hib = c;
  }
  return {
    lastActive: d.last_active_at,
    vmStatus: vm.status,
    lifeSec: vm.life_time_seconds,
    hibReason: hib ? hib.reason : '(无)',
    hibStatus: hib ? hib.status : '',
    hibAt: hib ? hib.last_transition_time : null,
  };
}

let round = 0;
async function tick() {
  round++;
  const detail = await get('/api/v1/users/tasks/' + encodeURIComponent(taskId));
  if (detail.status !== 200) {
    console.log('[' + nowStr() + '] #' + round + ' 详情 -> ' + detail.status + ' ' + detail.body.slice(0, 80));
    return;
  }
  let info;
  try {
    info = extract(JSON.parse(detail.body));
  } catch (e) {
    console.log('[' + nowStr() + '] #' + round + ' 解析失败 ' + e.message);
    return;
  }
  const idleMin = info.lastActive ? Math.round((Date.now() / 1000 - info.lastActive) / 60 * 10) / 10 : '?';
  console.log(
    '[' + nowStr() + '] #' + round +
    ' vm.status=' + info.vmStatus +
    ' | Hibernated.reason=' + info.hibReason + (info.hibStatus ? '(status=' + info.hibStatus + ')' : '') +
    ' | last_active=' + (info.lastActive ? ts(info.lastActive) : '?') +
    ' | 空闲=' + idleMin + '分'
  );
  // 检测到休眠迹象就高亮
  if (info.vmStatus === 'offline' || info.vmStatus === 'hibernated' ||
      /hibernat/i.test(info.hibReason) && !/not/i.test(info.hibReason)) {
    console.log('  >>> 检测到休眠！最后活跃到现在约 ' + idleMin + ' 分钟。这就是休眠阈值上界。');
  }
}

(async () => {
  if (!taskId) taskId = await resolveTaskId();
  if (!taskId) {
    console.log('未找到任务 id');
    return;
  }
  console.log('开始观测任务 ' + taskId + '，每 ' + intervalMin + ' 分钟一次。Ctrl+C 停止。');
  await tick();
  setInterval(tick, intervalMin * 60 * 1000);
})();
