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

CREATE TRIGGER project_bindings_child_scope_update
BEFORE UPDATE OF target_id ON project_bindings
WHEN EXISTS (
    SELECT 1
    FROM project_role_defaults
    WHERE binding_id = OLD.id AND target_id <> NEW.target_id
)
BEGIN
    SELECT RAISE(ABORT, 'project binding target scope has dependent rows');
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

CREATE TRIGGER import_sources_child_scope_update
BEFORE UPDATE OF target_id ON import_sources
WHEN EXISTS (
    SELECT 1
    FROM import_records
    WHERE source_id = OLD.id AND target_id <> NEW.target_id
)
BEGIN
    SELECT RAISE(ABORT, 'import source target scope has dependent rows');
END;
