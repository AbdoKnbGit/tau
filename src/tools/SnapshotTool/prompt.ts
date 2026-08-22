export const SNAPSHOT_TOOL_NAME = 'Snapshot'

export const DESCRIPTION =
  'Save, list, diff, or restore working-tree snapshots stored in a shadow git repo. Independent of the project .git.'

export const SNAPSHOT_TOOL_PROMPT = `Manage per-project undo snapshots in an isolated shadow git repo; the real .git and its hooks are untouched.

- save: capture modified/untracked files except files over 2 MB; returns a hash even with no changes.
- list: recent hashes, dates, and labels.
- diff: compare hash to the working tree, or hash (base) to compareHash (target). For a working-tree diff, "+" is current content restore would remove; "-" is snapshot content restore would bring back.
- restore: overwrite files contained in the snapshot, but do not delete current files absent from it. Confirm first unless the user explicitly requested restoration.

Save before risky multi-step edits and diff before restore. hash is required for diff/restore; label is save-only; limit is list-only.`
