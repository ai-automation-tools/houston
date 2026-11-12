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
];
