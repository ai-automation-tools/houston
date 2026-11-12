# Harness H0 spikes S1 to S5: results

**Date:** 2026-11-12 · **Status:** closed. S2, S3 and S4 passed; S1 and S5 passed in part. The owner accepted the slowdown and the schemas on 2026-11-12, and ADR-004's containment decision is confirmed.
**Serves:** [ADR-004](../adr-004-core-companion-process.md), [harness requirements](../../product/harness-requirements.md) · **Earlier:** [S1 first contact](2026-11-12-s1-first-contact.md)

Containment works on this machine and the plan holds. Six findings change how H1 to H3 must be built; they are listed under [What this changes](#what-this-changes).

| Spike | Pass bar | Result |
|:---|:---|:---|
| S1 containment | All five commands run, short grant list, slowdown under 1.3x | Commands run on a list of 5 paths. **Slowdown bar missed**: 1.15x to 1.96x. Learning mode is unavailable |
| S2 loopback | One configuration blocks the three app ports and leaves a gateway port open | **Pass**, with the container proxy setting. Port rules do not filter loopback |
| S3 terminal | Terminal works; Codex and Claude Code usable for a 10-minute task | **Pass**, with a caveat. Terminal works; both CLIs, signed in, finished a coding task in a container. Each took about 1.4 minutes, not 10, and ran headless |
| S4 contracts | Schemas reviewed by the owner | **Pass.** Three schemas written and accepted by the owner; Cedar's Node binding works |
| S5 secrets | The Core reads the secret, the container cannot | The container cannot read the file. **It can decrypt the blob if it ever gets the bytes** |

## Machine and method

Windows 11 Home (`EditionID` Core), build 26300.9974, Node 24.22.1, Python 3.12.10, Git 2.51.0, `@microsoft/mxc-sdk` 1.0.1, process container backend, not elevated. Telemetry was left off on every call and the consent prompt was not answered.

Scripts are in [`spikes/`](../../../spikes/). Run them from PowerShell: under Git Bash the SDK's own call to `whoami /user` picks up Git's `whoami` and fails. Scratch folders are on a data drive, shown below as `<tmp>`; the user profile is shown as `%USERPROFILE%`.

## S1: containment

`node spikes/s1-containment.mjs`, with `spikes/s1-probe.mjs` for single commands.

**The policy that works**

| Kind | Paths |
|:---|:---|
| Read and write | the workspace, a temp folder (the npm cache lives inside it) |
| Read only | `C:\Program Files\Git`, `C:\Program Files\nodejs`, `C:\Python312` |
| Enumerate (names only) | `C:\`, `D:\` |
| Denied | `C:\Users` |
| UI | `ui: { disable: false }`; clipboard and input injection stay denied |

```text
=== echo -> exit 0          MXC_OK
=== git status -> exit 0    A  a.test.mjs / A  package.json / A  test_a.py
                            warning: unable to access '%USERPROFILE%/.config/git/ignore': Permission denied
=== npm install -> exit 0   added 2 packages in 1s
=== node --test -> exit 0   pass 1, fail 0
=== pytest -> exit 0        1 passed in 0.00s
```

**How it got there.** Each line is a failure and the one change that fixed it.

```text
node -v, git, npm, node --test   exit 0xC0000142 (DLL init failed)   -> ui: { disable: false }
python -c "import ssl"           ImportError: DLL load failed: _ssl   -> same fix
npm install                      EPERM: lstat 'C:\'                   -> enumerate on the drive roots
pytest                           PermissionError on a file in the per-user site-packages -> PYTHONNOUSERSITE=1
```

**Learning mode does not work here.** Asking for denial capture fails every launch:

```text
backend_unavailable captureDenials: failed to start learning-mode capture:
StartLearningModeTraceWithOptions failed (HRESULT = 0x80004001)
```

The backend advertises `captureDenials`, so this is either an elevation requirement or not implemented on this build. Not tested elevated. The read list above was found by hand.

**What the container can and cannot touch** (`s1-probe.mjs`, enumerate on the drive roots, no deny rule yet):

```text
type %USERPROFILE%\.gitconfig            Access is denied.
type <tmp>\outside\o.txt                 Access is denied.
echo x> <tmp>\outside\w.txt              Access is denied.
echo x> C:\Python312\w.txt               Access is denied.          (read-only grant holds)
type C:\Windows\System32\drivers\etc\hosts   readable               (Windows folders are readable by default)
dir /b %USERPROFILE%                     lists every name
dir /b %USERPROFILE%\.ssh                lists the key file names
```

Enumerate is recursive. Granting it on `C:\` so Node can `lstat` the root lets a contained process list every file name on the drive. It cannot read any of them. With `deniedPaths: ['C:\Users']` added:

```text
dir /b %USERPROFILE%\.ssh                Access is denied.
npm --version                            11.19.1
```

A denied folder with a granted folder under it works for plain file reads and writes, and a granted program under the denied profile still starts. Node breaks, because it walks every parent folder:

```text
deny <tmp parent>, workspace granted beneath it
  cmd: echo hi> w.txt & type w.txt       hi
  node: realpathSync(cwd)                EPERM: lstat '<tmp parent>\tmp'
```

**Speed.** Five alternating runs each, contained then host, same environment, warm npm cache, median.

| Command | Contained | Host | Slowdown |
|:---|---:|---:|---:|
| `cmd /c echo` | 122 ms | 99 ms | 1.23x |
| `git status` | 168 ms | 141 ms | 1.19x |
| `npm install` (2 packages) | 2,322 ms | 1,183 ms | 1.96x |
| `npm install` (163 packages) | 4,245 ms | 2,690 ms | 1.58x |
| `node --test` | 286 ms | 249 ms | 1.15x |
| `pytest` | 833 ms | 574 ms | 1.45x |

A launch costs about 25 ms. File-heavy work costs more: about 1.5 seconds on a 163-package install. The 1.3x bar is missed for `npm install` and `pytest`. Whether that matters is the owner's call; nothing here suggests it gets worse than 2x.

## S2: loopback

`node spikes/s2-loopback.mjs`. A Node script inside the container opens TCP connections to Project Hub (4273), Promptbook (3010), Roundtable (8765), a test listener standing in for the gateway, a host proxy port, the same on IPv6 and on the machine's own LAN address, then makes one HTTPS request to the npm registry. All three apps were running.

```text
A  network omitted                          every loopback and LAN target EACCES   internet ENOTFOUND
B  egress allow                             every loopback and LAN target EACCES   internet HTTP 200
C  egress allow + hostLoopback allow        4273 3010 8765 gateway proxy LAN: OPEN internet HTTP 200
D  egress deny  + hostLoopback allow        4273 3010 8765 gateway proxy LAN: OPEN internet ENOTFOUND
E  egress deny, allow 127.0.0.1:gateway     4273 3010 8765 gateway proxy LAN: OPEN internet EACCES
F  egress allow, deny 127/8 except gateway  4273 3010 8765 gateway proxy LAN: OPEN internet HTTP 200
G  egress allow, deny the three app ports   4273 3010 8765 gateway proxy LAN: OPEN internet HTTP 200
H  container proxy (below)                  4273 3010 8765 gateway LAN: EACCES     proxy: OPEN   internet EACCES
```

- **By default a container cannot reach any local app.** Loopback and the machine's own LAN address are refused even when internet egress is allowed. The top risk in the plan is closed by the default policy.
- **Host loopback is all or nothing.** Once `hostLoopback: 'allow'` is set, no egress rule by port or by address filters it (E, F, G).
- **The container proxy setting is the answer (H).** The request is:

```js
network: {
  egress: { default: 'deny' },                       // required, and no allow or deny rules
  ingress: { default: 'allow', hostLoopback: 'allow' }, // both required
  runtimeConfig: { networkProxy: 'http://127.0.0.1:<port>' },
}
```

The container then reaches that one port and nothing else: not the three apps, not another listener on loopback, not the LAN, not the internet directly. `HTTP_PROXY` and `HTTPS_PROXY` are set inside it. A plain HTTP request straight to the port also arrives, so the same port can serve the MCP endpoint. The SDK rejects any other combination, with messages that name the missing field.

`node spikes/s2b-channels.mjs` tried the other channels:

```text
T2 loopback inside one container, default policy     listen ok; child EACCES
T3 container opens a pipe the host created           EPERM
T4 host opens a pipe the container created           CONTAINER_PIPE_OK
   (host path: \\.\pipe\Sessions\1\AppContainerNamedObjects\<container sid>\<name>)
```

- A contained process cannot open a host named pipe with default permissions. The Control API pipe is out of an agent's reach without extra work.
- The host can connect to a pipe a container creates. That is a second way to carry gateway traffic if the proxy route disappoints.
- Two processes in the same container cannot talk over loopback under the default policy. An agent that starts a dev server and then requests `localhost` will fail unless host loopback is opened, which opens everything.

## S3: terminal

`node spikes/s3-pty.mjs --rawmode`: a contained Node process on `spawnWithPty`, checked headless (the bytes, not a drawn xterm.js).

```json
{
  "isTty": true, "initialSize": "80x24",
  "colourCodesIntact": true,
  "resizeSequenceSeen": true, "resize": "132x40 seen",
  "burstSeconds": 6.7, "burstPayloadBytes": 10223624, "burstExpected": 10223616, "burstComplete": true,
  "ctrlC": "GOT_RAW_03", "afterCtrlC": { "exitCode": 0 }
}
```

- A real terminal, resize arrives, colour arrives, and 10 MB comes through whole in about 6 seconds.
- Colour sequences are rewritten on the way (`ESC[1;32m` arrives as `ESC[32m` `ESC[1m`). Harmless to xterm.js; do not compare bytes in tests.
- In raw mode, which is how agent CLIs read keys, Ctrl+C arrives as byte `0x03` and the program lives. In line mode the program's handler runs and then Windows ends it with `0xC000013A`.
- The terminal title is set to the path of the SDK's `wxc-exec.exe`. The Core should overwrite it.

`node spikes/s3b-cli-start.mjs`: do the two agent CLIs start in a container? Version checks only, no sign-in, no credentials granted.

```text
claude --version, profile denied, its folder granted read-only    exit 0: 2.1.322 (Claude Code)
codex --version, its folder granted read-only                     exit 0: codex-cli 0.167.2
  WARNING: could not create PATH aliases: Access is denied. at "%USERPROFILE%\.codex\tmp\..."
```

Both programs and their sign-in files live inside the user profile.

**Signed in, doing real work.** `node spikes/s3c-cli-task.mjs claude` and `... codex`. The owner approved granting each CLI its own config folder for this test. The container gets the workspace, a temp folder, the toolchain, the CLI's program folder read-only and its config folder read and write; the rest of the user profile is denied. Network is internet only, with loopback and the LAN blocked. Each CLI runs headless with its own permission prompts off, because the container is the boundary under test. The task: write a markdown table formatter with at least 8 tests, make the tests pass, write a CLI and a README, commit, then call the stub MCP server's one tool and save what it returns.

| | Claude Code 2.1.322 | Codex 0.167.2 |
|:---|:---|:---|
| Exit | 0 | 0 |
| Time | 1.4 min | 1.3 min |
| Tests, rerun on the host afterwards | 12 pass, 0 fail | 10 pass, 0 fail |
| Commit | `tablefmt` | `tablefmt` |
| Stub MCP call logged by the server | `stamp {"note":"finished"}` | `stamp {"note":"finished"}` |
| `RESULT.md` | `RECEIPT-8-7Q` | `RECEIPT-8-7Q` |

- Both finished every step. Git warned that it could not read its config under the denied profile and carried on.
- **Codex must be started from its native program.** Through the Node wrapper it fails with `EPERM: lstat 'C:\Users'`, the same parent-folder walk as in S1.
- **Claude Code needs `CLAUDE_CONFIG_DIR` set to its config folder.** Its main config file normally sits beside that folder, in the profile root, which the container cannot see. With the variable set it creates a fresh one inside the folder. User settings were skipped (`--setting-sources project`) so the owner's hooks did not run in the container.
- Codex loaded the owner's own MCP server list and one of them, on `localhost`, failed to connect. That is the loopback block from S2 doing its job, and it means a backend's manifest must replace the MCP list, not add to it.
- Codex ran PowerShell 7 from `C:\Program Files`, which was not on the grant list. Program folders that Windows already opens to app containers are readable without a grant.

**Not shown:** ten minutes of use, and drawing in xterm.js. Both tasks were done in under two minutes and ran without a person at a terminal. The first contained session in the window (H2) is where that gets exercised.

## S4: contracts

Drafts in [`core/schemas/`](../../../core/schemas/): `identity`, `policy-request` (request and decision) and `audit-event`, JSON Schema 2020-12. Each parses and is marked draft v0.1.

Cedar has a working Node binding. `@cedar-policy/cedar-wasm` 4.14.0, Apache-2.0, about 4.4 MB for the Node build, installed in a scratch folder and not added to this repo (`spikes/s4-cedar-check.cjs`):

```text
D:/ws/a.txt        -> success allow reasons: ["policy0"]
C:/Users/x/.ssh/id -> success deny  reasons: []
cedar version: 4.14.0
```

Field names follow the org's agent-inventory v0.1 format and a sibling project's draft event and policy contracts where those exist: `principal`, `action`, `resource`, `context`; `policy_version`, `determining_policies`, `reasons`; `audit.seq`, `audit.prev_hash`, `audit.hash`. Three deliberate differences for the owner to accept or reject:

1. The decision has a third value, `ask`. The sibling contract has only allow and deny.
2. There is no tenant field. One operator, one machine.
3. Identity ids are `local:<slug>`, which fits the inventory format's `<platform>:<native id>` pattern.

## S5: secrets

`node spikes/s5-secrets.mjs`. DPAPI is called from Node through `koffi`, which the containers SDK already installs. The container side is Python with `ctypes`.

```text
Core: stored 246-byte blob, read back OK (matches)
Core: with entropy, read back OK
Container (exit 0):
  read blob file: PermissionError 13
  decrypt handed-over blob: DECRYPTED s5-canary-...
  decrypt handed-over blob made with entropy the container lacks: DENIED winerror=13
```

- DPAPI works from Node with no new dependency.
- A container cannot read a file in a folder it was not granted.
- **DPAPI is not a wall between the Core and a container.** A contained process runs as the same Windows user and can decrypt any blob it gets hold of. What protects the vault is the file policy, and a blob made with extra entropy the container never sees.

## What this changes

1. **The gateway port is also the only way out (S2).** With the proxy setting, model-provider traffic goes through the Core too. The Core needs a forward proxy with a host allow-list, in H1 for the first contained agent and not in H3. In return, network default-deny by host name comes for free. The alternative is `egress: allow` with no gateway reachable over TCP, and the container-created pipe as the MCP channel.
2. **Every launch needs `ui: { disable: false }` (S1).** Without it Node, Git and Python's TLS do not start. An abuse test should confirm that clipboard and input injection stay blocked with it set.
3. **Enumerate on the drive roots leaks file names unless private folders are denied (S1).** The launch policy must deny the user profile and any other private tree, and a workspace cannot sit under a denied folder, because Node will not run there. Workspaces inside the profile need their sibling folders denied instead.
4. **No denial events from the SDK without more work (S1).** The acceptance criterion "a `deny` event names the identity, session and path" has no data source until denial capture works. Try it elevated before H1 commits to that criterion.
5. **The vault must not rely on DPAPI alone (S5).** Keep blobs in the Core's data folder, protect them with entropy held only by the Core, and add an abuse test that hands a container a blob.
6. **Agent CLIs and their sign-in files live in the user profile (S3).** Each backend's manifest must name its program folder (read-only) and its credential folder (read and write), and the Identity Center must show that an agent can read its own model credential, as ADR-004 already says.

Smaller notes: start containers with a clean `PATH` that puts `System32` first, since the SDK shells out to `whoami`; a same-container dev server is unreachable over loopback under the default policy.

## Owner decisions

Answered by the owner on 2026-11-12, recorded in [OPEN-QUESTIONS.md](../../OPEN-QUESTIONS.md):

- **The slowdown is accepted** (1.15x to 1.96x against a 1.3x bar). ADR-004's containment decision is confirmed.
- **The schemas are accepted**, with the `ask` decision value, no tenant field and `local:<slug>` ids.
- **A test container may be granted the two CLIs' config folders.** Used for the signed-in runs above and nothing else.

Still open: **telemetry consent** for Execution Containers. Nobody has answered it; every run here left telemetry off.
