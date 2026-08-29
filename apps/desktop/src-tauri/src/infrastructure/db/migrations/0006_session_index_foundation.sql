CREATE TABLE profile_session_roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    profile TEXT NOT NULL CHECK (length(profile) BETWEEN 1 AND 64),
    authorized_root_id INTEGER NOT NULL UNIQUE
        REFERENCES authorized_roots(id) ON DELETE RESTRICT,
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0),
    last_scanned_at_epoch_ms INTEGER CHECK (last_scanned_at_epoch_ms >= 0),
    UNIQUE (target_id, profile)
);

CREATE TRIGGER profile_session_roots_scope_insert
BEFORE INSERT ON profile_session_roots
WHEN NOT EXISTS (
    SELECT 1
    FROM authorized_roots
    WHERE id = NEW.authorized_root_id
      AND target_id = NEW.target_id
      AND kind = 'profile'
)
BEGIN
    SELECT RAISE(ABORT, 'profile session root scope mismatch');
END;

CREATE TRIGGER profile_session_roots_scope_update
BEFORE UPDATE OF target_id, authorized_root_id ON profile_session_roots
WHEN NOT EXISTS (
    SELECT 1
    FROM authorized_roots
    WHERE id = NEW.authorized_root_id
      AND target_id = NEW.target_id
      AND kind = 'profile'
)
BEGIN
    SELECT RAISE(ABORT, 'profile session root scope mismatch');
END;

ALTER TABLE session_index
ADD COLUMN read_status TEXT NOT NULL DEFAULT 'partial' CHECK (
    read_status IN ('readable', 'partial', 'unreadable')
);

ALTER TABLE session_index
ADD COLUMN freshness TEXT NOT NULL DEFAULT 'stale' CHECK (
    freshness IN ('fresh', 'stale', 'missing', 'failed')
);

ALTER TABLE session_index
ADD COLUMN source_identity_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE session_index
ADD COLUMN scan_offset INTEGER NOT NULL DEFAULT 0 CHECK (scan_offset >= 0);

ALTER TABLE session_index
ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0 CHECK (parser_version >= 0);

ALTER TABLE session_index
ADD COLUMN last_scanned_at_epoch_ms INTEGER NOT NULL DEFAULT 0 CHECK (
    last_scanned_at_epoch_ms >= 0
);

ALTER TABLE session_index
ADD COLUMN warning_codes_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX profile_session_roots_profile_idx
    ON profile_session_roots(target_id, profile);
CREATE INDEX session_index_profile_freshness_idx
    ON session_index(target_id, profile, freshness, modified_at_epoch_ms DESC);
