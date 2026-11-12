// Spike S5 (throwaway): the Core stores a secret with DPAPI from Node. Can a contained
// process read the blob file, or decrypt the blob if it is handed the bytes?
// Usage (PowerShell): node spikes/s5-secrets.mjs
// DPAPI is called through koffi, which is already installed as a dependency of the containers SDK.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import koffi from 'koffi';
import { run } from '@microsoft/mxc-sdk/v1';

const ROOT = 'D:\\AI_Agents\\_maintenance\\tmp\\houston-s5';
const VAULT = path.join(ROOT, 'core-data'); // stands in for the Core's data folder: never granted
const WS = path.join(ROOT, 'ws');
mkdirSync(VAULT, { recursive: true }); mkdirSync(WS, { recursive: true });

// --- DPAPI from Node
const crypt32 = koffi.load('crypt32.dll');
const kernel32 = koffi.load('kernel32.dll');
const BLOB = koffi.struct('DATA_BLOB', { cbData: 'uint32', pbData: 'void *' });
const CryptProtectData = crypt32.func('bool __stdcall CryptProtectData(DATA_BLOB *in, void *descr, DATA_BLOB *entropy, void *res, void *prompt, uint32 flags, _Out_ DATA_BLOB *out)');
const CryptUnprotectData = crypt32.func('bool __stdcall CryptUnprotectData(DATA_BLOB *in, void *descr, DATA_BLOB *entropy, void *res, void *prompt, uint32 flags, _Out_ DATA_BLOB *out)');
const LocalFree = kernel32.func('void * __stdcall LocalFree(void *p)');
const UI_FORBIDDEN = 0x1;
function dpapi(fn, buf, entropy) {
  const out = {};
  const ent = entropy ? { cbData: entropy.length, pbData: entropy } : null;
  if (!fn({ cbData: buf.length, pbData: buf }, null, ent, null, null, UI_FORBIDDEN, out)) throw new Error('DPAPI call failed');
  const res = Buffer.from(koffi.decode(out.pbData, 'uint8', out.cbData));
  LocalFree(out.pbData);
  return res;
}

const secret = `s5-canary-${Date.now()}`;
const entropy = Buffer.from('houston-core-entropy'); // the Core would keep this beside the blob
const blob = dpapi(CryptProtectData, Buffer.from(secret));
const blobE = dpapi(CryptProtectData, Buffer.from(secret), entropy);
const blobPath = path.join(VAULT, 'secret.bin');
writeFileSync(blobPath, blob);
const back = dpapi(CryptUnprotectData, readFileSync(blobPath)).toString();
console.log(`Core: stored ${blob.length}-byte blob, read back ${back === secret ? 'OK (matches)' : 'MISMATCH'}`);
console.log(`Core: with entropy, read back ${dpapi(CryptUnprotectData, blobE, entropy).toString() === secret ? 'OK' : 'MISMATCH'}`);

// --- The container side, in Python (ctypes ships with it; nothing extra to grant)
writeFileSync(path.join(WS, 'attack.py'), `
import ctypes, sys, binascii
from ctypes import wintypes
class BLOB(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("pb", ctypes.POINTER(ctypes.c_char))]
def unprotect(data):
    i = BLOB(len(data), ctypes.cast(ctypes.create_string_buffer(data, len(data)), ctypes.POINTER(ctypes.c_char)))
    o = BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(i), None, None, None, None, 1, ctypes.byref(o))
    if not ok: return "DENIED winerror=%d" % ctypes.GetLastError()
    return "DECRYPTED " + ctypes.string_at(o.pb, o.cb).decode()
try:
    open(sys.argv[1], "rb").read(); print("read blob file: READ")
except OSError as e: print("read blob file:", type(e).__name__, e.errno)
print("decrypt handed-over blob:", unprotect(binascii.unhexlify(sys.argv[2])))
print("decrypt handed-over blob made with entropy the container lacks:", unprotect(binascii.unhexlify(sys.argv[3])))
`);
const r = await run({
  command: `python attack.py "${blobPath}" ${blob.toString('hex')} ${blobE.toString('hex')}`,
  workingDirectory: WS, timeoutMs: 30_000,
  environment: { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }, inheritDefaultEnvironment: true,
  filesystem: { readwritePaths: [WS], readonlyPaths: ['C:\\Python312'], deniedPaths: ['C:\\Users'] },
  ui: { disable: false },
  containment: { type: 'processcontainer', config: { filesystem: { enumeratePaths: ['C:\\', 'D:\\'] } } },
});
console.log(`Container (exit ${r.exitCode}):\n  ${(r.stdout + r.stderr).trim().replaceAll('\n', '\n  ')}`);
