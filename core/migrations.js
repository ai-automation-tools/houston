// The Core's database schema, one SQL string per version. Entry 0 makes schema v1.
// A migration that has shipped is never edited: a change is a new entry at the end.
// Column names are snake_case; core/schemas/ holds the JSON shapes they are read into.

/** @type {string[]} */
export const MIGRATIONS = [
  // v1: identities, their grants, and sessions. Enums match core/schemas/identity.schema.json.
  `
  CREATE TABLE identities (
    id            TEXT PRIMARY KEY CHECK (id GLOB 'local:?*' AND length(id) <= 69),
    kind          TEXT NOT NULL CHECK (kind IN ('operator', 'ai-agent', 'sub-agent', 'service-account', 'mcp-server')),
    display_name  TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
    owner         TEXT REFERENCES identities(id),
    parent        TEXT REFERENCES identities(id),
    purpose       TEXT CHECK (purpose IS NULL OR length(purpose) <= 300),
    backend       TEXT,
    status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended', 'retired')),
    containment   TEXT NOT NULL CHECK (containment IN ('container', 'restricted-token', 'unconfined')),
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    expires_at    TEXT,
    retired_at    TEXT,
    tags          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
    CHECK (kind = 'operator' OR owner IS NOT NULL)
  ) STRICT;

  -- An id is never reused, so a row is retired, not deleted, and 'retired' is final.
  CREATE TRIGGER identities_no_delete BEFORE DELETE ON identities
  BEGIN SELECT RAISE(ABORT, 'an identity is retired, never deleted'); END;

  CREATE TRIGGER identities_retired_is_final BEFORE UPDATE OF status ON identities
  WHEN OLD.status = 'retired' AND NEW.status <> 'retired'
  BEGIN SELECT RAISE(ABORT, 'a retired identity stays retired'); END;

  CREATE TABLE grants (
    id            TEXT PRIMARY KEY,
    identity_id   TEXT NOT NULL REFERENCES identities(id),
    resource      TEXT NOT NULL CHECK (
                    resource GLOB 'file:?*' OR resource GLOB 'net:?*' OR resource GLOB 'tool:?*' OR
                    resource GLOB 'command:?*' OR resource GLOB 'secret:?*' OR resource GLOB 'session:?*'),
    permission    TEXT NOT NULL CHECK (permission IN ('read', 'write', 'list', 'connect', 'call', 'run', 'use', 'spawn')),
    effect        TEXT NOT NULL CHECK (effect IN ('allow', 'ask')),
    granted_at    TEXT NOT NULL,
    granted_by    TEXT NOT NULL,
    expires_at    TEXT,
    last_used_at  TEXT
  ) STRICT;

  CREATE TABLE sessions (
    id                 TEXT PRIMARY KEY,
    identity_id        TEXT NOT NULL REFERENCES identities(id),
    parent_session_id  TEXT REFERENCES sessions(id),
    workspace          TEXT NOT NULL,
    containment        TEXT NOT NULL CHECK (containment IN ('container', 'restricted-token', 'unconfined')),
    attended           INTEGER NOT NULL CHECK (attended IN (0, 1)),
    policy_version     TEXT NOT NULL,
    started_at         TEXT NOT NULL,
    ended_at           TEXT,
    end_reason         TEXT
  ) STRICT;
  `,

  // v2: a grant can be an explicit deny (precedence: global deny, explicit deny, narrowest
  // allow). SQLite can't change a CHECK in place, so the table is rebuilt.
  `
  CREATE TABLE grants_v2 (
    id            TEXT PRIMARY KEY,
    identity_id   TEXT NOT NULL REFERENCES identities(id),
    resource      TEXT NOT NULL CHECK (
                    resource GLOB 'file:?*' OR resource GLOB 'net:?*' OR resource GLOB 'tool:?*' OR
                    resource GLOB 'command:?*' OR resource GLOB 'secret:?*' OR resource GLOB 'session:?*'),
    permission    TEXT NOT NULL CHECK (permission IN ('read', 'write', 'list', 'connect', 'call', 'run', 'use', 'spawn')),
    effect        TEXT NOT NULL CHECK (effect IN ('allow', 'ask', 'deny')),
    granted_at    TEXT NOT NULL,
    granted_by    TEXT NOT NULL,
    expires_at    TEXT,
    last_used_at  TEXT
  ) STRICT;
  INSERT INTO grants_v2 SELECT * FROM grants;
  DROP TABLE grants;
  ALTER TABLE grants_v2 RENAME TO grants;
  CREATE INDEX grants_by_identity ON grants (identity_id);
  `,

  // v3: one operator per database (one operator, one machine).
  `
  CREATE UNIQUE INDEX one_operator ON identities (kind) WHERE kind = 'operator';
  `,

  // v4 (H3): the vault and the gateway's MCP server registrations.
  // A secret's blob is DPAPI with the Core's entropy (vault.js); its value is in no other column.
  // A server runs as its own mcp-server identity, whose grants are the container's policy.
  // env maps a variable to text or to 'secret:<name>'. tools and tools_hash are the list as
  // last read from the server; a pinned server whose list changes goes to needs_review.
  `
  CREATE TABLE secrets (
    name          TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 63),
    blob          BLOB NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_used_at  TEXT
  ) STRICT;

  CREATE TABLE mcp_servers (
    name         TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 40),
    identity_id  TEXT NOT NULL UNIQUE REFERENCES identities(id),
    command      TEXT NOT NULL,
    env          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(env)),
    path_dirs    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(path_dirs)),
    state        TEXT NOT NULL CHECK (state IN ('discovered', 'installed', 'pinned', 'needs_review', 'disabled')),
    tools        TEXT CHECK (tools IS NULL OR json_valid(tools)),
    tools_hash   TEXT,
    pinned_hash  TEXT,
    added_at     TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  ) STRICT;
  `,

  // v5 (H3): how the gateway reaches a server. 'container' starts its stdio command in a
  // container of its own; 'host' starts it on the host, unconfined, for a server that needs
  // what a container refuses (Cronsole's calls its own API on loopback); 'http' is a server
  // already listening on loopback (Houston's own), and command holds its URL.
  `
  ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'container' CHECK (transport IN ('container', 'host', 'http'));
  `,

  // v6 (H4): standing grants, the operator's leave for an identity to run one command in one
  // folder with nobody watching (standing.js). grants_hash is the identity's grants when the
  // operator approved it: a run is refused once they differ. A session started under one
  // names it, so its audit trail says which leave it ran on.
  `
  CREATE TABLE standing_grants (
    id           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 40),
    identity_id  TEXT NOT NULL REFERENCES identities(id),
    workspace    TEXT NOT NULL,
    command      TEXT NOT NULL,
    path_dirs    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(path_dirs)),
    grants_hash  TEXT NOT NULL,
    max_minutes  INTEGER NOT NULL CHECK (max_minutes BETWEEN 1 AND 1440),
    expires_at   TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    last_run_at  TEXT
  ) STRICT;
  ALTER TABLE sessions ADD COLUMN standing_grant_id TEXT REFERENCES standing_grants(id);
  `,

  // v7 (H4): a standing grant for a backend identity (Claude Code) names a prompt, which the
  // manifest's headless start runs; its command is then ''.
  `
  ALTER TABLE standing_grants ADD COLUMN prompt TEXT CHECK (prompt IS NULL OR length(prompt) BETWEEN 1 AND 8000);
  `,

  // v8 (H5): review dates. The operator marks an identity reviewed (identity.review); review_by
  // is when it's due again. Null until its first review.
  `
  ALTER TABLE identities ADD COLUMN reviewed_at TEXT;
  ALTER TABLE identities ADD COLUMN review_by TEXT;
  `,
];
