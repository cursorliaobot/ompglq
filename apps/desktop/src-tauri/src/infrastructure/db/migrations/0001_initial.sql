CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at_epoch_ms INTEGER NOT NULL CHECK (applied_at_epoch_ms >= 0)
);

CREATE TABLE execution_targets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'wsl', 'ssh')),
    label TEXT NOT NULL,
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0)
);

CREATE TABLE omp_installations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    executable_path TEXT NOT NULL,
    version TEXT NOT NULL,
    architecture TEXT NOT NULL,
    capability_json TEXT NOT NULL DEFAULT '{}',
    binary_modified_at_epoch_ms INTEGER,
    probed_at_epoch_ms INTEGER NOT NULL CHECK (probed_at_epoch_ms >= 0),
    UNIQUE (target_id, executable_path)
);

CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    canonical_path TEXT NOT NULL,
    canonical_key TEXT NOT NULL,
    display_path TEXT NOT NULL,
    git_common_directory TEXT,
    git_relative_path TEXT,
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    last_used_at_epoch_ms INTEGER NOT NULL CHECK (last_used_at_epoch_ms >= 0),
    UNIQUE (target_id, canonical_key)
);

CREATE TABLE project_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    path_prefix TEXT NOT NULL,
    path_prefix_key TEXT NOT NULL,
    profile TEXT NOT NULL,
    terminal_mode TEXT NOT NULL DEFAULT 'embedded' CHECK (terminal_mode IN ('embedded', 'external')),
    account_policy TEXT NOT NULL DEFAULT 'automatic' CHECK (account_policy IN ('automatic', 'profile', 'credential_pin')),
    credential_ref_id TEXT,
    allowed_models_json TEXT NOT NULL DEFAULT '[]',
    disabled_providers_json TEXT NOT NULL DEFAULT '[]',
    priority INTEGER NOT NULL DEFAULT 0,
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0),
    CHECK (account_policy = 'credential_pin' OR credential_ref_id IS NULL),
    UNIQUE (target_id, path_prefix_key)
);

CREATE TABLE project_role_defaults (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    binding_id INTEGER NOT NULL REFERENCES project_bindings(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    model_selector TEXT NOT NULL,
    credential_ref_id TEXT,
    UNIQUE (binding_id, role)
);

CREATE TABLE session_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    profile TEXT,
    session_path TEXT NOT NULL,
    session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    first_message_summary TEXT,
    created_at_epoch_ms INTEGER,
    modified_at_epoch_ms INTEGER NOT NULL CHECK (modified_at_epoch_ms >= 0),
    status TEXT NOT NULL,
    model_selector TEXT,
    provider TEXT,
    masked_credential_label TEXT,
    message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    fingerprint TEXT NOT NULL,
    UNIQUE (target_id, session_path)
);

CREATE TABLE session_annotations (
    session_index_id INTEGER PRIMARY KEY REFERENCES session_index(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    alias TEXT,
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    tags_json TEXT NOT NULL DEFAULT '[]',
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0)
);

CREATE TABLE credential_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    profile TEXT NOT NULL,
    opaque_reference TEXT NOT NULL,
    provider TEXT NOT NULL,
    masked_identity TEXT NOT NULL,
    alias TEXT,
    last_status TEXT NOT NULL DEFAULT 'unknown',
    last_checked_at_epoch_ms INTEGER,
    UNIQUE (target_id, profile, opaque_reference)
);

CREATE TABLE import_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    adapter_id TEXT NOT NULL,
    location TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    options_json_redacted TEXT NOT NULL DEFAULT '{}',
    last_sync_at_epoch_ms INTEGER,
    availability_status TEXT NOT NULL DEFAULT 'unknown',
    UNIQUE (target_id, adapter_id, location)
);

CREATE TABLE import_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES import_sources(id) ON DELETE CASCADE,
    source_fingerprint TEXT NOT NULL,
    target_opaque_reference TEXT,
    result TEXT NOT NULL,
    imported_at_epoch_ms INTEGER NOT NULL CHECK (imported_at_epoch_ms >= 0)
);

CREATE TABLE trash_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    profile TEXT,
    original_path TEXT NOT NULL,
    trash_path TEXT NOT NULL,
    attachment_original_path TEXT,
    attachment_trash_path TEXT,
    fingerprint TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    deleted_at_epoch_ms INTEGER NOT NULL CHECK (deleted_at_epoch_ms >= 0),
    UNIQUE (target_id, trash_path)
);

CREATE TABLE app_settings (
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0),
    PRIMARY KEY (target_id, key)
);

CREATE INDEX projects_last_used_idx ON projects(target_id, last_used_at_epoch_ms DESC);
CREATE INDEX project_bindings_target_idx ON project_bindings(target_id, path_prefix_key);
CREATE INDEX session_index_project_idx ON session_index(target_id, project_id, modified_at_epoch_ms DESC);
CREATE INDEX credential_aliases_profile_idx ON credential_aliases(target_id, profile, provider);
CREATE INDEX trash_items_deleted_idx ON trash_items(target_id, deleted_at_epoch_ms DESC);
