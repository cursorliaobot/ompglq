# OMP Manager threat model

## Assets and trust boundaries

Protected assets include OMP credentials, Broker bearer tokens, session
content, project paths, configuration, launch intent, and recoverability of
user data. The principal trust boundaries are:

1. untrusted project/session/import content entering the Rust backend;
2. Rust domain DTOs crossing into the WebView;
3. child processes and PTYs started by the application;
4. OMP-owned storage versus manager-owned metadata;
5. optional loopback Broker/Gateway services;
6. downloaded dependencies and future installer/update artifacts.

The local OS account is trusted to access its own files. Another process under
that account, a malicious repository, a malicious session transcript, and a
poisoned import file are not trusted. The application does not defend against
a fully compromised kernel or administrator account.

## Security invariants

- Secrets never cross to the WebView and are never persisted by manager
  SQLite, logs, URLs, notifications, clipboard, diagnostics, or crash output.
- The WebView has no arbitrary process, filesystem, network, or URL capability.
- A user-controlled path is data in an argument array, never shell syntax.
- OMP-owned session JSONL is read-only; OMP-owned `agent.db` is never directly
  mutated.
- Destructive, overwriting, billing, login, installation, and update actions
  require a target-specific preview and confirmation.
- Missing capability fails closed and is visible to the user.

## Threats and controls

### Malicious project paths and command injection

**Threat:** a path containing spaces, Chinese characters, quotes, `&`, `;`, a
newline, or `$()` escapes a command and runs attacker-selected code.

**Controls:** Rust spawns an already verified executable with an argument
array; no `sh -c`, `cmd /c`, or PowerShell command string accepts project data.
Paths are canonicalized at authorization and checked again immediately before
use. Tests include platform-valid adversarial names and assert argument
boundaries.

### Path traversal, symlink escape, and TOCTOU

**Threat:** `..`, a junction, symlink replacement, or a race redirects an
authorized operation outside project, Agent, import, export, or application
private roots.

**Controls:** authorization is target-scoped; normalize lexical components,
resolve existing ancestors, reject escaping symlinks, avoid following import
symlinks, and re-open/revalidate at the operation boundary. Writes use a
same-directory temporary file and atomic replace. Irreducible races fail
without a write.

### Project authorization forgery and binding races

**Threat:** a compromised WebView invokes project registration with a guessed
home/configuration path, a duplicate add silently changes the Profile used by a
project, Git worktree identity spreads access to another directory, or two
binding editors overwrite one another.

**Controls:** `add_project` has no path or target field. Its Rust command opens
the native folder picker itself, converts only its selected local directory,
and then calls `LocalTarget`; the WebView capability does not grant the dialog
plugin's direct commands or a generic filesystem API. The target requires an
absolute existing directory, rejects non-Unicode identity keys, canonicalizes
the path, and captures versioned stable identity. On Unix the grant records
device/inode. The non-Unix fallback is deliberately not accepted as proof for
future sensitive operations; Windows requires handle-derived volume/file
identity and host tests before scan/launch/write/editor actions are enabled.

Project, project-kind root, and exact direct binding are written under one
immediate transaction with schema guards. Duplicate selection may refresh the
explicit root grant but never overwrites the existing binding; a separate
binding update requires the caller's observed revision and rejects stale
writes. Responses join the authorization root separately and never infer an
active grant from a project row. Longest-prefix setting selection uses native
path components and is not an authorization decision. Git identity is optional,
bounded, parsed without a shell, and never creates or shares an authorized
root. Malformed Git metadata is a visible partial-success diagnostic.

This slice still exposes no session read, OMP launch, delete, or configuration
write. The fixed Cursor action is the first project-backed process boundary and
applies the re-canonicalization/identity controls below; other operations remain
disabled until they implement equivalent operation-boundary checks.

### Cursor launcher confusion and project handoff races

**Threat:** a renderer supplies an executable/path/argument, an `agent` CLI or
malicious PATH program is mistaken for the desktop editor, help output hangs or
exhausts memory, a project/launcher is replaced between validation and spawn,
concurrent IPC opens duplicate windows, or provider secrets leak into Cursor's
environment.

**Controls:** IPC accepts only a positive `project_id` and typed fixed
`editor_id=cursor`. Rust reloads the project/root, rejects missing/revoked
authorization, and on Unix compares canonical path plus stored/current
device/inode before detection and again at launch. The adapter rejects symlink
paths, verifies directory and launcher file handles against path identity, and
holds both handles through direct argument-array spawn. A per-project backend
single-flight rejects overlapping opens. Adapter boundary failures persist
`offline`/`replaced`; frontend reads are forcibly refreshed, and only
offline/replaced roots offer identity revalidation.

Cursor candidates are bounded and their exact `--help` usage must name
`cursor` or `cursor.exe`, advertise desktop path/window flags, exit
successfully, remain under byte limits, and complete child/output-pipe handling
within a total timeout. Unix detection uses a dedicated process group so
inherited pipes and descendants can be terminated. If descendants survive the
direct help process, the evidence is rejected after cleanup rather than
accepting a potentially truncated prefix. Agent CLI shapes, truncation,
ambiguity, and changed launcher identity fail closed. Launch uses a verified
window flag and canonical project as separate argv entries, null stdio, and an
explicit environment allowlist that excludes OMP/model/Broker secrets and
loader injection variables.

Cursor's public CLI consumes a path, not a directory handle. Holding and
rechecking the handle closes practical pre-spawn races but cannot control what
another same-account process changes after spawn; no stronger guarantee is
claimed without a Cursor-supported handle protocol. Windows remains disabled
until stable handle-derived directory identity and ACL behavior are verified.
The OS file-manager helper/right-click boundary remains unimplemented M2 work.

### Malicious session content and XSS

**Threat:** a JSONL message/title contains HTML, SVG, script, terminal escape,
or oversized content that executes in or stalls the WebView.

**Controls:** no session IPC accepts a filesystem path. Rust freezes the
project/Profile/binding revision and owns the native directory picker under a
Profile-wide single-flight guard. Linux opens the selected root before deriving
its canonical name and device/inode, then anchors bounded one-level listing and
relative file opens to directory handles. Every component uses no-follow
`openat`; final opens are nonblocking, ordinary-file checked, and reopened by
name after reading. Root identity is checked before listing and before commit.
Equal or overlapping roots across Profiles are rejected. Other platforms fail
closed pending equivalent handle evidence.

The parser accepts only a caller-bounded byte buffer, counts every physical
line before decoding, enforces file/line/record and independent text budgets,
and consumes only newline-terminated records. It detects title-slot drift,
malformed records, duplicate IDs, missing parents, cycles and future versions
without writing back. OMP's final-leaf parent chain is reconstructed before
projection, so abandoned branches cannot inject model, pin, title or preview
state. Preview keeps a bounded latest-message window and neutralizes display
controls. Raw `cwd` stays in Rust for canonical longest-project-root ownership
matching.

Credential pin hashes are shape-validated but deliberately discarded; only
provider labels survive. Model selectors and legacy assistant fallback require
valid `provider/modelId` structure. Image-only payload data and unknown record
bodies are never copied into preview DTOs. SQLite receives only validated,
bounded structural metadata and `fresh/stale/missing/failed` state under
`target + profile + canonical path`; first-message summaries, transcript
bodies, source bytes, and hashes have no persistence path. One malformed file
becomes a bounded diagnostic and cannot prevent other files from indexing.
The React list independently validates row scope, identifiers, enums, array
counts, timestamps, and text limits, renders values as text, searches only
structural metadata, and mounts rows in bounded increments. Transcript preview
is an explicit on-demand read with a bounded latest-message window; it remains
memory-only and text-only with no raw HTML injection. HTML export remains an
explicit OMP operation, and terminal bytes go to xterm.js rather than an HTML
parser.

### LaunchPlan replay, scope races, and process injection

**Threat:** a compromised or stale WebView changes a project binding, swaps an
OMP binary/session file after preview, replays an execute request, supplies a
model as shell syntax, or smuggles arbitrary environment variables into OMP.

**Controls:** launch IPC accepts project/session database IDs, expected binding
revision, closed action/model-role names, exact `provider/modelId` selectors,
and a fixed thinking-level enum. Rust also rejects an explicit thinking level
that the selected primary model does not advertise. Rust resolves all paths.
Model inventory comes from the fixed
`omp --profile <name> models --json --no-extensions` argv shape
with bounded stdout, timeout, strict DTO projection, and no extension
discovery. It runs under a random manager-owned HOME/cwd/agent directory with
no Profile, project, provider-key, or behavioral `PI_*` environment, so
`!command` secret resolution from real configuration cannot run. Custom model
inventory is therefore deliberately incomplete. Launch argv is built in Rust
and never passed through a shell.

The prepared plan remains in a bounded Rust registry. Its public UUID is
single-use and expires after two minutes; a per-runtime salted SHA-256 input
fingerprint reveals no raw path. Before PTY or external-terminal spawn, Rust rechecks binding
revision, canonical project identity, OMP entrypoint and Bun interpreter
path/device/inode/size/nanosecond-mtime/SHA-256,
and, for resume, session path/identity/ID/size/mtime through the authorized
session-root reader. Any mismatch consumes the plan and requires a new
preview. Environment values never enter the DTO or plan preview; only allowed
names, source, and presence cross IPC. At execution, names are re-read and
compared with the runtime-salted presence/value fingerprints captured by Rust
during preparation. A mismatch consumes the plan. Automatic policy forwards
credential variables only for explicitly selected providers; Profile policy
forwards no parent provider credential. Profile selection and behavioral
`PI_*` variables are omitted because argv is authoritative.

The same checks run before an external-terminal spawn. Terminal selection is a
closed adapter list with per-terminal argv layouts; no project/Profile/model
value enters `sh -c`, `$TERMINAL`, `cmd /c`, or a PowerShell command string.
Linux desktop-session variables required to reach the display are explicit
members of the plan environment summary. External results are tagged separately
from PTY runs and are described as detached, so the manager does not claim
streaming, reattachment, or termination authority it does not have.

Project binding updates share a project-scoped lease with launch resolution,
and session preview/identity reads retain a Profile-scoped lease through PTY
spawn. These leases prevent manager-owned binding/scanning races; external
same-account path replacement remains subject to the handle limitation below.

On Linux, probe/model commands execute the verified OMP entrypoint and, for the
official shebang, its resolved Bun interpreter through inherited
`/proc/self/fd` descriptors. PTY launch retains both handles while using the
manager's `/proc/<pid>/fd` references, pinning their identities through `exec`
instead of resolving `bun` again from `PATH`. `portable-pty` cwd and OMP's
public `--resume <path>` interface remain path-based. Final identity checks and
manager-scoped leases narrow those races but cannot prevent a same-account
process from replacing cwd/session paths after the check and before OMP resolves
them. No stronger guarantee is claimed until handle-derived cwd and an OMP
resume-handle protocol are available.

For Linux external terminals, `LocalTarget` passes manager-owned
`/proc/<pid>/fd` references and retains the verified OMP/Bun handles in a
bounded registry for 30 seconds. This covers terminal clients that hand launch
requests to a desktop process asynchronously without retaining handles
indefinitely. A manager crash or a terminal delaying command resolution beyond
that lease can still make the detached launch fail; it cannot silently fall
back to resolving a different OMP binary.

### Terminal output, input, and process lifetime

**Threat:** terminal output exhausts memory or injects DOM, a renderer sends
unbounded input/resize calls, stale events attach to another run, or force-stop
kills an unrelated process.

**Controls:** Rust assigns UUID run IDs and monotonic output sequence numbers,
frames reads at 8 KiB, retains at most 2 MiB and 4,096 frames per run, caps the
registry, and reports replay gaps. A nonblocking 64-frame bridge bounds Tauri
event pressure; dropped notifications remain recoverable from replay. IPC input
is limited to 64 KiB per call and enters a bounded 16-message queue serviced by
a dedicated writer thread, so PTY backpressure cannot block the Tauri command
dispatcher. Large paste input is split into ordered chunks, and resize
dimensions are bounded. The frontend verifies every event/run UUID,
byte, sequence, timestamp/state invariant, and immutable launch context before
writing bytes to xterm.js; terminal data is never parsed as HTML. Out-of-order
live frames wait in a bounded pending map until replay fills their sequence gap.

Graceful stop writes Ctrl+C. On Unix, force-stop addresses a negative process
group only when the PTY-reported group leader equals the just-spawned child
PID; otherwise it uses the portable child killer. Run state, exit code, and
signal remain queryable after WebView reload. The UI exposes force-stop only
after an interrupt attempt and a separate destructive confirmation. Closing a
completed tab removes its backend run record and bounded replay; running tabs
cannot be dismissed. A user-selectable application exit policy and verified
Windows process-tree cleanup remain required hardening; the UI does not claim
those are complete.

Main-child exit is distinct from PTY reader EOF. The runtime drops input/control
handles, waits briefly for EOF, and sends TERM then KILL to remaining Unix
process-group members. Entries cannot be closed or pruned before reader EOF, so
a detached descendant cannot be silently hidden or grow the registry beyond
its fixed cap. Bounded probe/model subprocesses likewise use isolated Unix
process groups and a two-second post-exit pipe-drain deadline.

The backend emits run creation only after registry insertion. The WebView
subscribes before its authoritative list read and briefly reconciles the list
after startup, closing the race where a launch completes while the renderer is
being reloaded.

### Log and diagnostic secret leakage

**Threat:** stdout/stderr, URLs, nested JSON/YAML, panic messages, or HTTP
headers carry API keys, OAuth tokens, cookies, emails, or Broker tokens into
durable logs and support bundles.

**Controls:** a centralized Rust redactor recognizes Bearer/basic headers,
cookies, query parameters, common credential shapes, and sensitive field
names. Child output is bounded and redacted before errors/DTOs/logs. Diagnostic
export excludes session bodies and environments, then runs a second secret
scan. Tests use synthetic sentinel secrets and assert absence from outputs.

### Poisoned import sources

**Threat:** malformed or deeply nested JSON/YAML, huge files/directories,
symlink farms, ambiguous field names, or executable templates exhaust
resources or cause the wrong credential to be overwritten.

**Controls:** import is read-only and non-recursive by default, with explicit
file count/byte/depth limits and no symlink following, script execution,
template expansion, or hooks. Format recognition is versioned and exact;
ambiguity fails closed. Import always creates an in-memory redacted preview,
requires target/conflict confirmation, and backs up the target before a
transactional change.

OMP configuration itself can contain executable secret resolvers such as
`!command`. Manager preview/schema validation treats those nodes as inert text
and never evaluates them; only an explicitly confirmed OMP launch may let OMP
interpret its own trusted configuration.

### Configuration races and corruption

**Threat:** concurrent OMP/editor writes are lost, invalid YAML is installed,
or an array merge silently changes security/provider policy.

**Controls:** read effective OMP schema, validate a proposed document, show
replacement semantics and a redacted diff, re-check the original fingerprint,
create a timestamped backup, write and flush a same-directory temporary file,
atomically rename, and verify. A conflict cancels rather than overwrites.

### Secondary-instance payload injection

**Threat:** a second process supplies shell metacharacters, a sensitive path,
an attacker-controlled working directory, or oversized/unexpected flags that
become a project authorization, command execution, log disclosure, or renderer
message. Concurrent primary instances could also race database migration and
own separate process registries.

**Controls:** the official single-instance plugin is registered before other
desktop plugins and scopes the OS primitive to the fixed application
identifier. On Windows, a separate pre-Tauri named mutex closes the plugin race
between its mutex and receiver-window creation. A secondary waits a bounded two
seconds for that receiver, sends only a minimal empty payload with a hung-window
timeout when available, and exits in every case before Tauri/plugin/database
initialization. The preflight mutex remains held until the primary `run()`
returns.

The callback maps every argument/cwd payload to a fieldless
`FocusMainWindow` action, immediately drops the payload, and only attempts
show/unminimize/focus on the fixed `main` window. It performs no logging,
parsing, filesystem access, authorization, shell invocation, event emission, or
WebView IPC. Any local process may cause a focus request, so caller identity is
not treated as an authorization boundary. The in-app fixed-ID Cursor command
is separate; secondary-instance payloads cannot invoke it or open a project.

### Manager metadata migration and rollback

**Threat:** two application instances migrate concurrently, a partial schema
is accepted after a crash, a stale or newer database is overwritten, a
malicious symlink redirects the database, or copying only the main SQLite file
loses committed WAL data.

**Controls:** the Rust backend owns the application connection and uses a
bounded busy timeout. Connection-local foreign-key enforcement, integrity,
foreign-key consistency, and an exact prefix of the append-only migration
manifest are checked before enabling persistent WAL. Unknown/newer history is
refused without switching journal mode. Migration then acquires an immediate
writer lock and rechecks the database. A separate no-follow, read-only
connection uses SQLite's Backup API to capture a consistent snapshot including
WAL state. Both source and pre-created destination use no-follow; path
identities are checked around open, after copy, and at publish. The snapshot is
flushed through the original writable handle and published via a no-clobber
hard link; Unix creates it with mode `0600`. Recursive triggers prevent SQLite
`REPLACE` from bypassing the immutable local-target guard. Child-write and
parent-update scope guards plus project/root/direct-binding identity guards and
binding revision checks commit with schema changes and history rows in one
transaction. The session identity migration rebuilds the parent and annotation
tables together, preserves IDs, and restores target-scope triggers so
`target + profile + path` replaces the earlier global-path key without
orphaning annotations. Failure rolls back and preserves the backup. The primary SQLite
open also uses no-follow and rejects path identity changes. Synchronous Tauri
setup registers only a pending runtime; file work runs on a blocking worker so
the probe UI remains responsive. Startup failures are captured without
retaining a database connection, so metadata writes remain unavailable. Fixed
status/retry IPC accepts no path or SQL, exposes in-progress state for reload
recovery, and carries a completed backup path directly from the failed
migration rather than guessing from directory contents. An app-local
file/sidecar fingerprint suppresses unchanged deterministic retries that would
otherwise create unbounded backups. The frontend bounds and neutralizes
returned text and renders it without raw HTML. Database and recovery paths are
intentionally shown only in this local recovery UI and remain sensitive
metadata for logs/diagnostic exports. A later M1 slice still must add
generalized mutation scope locks, stable Windows file-ID checks, and explicit
Windows DACL verification.

### Background operation replay, leakage, and stale state

**Threat:** renderer reloads, double clicks, or IPC retries start duplicate OMP
process trees; task results grow without bound; a user-supplied executable path
or raw probe output leaks into durable history; a crashed process leaves
`running` rows that appear live; or an unsupported cancel action claims work
was stopped.

**Controls:** Rust owns the task registry and generates canonical UUID v4
identifiers. A local-target lock coalesces every active OMP probe regardless of
automatic/explicit path spelling. The WebView stores only the UUID for reload
recovery and cannot provide status, revision, timestamps, results, executable
arguments, or history records. The registry is bounded and evicts completed
entries even when SQLite is unavailable. Probe subprocesses remain covered by
per-command limits plus a supervisor total timeout; the current capability is
truthfully non-cancellable.

Only lifecycle metadata and a generated count/status summary enter
`operation_history`; full results, stdout/stderr, diagnostics, and executable
paths stay out. History uses a generic `explicit_executable` scope label rather
than persisting the supplied path. Revision-guarded upserts prevent an older
running write from replacing a terminal write. Startup reconciliation changes
old queued/running/cancelling rows to `needs_reconciliation`. History failures
are visible partial success and do not discard the probe result. Task IDs are
lookup handles, not authorization tokens; every future target-changing task
still requires independent scope authorization and an idempotency plan.

### Temporary-file theft

**Threat:** another local process reads a launch overlay or installer artifact
before cleanup.

**Controls:** use the application-private temporary root and user-only
permissions, random filenames, no credentials in overlays, explicit handles
where supported, and cleanup on process exit plus next-start orphan cleanup.
Installer downloads are a separate confirmed flow with an origin and digest
policy.

### Broker token exposure and unsafe listeners

**Threat:** a bearer appears in CLI arguments/logs, a Broker/Gateway binds a
public interface, OAuth callbacks are forged, or a renderer can query the
service directly.

**Controls:** tokens stay in Rust memory or OMP-owned user-only files, never in
arguments or DTOs. Services default to loopback; non-loopback configuration is
not automated by the manager. Bearer/state is validated, output is redacted,
and the WebView has no generic HTTP permission. Strict credential checks are
separately confirmed because they perform provider requests.

### Credential targeting mistakes

**Threat:** an unsupported exact-account operation silently applies to every
credential for a provider or falls back to another account.

**Controls:** operations are gated by backend capability and opaque stable
references. On OMP 18.0.3, local CLI logout is provider-wide and no public
launch flag pins a chosen credential, so those granular UI capabilities remain
disabled. Profile isolation and OMP automatic selection remain available.

### Supply-chain and installer compromise

**Threat:** a malicious npm/crate update, Tauri plugin, OMP install script, or
unsigned application update executes with user access.

**Controls:** lock all dependencies, minimize dependencies and Tauri plugins,
run audit/license checks before release, pin CI toolchains, and review lockfile
changes. Future OMP installation shows the official origin, exact fixed
command, target, and impact; it requires confirmation and captures redacted
logs. App updates require signatures before public release.

### Destructive deletion and recovery failure

**Threat:** session/attachment removal is partial, targets the wrong profile,
or cannot be restored.

**Controls:** deletion is not present in the current M1 slices. M2 will fingerprint the exact
session and attachment set, move them transactionally into application trash,
record original target/profile/project, and resolve restore conflicts without
silent overwrite. Permanent empty-trash is a separate quantified confirmation.

## Verification strategy

- Rust unit tests cover redaction, output limits, argument separation,
  capability mapping, database migration/rollback, project transaction
  idempotency, component-aware binding resolution, revision conflicts, and
  failure-safe errors.
- Stub-OMP integration tests never read the developer's real OMP directory.
- PTY tests use a fixed harmless child and bounded I/O.
- Frontend tests verify state rendering, i18n keys, and escaped text.
- Release checks scan source, build output, fixtures, databases, logs, and
  diagnostics for a synthetic secret sentinel.

This document is reviewed whenever a new IPC command, Tauri permission,
credential backend, importer, executable, network listener, or destructive
operation is added.
