# OMP Manager architecture (M1 in progress)

## Scope

OMP Manager is an orchestration layer around a separately installed OMP
binary. It does not implement an agent, own OMP credentials, or reinterpret
saved conversations for execution. M0 established the trust boundaries and
adapter seams. M1 now adds production infrastructure and business behavior as
small, tested slices without weakening those boundaries.

```text
React WebView
    |
    | typed, allow-listed Tauri commands
    v
IPC commands -> domain services -> OmpAdapter
                         |             |
                         v             v
                  ExecutionTarget   public OMP CLI / Broker
                         |
                         v
                 LocalTarget (V1 only)

Rust services -> metadata repositories -> application-private SQLite
```

The frontend receives domain DTOs. It never receives raw stdout/stderr,
credentials, environment snapshots, file handles, or an arbitrary executable
and argument list.

## Module boundaries

### Domain

The domain layer owns serializable, secret-free types:

- `TargetId` and target health/capability descriptions;
- `OmpInstallation` and `OmpProbeReport`;
- stable `DomainError` codes with a Chinese user message, actionable
  suggestion, retryability, and redacted technical detail;
- immutable `LaunchPlan` and settings provenance;
- credential/import capability declarations without credential values.

`LaunchPlan` is now executed by the M1 launch service. A plan carries the
target, verified executable, authorized working directory, explicit profile,
exact model selectors, action, argument array, allow-listed environment keys,
terminal mode, redacted preview, and warnings. The WebView receives only a
short-lived UUID, a runtime-salted input fingerprint, the secret-free preview,
and each permitted environment variable's name/source/presence. Values never
cross IPC. Rust keeps the executable path, session path, identities, argv, and
salted environment-value evidence. Execution returns a tagged embedded-PTY or
detached-external result; the renderer cannot mistake an external launcher PID
for a managed PTY run.
Plans expire after two minutes and transition atomically from prepared to
consumed before asynchronous revalidation starts, using a backend monotonic
deadline so wall-clock changes or a cancelled IPC future cannot extend or
strand their lifetime. Double clicks and IPC replay cannot start a second
process.

### ExecutionTarget

All target-dependent process, path, file, and PTY operations pass through an
asynchronous `ExecutionTarget` contract:

- probe and health check;
- canonicalize a path and resolve Git shared-directory identity;
- execute a bounded OMP request;
- spawn a validated PTY or open an external terminal;
- read or atomically write an explicitly authorized file.

`LocalTarget` is the only implementation registered in V1. Business services
depend on the trait, so later `WslTarget` and `SshTarget` implementations can
provide their own path syntax, process transport, trust establishment, and
terminal lifecycle without changing project/session rules. Every future
persistent reference includes `target_id` from its first migration.

### OmpAdapter

The single OMP adapter owns installation discovery and public-interface
compatibility. Capability decisions are derived from observed help/JSON
behavior and stored alongside executable path, version, binary modification
time, and probe time. A changed binary invalidates the observation.

M0 deliberately separates two concepts:

1. a command is present in documentation or target-version source; and
2. a command is safe to prove automatically on the current machine.

Only the second enables a runtime action. A probe never logs in, updates OMP,
runs a prompt, fetches live usage, reads real sessions, or enumerates raw local
credentials. Output has byte/time limits and is redacted before parsing errors
or diagnostics are returned.

### CredentialBackend

Credential access is capability-driven:

- `BrokerCredentialBackend` represents the authenticated, documented Broker
  snapshot and credential endpoints.
- `NativeInteractiveCredentialBackend` launches OMP's own login/logout flow
  when no safe structured local API exists.
- no companion bridge exists in M0 because no safe public package boundary has
  yet justified one.

The capability DTO distinguishes list, login, disable, delete, exact pin,
non-billing check, and strict check. Unsupported operations remain disabled;
there is no fallback that silently targets a different account.

### CredentialImporter

Importers expose detection, preview, import, resync, and capability methods.
The M0 trait makes preview identifiers opaque and short-lived. Implementations
must keep raw secrets in Rust memory only, apply size/count/depth/symlink
limits, and treat sources as read-only. SQLite records only source metadata,
fingerprints, and opaque target references.

### Single-instance process boundary

The desktop registers official `tauri-plugin-single-instance` before every
other plugin. Linux uses its application-identifier-scoped D-Bus service.
Windows additionally acquires a distinct named preflight mutex before building
the Tauri runtime and holds it until `run()` returns. This closes the upstream
plugin's interval between creating its own mutex and creating the hidden
WM_COPYDATA receiver window.

A Windows secondary that sees the preflight mutex polls for the plugin receiver
for at most 80 × 25 ms. If found, it sends the minimal empty callback payload
with a 500 ms hung-window timeout; whether found or not, it closes its handle
and exits before any plugin/setup/database/task initialization. The primary
continues to use the official plugin receiver and callback. Linux secondary
instances exit through the official D-Bus implementation. These boundaries
prevent concurrent Tauri setup, database migration, and duplicate in-memory
task registries.

The current callback intentionally reduces every forwarded argument list and
working-directory string to one fieldless action: show, unminimize, and focus
the `main` window. It never logs, stores, parses as a path, opens, authorizes, or
passes those values to the WebView. There is no single-instance IPC permission
exposed to frontend code. A later fixed project-opening protocol may forward a
validated project ID, but arbitrary paths and commands will remain rejected.

The plugin is locked to version `2.4.3`. Its Linux D-Bus dependency family is
locked to Rust 1.85-compatible releases, and Cargo's MSRV-aware fallback
resolver is enabled in `.cargo/config.toml` to avoid future compatible-range
updates silently raising the repository baseline.

### Metadata database

M1 registers a pending `DatabaseRuntime` in Tauri's platform-local application
data directory during synchronous setup, then performs open, integrity checks,
backup, and migration on a blocking worker. The window and read-only OMP probe
IPC therefore remain available while the revisioned database status is
`initializing`. On success, the runtime owns the manager's SQLite connection.
On failure, it owns no connection and instead retains a structured recovery
snapshot. Future metadata services must obtain the connection through this
runtime and therefore fail closed while initialization or recovery is active.
The WebView receives no database handle or SQL surface. The worker first
configures connection-local foreign keys, a five-second busy timeout, recursive
triggers, and SQLite's untrusted-schema mode. It validates integrity,
foreign-key consistency, and migration history before making the persistent
switch to WAL and full synchronous writes.

Migrations are an ordered, append-only manifest. `0001_initial.sql` remains
unchanged; `0002_m1_foundation.sql` adds capability evidence, authorized roots,
operation history, and the built-in `local` execution target.
`0003_target_scope_guards.sql` validates existing rows and installs database
guards that prevent redundant `target_id` columns from pointing across
execution targets. `0004_parent_scope_guards.sql` also prevents parent-row
updates from invalidating those scopes. `0005_project_integrity.sql` adds
monotonic project-binding revisions, one direct binding per project, and guards
that keep direct bindings and project-kind authorized roots aligned with the
project target/path identity. Before pending migrations touch an existing
non-empty database, an immediate writer lock is acquired and a second no-follow,
read-only connection uses SQLite's Backup API to produce a consistent snapshot
that includes WAL state. The destination is also opened explicitly with
no-follow rather than through a path-only convenience API.
Source and destination path identities are checked around their opens and
before publish. The backup is flushed through its original writable handle and
published with a no-clobber hard link. All pending migrations and their history
rows then commit in the same transaction; any error rolls the transaction back
and retains the completed backup.

The runtime opens database files with SQLite's no-follow flag and rejects
symlinks, path identity changes, non-contiguous or unknown migration history,
databases created by a newer application, integrity/foreign-key violations,
conflicting `local` target rows, and storage that cannot provide WAL. On Unix,
the application data directory and database/backup files are restricted to
mode `0700` and `0600` respectively. Windows currently relies on inherited
local-application-data ACLs; explicit ACL verification and handle-derived
stable Windows directory identity remain implementation and host-test work.
Project registration now persists `AuthorizedRoot` rows. Session scan, Cursor
open, LaunchPlan preparation, and final PTY execution revalidate their
respective roots and identities; delete and configuration-write boundaries
remain future work.

### ProjectService

The first project slice registers local directories through one Rust-owned
native folder picker. The `add_project` IPC accepts binding values but no path,
target, executable, argument array, or filesystem token. The dialog plugin is
registered after the single-instance plugin, and the main WebView capability
does not grant the plugin's direct open/save commands. A compromised renderer
therefore cannot convert an arbitrary path string into an `AuthorizedRoot`.

`LocalTarget` requires a selected absolute, existing directory, resolves it to
a Unicode canonical path, and records a versioned stable identity. Linux/Unix
uses device and inode identity. The current non-Unix fallback is not sufficient
for sensitive Windows operations, so this slice only records projects there;
Windows launch/read/write/editor actions remain disabled until handle-derived
volume/file identity and real-host tests exist. Optional Git identity is read
without a shell or Git process: bounded `.git`/`commondir` pointers yield the
canonical common directory plus repository-relative path. A non-repository is
normal; malformed or inaccessible Git metadata becomes a visible non-blocking
diagnostic and never grants another worktree.

One immediate SQLite transaction inserts a project, its project-kind
authorized root, and its exact direct binding. Re-selecting the same canonical
directory refreshes the explicit root grant but does not overwrite its Profile
binding; the UI directs binding changes through a separate command. Binding
updates use an expected monotonic revision and reject stale writes. Project
responses join the root independently and expose `active`, `offline`,
`replaced`, `revoked`, or `missing`; a project row is never treated as proof of
authorization. The known Profile inventory contains only `default` and names
actually present in project bindings, marks their source, and always reports
that discovery is incomplete.

The service also implements same-target longest-prefix selection using native
path components, so `/work/app` does not match `/work/application`. This selects
settings only; it never expands authorization. `SessionService` reuses the same
longest-component rule solely to assign a parsed session `cwd` to the most
specific registered project; the separate Profile-kind session-root grant
still bounds every file read. The launch service can now start new sessions or
resume an indexed session in either a managed local PTY or a detached external
terminal. Credential mutation, delete, and configuration writes remain outside
this slice.

External terminal launch remains an `ExecutionTarget` operation. `LocalTarget`
selects only fixed, known adapters and sends OMP executable/path options as
separate argv elements. Linux supports XFCE Terminal, GNOME Terminal, Konsole,
Kitty, Alacritty, WezTerm, Foot, and XTerm, prioritizing the current desktop
when known. It does not interpret `$TERMINAL` or invoke a shell. Windows prefers
Windows Terminal and otherwise creates a native console directly, but the
existing Windows project-identity gate keeps that source path disabled until
host verification is complete. External launches use the plan's environment
allowlist plus explicitly previewed desktop session variables and remain alive
independently of the manager.

### ExternalEditorAdapter

The application exposes one editor ID, `cursor`. The
`open_project_in_editor` request contains exactly `project_id + editor_id`;
Rust reloads the project and its independently joined project-kind
`AuthorizedRoot`. Revoked/missing roots fail immediately. Offline/replaced
roots may be revalidated, allowing an original directory that has returned to
recover without silently accepting a different identity.

On Unix, the service canonicalizes and compares the stored/current
`unix_dev_ino_v1` identity before editor detection and again immediately before
launch. The Cursor adapter then rejects symlinks, opens a directory handle,
compares handle and path device/inode, and holds that handle through process
spawn. Final-boundary failures are written back as `offline` or `replaced`.
Windows editor opening remains fail-closed until volume/file-handle identity
and ACL behavior have real-host evidence.

`CursorEditorAdapter` checks at most eight PATH/common-install candidates. A
candidate must have a Cursor-named canonical program and bounded `--help`
output whose exact usage command is `cursor`/`cursor.exe` and which advertises
desktop window/path behavior. `cursor-agent`, `agent`, ambiguous help, failed
exit, output truncation, and timeout are rejected. On Unix the help child runs
in its own process group; the three-second total deadline covers child exit and
inherited output pipes. Any surviving descendant is terminated and makes the
captured evidence unusable even when its prefix looked valid. Runtime help
selects `--classic` when observed, otherwise the observed `--new-window`
protocol.

Before launch, the adapter rechecks launcher path identity, opens and verifies
the same launcher object, and holds its handle through spawn. It starts the
verified executable directly with `[verified_window_flag, canonical_project]`
as separate arguments, null stdio, and a minimal desktop environment that
omits OMP/provider/Broker secrets, loader injection variables, and shell
profiles. Cursor is detached from manager lifecycle and is not registered as an
OMP/PTY process. A backend per-project single-flight rejects concurrent open
requests; the UI also disables actions during reads/mutations and refreshes
authorization after success/failure.

Cursor accepts a filesystem path rather than an inherited directory handle, so
no implementation can prove what a separate same-account process resolves
after `spawn` without a Cursor-supported handle protocol. The current design
performs the final practical handle/path checks at the spawn boundary and
documents this residual race rather than claiming an impossible guarantee.
System file-manager context-menu integration and its helper remain M2.

### TaskSupervisor

The first `TaskSupervisor` slice owns OMP capability probes. Starting a probe
creates an opaque UUID v4 and an in-memory snapshot with queued, running, and
terminal states. Every lifecycle/persistence change increments a monotonic
in-process revision. One local-target probe may be active at a time, so
automatic discovery, explicit-path requests, double clicks, and WebView
retries cannot create concurrent probe trees. Completed operations are retained
in a bounded 128-entry registry; old terminal entries can be evicted even when
history persistence is unavailable, preserving probe degradation.

OMP probe cancellation is explicitly reported as unsupported because the
adapter does not yet expose reliable cooperative cancellation. The supervisor
still applies a 40-second total timeout. Dropping the timed-out adapter future
drops `tokio::process::Child` with `kill_on_drop`, while every individual
command also retains its four-second timeout and bounded stdout/stderr readers.

The full probe result remains only in bounded backend/frontend runtime state.
`operation_history` receives lifecycle fields and a compact JSON summary with
probe status and counts; executable paths, CLI output, diagnostics, and
credentials are excluded. Explicit probe paths are represented in history only
as `explicit_executable`, never as the path itself. History failure does not
invalidate a successful probe: the snapshot reports partial success and
retries at a bounded rate when queried. Startup changes stale
queued/running/cancelling rows to `needs_reconciliation` before current-process
history is inserted.

## IPC boundary

The current application exposes only named operations:

- `database_status()` returns the immutable, secret-free runtime snapshot;
- `retry_database_initialization()` repeats only the fixed database
  initialization/migration flow, coalesces an in-progress attempt, and refuses
  to repeat an unchanged deterministic failure;
- `start_omp_probe(requested_path)` validates the optional path and returns the
  new or already-active target-scoped operation;
- `get_omp_probe_operation(operation_id)` returns one typed probe snapshot;
- `cancel_operation(operation_id)` returns an explicit unsupported result for
  the currently non-cancellable probe operation;
- `project_workspace()` returns bounded project summaries plus an explicitly
  incomplete, source-labelled known-Profile inventory;
- `add_project(request)` opens the native folder picker in Rust and returns
  `null` on user cancellation or the persisted project plus non-blocking
  diagnostics; the request has no path field;
- `update_project_binding(request)` changes only the selected local project
  binding and requires the binding revision observed by the caller;
- `open_project_in_editor({project_id, editor_id})` accepts no path,
  executable, arguments, environment, URL, or command template and currently
  permits only `editor_id = cursor`;
- `pty_spike()` for a fixed, non-user-controlled test program.

Database status text and intentional recovery paths are bounded, control
characters are neutralized before rendering, and React renders them as text.
The retry runs on a blocking backend worker; it never accepts a database path,
SQL, migration, backup destination, or shell argument from the WebView.
Database snapshots expose `initializing`, `ready`, or `recovery_required` plus a
monotonic in-process revision. The frontend polls only while initialization is
active, so a WebView reload rejoins the backend-owned attempt and observes its
final result.

The WebView stores only the current probe UUID in `sessionStorage`. After a
reload it queries that UUID before considering a new probe; missing/evicted IDs
start a replacement, while other lookup errors fail visibly. The frontend
validates UUID shape, lifecycle/timestamp invariants, bounded text, terminal
result combinations, and persistence diagnostics before rendering.

There is no generic `run`, `read_file`, `write_file`, dialog-open, or
shell-plugin permission. IPC input is validated again in Rust; TypeScript types
are not a security boundary. Later commands will accept domain requests such as
`preview_launch` and `execute_launch_plan`, never raw paths or shell strings.

## OMP discovery and probing

Candidate order is:

1. an explicitly selected executable path;
2. `omp` resolved from the application process `PATH`;
3. platform-specific user installation locations.

Each candidate must be a file and successfully answer `--version`. The probe
then uses a fixed allow-list of help and machine-readable commands. Commands
run with cleared/allow-listed environment where practical, a timeout, bounded
stdout/stderr, and direct argument passing. Credential-looking output is
redacted before it reaches logs, errors, fixtures, or the frontend.
The adapter is now invoked only by the backend probe operation; the former
request/response `probe_omp` IPC is no longer registered.

### Session authorization, indexing, and JSONL boundary

The backend now exposes `project_sessions`, `authorize_project_sessions`, and
`scan_project_sessions`; no command accepts a root or session path from the
WebView. Authorization prepares a project/Profile/binding-revision intent
before Rust opens the native folder picker. The intent owns a Profile-wide
single-flight guard until authorization, scanning, and index commit finish, and
SQLite rechecks the binding revision plus root mapping in the final
transaction. Different Profiles cannot bind equal or ancestor/descendant
session roots. Profile discovery is still explicitly incomplete.

Each project card now owns a lazy session panel. Opening it reads the cached
snapshot; explicit buttons invoke the native-picker authorization or rescan.
The frontend decoder rechecks project/Profile scope, enums, timestamps, row
identity, array counts, and text limits before rendering. Search covers only
bounded structural metadata, and the list reveals 50 rows at a time to avoid
mounting the entire bounded index at once. Last-good rows remain visible beside
refresh or mutation diagnostics. There is no transcript preview or
resume/fork/export action in this slice.

Linux authorization opens the selected directory first with
`O_DIRECTORY | O_NOFOLLOW`, derives its canonical path and device/inode from
that same handle, and verifies that the resolved name still points to it.
Listing stays anchored to that root descriptor through `/proc/self/fd`; it
visits only root JSONL files and one level of ordinary child directories.
Reads accept only one or two normal relative components, open each component
with `openat` and `O_NOFOLLOW`, use `O_NONBLOCK` before checking the final
ordinary-file type, and reopen the final name after reading to detect
replacement. Root identity is checked before listing and again before commit.
Windows and other platforms remain fail-closed until equivalent
handle-derived identity and real-host tests exist.

The scan bounds physical entries, child directories, JSONL files, bytes per
file, total source bytes, diagnostics, and cached results. One malformed or
unreadable file becomes a bounded diagnostic while other files continue.
Parsed raw `cwd` is canonicalized and assigned by the longest registered
project root. Only structured metadata is upserted into `session_index` under
`target + profile + canonical session path`; `fresh`, `stale`, `missing`, and
`failed` distinguish cache state. Message bodies, previews, first-message
summaries, credential hashes, and session file contents have no SQLite write
path. Scans are currently request-scoped with Profile single-flight; progress,
cancellation, and `TaskSupervisor` operation recovery remain a later slice.

The parser input is always an explicitly bounded byte buffer. The parser
accepts legacy header-first files and exact 256-byte physical title slots. A
recognized future/damaged title slot is consumed and marks the result partial
instead of hiding the following logical session header. A valid empty title
slot preserves “no current title” and does not resurrect an older header title.

Every complete physical line counts toward a hard record budget before UTF-8
or JSON parsing. Only newline-terminated records contribute to the branch or
`consumed_bytes`; an appending tail remains for the next scan. File, line,
record, per-message, first-summary, message-count, and total/latest-preview
budgets are independent. Malformed complete records mark the session partial
without blocking later records; unknown future types remain on the parent
chain but are skipped for display.

OMP v3's final physical valid entry is the active leaf. The parser builds a
bounded `id → entry` index, detects duplicate IDs, missing parents and cycles,
then projects only the leaf's root-to-leaf ancestry. Abandoned branches cannot
change preview messages, title changes, role-specific models, thinking level,
or pin providers. Known display records include messages, displayed custom
messages, branch summaries and compaction summaries; current non-display
metadata and reset boundaries are recognized without being treated as unknown.
The preview is a rolling latest-message window so old compacted history cannot
consume the entire budget.

Credential pins are accepted only with provider plus a 64-hex hash, but the
hash is never copied into the parsed DTO. Only a sorted provider set is
projected. Model selectors require a non-empty `provider/modelId`, including
legacy assistant metadata fallback, and role changes remain a map rather than
being flattened. User-visible text is control-neutralized and truncation is
explicitly warned. Raw `cwd` remains crate-private and is used only for backend
canonical project ownership matching; the public display projection is
separately sanitized.

## PTY lifecycle

`portable-pty::native_pty_system` selects Unix PTY on Linux and ConPTY on
supported Windows systems. In addition to the fixed M0 spike, M1 now has a
Rust-owned registry capped at 32 runs. It starts the verified executable
directly with a separate argv array, a canonical cwd, and a fixed environment
name allowlist. Preparation captures only each value's runtime-salted
fingerprint and presence in Rust; execution re-reads them and rejects a changed
environment before spawn. Runtime variables are fixed; automatic credential
selection adds keys only for explicitly selected model providers, while the
Profile policy inherits no provider key from the manager process. Behavioral
`PI_*` model/PTY overrides are never forwarded. IPC exposes only names, source,
and presence.

Model inventory subprocesses are globally single-flight and run with a
manager-owned temporary HOME, agent directory, cache, and cwd. Only basic
process-locale variables survive, so Profile/project `!command` resolvers and
configuration are not loaded. The resulting built-in inventory is explicitly
marked incomplete for custom models. Overlapping requests degrade to a
retryable warning rather than spawning unbounded OMP children.

OMP probing records canonical path, size, nanosecond timestamp, SHA-256, and
Unix device/inode from a no-follow file handle. A supported Bun shebang adds
the same evidence for the resolved interpreter. Model lookup, plan preparation,
execution revalidation, and the PTY boundary compare the complete chain instead
of trusting millisecond mtime or `PATH` alone. On Linux, bounded subprocesses
execute the Bun/OMP descriptors through `/proc/self/fd` after clearing
close-on-exec in the child. Because `portable-pty` closes inherited descriptors,
PTY launch instead uses the manager's `/proc/<manager-pid>/fd` references and
retains both open files for the run lifetime. These forms pin verified inodes
through `exec`; cwd and resume handoff remain path-based.

Reader threads split output into 8 KiB frames, retain at most 2 MiB and 4,096
frames per run, assign monotonic sequence numbers, and feed a 64-frame
nonblocking Tauri event queue. Event overflow is deliberately dropped because
the bounded replay IPC is authoritative; the WebView drains an initial replay
high-water mark, fills sequence gaps by polling, and reports an evicted prefix.
Large paste input is split into ordered 64 KiB calls; resize dimensions are
bounded and acknowledged before the frontend suppresses duplicate updates.
Each run owns a bounded 16-message input queue and writer thread, so a child
that stops reading cannot block a synchronous Tauri command. Ctrl+C enters the
same queue. Forced Unix termination targets only a PTY process-group leader
that equals the spawned child identity, with the portable child killer as the
platform fallback. After the main child exits, the runtime closes control/input
handles, waits for reader EOF, then terminates remaining Unix group members
with a bounded TERM/KILL sequence. A run is not closeable or prunable until
reader EOF. Exit code/signal and terminal state remain
queryable together with the immutable Profile/model launch context. The
frontend renders raw bytes with xterm.js and never treats them as HTML.

Completed tabs close through a backend command that removes the Rust run
record and replay buffer; a running child cannot be dismissed without first
being interrupted or force-terminated.

Run creation emits a global status event only after the backend registry entry
exists. A new WebView subscribes before listing runs and performs a bounded
startup reconciliation window, so a launch already revalidating during reload
can be reattached without a second process start.

## Persistence status

The SQLite migration runtime, startup connection ownership, consistent backup,
rollback, foreign-key enforcement, and initial M1 foundation tables are now
connected. Initialization failure now produces a revisioned recovery snapshot
instead of terminating the desktop; the UI shows display-safe
database/completed-backup paths supplied directly by the failed migration,
bounded diagnostics, and a retry action while leaving manager metadata writes
unavailable. A metadata fingerprint suppresses repeated backups for an
unchanged deterministic migration failure while still allowing retry after the
database or sidecars change. The schema contains metadata columns only and
never opens OMP-owned `agent.db`. The project repository and initial native
authorization grant are connected. Linux Profile session-root authorization,
handle-anchored read-only scanning, metadata-only session indexing, cache
freshness, root identity revalidation, on-demand transcript preview, model
listing, one-time LaunchPlan execution, and the managed PTY are connected.
Configuration mutation and durable capability caching remain subsequent
slices.
`operation_history` is connected for OMP probe
lifecycle/summary persistence and stale-row reconciliation; additional task
types will reuse the same repository contract. Session content indexing remains
off and has no storage path in this database.

## Configuration writes

Configuration mutation is not exposed in the current M1 slice. The future
write service will:

1. authorize and re-resolve the target path;
2. parse against the observed OMP schema;
3. present a redacted diff;
4. create a timestamped backup;
5. write a same-directory, user-only temporary file and flush it;
6. atomically replace the target and verify the result.

Per-launch overlays live in the application-private temporary directory,
never contain credentials, and are passed with `--config` as an argument.

## Milestone boundary

M0 proved architecture and compatibility. The M1 vertical path is now
connected on the verified Linux target: persistence, background probe, native
project registration, Profile session-root authorization, indexing/list/
preview, model selection, new/resume settings, one-time LaunchPlan preview,
managed PTY, detached external-terminal launch, and the fixed Cursor action.
Remaining M1 hardening includes
Windows handle/ACL evidence, application-exit policy for active runs, and
additional background-operation progress/cancellation. M2 adds credential
management, import, trash, installation/update, system
folder integration, and release UX.
