-- A small image of the first page, refreshed by whoever has the project open.
ALTER TABLE projects ADD COLUMN thumb BLOB;
ALTER TABLE projects ADD COLUMN thumb_type TEXT;
ALTER TABLE projects ADD COLUMN thumb_at INTEGER;
