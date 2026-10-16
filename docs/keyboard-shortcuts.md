# Keyboard Shortcuts

Velo is designed to be used entirely from the keyboard. All shortcuts are customizable in Settings.

## Navigation

| Key | Action |
|-----|--------|
| `j` / `k` | Next / previous thread or ticket |
| `Enter` (also `o` with the default binding) | Open thread or ticket |
| `Escape` | Close composer / clear selection / deselect |
| `g` then `i` | Go to Inbox |
| `g` then `s` | Go to Starred |
| `g` then `t` | Go to Sent |
| `g` then `d` | Go to Drafts |
| `g` then `p` | Go to Primary |
| `g` then `u` | Go to Updates |
| `g` then `o` | Go to Promotions |
| `g` then `c` | Go to Social |
| `g` then `n` | Go to Newsletters |
| `g` then `k` | Go to Tasks |
| `g` then `a` | Go to Attachments |
| `g` then `l` | Go to Scheduled emails |

## Actions

| Key | Action |
|-----|--------|
| `c` | Compose new email |
| `r` | Reply |
| `a` | Reply all |
| `f` | Forward |
| `e` | Archive |
| `s` | Star / unstar |
| `p` | Pin / unpin |
| `m` | Mute / unmute thread |
| `#` | Trash (permanent delete if already in trash) |
| `!` | Spam / not spam |
| `u` | Unsubscribe |
| `t` | Open ClickUp create/link controls for the selected email or ticket |
| `Shift+T` | Create a Velo to-do from email (AI) |
| `v` | Move to folder/label |
| `Ctrl+Enter` | Send email, ticket reply or internal note (inside the composer) |
| `Ctrl+Shift+L` | Send later / schedule a reply (inside the composer) |
| `Ctrl+A` | Select all threads |
| `Ctrl+Shift+A` | Select all from current position |

## Tickets

Tickets use the same navigation, reply (`r`), send, send-later and search actions as email.

| Key | Action |
|-----|--------|
| `n` | Internal note |
| `z` | Summarize through the AI send preview |
| `d` | Open Reply and propose an AI draft; keep existing text |
| `Shift+S` | Focus Status |
| `Shift+P` | Focus Priority |
| `Shift+A` | Focus Assignee |
| `b` | Switch the current view between list and board |

Field shortcuts focus the existing control; use its arrow keys and Enter to choose a value. Ticket actions are skipped in inputs, selects and rich text editors, even after rebinding to a modified key. Send and send-later work while composing with command-key bindings. Search keeps its command-key behavior while typing. Settings and shortcuts help both warn about duplicate assignments. On macOS, `Ctrl` bindings use Command and `Alt` uses Option.

## In-thread

| Key | Action |
|-----|--------|
| `↓` (Arrow Down) | Next message in thread |
| `↑` (Arrow Up) | Previous message in thread |

## App

| Key | Action |
|-----|--------|
| `/` or `Ctrl+K` | Command palette: search mail, tickets and commands |
| `?` | Keyboard shortcuts help |
| `i` | Ask Inbox (AI) |
| `F5` | Sync current folder |
| `Ctrl+Shift+E` | Toggle sidebar |

## Multi-select

- **Click** a thread to toggle its selection
- **Shift+click** to select a range
- All keyboard actions (archive, trash, star, etc.) apply to the entire selection

## Two-key sequences

Velo supports Vim-style two-key sequences. Press the first key, then the second within 1 second:

- `g` is the only prefix key currently
- If the second key isn't pressed in time, the sequence resets

## Customization

All shortcuts can be rebound in **Settings > Keyboard Shortcuts**. Custom bindings are persisted to the local database and restored on startup. Shortcut definitions live in `src/constants/shortcuts.ts`.
