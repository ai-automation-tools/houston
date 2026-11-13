// H5 check (run by hand from PowerShell): the Identity Center's Core methods against a real Core and
// a real container. A throwaway Core (data in %LOCALAPPDATA%\houston-core-h5check, work in
// <H1_ROOT>\houston-h5check, both wiped before and after) and one identity, then:
//   identity.review marks it reviewed and due again in the days given
//   identity.reach groups its grants, names the one a container can't apply and the expired one
//   suspending it while a session runs ends that session within 5 seconds (H5's done-when), and a
//   new session is refused until it's active again
// Usage: $env:H1_ROOT = '<a scratch folder outside your user profile>'; node spikes/h5-identity-center.mjs
import path from 'node:path';
import { createHarness, sleep } from '../abuse/harness.js';

if (!process.env.H1_ROOT || !process.env.LOCALAPPDATA) { console.error('Set H1_ROOT to a scratch folder outside your user profile.'); process.exit(1); }
const ID = 'local:h5-agent';
const h = await createHarness({ root: path.join(process.env.H1_ROOT, 'houston-h5check'), data: path.join(process.env.LOCALAPPDATA, 'houston-core-h5check') });
let pass = false;
try {
  await h.startCore();
  console.log(`schema ${(await h.call('core.status')).schema}`);
  await h.call('identity.create', { id: ID, kind: 'ai-agent', displayName: 'H5 agent' });
  for (const [resource, permission, effect] of [[`file:${h.ws.replaceAll('\\', '/')}/**`, 'write', 'allow'], ['file:D:/docs/*.md', 'read', 'allow'], ['net:example.com:443', 'connect', 'ask']]) {
    await h.call('grant.add', { identity: ID, resource, permission, effect });
  }
  await h.call('grant.add', { identity: ID, resource: 'net:old.example:443', permission: 'connect', expiresAt: new Date(Date.now() + 1500).toISOString() });
  await h.call('identity.activate', { id: ID });
  await sleep(2000);

  const reviewed = await h.call('identity.review', { id: ID, days: 30 });
  const days = Math.round((Date.parse(reviewed.reviewBy) - Date.parse(reviewed.reviewedAt)) / 86_400_000);
  console.log(`review: reviewed ${reviewed.reviewedAt}, due ${reviewed.reviewBy} (${days} days)`);
  const reach = await h.call('identity.reach', { id: ID });
  console.log(`reach: files ${JSON.stringify(reach.types.file)}; net ${JSON.stringify(reach.types.net)}; expired ${reach.expired}; not applied ${JSON.stringify(reach.notApplied)}; ${reach.alwaysDenied.length} always denied`);

  const s = await h.call('session.start', { identity: ID, workspace: h.ws, command: 'cmd.exe /d /q /k' });
  await sleep(1500);
  const running = (await h.call('session.list')).some((/** @type {any} */ x) => x.id === s.id);
  const t0 = Date.now();
  const r = await h.call('identity.suspend', { id: ID, reason: 'H5 check' });
  let gone = 0;
  for (; Date.now() - t0 < 10_000; await sleep(100)) if (!(await h.call('session.list')).some((/** @type {any} */ x) => x.id === s.id)) { gone = Date.now() - t0; break; }
  const end = await h.waitEnd(s.id, 15_000);
  console.log(`suspend: session was running ${running}; suspend stopped ${r.stopped}; gone from session.list after ${gone} ms; session.end ${end.outcome?.error_code ?? end.outcome?.status}`);
  const refused = await h.call('session.start', { identity: ID, workspace: h.ws, command: 'cmd.exe /d /q /k' }).then(() => 'started (wrong)', (e) => `refused: ${e.message}`);
  console.log(`a new session while suspended: ${refused}`);

  pass = days === 30 && reach.types.file.allow.length === 2 && reach.types.net.ask.length === 1 && reach.expired === 1 && reach.notApplied.length >= 1
    && running && r.stopped === 1 && gone > 0 && gone < 5000 && refused.startsWith('refused');
} finally {
  await h.close();
  for (const d of [h.root, h.data]) await import('node:fs').then((fs) => fs.rmSync(d, { recursive: true, force: true }));
}
console.log(pass ? '\nPASS' : '\nFAIL');
// The container SDK keeps a message port open, so the process would not end by itself.
process.exit(pass ? 0 : 1);
