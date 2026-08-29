CREATE TEMP TABLE m3_scope_integrity_guard (
    valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO m3_scope_integrity_guard (valid)
VALUES (
    CASE
        WHEN NOT EXISTS (
            SELECT 1
            FROM execution_targets
            WHERE id = 'local' AND kind = 'local'
        )
        OR EXISTS (
            SELECT 1
            FROM project_bindings AS binding
            JOIN projects AS project ON project.id = binding.project_id
            WHERE binding.target_id <> project.target_id
        )
        OR EXISTS (
            SELECT 1
            FROM project_role_defaults AS role_default
            JOIN project_bindings AS binding ON binding.id = role_default.binding_id
            WHERE role_default.target_id <> binding.target_id
        )
        OR EXISTS (
            SELECT 1
            FROM session_index AS session
            JOIN projects AS project ON project.id = session.project_id
            WHERE session.target_id <> project.target_id
        )
        OR EXISTS (
            SELECT 1
            FROM session_annotations AS annotation
            JOIN session_index AS session ON session.id = annotation.session_index_id
            WHERE annotation.target_id <> session.target_id
        )
        OR EXISTS (
            SELECT 1
            FROM import_records AS import_record
            JOIN import_sources AS import_source ON import_source.id = import_record.source_id
            WHERE import_record.target_id <> import_source.target_id
        )
        OR EXISTS (
            SELECT 1
            FROM trash_items AS trash_item
            JOIN projects AS project ON project.id = trash_item.project_id
            WHERE trash_item.target_id <> project.target_id
        )
        THEN 0
        ELSE 1
    END
);

DROP TABLE m3_scope_integrity_guard;

CREATE TRIGGER execution_targets_protect_local_update
BEFORE UPDATE OF id, kind ON execution_targets
WHEN OLD.id = 'local' AND (NEW.id <> 'local' OR NEW.kind <> 'local')
BEGIN
    SELECT RAISE(ABORT, 'local execution target identity is immutable');
END;

CREATE TRIGGER execution_targets_protect_local_delete
BEFORE DELETE ON execution_targets
WHEN OLD.id = 'local'
BEGIN
    SELECT RAISE(ABORT, 'local execution target cannot be deleted');
END;

CREATE TRIGGER project_bindings_target_scope_insert
BEFORE INSERT ON project_bindings
WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id AND target_id = NEW.target_id
    )
BEGIN
    SELECT RAISE(ABORT, 'project binding target scope mismatch');
END;

CREATE TRIGGER project_bindings_target_scope_update
BEFORE UPDATE OF target_id, project_id ON project_bindings
WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id AND target_id = NEW.target_id
    )
BEGIN
    SELECT RAISE(ABORT, 'project binding target scope mismatch');
END;

CREATE TRIGGER project_role_defaults_target_scope_insert
BEFORE INSERT ON project_role_defaults
WHEN NOT EXISTS (
    SELECT 1
    FROM project_bindings
    WHERE id = NEW.binding_id AND target_id = NEW.target_id
)
BEGIN
    SELECT RAISE(ABORT, 'project role default target scope mismatch');
END;

CREATE TRIGGER project_role_defaults_target_scope_update
BEFORE UPDATE OF target_id, binding_id ON project_role_defaults
WHEN NOT EXISTS (
    SELECT 1
    FROM project_bindings
    WHERE id = NEW.binding_id AND target_id = NEW.target_id
)
BEGIN
    SELECT RAISE(ABORT, 'project role default target scope mismatch');
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

CREATE TRIGGER import_records_target_scope_insert
BEFORE INSERT ON import_records
WHEN NOT EXISTS (
    SELECT 1
    FROM import_sources
    WHERE id = NEW.source_id AND target_id = NEW.target_id
)
BEGIN
    SELECT RAISE(ABORT, 'import record target scope mismatch');
END;

CREATE TRIGGER import_records_target_scope_update
BEFORE UPDATE OF target_id, source_id ON import_records
WHEN NOT EXISTS (
    SELECT 1
    FROM import_sources
    WHERE id = NEW.source_id AND target_id = NEW.target_id
)
BEGIN
    SELECT RAISE(ABORT, 'import record target scope mismatch');
END;

CREATE TRIGGER trash_items_target_scope_insert
BEFORE INSERT ON trash_items
WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id AND target_id = NEW.target_id
    )
BEGIN
    SELECT RAISE(ABORT, 'trash item target scope mismatch');
END;

CREATE TRIGGER trash_items_target_scope_update
BEFORE UPDATE OF target_id, project_id ON trash_items
WHEN NEW.project_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id AND target_id = NEW.target_id
    )
BEGIN
    SELECT RAISE(ABORT, 'trash item target scope mismatch');
END;
