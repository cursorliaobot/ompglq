DROP TRIGGER IF EXISTS projects_target_scope_update;
DROP TRIGGER IF EXISTS session_index_target_scope_insert;
DROP TRIGGER IF EXISTS session_index_target_scope_update;
DROP TRIGGER IF EXISTS session_annotations_target_scope_insert;
DROP TRIGGER IF EXISTS session_annotations_target_scope_update;
DROP TRIGGER IF EXISTS session_index_child_scope_update;

CREATE TABLE session_index_rebuilt (
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
    read_status TEXT NOT NULL DEFAULT 'partial' CHECK (
        read_status IN ('readable', 'partial', 'unreadable')
    ),
    freshness TEXT NOT NULL DEFAULT 'stale' CHECK (
        freshness IN ('fresh', 'stale', 'missing', 'failed')
    ),
    source_identity_json TEXT NOT NULL DEFAULT '{}',
    scan_offset INTEGER NOT NULL DEFAULT 0 CHECK (scan_offset >= 0),
    parser_version INTEGER NOT NULL DEFAULT 0 CHECK (parser_version >= 0),
    last_scanned_at_epoch_ms INTEGER NOT NULL DEFAULT 0 CHECK (
        last_scanned_at_epoch_ms >= 0
    ),
    warning_codes_json TEXT NOT NULL DEFAULT '[]',
    credential_providers_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE (target_id, profile, session_path)
);

INSERT INTO session_index_rebuilt (
    id, target_id, project_id, profile, session_path, session_id, cwd, title,
    first_message_summary, created_at_epoch_ms, modified_at_epoch_ms, status,
    model_selector, provider, masked_credential_label, message_count, size_bytes,
    fingerprint, read_status, freshness, source_identity_json, scan_offset,
    parser_version, last_scanned_at_epoch_ms, warning_codes_json,
    credential_providers_json
)
SELECT
    id, target_id, project_id, profile, session_path, session_id, cwd, title,
    first_message_summary, created_at_epoch_ms, modified_at_epoch_ms, status,
    model_selector, provider, masked_credential_label, message_count, size_bytes,
    fingerprint, read_status, freshness, source_identity_json, scan_offset,
    parser_version, last_scanned_at_epoch_ms, warning_codes_json,
    credential_providers_json
FROM session_index;

CREATE TABLE session_annotations_rebuilt (
    session_index_id INTEGER PRIMARY KEY
        REFERENCES session_index_rebuilt(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    alias TEXT,
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    tags_json TEXT NOT NULL DEFAULT '[]',
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0)
);

INSERT INTO session_annotations_rebuilt (
    session_index_id, target_id, alias, favorite, tags_json, updated_at_epoch_ms
)
SELECT
    session_index_id, target_id, alias, favorite, tags_json, updated_at_epoch_ms
FROM session_annotations;

DROP TABLE session_annotations;
DROP TABLE session_index;
ALTER TABLE session_index_rebuilt RENAME TO session_index;
ALTER TABLE session_annotations_rebuilt RENAME TO session_annotations;

CREATE INDEX session_index_project_idx
    ON session_index(target_id, project_id, modified_at_epoch_ms DESC);
CREATE INDEX session_index_profile_freshness_idx
    ON session_index(target_id, profile, freshness, modified_at_epoch_ms DESC);

CREATE TRIGGER projects_target_scope_update
BEFORE UPDATE OF target_id ON projects
WHEN EXISTS (
    SELECT 1
    FROM project_bindings
    WHERE project_id = OLD.id AND target_id <> NEW.target_id
)
OR EXISTS (
    SELECT 1
    FROM session_index
    WHERE project_id = OLD.id AND target_id <> NEW.target_id
)
OR EXISTS (
    SELECT 1
    FROM trash_items
    WHERE project_id = OLD.id AND target_id <> NEW.target_id
)
BEGIN
    SELECT RAISE(ABORT, 'project target scope has dependent rows');
END;

CREATE TRIGGER session_index_target_scope_insert
BEFORE INSERT ON session_index
WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id AND target_id = NEW.target_id
    )
BEGIN
    SELECT RAISE(ABORT, 'session project target scope mismatch');
END;

CREATE TRIGGER session_index_target_scope_update
BEFORE UPDATE OF target_id, project_id ON session_index
WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id AND target_id = NEW.target_id
    )
BEGIN
    SELECT RAISE(ABORT, 'session project target scope mismatch');
END;

CREATE TRIGGER session_annotations_target_scope_insert
BEFORE INSERT ON session_annotations
WHEN NOT EXISTS (
    SELECT 1
    FROM session_index
    WHERE id = NEW.session_index_id AND target_id = NEW.target_id
)
BEGIN
    SELECT RAISE(ABORT, 'session annotation target scope mismatch');
END;

CREATE TRIGGER session_annotations_target_scope_update
BEFORE UPDATE OF target_id, session_index_id ON session_annotations
WHEN NOT EXISTS (
    SELECT 1
    FROM session_index
    WHERE id = NEW.session_index_id AND target_id = NEW.target_id
)
BEGIN
    SELECT RAISE(ABORT, 'session annotation target scope mismatch');
END;

CREATE TRIGGER session_index_child_scope_update
BEFORE UPDATE OF target_id ON session_index
WHEN EXISTS (
    SELECT 1
    FROM session_annotations
    WHERE session_index_id = OLD.id AND target_id <> NEW.target_id
)
BEGIN
    SELECT RAISE(ABORT, 'session target scope has dependent rows');
END;
