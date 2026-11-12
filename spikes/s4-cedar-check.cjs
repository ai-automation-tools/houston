// Spike S4 (throwaway): does a Cedar binding for Node exist and answer an authorization request?
// Not a dependency of this repo. Install it in a scratch folder and run this file from there:
//   npm install @cedar-policy/cedar-wasm@4.14.0 && node s4-cedar-check.cjs
const cedar = require('@cedar-policy/cedar-wasm/nodejs');

const policies = { staticPolicies: 'permit(principal == Identity::"dev-codex", action == Action::"file.write", resource) when { resource.path like "D:/ws/*" };' };
const ask = (p) => cedar.isAuthorized({
  principal: { type: 'Identity', id: 'dev-codex' },
  action: { type: 'Action', id: 'file.write' },
  resource: { type: 'File', id: p },
  context: {},
  policies,
  entities: [{ uid: { type: 'File', id: p }, attrs: { path: p }, parents: [] }],
});
for (const p of ['D:/ws/a.txt', 'C:/Users/x/.ssh/id']) {
  const r = ask(p);
  console.log(p, '->', r.type, r.response?.decision ?? JSON.stringify(r.errors), 'reasons:', JSON.stringify(r.response?.diagnostics?.reason));
}
console.log('cedar version:', cedar.getCedarVersion());
