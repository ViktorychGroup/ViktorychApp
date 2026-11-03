-- Linked profiles: "specific people" audience (worker/src/identities.js
-- creates the same table on demand). The merged/separate choice is a column
-- the Worker adds itself (account_identities.merged, default 1 = merge).
CREATE TABLE IF NOT EXISTS identity_people_grants (
    identity_id INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    PRIMARY KEY (identity_id, member_id)
);
