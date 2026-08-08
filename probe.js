// 一次性探测：尝试抓取休眠默认值 / vm 对象里的空闲相关字段。
// 复用 session.json 的 cookie，只读，不改任何状态。
const fs = require('fs');
const path = require('path');

const sessRaw = fs.readFileSync(path.join(__dirname, 'session.json'), 'utf8').replace(/^\uFEFF/, '');
const sess = JSON.parse(sessRaw);
const HOST = sess.host || 'https://monkeycode-ai.com';
const cookieHeader = (sess.cookies || []).map((c) => c.name + '=' + c.value).join('; ');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(pathname) {
  const url = HOST + pathname;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { Cookie: cookieHeader, Origin: HOST, 'User-Agent': UA, Accept: 'application/json' },
      redirect: 'manual',
    });
    const body = await r.text();
    return { status: r.status, body: body };
  } catch (ex) {
    return { status: 0, body: 'ERR: ' + (ex && ex.message ? ex.message : ex) };
  }
}

// 递归找 key 里含 sleep/idle/recycle/hibernat/expire/active 的字段
function findInteresting(obj, prefix, out) {
  if (obj == null || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const full = prefix ? prefix + '.' + k : k;
    const v = obj[k];
    if (/sleep|idle|recycl|hibernat|expire|active|dormant|suspend|last_/i.test(k)) {
      if (typeof v !== 'object') out.push(full + ' = ' + JSON.stringify(v));
    }
    if (v && typeof v === 'object') findInteresting(v, full, out);
  }
}

(async () => {
  // 1. 策略接口（大概率 403，但试）
  const policy = await get('/api/v1/teams/task-vm-idle-policy');
  console.log('=== /api/v1/teams/task-vm-idle-policy -> ' + policy.status + ' ===');
  console.log(policy.body.slice(0, 1500));
  console.log('');

  // 2. 任务列表，取第一个任务 id
  const list = await get('/api/v1/users/tasks?page=1&size=10&status=pending%2Cprocessing');
  console.log('=== tasks list -> ' + list.status + ' ===');
  let taskId = null;
  try {
    const j = JSON.parse(list.body);
    const arr = (j.data && (j.data.list || j.data.tasks || j.data.items)) || j.data || [];
    const first = Array.isArray(arr) ? arr[0] : null;
    if (first && first.id) taskId = first.id;
  } catch (_) {}
  // 兜底：正则抓第一个 uuid 作为 id
  if (!taskId) {
    const m = list.body.match(/"id":"([0-9a-f-]{36})"/);
    if (m) taskId = m[1];
  }
  console.log('picked taskId = ' + taskId);
  console.log('');

  if (taskId) {
    // 3. 任务详情原始 JSON + 挑出有意思的字段
    const detail = await get('/api/v1/users/tasks/' + encodeURIComponent(taskId));
    console.log('=== task detail -> ' + detail.status + ' ===');
    console.log('RAW (前 3000 字符):');
    console.log(detail.body.slice(0, 3000));
    console.log('');
    try {
      const dj = JSON.parse(detail.body);
      const out = [];
      findInteresting(dj, '', out);
      console.log('--- 关键字段(sleep/idle/recycle/expire/active/last_) ---');
      console.log(out.length ? out.join('\n') : '(无匹配字段)');
    } catch (e) {
      console.log('detail JSON 解析失败：' + e.message);
    }
  }
})();
