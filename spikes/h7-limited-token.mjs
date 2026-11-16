// H7 spike (run by hand from PowerShell): the fallback rung ADR-004 names, a write-restricted
// token, tried before building it. In a scratch folder under H1_ROOT:
//
//   ws\          the session's workspace: an inheritable Modify ACE for the session's own SID
//   ws\secret\   a denied folder inside it: an inheritable deny-write ACE for that SID
//   other\       a folder it has no grant on, with files to delete, move and rename
//
// The token is the operator's, write-restricted (CreateRestrictedToken WRITE_RESTRICTED) to the
// session SID (S-1-9-..., made for the run), WRITE_RESTRICTED (S-1-5-33), the logon SID and,
// in the second run, Everyone. A probe runs under it in a ConPTY (node-pty, as the runner would),
// inside a kill-on-close job, and reports each attempt. Then the ACEs are removed again.
//
// Usage: $env:H1_ROOT = '<a scratch folder>'; node spikes/h7-limited-token.mjs
// Result: docs/decisions/spikes/2026-11-15-h7-limited-token.md
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/** S-1-9 (an application's own SIDs) and a UUID's 128 bits as four sub-authorities. */
const sessionSid = () => `S-1-9-${crypto.randomBytes(16).toString('hex').match(/.{8}/g)?.map((h) => parseInt(h, 16)).join('-')}`;

/** @type {Promise<any> | null} */
let W = null;
const win32 = () => (W ??= bind());
async function bind() {
  const { default: koffi } = await import('koffi');
  const k32 = koffi.load('kernel32.dll');
  const adv = koffi.load('advapi32.dll');
  koffi.struct('SID_AND_ATTRIBUTES', { Sid: 'void *', Attributes: 'uint32' });
  koffi.struct('TRUSTEE_W', { pMultipleTrustee: 'void *', MultipleTrusteeOperation: 'int', TrusteeForm: 'int', TrusteeType: 'int', ptstrName: 'void *' });
  koffi.struct('EXPLICIT_ACCESS_W', { grfAccessPermissions: 'uint32', grfAccessMode: 'int', grfInheritance: 'uint32', Trustee: 'TRUSTEE_W' });
  koffi.struct('STARTUPINFOW', {
    cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *', dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
    dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32', dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16',
    lpReserved2: 'void *', hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
  });
  koffi.struct('PROCESS_INFORMATION', { hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32' });
  koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
    PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32', MinimumWorkingSetSize: 'size_t', MaximumWorkingSetSize: 'size_t',
    ActiveProcessLimit: 'uint32', Affinity: 'size_t', PriorityClass: 'uint32', SchedulingClass: 'uint32',
    ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64', ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64',
    ProcessMemoryLimit: 'size_t', JobMemoryLimit: 'size_t', PeakProcessMemoryUsed: 'size_t', PeakJobMemoryUsed: 'size_t',
  });
  return {
    koffi,
    GetLastError: k32.func('uint32 __stdcall GetLastError()'),
    LocalFree: k32.func('void * __stdcall LocalFree(void *p)'),
    ConvertStringSidToSidW: adv.func('bool __stdcall ConvertStringSidToSidW(str16 s, _Out_ void **sid)'),
    GetLengthSid: adv.func('uint32 __stdcall GetLengthSid(void *sid)'),
    GetNamedSecurityInfoW: adv.func('uint32 __stdcall GetNamedSecurityInfoW(str16 name, int type, uint32 info, void *owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **sd)'),
    SetEntriesInAclW: adv.func('uint32 __stdcall SetEntriesInAclW(uint32 n, EXPLICIT_ACCESS_W *ea, void *old, _Out_ void **acl)'),
    SetNamedSecurityInfoW: adv.func('uint32 __stdcall SetNamedSecurityInfoW(str16 name, int type, uint32 info, void *owner, void *group, void *dacl, void *sacl)'),
    GetAce: adv.func('bool __stdcall GetAce(void *acl, uint32 i, _Out_ void **ace)'),
    DeleteAce: adv.func('bool __stdcall DeleteAce(void *acl, uint32 i)'),
    GetCurrentProcess: k32.func('void * __stdcall GetCurrentProcess()'),
    OpenProcessToken: adv.func('bool __stdcall OpenProcessToken(void *h, uint32 access, _Out_ void **tok)'),
    GetTokenInformation: adv.func('bool __stdcall GetTokenInformation(void *tok, int cls, _Out_ uint8_t *buf, uint32 len, _Out_ uint32 *ret)'),
    CreateRestrictedToken: adv.func('bool __stdcall CreateRestrictedToken(void *tok, uint32 flags, uint32 nd, void *d, uint32 np, void *p, uint32 nr, SID_AND_ATTRIBUTES *r, _Out_ void **out)'),
    CreateProcessAsUserW: adv.func('bool __stdcall CreateProcessAsUserW(void *tok, str16 app, void *cmd, void *pa, void *ta, bool inherit, uint32 flags, void *env, str16 cwd, STARTUPINFOW *si, _Out_ PROCESS_INFORMATION *pi)'),
    CreateJobObjectW: k32.func('void * __stdcall CreateJobObjectW(void *attrs, void *name)'),
    SetInformationJobObject: k32.func('bool __stdcall SetInformationJobObject(void *job, int cls, JOBOBJECT_EXTENDED_LIMIT_INFORMATION *info, uint32 len)'),
    AssignProcessToJobObject: k32.func('bool __stdcall AssignProcessToJobObject(void *job, void *proc)'),
    ResumeThread: k32.func('uint32 __stdcall ResumeThread(void *h)'),
    WaitForSingleObject: k32.func('uint32 __stdcall WaitForSingleObject(void *h, uint32 ms)'),
    GetExitCodeProcess: k32.func('bool __stdcall GetExitCodeProcess(void *h, _Out_ uint32 *code)'),
  };
}

/** @param {any} w @param {string} s */
function sidOf(w, s) {
  const out = [null];
  if (!w.ConvertStringSidToSidW(s, out)) throw new Error(`bad SID ${s} (${w.GetLastError()})`);
  return out[0];
}

/** Add an inheritable allow-Modify or deny-write ACE for `sid`, or (kind 'revoke') delete its explicit ACEs. */
async function acl(/** @type {string} */ sid, /** @type {string} */ folder, /** @type {'allow' | 'deny' | 'revoke'} */ kind) {
  const w = await win32();
  const psid = sidOf(w, sid);
  const dacl = [null], sd = [null];
  let rc = w.GetNamedSecurityInfoW(folder, 1, 4, null, null, dacl, null, sd);
  if (rc) throw new Error(`GetNamedSecurityInfo ${folder}: ${rc}`);
  let next = null;
  if (kind === 'revoke') {
    // REVOKE_ACCESS removes allow ACEs only, so delete ours, allow and deny, by hand.
    const mine = Buffer.from(w.koffi.decode(psid, 'uint8', w.GetLengthSid(psid)));
    for (let i = w.koffi.decode(dacl[0], 4, 'uint16') - 1; i >= 0; i--) {
      const ace = [null];
      if (!w.GetAce(dacl[0], i, ace)) continue;
      const head = Buffer.from(w.koffi.decode(ace[0], 'uint8', 4));
      const body = Buffer.from(w.koffi.decode(ace[0], 'uint8', head.readUInt16LE(2)));
      if (head[0] <= 1 && !(head[1] & 0x10) && body.subarray(8, 8 + mine.length).equals(mine)) w.DeleteAce(dacl[0], i);
    }
    next = dacl[0];
  } else {
    const out = [null];
    const mask = kind === 'allow' ? 0x1301bf /* Modify */ : 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 /* write data, append, EA, delete child, attributes, delete */;
    rc = w.SetEntriesInAclW(1, [{ grfAccessPermissions: mask, grfAccessMode: kind === 'allow' ? 1 : 3, grfInheritance: 3, Trustee: { pMultipleTrustee: null, MultipleTrusteeOperation: 0, TrusteeForm: 0, TrusteeType: 0, ptstrName: psid } }], dacl[0], out);
    if (rc) throw new Error(`SetEntriesInAcl ${folder}: ${rc}`);
    next = out[0];
  }
  rc = w.SetNamedSecurityInfoW(folder, 1, 4, null, null, next, null);
  if (rc) throw new Error(`SetNamedSecurityInfo ${folder}: ${rc}`);
}

/** The helper, run under the ConPTY: the command on the write-restricted token, in a kill-on-close job. */
async function helper() {
  const { sid, everyone, command, cwd } = JSON.parse(/** @type {string} */ (process.env.H7_LAUNCH));
  const w = await win32();
  process.on('SIGINT', () => {});
  const tok = [null];
  if (!w.OpenProcessToken(w.GetCurrentProcess(), 0x1 | 0x2 | 0x8, tok)) throw new Error(`OpenProcessToken ${w.GetLastError()}`);
  const groups = Buffer.alloc(256);
  if (!w.GetTokenInformation(tok[0], 28 /* TokenLogonSid */, groups, groups.length, [0])) throw new Error(`logon SID ${w.GetLastError()}`);
  const sids = [sidOf(w, sid), sidOf(w, 'S-1-5-33'), w.koffi.decode(groups, 8, 'void *'), ...(everyone ? [sidOf(w, 'S-1-1-0')] : [])];
  const restricted = [null];
  if (!w.CreateRestrictedToken(tok[0], 0x8 /* WRITE_RESTRICTED */, 0, null, 0, null, sids.length, sids.map((Sid) => ({ Sid, Attributes: 0 })), restricted)) throw new Error(`CreateRestrictedToken ${w.GetLastError()}`);
  const job = w.CreateJobObjectW(null, null);
  if (!w.SetInformationJobObject(job, 9, { LimitFlags: 0x2000 /* KILL_ON_JOB_CLOSE */ }, w.koffi.sizeof('JOBOBJECT_EXTENDED_LIMIT_INFORMATION'))) throw new Error(`job ${w.GetLastError()}`);
  const line = Buffer.from(`"${process.env.SystemRoot}\\System32\\cmd.exe" /d /s /c "${command}"\0`, 'utf16le');
  /** @type {any} */
  const pi = {};
  if (!w.CreateProcessAsUserW(restricted[0], null, line, null, null, false, 0x4 /* suspended */, null, cwd, { cb: w.koffi.sizeof('STARTUPINFOW') }, pi)) throw new Error(`CreateProcessAsUser ${w.GetLastError()}`);
  if (!w.AssignProcessToJobObject(job, pi.hProcess)) throw new Error(`AssignProcessToJobObject ${w.GetLastError()}`);
  w.ResumeThread(pi.hThread);
  await new Promise((resolve) => w.WaitForSingleObject.async(pi.hProcess, 0xffffffff, resolve));
  const code = [0];
  w.GetExitCodeProcess(pi.hProcess, code);
  return code[0];
}

const PROBE = `
const fs = require('node:fs'), path = require('node:path');
const [ws, other] = process.argv.slice(2);
const t = (what, fn) => { try { fn(); return [what, 'ok']; } catch (e) { return [what, 'refused ' + e.code]; } };
const r = [
  t('write a file in the workspace', () => fs.writeFileSync(path.join(ws, 'a.txt'), 'x')),
  t('make folders in the workspace', () => fs.mkdirSync(path.join(ws, 'sub', 'deep'), { recursive: true })),
  t('write a file in the denied folder', () => fs.writeFileSync(path.join(ws, 'secret', 'a.txt'), 'x')),
  t('remove the denied folder', () => fs.rmdirSync(path.join(ws, 'secret'))),
  t('write a file in other', () => fs.writeFileSync(path.join(other, 'new.txt'), 'x')),
  t('overwrite a file in other', () => fs.writeFileSync(path.join(other, 'keep.txt'), 'changed')),
  t('rename a file within other', () => fs.renameSync(path.join(other, 'r1.txt'), path.join(other, 'r2.txt'))),
  t('read a file in other', () => fs.readFileSync(path.join(other, 'keep.txt'))),
  t('DELETE a file in other', () => fs.unlinkSync(path.join(other, 'victim.txt'))),
  t('MOVE a file out of other into the workspace', () => fs.renameSync(path.join(other, 'moved.txt'), path.join(ws, 'moved.txt'))),
  t('REMOVE an empty folder in other', () => fs.rmdirSync(path.join(other, 'emptydir'))),
];
fs.writeFileSync(path.join(ws, 'probe.json'), JSON.stringify(r));
`;

async function check() {
  if (!process.env.H1_ROOT) { console.error('Set H1_ROOT to a scratch folder.'); process.exit(1); }
  const { default: pty } = await import('node-pty');
  const root = path.join(process.env.H1_ROOT, 'houston-h7limited');
  let fail = false;
  for (const everyone of [false, true]) {
    fs.rmSync(root, { recursive: true, force: true });
    const ws = path.join(root, 'ws'), secret = path.join(ws, 'secret'), other = path.join(root, 'other');
    for (const d of [secret, path.join(other, 'emptydir')]) fs.mkdirSync(d, { recursive: true });
    for (const f of ['keep.txt', 'r1.txt', 'victim.txt', 'moved.txt']) fs.writeFileSync(path.join(other, f), f);
    fs.writeFileSync(path.join(root, 'probe.cjs'), PROBE);
    const sid = sessionSid();
    await acl(sid, ws, 'allow');
    await acl(sid, secret, 'deny');
    const command = `"${process.execPath}" "${path.join(root, 'probe.cjs')}" "${ws}" "${other}" & call echo probe-exit=%^errorlevel%`;
    const env = { SystemRoot: /** @type {string} */ (process.env.SystemRoot), H7_LAUNCH: JSON.stringify({ sid, everyone, command, cwd: ws }) };
    const t0 = Date.now();
    const p = pty.spawn(process.execPath, [SELF, 'helper'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: ws, env, useConpty: true, useConptyDll: true });
    let text = '';
    p.onData((d) => { text += d; });
    const code = await new Promise((resolve) => p.onExit((e) => resolve(e.exitCode)));
    const ms = Date.now() - t0;
    await acl(sid, ws, 'revoke');
    if (fs.existsSync(secret)) await acl(sid, secret, 'revoke');
    console.log(`\n== restricting SIDs: session, WRITE_RESTRICTED, logon${everyone ? ', Everyone' : ''} (${sid})`);
    console.log(`helper exit ${code} in ${ms} ms; ${/probe-exit=\d+/.exec(text)?.[0] ?? 'no probe exit code'}`);
    const out = path.join(ws, 'probe.json');
    if (fs.existsSync(out)) for (const [what, r] of JSON.parse(fs.readFileSync(out, 'utf8'))) console.log(`  ${what.padEnd(48)} ${r}`);
    else console.log('  the probe wrote no results');
    if (everyone && !fs.existsSync(out)) fail = true;
  }
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

if (process.argv[2] === 'helper') helper().then((c) => process.exit(c), (e) => { process.stderr.write(`${e.message}\r\n`); process.exit(1); });
else await check();
