const fs = require('fs');
const s = JSON.parse(fs.readFileSync('session.json', 'utf8').replace(/^\uFEFF/, ''));
const H = s.host;
const ck = s.cookies.map((c) => c.name + '=' + c.value).join('; ');
const TASK = 'c1e5e498-ccd5-446a-83cf-691cd2a201e8';

// print all key paths with primitive values, plus any key containing time/status/active/hibernat/sleep/idle
function walk(obj, prefix, out) {
  if (obj === null || typeof obj !== 'object') { out.push(prefix + ' = ' + JSON.stringify(obj)); return; }
  if (Array.isArray(obj)) {
    out.push(prefix + ' = [array len=' + obj.length + ']');
    obj.slice(0, 6).forEach((v, i) => walk(v, prefix + '[' + i + ']', out));
    return;
  }
  for (const k of Object.keys(obj)) walk(obj[k], prefix ? prefix + '.' + k : k, out);
}

(async () => {
  const r = await fetch(H + '/api/v1/users/tasks/' + TASK, { headers: { Cookie: ck, Origin: H } });
  const j = JSON.parse(await r.text());
  const out = [];
  walk(j.data || j, '', out);
  const kw = /(time|status|active|hibernat|sleep|idle|state|online|offline|expire|updated|created|heartbeat|last)/i;
  console.log('===== 含关键词的字段 =====');
  out.filter((l) => kw.test(l)).forEach((l) => console.log(l));
  console.log('\n===== 顶层键 =====');
  console.log(Object.keys(j.data || j).join(', '));
})();
