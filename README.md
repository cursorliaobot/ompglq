# OMP Manager

OMP Manager is a Windows and Linux desktop control plane for local
[Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) installations. OMP remains
the source of truth for sessions, models, configuration, and authentication;
the manager only probes public capabilities and orchestrates validated launch
plans.

## Current milestone: M1 in progress

M0 compatibility and security work is complete. M1 is being delivered as
small, real vertical slices; the application is not yet the finished V1
product. The current repository provides:

- a Tauri 2 + React + strict TypeScript desktop shell;
- a process-level single-instance boundary whose secondary-instance payload
  can only show and focus the existing main window;
- a Rust-only process and filesystem boundary with no frontend shell access;
- contracts for `ExecutionTarget`, `OmpAdapter`, `CredentialBackend`, and
  `CredentialImporter`;
- bounded, redacted OMP capability probing;
- a cross-platform `portable-pty` smoke test;
- an application-private SQLite metadata database with numbered migrations,
  foreign keys, WAL, bounded lock waiting, consistent pre-migration backups,
  transactional rollback, and a seeded local execution target;
- a background-initialized database runtime that keeps the probe workbench
  available during startup and after failure, with bounded status/retry
  commands, observable revisions, recovery paths, and diagnostics;
- a Rust-owned `TaskSupervisor` that runs OMP probing as a bounded,
  target-deduplicated background operation with UUID identity, total timeout,
  reload recovery, startup reconciliation, and secret-free history summaries;
- a native-picker-only local project registry that canonicalizes selected
  directories, records target-scoped authorization identity and optional Git
  identity, persists project/root/binding rows atomically, and exposes an
  honest incomplete Profile inventory;
- a real project workbench with loading, empty, recovery-gated, partial-success,
  authorization-status, binding-edit, and revision-conflict states;
- a fixed in-app Cursor action whose IPC accepts only project/editor IDs,
  revalidates Unix project identity, verifies desktop-launcher help/identity,
  and spawns an argument array with a minimal environment;
- a bounded, read-only OMP v3 JSONL parser with fixed title-slot support,
  active-branch reconstruction, append-tail tolerance, role-model metadata,
  secret-free credential-provider projection, and latest-message preview
  budgets;
- Profile-authorized Linux session discovery, indexing, search, cache
  freshness, and memory-only transcript preview;
- user-triggered, bounded model listing plus new/resume settings and a
  short-lived, single-use LaunchPlan that revalidates the OMP binary, project,
  binding, and session before execution;
- a Rust-owned embedded PTY registry with sequenced events, bounded replay,
  input/resize/interrupt/force-stop commands, reload recovery, and an xterm.js
  terminal workspace;
- project-selectable external terminal launch with fixed argv adapters for
  common Linux terminals, the same allow-listed OMP environment, and no shell
  command interpolation; the Windows adapter remains behind the existing
  project-identity verification gate;
- synthetic fixtures and contract/security tests;
- architecture, threat-model, development, and compatibility records.

Remaining M1 hardening includes Windows project/session handle identity,
active-run application-exit policy, and generalized task progress/cancellation.
Credential mutation, imports, system folder integration, trash, and
configuration writes remain M2 work. None are represented by fake data.

## Quick start

Prerequisites:

- Node.js 22 or newer and npm 10 or newer;
- Rust 1.85 or newer;
- Tauri's Linux or Windows system prerequisites;
- OMP is optional. A missing installation is a supported probe result.

```bash
npm install
npm run dev
```

Run the complete repository quality gate:

```bash
npm run check
```

Individual entry points:

```bash
npm run typecheck
npm run test
npm run build
npm run package
```

See [development instructions](docs/development.md) for platform packages,
fixture rules, and isolated OMP testing.

## Security invariants

- The WebView cannot execute arbitrary commands or read arbitrary files.
- The WebView cannot turn a path string into an authorized project; the Rust
  command receives a directory only from the native system picker.
- OMP is spawned directly with an executable and argument array; no
  user-controlled shell command string is constructed.
- Probe output is bounded and centrally redacted before it crosses IPC.
- API keys, access tokens, refresh tokens, cookies, and authorization headers
  are never application DTO fields.
- OMP's `agent.db` and session JSONL files are not modified.
- M0 does not run login, update, live usage, model completion, or strict
  credential-check commands.

The complete trust model is in [docs/threat-model.md](docs/threat-model.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [OMP compatibility matrix](docs/omp-compatibility.md)
- [Development and testing](docs/development.md)

The Chinese product requirements remain authoritative:
[`OMP-Manager-完整需求文档.md`](OMP-Manager-完整需求文档.md).
