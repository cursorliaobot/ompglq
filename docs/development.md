# Development and test guide

## Toolchains

Use Node.js 22+, npm 10+, and Rust 1.85+ with the `rustfmt` and `clippy`
components. Dependencies are locked by `package-lock.json` and `Cargo.lock`;
update them as a reviewed change.

Tauri also needs its official platform prerequisites. On Linux this normally
includes a C compiler, `pkg-config`, GTK/WebKitGTK development packages, and
the system libraries named by the current Tauri 2 prerequisites page. On
Windows use the Microsoft C++ build tools and WebView2 runtime.

## Install and run

```bash
npm install
npm run dev
```

The desktop starts even when OMP is absent. The overview reports a structured
`missing` result and an actionable diagnostic; it never fabricates models,
profiles, sessions, or credentials.

## Manager metadata and migration recovery

On desktop startup, Tauri resolves the platform-specific local application
data directory (`LocalAppData` rather than roaming data on Windows), registers
an initializing runtime state, and opens `metadata.sqlite3` on a blocking
worker. The window and OMP probe remain responsive while status is
`initializing`. This database is manager-owned metadata; it is not OMP's
`agent.db` and it does not store raw credentials or session bodies.

When an existing non-empty database has pending migrations, startup first
creates a consistent sibling backup named
`metadata.sqlite3.pre-migration-<timestamp>-<pid>-<attempt>.bak`. A migration
failure rolls back the transaction and leaves that backup intact. Manual
recovery currently requires these steps:

1. Stop every OMP Manager process.
2. Move `metadata.sqlite3`, `metadata.sqlite3-wal`, and
   `metadata.sqlite3-shm` (when present) together into a new quarantine
   directory; do not delete them.
3. Copy the selected `.bak` file into place as `metadata.sqlite3`, leaving no
   old `-wal` or `-shm` beside it.
4. Start the same or newer application version and retain the quarantine
   directory until the restored database has been verified.

Never overwrite only the main file while old sidecars remain: SQLite could
replay the old WAL into the restored backup. When initialization fails, the
in-app recovery status keeps OMP probing available, shows the database and any
new completed backup path, and allows a fixed retry after the files are
repaired. Backup restoration itself remains a manual, application-stopped
operation in this M1 slice.

On Unix, startup verifies mode `0700` for the application data directory and
`0600` for database and backup files. Windows uses the application data
directory's inherited ACL in this slice; explicit Windows ACL verification
still requires Windows implementation and host testing.

## Native project registration

The project workbench is enabled only after the metadata runtime reports
`ready`. Pressing “select folder and add” calls `add_project` with only Profile,
embedded-terminal, and supported account-policy fields. Rust opens the native
folder picker; the frontend never receives or submits an authorization path.
Cancellation is a successful no-op.

After selection, `LocalTarget` canonicalizes the existing directory and records
stable authorization identity. Project, authorized-root, and direct-binding
rows commit together. Re-selecting an existing project does not replace its
binding; edit that binding explicitly. Profile discovery in this slice is only
`default` plus stored binding names and is always labelled incomplete. No home
directory/Profile scan occurs.

Project binding saves include the last observed revision. A
`project_binding_conflict` means another update won and the UI must refresh
instead of retrying the stale write. `credential_pin` and external terminal
values are rejected by Rust even if crafted outside the UI.

Relevant isolated checks are:

```bash
cargo test -p omp-manager --lib services::project_service
npm run test --workspace=@omp-manager/desktop -- project
```

Linux tests prove Unicode and shell-significant path data, symlink
canonicalization, stable Unix identity, atomic persistence, and component-aware
longest-prefix behavior. They do not prove Windows junction, UNC, case-sensitive
directory, or stable volume/file identity behavior. Until Windows host tests
and handle-derived identity exist, project registration is metadata only there;
sensitive project actions remain disabled.

## In-app Cursor action

Project cards expose “Open in Cursor” directly and through a focusable “More
actions” menu. The frontend command contains only `project_id` and
`editor_id=cursor`; never add a path, executable, argument list, environment,
URL, or command template. Offline/replaced roots may be retried because Rust
revalidates the original identity. Missing/revoked roots stay disabled and
replacement requires selecting the folder again.

On Linux, each open performs two service-level path/identity checks followed by
the adapter's no-follow path check and directory-handle device/inode check.
Cursor detection runs only after the user action. Candidate count, help bytes,
child/output lifetime, and process descendants are bounded; only an exact
desktop `cursor` usage with verified window flags is accepted. The adapter
chooses observed `--classic` or `--new-window`, rechecks/opens the launcher,
then directly spawns `[flag, canonical_project_path]` with null stdio and a
minimal environment.

Automated tests use synthetic launcher scripts and temporary projects. They
cover Unicode/shell-significant/newline paths as one argument, agent-CLI
rejection, truncated help, inherited-pipe timeout, launcher/path replacement,
authorization status updates, and concurrent-open rejection. They never start
an installed Cursor. Manual Linux acceptance must verify the target Cursor
version opens the classic/new editor with the intended folder. Windows remains
disabled until stable directory handle identity and ACL behavior are verified.
The system file-manager right-click helper remains M2.

Relevant checks:

```bash
cargo test -p omp-manager --lib adapters::editors
cargo test -p omp-manager --lib services::project_service
npm run test --workspace=@omp-manager/desktop -- project
```

Cursor's CLI accepts a path rather than a directory handle. The application
holds and rechecks handles through `spawn`, but cannot control a malicious
same-account process after that boundary; do not describe this as an absolute
race-free handoff without a future Cursor-supported handle protocol.

## Session authorization, scan, and JSONL parser

The backend never scans `~/.omp` implicitly. `authorize_project_sessions`
captures the selected directory in a Rust-owned native picker and binds it to
the project's current Profile; its IPC input is only `project_id`.
`project_sessions` reads cached metadata and `scan_project_sessions` reuses the
stored grant. Profile discovery remains incomplete. Each project card lazily
loads its session panel, searches only decoded metadata, and renders results in
50-row increments. The panel deliberately has no transcript preview or launch
action.

Linux session authorization and reads are rooted in directory descriptors.
Do not replace the `openat`/`O_NOFOLLOW` relative-component flow with
`canonicalize + starts_with`: that would reopen a root/intermediate-component
race. Root plus one child level, physical entries, files, per-file bytes, total
source bytes, diagnostics, and returned rows are independently bounded.
Windows and non-Linux scanning intentionally fail closed until equivalent
handle identity has real-host coverage.

The parser supports header-first and exact 256-byte title-slot files, ignores
unterminated append tails, and reconstructs only the final leaf's active
ancestry. Limits cover bytes, physical records, line size, message extraction,
first-message summary, latest preview count and total preview characters.
Unknown records remain branch links but do not execute or render their body.
Malformed records, cycles, missing parents, future slots/versions and metadata
truncation produce explicit partial/warning state.

Tests cover active versus abandoned branches, empty/future title slots,
role-specific model changes, legacy assistant model fallback, multiple pin
providers without retaining hashes, current transcript entry types, image-only
custom messages, malformed messages, physical-record limits, display controls,
and an appending final line:

```bash
cargo test -p omp-manager --lib session_parser
cargo test -p omp-manager --lib services::session_service
cargo test -p omp-manager --lib adapters::targets::local
npm run test --workspace=@omp-manager/desktop -- session
npm run test --workspace=@omp-manager/desktop -- ProjectSessionsPanel
```

`ParsedSessionHeader::cwd` is crate-private raw path data. `SessionService`
uses it only for canonical longest-project-root ownership matching, then
returns a separately sanitized `cwd_display`. `session_index` stores structural
metadata and explicit freshness only; message/preview bodies,
`first_message_summary`, credential hashes, and source bytes must remain
absent. A single source failure must not poison otherwise readable rows.

The current scan command is request-scoped and protected by a Profile-wide
single-flight guard. Do not present it as cancellable or reload-resumable;
moving it into `TaskSupervisor` with progress and cancellation is still pending.
Frontend mutation results remain valid when the panel is collapsed, while a
binding revision/Profile change invalidates stale responses.

## Background OMP probe operation

The probe workbench starts OMP detection through `TaskSupervisor`, not a
request-scoped command. The backend returns a UUID operation snapshot and owns
the adapter future, total timeout, deduplication, memory retention, and history
write. The frontend keeps only that UUID in `sessionStorage`; reloading the
WebView queries the existing operation before starting another.

`operation_history` intentionally contains lifecycle fields and a generated
status/count JSON summary. It must not contain the selected/resolved executable
path, raw stdout/stderr, diagnostics, credentials, or the full probe report.
When SQLite is unavailable, the probe result remains usable and the UI reports
history persistence as partial success. Old terminal operations are evicted
from the bounded memory registry rather than disabling probing. The current
probe advertises `cancellable = false`; timeout is not presented as proof that
no subprocess was ever started.

Relevant isolated checks are:

```bash
cargo test -p omp-manager --lib services::task_supervisor
npm run test --workspace=@omp-manager/desktop -- operation
npm run test --workspace=@omp-manager/desktop -- probe-client
```

## Single-instance desktop check

`tauri-plugin-single-instance` must remain the first registered desktop plugin.
Windows must also acquire `WindowsPreflightGuard` before
`tauri::Builder::default()`. Do not shorten that guard's lifetime: it closes the
official plugin's mutex/receiver-window race and remains held until the primary
event loop returns. A Windows secondary waits at most two seconds for the
receiver, sends only the empty focus payload with a 500 ms timeout, then exits
even if the receiver never appears.

The secondary callback intentionally ignores all forwarded arguments and its
working directory; current behavior is only show, unminimize, and focus of the
fixed `main` window. Do not add project paths, shell strings, logging, or
frontend events to this callback.

After installing the platform prerequisites, build or run the desktop and start
the same executable a second time. Verify that the second process exits, the
existing window becomes visible/focused, no second SQLite migration or OMP
probe registry starts, and arguments containing spaces, Unicode, quotes,
newlines, `&`, semicolons, and `$()` have no effect beyond focus. Windows and
Linux both require host verification; unit tests prove payload reduction and
the bounded Windows wait policy but cannot prove named-mutex/window timing.
Windows stress acceptance must start many pairs concurrently while delaying
primary setup and confirm that no secondary reaches Tauri setup.

The Linux plugin uses D-Bus dependencies whose newest semver-compatible
releases currently require a newer Rust compiler. `Cargo.lock` therefore pins
the Rust 1.85-compatible family, while `.cargo/config.toml` enables
MSRV-aware fallback resolution. Review those versions together when updating
the plugin or Rust baseline.

## Checks

```bash
npm run format:check
npm run typecheck
npm run lint
npm run test
npm run build
```

`npm run check` runs the complete repository gate. Rust tests can also run
directly:

```bash
cargo test --workspace
```

The desktop development command is:

```bash
npm run dev
```

The web-only Vite view, useful for frontend state work, can be run from the
workspace package. Tauri IPC is unavailable there, so the UI must display its
real connection error rather than substitute fixture data.

## Safe OMP compatibility work

Never use a developer's real sessions or credentials in tests. Integration
tests create a temporary directory and a stub executable with deterministic
help/JSON/exit behavior. The parent process receives only an allow-list of
environment names.

Manual M0 checks against an installed OMP are restricted to:

- `omp --version` and fixed help commands;
- `omp config path` and `omp config list --json` only with an isolated,
  synthetic `PI_CODING_AGENT_DIR`;
- `omp models --json --no-extensions` only in that synthetic context;
- `omp auth-broker status --json` and provider catalog listing without a
  configured Broker.

Do not run login/logout, import without `--dry-run`, update, live usage,
gateway checks, session launch/resume/fork/export, or model completions as an
automated probe. Some apparently invalid launch invocations still initialize
OMP runtime directories; help/source evidence is safer.

## Fixture policy

Committed files under `tests/fixtures/omp` must be synthetic and reviewed.
They may contain invented model/provider names and the designated fake-secret
sentinel used by redactor tests, but no real usernames, home paths, emails,
projects, sessions, keys, tokens, cookies, authorization headers, or Broker
URLs. Each fixture states the observed shape/version it models.

Raw local probe output belongs under ignored `.m0-probes/`, is redacted before
writing, and is never committed by default.

## Adding an IPC command

1. Define a secret-free domain request/response.
2. Add backend authorization and validation independent of TypeScript.
3. Use an existing service/adapter; do not expose infrastructure primitives.
4. Register the named Tauri command without adding generic shell/filesystem
   plugin permissions.
5. Add success, denied, malformed, timeout, and redaction tests.
6. Update `docs/architecture.md` and `docs/threat-model.md` when the trust
   surface changes.

## Adding an OMP capability

Capabilities are facts, not version guesses. Add a fixed probe, timeout/output
budget, parser fixture, and explicit unsupported/invalid-JSON behavior. Cache
evidence with executable identity and invalidate it when the binary changes.
Raw CLI text never crosses IPC.

## PTY work

The M0 spike uses `portable-pty` with a fixed harmless program. M1 PTY work
must retain direct argument passing, bounded queues, session IDs owned by Rust,
resize validation, graceful termination before force kill, and cleanup on
application exit. Windows and Linux behavior need separate CI coverage.

## Packaging

```bash
npm run package
```

Packaging requires the platform's Tauri prerequisites. M0 validates source and
web/Rust builds; signed Windows installers and Linux AppImage/distribution
packages are M3 deliverables and are not claimed until produced in CI.
