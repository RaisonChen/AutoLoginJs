const fs = require('fs');
const s = JSON.parse(fs.readFileSync('session.json', 'utf8').replace(/^\uFEFF/, ''));
const H = s.host;
const ck = s.cookies.map((c) => c.name + '=' + c.value).join('; ');
const TASK = 'c1e5e498-ccd5-446a-83cf-691cd2a201e8';

function findCond(conds, type) {
  if (!Array.isArray(conds)) return null;
  for (const c of conds) if (c && c.type === type) return c;
  return null;
}

(async () => {
  const r = await fetch(H + '/api/v1/users/tasks/' + TASK, { headers: { Cookie: ck, Origin: H } });
  const j = JSON.parse(await r.text());
  const d = j.data || {};
  const vm = d.vm || {};
  const hib = findCond(d.conditions, 'Hibernated');
  const la = d.last_active_at;
  console.log('HTTP=' + r.status);
  console.log('vm.status=' + (vm.status || '?'));
  console.log('Hibernated.reason=' + (hib ? hib.reason : '(无该condition)'));
  console.log('Hibernated.status=' + (hib ? hib.status : '?'));
  console.log('Hibernated.last_transition_time=' + (hib ? hib.last_transition_time : '?') +
    (hib && hib.last_transition_time ? ' (' + new Date(hib.last_transition_time * 1000).toLocaleString('zh-CN', { hour12: false }) + ')' : ''));
  console.log('last_active_at=' + la + ' (' + new Date(la * 1000).toLocaleString('zh-CN', { hour12: false }) + ')');
})();
