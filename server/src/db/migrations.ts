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
  // 2: personal, curation and refresh-safety schema
  `
  DROP TRIGGER items_fts_au;
  CREATE TRIGGER items_fts_au AFTER UPDATE OF name ON items WHEN old.name IS NOT new.name BEGIN
    INSERT INTO items_fts (items_fts, rowid, name) VALUES ('delete', old.id, old.name);
    INSERT INTO items_fts (rowid, name) VALUES (new.id, new.name);
  END;
  ALTER TABLE item_categories ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE categories ADD COLUMN tag TEXT;                     -- detected tag key, NULL = untagged
  ALTER TABLE categories ADD COLUMN first_seen_at INTEGER NOT NULL DEFAULT 0;
  UPDATE categories SET first_seen_at = seen_at;
  ALTER TABLE categories ADD COLUMN tag_changed_at INTEGER NOT NULL DEFAULT 0;  -- last sync that changed tag; 0 = never
  CREATE TABLE catalogue_styles (
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, style TEXT NOT NULL CHECK (style IN ('tagged','mixed','untagged')), pattern TEXT,
    PRIMARY KEY (provider_id, kind));
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
  INSERT INTO users (id, name, created_at) VALUES (1, 'Owner', 0);
  CREATE TABLE category_rules (
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,         -- NULL = default (admin) rule
    kind TEXT NOT NULL, target_type TEXT NOT NULL CHECK (target_type IN ('tag','category')),
    target TEXT NOT NULL,                                            -- tag key, or category remote_id
    visible INTEGER NOT NULL CHECK (visible IN (0,1)));
  CREATE UNIQUE INDEX category_rules_key ON category_rules (provider_id, kind, target_type, target, COALESCE(user_id, 0));
  CREATE TABLE curation_state (
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, saved_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX curation_state_key ON curation_state (provider_id, kind, COALESCE(user_id, 0));
  CREATE TABLE pins (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, category_remote_id TEXT NOT NULL, pinned_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider_id, kind, category_remote_id));
  CREATE TABLE favourites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, remote_id TEXT NOT NULL, added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider_id, kind, remote_id));
  CREATE TABLE history (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, remote_id TEXT NOT NULL, episode_remote_id TEXT, watched_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider_id, kind, remote_id));
  CREATE INDEX history_recent ON history (user_id, provider_id, kind, watched_at DESC);
  CREATE TABLE positions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    content_key TEXT NOT NULL,          -- 'movie:<remoteId>' | 'episode:<episodeRemoteId>'
    series_remote_id TEXT,              -- set for episodes
    episode_label TEXT,                 -- 'S<season> E<num>' for episodes, kept so browsing never asks the provider
    position_sec REAL NOT NULL, duration_sec REAL, finished INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider_id, content_key));
  CREATE INDEX positions_recent ON positions (user_id, provider_id, finished, updated_at DESC);
  `,
  // 3: TV guide (times are epoch seconds) and user preferences
  `
  CREATE TABLE guide_state (provider_id INTEGER PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 0, fetched_at INTEGER, attempted_at INTEGER,
    source TEXT CHECK (source IN ('xmltv','provider')), failures INTEGER NOT NULL DEFAULT 0, last_error TEXT);
  CREATE TABLE guide_channels (provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, names TEXT NOT NULL,  -- names: JSON array
    PRIMARY KEY (provider_id, generation, key));
  CREATE TABLE programmes (id INTEGER PRIMARY KEY, provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL, channel_key TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL,
    title TEXT NOT NULL, subtitle TEXT, description TEXT, category TEXT);
  -- (match.ts pins programmes_slot by name with INDEXED BY: renaming it breaks matching)
  CREATE UNIQUE INDEX programmes_slot ON programmes (provider_id, generation, channel_key, start);
  CREATE INDEX programmes_time ON programmes (provider_id, generation, start);
  CREATE INDEX programmes_stop ON programmes (provider_id, generation, stop);
  CREATE TABLE guide_links (item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    provider_id INTEGER NOT NULL, channel_key TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('manual','id','name','normalised','sibling','provider')));
  CREATE INDEX guide_links_channel ON guide_links (provider_id, channel_key);
  CREATE TABLE guide_maps (provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    item_remote_id TEXT NOT NULL, channel_key TEXT NOT NULL, PRIMARY KEY (provider_id, item_remote_id));
  CREATE TABLE user_prefs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
  `,
  // 4: manual "watched" marks, kept apart from real playback (manual rows are always finished)
  `
  ALTER TABLE positions ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
  `,
];
