export const migrations: string[] = [
  // 1: catalogue schema
  `
  CREATE TABLE providers (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('xtream','m3u','stalker')),
    name TEXT NOT NULL,
    config TEXT NOT NULL,              -- JSON; xtream: {"serverUrl","username","password"}
    account TEXT,                      -- JSON XtreamAccount from last authenticate()
    created_at INTEGER NOT NULL,
    last_synced_at INTEGER
  );
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('live','movie','series')),
    remote_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    UNIQUE (provider_id, kind, remote_id)
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('live','movie','series')),
    remote_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER,
    logo_url TEXT,
    container_ext TEXT,
    epg_channel_id TEXT,
    catchup_days INTEGER,
    added_at INTEGER,
    rating TEXT,
    year INTEGER,
    seen_at INTEGER NOT NULL,
    UNIQUE (provider_id, kind, remote_id)
  );
  CREATE TABLE item_categories (
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (category_id, item_id)
  );
  CREATE INDEX item_categories_order ON item_categories (category_id, position, item_id);
  CREATE INDEX item_categories_item ON item_categories (item_id);
  CREATE VIRTUAL TABLE items_fts USING fts5 (name, content='items', content_rowid='id', tokenize='trigram remove_diacritics 1');
  CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts (rowid, name) VALUES (new.id, new.name);
  END;
  CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, name) VALUES ('delete', old.id, old.name);
  END;
  CREATE TRIGGER items_fts_au AFTER UPDATE OF name ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, name) VALUES ('delete', old.id, old.name);
    INSERT INTO items_fts (rowid, name) VALUES (new.id, new.name);
  END;
  CREATE TABLE probe_cache (url_key TEXT PRIMARY KEY, result TEXT NOT NULL, probed_at INTEGER NOT NULL);
  `,
];
