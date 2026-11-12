# Spike S1, first contact: Execution Containers load and run on Windows 11 Home

**Date:** 2026-11-12 · **Status:** partial. S1 stays open on the [roadmap](../../ROADMAP.md#agent-harness) until the toolchain runs below are done.
**Serves:** [ADR-004](../adr-004-core-companion-process.md), requirement SEC-04

## The question

Before anything else in S1: does `@microsoft/mxc-sdk` load on this machine, report a usable backend, and run one contained command, with no admin rights?

## Machine

Windows 11 Home (`EditionID` Core), build 26300.9974, display version 26H2. Node 24. Not elevated.

## What was run

`@microsoft/mxc-sdk@1.0.1` installed as a dev dependency. Its install pulled `koffi@3.3.7`, whose install script is not covered by `allowScripts` and did not run; the SDK loaded anyway.

```js
import * as m from '@microsoft/mxc-sdk/v1';
await m.getPlatformSupport();
await m.getAvailableBackends();
await m.getTelemetryConsentStatus();
await m.probe();
await m.run({ command: 'cmd.exe /d /c echo MXC_OK', timeoutMs: 30000 });
```

## Output

```text
getPlatformSupport => {"isSupported":true,"reason":"","availableMethods":["processcontainer","isolation_session","hyperlight"],"isolationTier":"base-container", ...}
getAvailableBackends => [{"backend":"processcontainer","tier":"base-container","capabilities":["captureDenials","filesystemDeniedPaths","filesystemEnumeratePaths","ingressHostLoopbackAllow","identitylessLoopbackProxy"],"warnings":[]},{"backend":"isolation_session","capabilities":[],"warnings":[]},{"backend":"hyperlight","capabilities":[],"warnings":[]}]
getTelemetryConsentStatus => {"state":"undetermined","storedState":"undetermined","effectiveState":"undetermined","needsPrompt":true,"policy":"unrestricted"}
probe => {"tier":"base-container","needsDaclAugmentation":false,"warnings":[],"probes":{"baseContainerApiPresent":true,"nativeCaptureAvailable":true,"guardedCaptureAvailable":false,"bfscfgPresent":false,"bfsCompiledIn":false,"baseContainerSupportsDenyPaths":true,"baseContainerSupportsEnumeratePaths":true,"baseContainerSupportsIngressHostLoopbackAllow":true,"baseContainerSupportsIdentitylessLoopbackProxy":true,"isolationSessionAvailable":true,"hyperlightAvailable":true, ...}}
run => {"stdout":"MXC_OK\r\n","stderr":"","exitCode":0,"timedOut":false,"warnings":[]}
```

The two long objects are cut where marked; the cut parts are the UI capability flags, all `true`.

## What this shows

- **Home edition is supported.** `isSupported: true` on `Core`, with the process container backend, and no elevation.
- **A contained command runs.** `cmd.exe` printed `MXC_OK` and exited 0 inside the default process container.
- **Denied paths and denial capture are available** (`filesystemDeniedPaths`, `captureDenials`), which the read-list work in S1 needs.
- **Loopback has controls.** The backend reports `ingressHostLoopbackAllow` and `identitylessLoopbackProxy`. That is a lead for S2, not its answer.
- **The session backend is present** (`isolationSessionAvailable: true`), relevant to per-agent Windows accounts later. Not exercised.

## What this does not show

- That a default-deny file policy holds. This run used the SDK's defaults; no path was denied or tested.
- That `git`, `npm install`, `node --test` or `python -m pytest` run inside a container, how wide the read list must be, or the slowdown. That is the rest of S1.
- Anything about network policy or reaching other local apps on loopback. That is S2.
- Whether the missing `koffi` install script matters for other SDK calls. It did not for these.

## Left for the owner

- **Telemetry consent is undetermined** and the SDK reports `needsPrompt: true`. Nobody has answered it. The harness must surface this choice in Settings; a spike or a routine must not answer it on the owner's behalf.
- **`koffi`'s install script** is not approved in `allowScripts`. Approving it is a hold-path change.
