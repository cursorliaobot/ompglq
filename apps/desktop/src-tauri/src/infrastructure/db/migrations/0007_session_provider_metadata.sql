ALTER TABLE session_index
ADD COLUMN credential_providers_json TEXT NOT NULL DEFAULT '[]';
