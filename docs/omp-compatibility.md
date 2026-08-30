# OMP compatibility matrix

## Verification record

| Item | Observation |
|---|---|
| Verification date | 2026-08-28 UTC |
| Host used for M0 | Linux x86_64 |
| Installed package | `@oh-my-pi/pi-coding-agent` 18.0.3 |
| Executable selected | `$HOME/.local/bin/omp` |
| `omp --version` | `omp/18.0.3`, exit 0 |
| Resolved CLI SHA-256 | `cad1b1b9389ce6844e8bbf7686e279321b2ebc254a1126817f6dede42ce62445` |
| Resolved CLI mtime | 2026-08-25 04:38:39 UTC |
| OMP main-branch docs checked | 2026-08-28 |

The installed npm package includes its target-version TypeScript source. M0
checked both that source and current official documentation rather than
inferring behavior from the version string.

There was already upstream drift on the verification date: the official
`main` package declared 18.0.9 while the latest published GitHub release was
v18.0.8 and the installed target was 18.0.3. Current documentation is useful
for design, but target behavior is accepted only when the tagged/installed
source or a safe runtime probe agrees.

No command was allowed to read real sessions or credentials. Commands that can
log in, log out, mutate configuration, import, update, contact a model, fetch
live account usage, check a configured gateway, or launch/resume a session were
not executed. Machine-readable commands were exercised only with a synthetic
`PI_CODING_AGENT_DIR`; committed fixtures replace all identities and paths.

## CLI and JSON observations

| Capability | 18.0.3 evidence | Exit/result | Manager behavior |
|---|---|---|---|
| Installation/version | `omp --version` | 0, `omp/18.0.3` | Available |
| Common launch flags | `omp --help` | 0 | Parse fixed help tokens; never launch during probe |
| Explicit Profile | root help and parser contain `--profile <name>` | help exit 0 | Available; every launch must pass it explicitly |
| Explicit cwd | root help contains `--cwd <dir>` | help exit 0 | Available as an argument, never shell text |
| Model role overrides | root help/source docs contain `--model`, `--smol`, `--slow`, `--plan` | help exit 0 | Probe each fixed flag independently; only exact `provider/modelId` values are emitted |
| Thinking override | root help/source docs contain `--thinking` | help exit 0 | Probe independently and accept only the closed supported-level set |
| Resume | root help contains `--resume [id/path]` | help exit 0 | Available; OMP owns reconstruction |
| Fork | target parser/docs contain `--fork <session>`; 18.0.3 root help omits it | not executed | Do not infer solely from root help; runtime remains unverified/disabled until a side-effect-free probe is available |
| HTML export | root help contains `--export <session>` | help exit 0 | Available by capability |
| Claude/Codex import | root help contains `--from-claude`, `--from-codex` | help exit 0 | Available by capability; interactive flow only |
| Config path | `config path` with synthetic Agent dir | 0, synthetic path | Available |
| Effective config JSON | `config list --json` with synthetic Agent dir | 0, object keyed by schema path | Available with strict DTO projection |
| Model JSON | `models --json --no-extensions` with synthetic Agent dir | 0, `{ "models": [] }` | Available; empty is valid, do not refresh in probe |
| Usage JSON | `usage --help` advertises `--json` and `--redact` | help exit 0 | Supported but live usage is user-triggered only |
| Broker status JSON | `auth-broker status --json` without configuration | 0, `{ok:false,reason:"not_configured"}` | Safe status capability |
| Broker provider list | `auth-broker list --json` | 0, provider catalog | This is not a stored-credential list |
| Gateway check | help advertises `check --json` and `--strict` | help exit 0 | Non-strict and strict are separate capabilities |
| Update | `update --help` advertises `--check` | help exit 0 | Network check/install never runs at startup |

### Configuration JSON

`omp config list --json` returns an object keyed by schema path. Each entry has
`type`, `description`, and usually `value`. For schema-declared credential
fields, a configured value is omitted and `redacted: true` is returned. In
contrast, `omp config get <credential-key> --json` is an explicit reveal path
and can return the full value. OMP Manager therefore allow-lists `list` and
forbids generic/config-`get` probing.

The command initializes OMP Settings and malformed persistent configuration
can be moved to a `.broken-*` file by OMP. Automatic startup probing therefore
does not run it against a real profile in M0. Later explicit config reads must
preview this behavior and use a tested target-version adapter.

OMP's own `secrets.enabled` setting is false by default and its obfuscation
feature is aimed at provider-visible text, not at-rest protection or a Manager
security boundary. Manager redaction is always applied independently.

### Models JSON

18.0.3 emits:

```text
models[]: provider, id, selector, name, contextWindow, maxTokens,
          reasoning, thinking[], input[], cost
```

`selector` is the required unique `provider/modelId`. The command returns
models considered available by OMP, not necessarily the entire bundled
catalog. Default execution can discover extensions and resolve configured
secrets. The manager therefore runs `--no-extensions` with a random temporary
HOME, cwd, cache, and agent directory and no provider credentials. This safely
lists the built-in inventory but intentionally omits Profile/project custom
models. `models refresh` can contact remote catalogs and write caches, so it is
an explicit user action.

Custom model configuration is not inert data: OMP supports `!command` secret
resolution for selected `models.yml` fields. The Manager's YAML preview and
validation path must never execute these commands, templates, extensions, or
hooks.

### Sessions

Target-version source and official session documentation agree on a v3 JSONL
model. Current physical files can start with a fixed-width 256-byte title slot;
the logical first record is a `type: "session"` header, followed by append-only
entries. Known entries include `model_change`, `thinking_level_change`, and
`credential_pin`, but unknown/malformed lines must remain non-fatal and the
manager never writes a parsed file back.

The M1 parser now contract-tests the 18.0.3 synthetic partial fixture and
target-version branch rules: an exact 256-byte `type:"title"` slot precedes the
logical header; the last physical valid entry is the active leaf; `id` /
`parentId` ancestry selects the live branch; role-specific `model_change`,
`thinking_level_change`, current transcript entries, and per-provider
`credential_pin` records are projected with bounded text. Pin hashes are
validated then discarded.

The Linux M1 backend can now read real files only after the user explicitly
selects a Profile session root in the Rust native picker. It supports JSONL
files directly in that root and in one ordinary child-directory level, matching
the observed encoded-project layout without assuming that every directory name
can be decoded. Parsed `cwd`, not the storage-directory spelling, assigns a
session to the longest matching registered project root. Automatic Profile
root discovery and Windows file-handle support remain unavailable. The project
UI now exposes this cached structural index with metadata search and progressive
50-row rendering plus an on-demand memory-only transcript preview. New and
resume actions are connected on the verified Linux target. Resume passes the
authorized absolute JSONL path to OMP's `--resume` argument; OMP, rather than
the manager, reconstructs the conversation and its stored credential pin.
Fork and export are not yet connected.

Opening launch settings runs the bounded
`omp --profile <name> models --json --no-extensions` adapter only inside that
isolated temporary environment, never in the selected project. The UI marks
the inventory incomplete. Failure or an empty result leaves “use OMP default”
available and does not invent model rows. Preparing and executing a launch then
revalidates digest-backed binary identity, project binding/identity, and
session identity. The committed `launch_flow_stub` test exercises this path
without contacting a provider, reading a real Profile, or inheriting unrelated
provider keys.

A session's artifact directory is the sibling path formed by removing the
`.jsonl` suffix. Nested agent sessions may live inside it. Global content-
addressed blobs are separate and can be shared; they must not be moved as if
owned by one session. OMP's file storage deletes the JSONL before recursively
removing the artifact directory, which can partially fail. Manager trash must
instead stage and record both paths as a recoverable transaction.

OMP HTML exports and request-dump sidecars can include session content, system
prompts, tools, and nested agent transcripts. They are user-selected sensitive
exports, never diagnostic attachments or passive probe artifacts.

## Credential capability conclusion

### Local/native mode

18.0.3 has no public structured CLI that safely lists every individual local
credential reference with full CRUD capability:

- `auth-broker list --json` lists supported OAuth providers, not stored rows;
- `auth-broker login` is an OMP-owned interactive flow;
- CLI `auth-broker logout <provider>` removes all stored credentials for that
  provider, not one selected row;
- OMP's interactive `/logout` can select an individual account through its
  official `AuthStorage`, so it is the safe native fallback;
- `usage --json --redact` can summarize accounts but may contact providers and
  refresh OAuth state, so it is not a passive startup inventory.

Consequently `NativeInteractiveCredentialBackend` advertises login/logout
through OMP interaction but not structured list, exact disable, or exact delete
until a public API is observed. The manager does not open `agent.db` directly.

### Broker mode

The documented Broker HTTP API has structured snapshot, upsert, refresh,
disable, disabled-list, usage, and health operations with exact credential
IDs. There is no observed exact re-enable or permanent credential-delete
endpoint in 18.0.3; HTTP `DELETE` operations documented for blocks remove
rate-limit blocks, not credentials.

The Broker snapshot must be treated as secret-bearing: although OAuth refresh
tokens are projected to a sentinel, 18.0.3 responses can still contain OAuth
access tokens and API keys. A Rust Broker backend must immediately map the raw
body to secret-free credential DTOs and must never log, persist, or pass the
raw snapshot across IPC.

### Credential health checks

`auth-gateway check` uses provider usage/auth probes. Even non-strict mode can
contact providers and refresh/persist OAuth state, so it runs only on user
request with timeout, cancellation, provider-level serialization, and bounded
total concurrency. `--strict` additionally sends a real chat completion and
consumes quota; it always requires a separate per-run confirmation.

### Exact credential pin

18.0.3 records `credential_pin` entries in sessions as a provider plus SHA-256
of the account/scope tuple and re-seeds OMP's own sticky routing on resume. It
also has an in-session `/session pin` interaction. No stable public launch flag
or credential-ID parameter selects a chosen credential.

Therefore:

```text
can_pin = false
```

OMP Manager may fix a Profile or leave selection automatic. Resuming a saved
session lets OMP honor its own stored pin. The GUI must not promise an exact
account launch or silently substitute another account.

## Profiles and folder binding

18.0.3 supports explicit `--profile` and the `OMP_PROFILE`/`PI_PROFILE`
environment choices, but exposes no `profile list` command and no stable
folder-binding command. Official issue #9655 remained open when checked. The
manager therefore stores path bindings in its own application data and passes
`--profile` explicitly. Inherited `OMP_PROFILE`/`PI_PROFILE` are removed from
the launch environment, while `PI_CODING_AGENT_DIR` remains allow-listed so a
custom OMP storage root is still respected. It never writes an
account-selecting file into a repository.

Observed profile layout is default `~/.omp/agent` and named
`~/.omp/profiles/<name>/agent`. Profile names are limited to 1–64 lower-case
ASCII letters/digits plus `._-`, must begin alphanumeric, and reject `.`, `..`,
trailing dots, and Windows reserved names. The Rust adapter must still obtain
and validate these facts per target rather than trusting a frontend regex.

Profile discovery remains a limited capability in M0. A later adapter may
enumerate authorized OMP profile roots and validate candidates without reading
credential contents, but the UI must not invent a complete list.

## Installation and upgrade

Current official installation forms include the fixed `https://omp.sh/install`
script for macOS/Linux, `https://omp.sh/install.ps1` for Windows PowerShell,
Bun global installation, Homebrew, Nix, and mise. `omp update --check` is the
non-installing update check advertised by 18.0.3.

M0 does not execute installation or update. M2 must fetch the current official
recipe at action time, show origin/command/target, obtain explicit consent,
use a fixed template with no project or credential interpolation, redact logs,
support cancellation, and preserve the existing executable on failure.

## Supported baseline and degradation

18.0.3 is the only runtime version actually verified in M0. It is the initial
compatibility fixture, not a hard-coded version gate. Every feature is enabled
from observed capability flags tied to executable path, version, hash/mtime,
and probe time; binary identity changes invalidate the cache.

Unknown/older versions may still show installation/version and any safely
observed capabilities. Missing JSON, Broker, Gateway, fork, exact pin, profile
discovery, or PTY evidence disables only that operation with an explicit
diagnostic. No text parser or direct database mutation is used to make the UI
appear complete.

## Platform verification status

- Linux x86_64: OMP 18.0.3 CLI probes performed; native PTY test runs on the
  current host as part of Rust tests.
- Windows x64: the code selects `portable-pty`'s native ConPTY backend and has
  platform-specific fixed child arguments, but runtime verification requires a
  Windows CI/host and is not claimed by this Linux M0 run.

## Fixture provenance

`tests/fixtures/omp/18.0.3` contains compact synthetic observations and parser
shapes. It contains no real credential, email, Broker URL, session, project, or
home path. The session fixture is intentionally truncated to exercise
fail-soft consumers in the future.
