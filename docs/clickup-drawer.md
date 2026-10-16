# ClickUp task drawer

Issue #38 extends the existing CreateTaskDialog, LinkTaskDialog and RelatedTasksPanel entrypoints. Task writes continue through taskCreate.ts and links.ts; their operation journal, backlinks and product AI gateway are unchanged.

Approved test seams: rendered task UI and recorded-shape responses at the Tauri HTTP boundary, backed by the migrated in-memory SQLite database. Fast loop: TypeScript and touched Vitest suites only.

## API contract

Validated against ClickUp's official public documentation on 2026-10-16:

- [Get Spaces](https://developer.clickup.com/reference/getspaces): `/team/{team_id}/space`.
- [Get Folders](https://developer.clickup.com/reference/getfolders), [Get Lists](https://developer.clickup.com/reference/getlists) and [Get Folderless Lists](https://developer.clickup.com/reference/getfolderlesslists): discover folders and both kinds of lists; these endpoints have no server search/page parameters.
- [Get List](https://developer.clickup.com/reference/getlist): selected list details and statuses.
- [Get List Members](https://developer.clickup.com/reference/getlistmembers): `/list/{list_id}/member`, `{members: User[]}`. Only explicit list access is returned; inherited Space/Folder/Team access is omitted. Velo does not fill gaps with workspace members.
- [Create Task](https://developer.clickup.com/reference/createtask): assignees are integer user IDs, status is a name, priority is integer/null, due date is milliseconds, and `markdown_content` is supported.
- [Task priorities](https://developer.clickup.com/docs/tasks): 1 Urgent, 2 High, 3 Normal, 4 Low; priorities cannot be customized. There is no per-list priorities lookup.

The drawer refreshes hierarchy on opening and explicit refresh, with cached lists labelled by their actual discovery time. Discovery is bounded and incomplete coverage is visible; filtering and result pages are local to that discovered set. Selected-list members, statuses and Ticket-ID field metadata are re-read together before creation is enabled. Async results are scoped to the connection and selected list.
