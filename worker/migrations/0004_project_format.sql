-- Existing projects are all Typst, which is what the default gives them.
ALTER TABLE projects ADD COLUMN format TEXT NOT NULL DEFAULT 'typst';
