CREATE UNIQUE INDEX session_index_profile_path_unique
    ON session_index(target_id, profile, session_path)
    WHERE profile IS NOT NULL;
