CREATE TABLE capability_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    installation_id INTEGER NOT NULL REFERENCES omp_installations(id) ON DELETE CASCADE,
    capability TEXT NOT NULL,
    evidence_level TEXT NOT NULL CHECK (
        evidence_level IN (
            'observed_safe',
            'observed_active',
            'documented',
            'unsupported_or_failed'
        )
    ),
    probe_method TEXT NOT NULL,
    probe_arguments_json TEXT NOT NULL DEFAULT '[]',
    binary_identity_json TEXT NOT NULL,
    exit_code INTEGER,
    response_shape TEXT,
    network_access INTEGER NOT NULL DEFAULT 0 CHECK (network_access IN (0, 1)),
    user_data_write INTEGER NOT NULL DEFAULT 0 CHECK (user_data_write IN (0, 1)),
    adapter_version TEXT NOT NULL,
    observed_at_epoch_ms INTEGER NOT NULL CHECK (observed_at_epoch_ms >= 0)
);

CREATE TABLE authorized_roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (
        kind IN ('project', 'profile', 'import_source', 'export_destination')
    ),
    canonical_path TEXT NOT NULL,
    canonical_key TEXT NOT NULL,
    display_path TEXT NOT NULL,
    stable_identity_json TEXT NOT NULL DEFAULT '{}',
    grant_metadata_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'offline', 'replaced', 'revoked')
    ),
    granted_at_epoch_ms INTEGER NOT NULL CHECK (granted_at_epoch_ms >= 0),
    last_verified_at_epoch_ms INTEGER CHECK (last_verified_at_epoch_ms >= 0),
    UNIQUE (target_id, kind, canonical_key)
);

CREATE TABLE operation_history (
    operation_id TEXT PRIMARY KEY,
    target_id TEXT REFERENCES execution_targets(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_reference TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN (
            'queued',
            'running',
            'cancelling',
            'cancelled',
            'succeeded',
            'failed',
            'timed_out',
            'needs_reconciliation'
        )
    ),
    cancellable INTEGER NOT NULL DEFAULT 0 CHECK (cancellable IN (0, 1)),
    cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (
        cancellation_requested IN (0, 1)
    ),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    started_at_epoch_ms INTEGER NOT NULL CHECK (started_at_epoch_ms >= 0),
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0),
    finished_at_epoch_ms INTEGER CHECK (finished_at_epoch_ms >= 0),
    redacted_result_json TEXT
);

CREATE INDEX capability_evidence_lookup_idx
    ON capability_evidence(installation_id, capability, observed_at_epoch_ms DESC);
CREATE INDEX authorized_roots_target_idx
    ON authorized_roots(target_id, kind, canonical_key);
CREATE INDEX operation_history_scope_idx
    ON operation_history(target_id, scope_kind, scope_reference, updated_at_epoch_ms DESC);

INSERT INTO execution_targets (
    id,
    kind,
    label,
    capabilities_json,
    created_at_epoch_ms
)
VALUES (
    'local',
    'local',
    'Local',
    '{}',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT(id) DO NOTHING;
