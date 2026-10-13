CREATE TABLE users (
	id INTEGER PRIMARY KEY,
	login TEXT NOT NULL UNIQUE COLLATE NOCASE,
	name TEXT NOT NULL,
	avatar TEXT NOT NULL,
	token TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	owner_id INTEGER NOT NULL REFERENCES users(id),
	repo TEXT NOT NULL,
	branch TEXT NOT NULL,
	main_file TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

-- Members are keyed by GitHub login so people can be invited before they first sign in.
CREATE TABLE members (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	login TEXT NOT NULL COLLATE NOCASE,
	role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
	added_at INTEGER NOT NULL,
	PRIMARY KEY (project_id, login)
);

CREATE INDEX members_by_login ON members(login);
