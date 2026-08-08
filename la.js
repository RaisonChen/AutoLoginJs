const fs = require('fs');
const s = JSON.parse(fs.readFileSync('session.json', 'utf8').replace(/^\uFEFF/, ''));
const H = s.host;
const ck = s.cookies.map((c) => c.name + '=' + c.value).join('; ');
const base = Number(process.argv[2] || 0);
(async () => {
  const r = await fetch(H + '/api/v1/users/tasks/c1e5e498-ccd5-446a-83cf-691cd2a201e8', {
    headers: { Cookie: ck, Origin: H },
  });
  const j = JSON.parse(await r.text());
  const la = j.data.last_active_at;
  const when = new Date(la * 1000).toLocaleString('zh-CN', { hour12: false });
  const idle = Math.round((Date.now() / 1000 - la) / 60 * 10) / 10;
  console.log('last_active_at=' + la + ' (' + when + ') 空闲=' + idle + '分');
  if (base) {
    const d = la - base;
    let verdict;
    if (d > 0) verdict = '前进 ' + d + ' 秒 ✅ 挂着在保活';
    else if (d < 0) verdict = '倒退 ' + d + '?';
    else verdict = '没变 ❌ 未保活';
    console.log('相比基线(' + base + ')：' + verdict);
  }
})();
