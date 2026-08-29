CREATE TEMP TABLE m5_project_integrity_guard (
    valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO m5_project_integrity_guard (valid)
VALUES (
    CASE
        WHEN EXISTS (
            SELECT 1
            FROM project_bindings AS binding
            JOIN projects AS project ON project.id = binding.project_id
            WHERE binding.project_id IS NOT NULL
              AND (
                  binding.target_id <> project.target_id
                  OR binding.path_prefix <> project.canonical_path
                  OR binding.path_prefix_key <> project.canonical_key
              )
        )
        OR EXISTS (
            SELECT project_id
            FROM project_bindings
            WHERE project_id IS NOT NULL
            GROUP BY project_id
            HAVING COUNT(*) > 1
        )
        OR EXISTS (
            SELECT 1
            FROM authorized_roots AS root
            WHERE root.kind = 'project'
              AND NOT EXISTS (
                  SELECT 1
                  FROM projects AS project
                  WHERE project.target_id = root.target_id
                    AND project.canonical_key = root.canonical_key
              )
        )
        THEN 0
        ELSE 1
    END
);

DROP TABLE m5_project_integrity_guard;

ALTER TABLE project_bindings
ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE UNIQUE INDEX project_bindings_direct_project_idx
    ON project_bindings(project_id)
    WHERE project_id IS NOT NULL;

CREATE TRIGGER authorized_project_roots_match_project_insert
BEFORE INSERT ON authorized_roots
WHEN NEW.kind = 'project'
    AND NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE target_id = NEW.target_id
          AND canonical_key = NEW.canonical_key
    )
BEGIN
    SELECT RAISE(ABORT, 'authorized project root does not match a project');
END;

CREATE TRIGGER authorized_project_roots_match_project_update
BEFORE UPDATE OF target_id, kind, canonical_key ON authorized_roots
WHEN NEW.kind = 'project'
    AND NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE target_id = NEW.target_id
          AND canonical_key = NEW.canonical_key
    )
BEGIN
    SELECT RAISE(ABORT, 'authorized project root does not match a project');
END;

CREATE TRIGGER project_bindings_match_direct_project_insert
BEFORE INSERT ON project_bindings
WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id
          AND target_id = NEW.target_id
          AND canonical_path = NEW.path_prefix
          AND canonical_key = NEW.path_prefix_key
    )
BEGIN
    SELECT RAISE(ABORT, 'direct project binding path mismatch');
END;

CREATE TRIGGER project_bindings_match_direct_project_update
BEFORE UPDATE OF target_id, project_id, path_prefix, path_prefix_key ON project_bindings
WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id
          AND target_id = NEW.target_id
          AND canonical_path = NEW.path_prefix
          AND canonical_key = NEW.path_prefix_key
    )
BEGIN
    SELECT RAISE(ABORT, 'direct project binding path mismatch');
END;

CREATE TRIGGER project_bindings_revision_update
BEFORE UPDATE OF profile, terminal_mode, account_policy, credential_ref_id,
                 allowed_models_json, disabled_providers_json, priority
ON project_bindings
WHEN NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'project binding revision must advance exactly once');
END;

CREATE TRIGGER projects_authorization_scope_update
BEFORE UPDATE OF target_id, canonical_path, canonical_key ON projects
WHEN EXISTS (
    SELECT 1
    FROM authorized_roots
    WHERE kind = 'project'
      AND target_id = OLD.target_id
      AND canonical_key = OLD.canonical_key
      AND (
          target_id <> NEW.target_id
          OR canonical_key <> NEW.canonical_key
      )
)
OR EXISTS (
    SELECT 1
    FROM project_bindings
    WHERE project_id = OLD.id
      AND (
          target_id <> NEW.target_id
          OR path_prefix <> NEW.canonical_path
          OR path_prefix_key <> NEW.canonical_key
      )
)
BEGIN
    SELECT RAISE(ABORT, 'project identity has authorized dependents');
END;

CREATE TRIGGER projects_authorization_scope_delete
BEFORE DELETE ON projects
WHEN EXISTS (
    SELECT 1
    FROM authorized_roots
    WHERE kind = 'project'
      AND target_id = OLD.target_id
      AND canonical_key = OLD.canonical_key
)
BEGIN
    SELECT RAISE(ABORT, 'project authorization must be revoked before deletion');
END;
