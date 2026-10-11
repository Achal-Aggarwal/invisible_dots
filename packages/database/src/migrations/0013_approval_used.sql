-- An approval of a call whose effect the host applies (an MCP server the Dot adds to its config, architecture
-- section 7) is the consent to that one call: the host uses it up when it applies the effect, so the same approval
-- can never apply it again. NULL is an approval nothing used, which is every approval before this migration.
ALTER TABLE approvals ADD COLUMN used_at timestamptz;
