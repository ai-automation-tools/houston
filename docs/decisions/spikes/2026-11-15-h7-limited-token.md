# Spike H7: the write-restricted token doesn't hold deletes

**Date:** 2026-11-15 · **Status:** failed. Resolved 2026-11-22: the owner chose no fallback rung (sessions don't start where containers are unavailable), and ADR-004 is amended ([open question](../../OPEN-QUESTIONS.md#harness-which-fallback-if-process-containers-fail-on-windows-11-home)).
**Serves:** [ADR-004](../adr-004-core-companion-process.md) ("Where that is unavailable, sessions run on a write-restricted token and are labelled 'limited containment'"), harness-requirements' platform row, roadmap H7 "The fallback containment rung".

## The question

Before building the fallback rung: does a write-restricted token, made from the operator's own token with no admin rights, keep a session's writes to the folders its grants name?

## Machine

Windows 11 Home, build 26300, Node 24, koffi 3.3.7 (already a dev dependency, used by the vault), node-pty 1.1. Not elevated.

## What was run

[`spikes/h7-limited-token.mjs`](../../../spikes/h7-limited-token.mjs), from PowerShell:

```powershell
$env:H1_ROOT = '<a scratch folder>'; node spikes/h7-limited-token.mjs
```

It makes `ws\` (an inheritable Modify ACE for a SID made for the run, `S-1-9-<128 random bits>`), `ws\secret\` (an inheritable deny-write ACE for that SID) and `other\` (no ACE, a few files). A helper running under a ConPTY, as the runner would start it, makes the token with `CreateRestrictedToken(WRITE_RESTRICTED)` and starts `cmd /c node probe.cjs` on it with `CreateProcessAsUserW`, inside a kill-on-close job. The probe tries each action and writes what happened. The ACEs are then removed (by hand: `REVOKE_ACCESS` removes allow ACEs only and left the deny ACE behind in a first try).

It runs twice: restricted to the session SID, `WRITE_RESTRICTED` (S-1-5-33) and the logon SID, then with Everyone (S-1-1-0) added, as Windows does for a restricted service.

## Output

```text
== restricting SIDs: session, WRITE_RESTRICTED, logon (S-1-9-1626786349-2627699660-1177185264-3846747506)
helper exit 0 in 3369 ms; probe-exit=134
  the probe wrote no results

== restricting SIDs: session, WRITE_RESTRICTED, logon, Everyone (S-1-9-3555482376-188411949-3242344880-719262585)
helper exit 0 in 3388 ms; probe-exit=0
  write a file in the workspace                    ok
  make folders in the workspace                    ok
  write a file in the denied folder                refused EPERM
  remove the denied folder                         ok
  write a file in other                            refused EPERM
  overwrite a file in other                        refused EPERM
  rename a file within other                       refused EPERM
  read a file in other                             ok
  DELETE a file in other                           ok
  MOVE a file out of other into the workspace      ok
  REMOVE an empty folder in other                  ok
```

Earlier tries the same evening, outside the spike script: `cmd /c echo` printed through the ConPTY on the first SID set, so the console works; a probe that wrote through a folder junction inside the workspace was refused (the inherited ACE doesn't cross a junction); setting and removing the ACEs on a small folder took about 150 ms each; the helper takes about 3.4 s to start (Node and koffi), against well under a second for a container.

## What it shows

1. **Without Everyone, Node doesn't start** (exit 134, an abort during start-up): something it opens for writing at start grants Everyone and none of the other three. With Everyone it runs.
2. **Writes are held.** Creating, overwriting and renaming are refused outside the session's ACEs, and inside the denied folder.
3. **Deletes are not.** A write-restricted token is checked against its restricting SIDs only for the access in the object type's generic *write* mapping. For files that is write data, append, attributes, extended attributes, read-control and synchronize; `DELETE` and `FILE_DELETE_CHILD` are not in it. So a session can delete any file or folder the operator can, including the denied folder inside its own workspace, and can **move** a file from anywhere into its workspace (a rename needs `DELETE` on the source and add-file on the target folder, which it has). A deny ACE for the session SID can't stop it either: it is consulted only in the restricted check, which a delete never reaches.
4. **Reads and network are open**, as ADR-004 expected for this rung.

So the rung ADR-004 names would let an agent run `rm -rf` on the operator's profile and other repos, or move any file out of its place into the workspace. "Limited containment" undersells that, and the item's own standard ("every control names what enforces it") isn't met for writes.

## Options (for the owner)

- **(a) Build it as ADR-004 says,** labelled so it doesn't overstate itself ("writes held, deletes and reads not"). Not recommended: an agent that deletes the wrong folder is the failure containment is for.
- **(b) A stricter token:** write-restricted as above, plus the user's own SID and Authenticated Users made deny-only (`SidsToDisable`), so the ordinary access check grants only through groups like Users. The user profile then can't be read, written or deleted; files outside it that grant Users or Everyone stay readable. The workspace would need an ACE for a group the token keeps, which every limited session shares. More programs break, each needing its own ACE, and it needs an ADR-004 update and its own spike.
- **(c) No fallback rung.** Below the container runtime's build floor, contained identities are refused and only broad-access (unconfined, marked ⚠) identities run, which is honest about what it is. Recommendation: (c) until a machine that needs the fallback exists; this one runs containers.

## Nothing kept

No code from this spike is in `core/`. The runner still refuses a `restricted-token` identity, and the identity schema keeps the value for whichever option is chosen.
