export const OPEN_PEER_TOOL_NAME = 'OpenPeer'

export const DESCRIPTION =
  'Open a Tau session in a new window, a closed one again or a new one in a folder, and give it a task'

export const PROMPT = `Opens a Tau session in a new terminal window and gives it a task, when no open session fits (ListPeers shows the open ones). Either:
- session: the id of a closed session to continue it with its whole history (ListPeers with closed: true lists recent ones), or
- folder: the absolute path of a project folder for a new session there.

The session works under that folder's own settings and takes tasks only from you. Its answer arrives later as a <task-notification> whose task-id is peer:<name>; send follow-ups with SendMessage to the same address. Don't wait or poll. If no window can be opened, the result says what the user should run; the task waits for that session.`
