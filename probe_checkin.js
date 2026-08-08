const fs = require('fs');
const s = JSON.parse(fs.readFileSync('session.json', 'utf8').replace(/^\uFEFF/, ''));
const H = s.host;
const ck = s.cookies.map((c) => c.name + '=' + c.value).join('; ');
const TASK = 'c1e5e498-ccd5-446a-83cf-691cd2a201e8';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readLA(tag) {
  const r = await fetch(H + '/api/v1/users/tasks/' + TASK, { headers: { Cookie: ck, Origin: H } });
  const j = JSON.parse(await r.text());
  const la = j.data.last_active_at;
  const vm = (j.data.virtualmachine || {}).status;
  console.log('[' + tag + '] last_active_at=' + la + ' (' + new Date(la * 1000).toLocaleString('zh-CN', { hour12: false }) + ') vm=' + vm);
  return la;
}

(async () => {
  const before = await readLA('前');
  console.log('--- 等待 8 秒（不发任何请求）---');
  await sleep(8000);
  // 只发一次 checkin
  const rc = await fetch(H + '/api/v1/users/wallet/checkin', { headers: { Cookie: ck, Origin: H } });
  const body = await rc.text();
  console.log('checkin HTTP=' + rc.status + ' body=' + body.slice(0, 120));
  console.log('--- 等待 5 秒让服务端落库 ---');
  await sleep(5000);
  const after = await readLA('后');
  const d = after - before;
  console.log('=====');
  if (d > 0) console.log('结论：last_active_at 前进 ' + d + ' 秒 —— checkin 可能是活跃信号 ✅');
  else if (d < 0) console.log('结论：倒退 ' + d + '?');
  else console.log('结论：没变 —— checkin 不影响 last_active_at ❌（不是活跃信号）');
})();
