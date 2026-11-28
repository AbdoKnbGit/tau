export const LIST_PEERS_TOOL_NAME = 'ListPeers'

export const DESCRIPTION =
  'List the other Tau sessions on this machine that take tasks from you'

export const PROMPT = `Lists the other Tau sessions on this machine that take tasks (their user ran /peers on). Each line shows the session's name, status (idle, busy, or waiting for its user), provider and model, folder, id, when it was last active, and how many of your tasks it still has open. With closed: true it also lists recent closed sessions, which OpenPeer can reopen.

Send one a task with SendMessage: {"to": "peer:<name>", "message": "..."}. Prefer an idle session whose folder fits the task.`
