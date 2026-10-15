# Velo

Velo is one operator's keyboard-first desktop workspace for email, Freshdesk customer support and ClickUp follow-up work. Freshdesk stays the system of record for tickets and ClickUp for tasks; Velo reads, caches and acts on them without owning them.

## People

**Operator**:
The one person using this Velo install; in Freshdesk they are also an agent.
_Avoid_: User, owner (in product text)

**Agent**:
A human support person in the connected helpdesk. "Me" is the agent identity Freshdesk reports for the operator's credentials, never a name match.
_Avoid_: Using "agent" for AI or coding agents

**Colleague**:
Any agent other than the operator.

**Customer**:
The person who raised a ticket and anyone writing to it from outside the helpdesk.
_Avoid_: Requester, contact (a contact is an email-address-book entry)

## Connections

**Helpdesk**:
The single Freshdesk account Velo is connected to.
_Avoid_: Freshdesk account, instance

**Workspace**:
The single ClickUp workspace Velo is connected to.
_Avoid_: Team, using "workspace" for Velo itself

**Tenant**:
Either connected remote system (the helpdesk or the workspace). Everything Velo stores from or about a tenant belongs to that tenant and must never show after reconnecting to a different one.
_Avoid_: Account (an account is always an email account)

**Sample data**:
Clearly marked stand-in statuses, tickets and lists shown until a tenant is connected; never presented as real.
_Avoid_: Mock data, demo data

## Email

**Email account**:
A Gmail or IMAP/SMTP mailbox connected to Velo.
_Avoid_: Account without qualifier when tickets are also in play

**Email thread**:
A conversation of email messages in one email account.
_Avoid_: Conversation, ticket

**Scheduled email**:
An email the operator has set to send later; it sends only when Velo is next open.

**Send later**:
The one action (default Cmd+Shift+L) that schedules whatever the current composer holds: a scheduled email or a scheduled reply.
_Avoid_: Schedule send, snooze

## Tickets

**Ticket**:
A Freshdesk support case, identified by its helpdesk ticket ID; never an email thread, even when it began as an email.
_Avoid_: Case, issue, thread

**Conversation**:
One entry on a ticket after the original request: a reply, a note or a logged interaction. A ticket's history is its original request plus its conversations.
_Avoid_: Thread, comment

**Reply**:
A conversation sent publicly to the customer by an agent.

**Ticket CC**:
The addresses Freshdesk copies on a ticket (its CC list and reply-CC list), stored per helpdesk with the ticket. A Reply starts with them, minus the customer; the operator can remove or add, and a restored draft keeps its own CC. Internal notes have none.

**Automated reply**:
A public reply produced by a Freshdesk rule or system rather than written by an agent; it never counts as an answer.

**Internal note**:
A note on a ticket that only agents can see (Freshdesk's private note).
_Avoid_: Private note

**Public note**:
A note visible to the customer; it is not a reply and never counts as an answer. Velo does not write public notes.

**Status**:
One of the helpdesk's own ticket statuses, matched by ID and shown with Freshdesk's exact label; a status Velo does not know shows as unknown, never hidden.

**Status class**:
The operator's classification of each status as open, waiting or done.
_Avoid_: Status category, state

**Open** (status class):
We are expected to act.
_Avoid_: Confusing it with a Freshdesk status that happens to be named "Open"

**Waiting** (status class):
The ball is in someone else's court, such as the customer or a third party.

**Done** (status class):
No further work expected.
_Avoid_: Resolved/closed as a synonym

**Outstanding**:
A ticket whose status is not classified done.
_Avoid_: Active, unresolved

## Activity

**Last answered**:
When an agent last sent a reply written by a human; automated replies, public notes, logged phone/chat interactions and internal notes do not count.
_Avoid_: Last response, first response, last reply, last-reply age

**Last customer message**:
When the customer last wrote, including the original request.

**Last internal note**:
When an agent last added an internal note.

**Last activity**:
When the latest conversation of any kind was added.

**Last updated**:
When Freshdesk last recorded any change to the ticket, including field changes and automations.

**Needs reply**:
An outstanding ticket whose latest customer message (the original request counts) is newer than its Last answered; Unknown while history is incomplete.
_Avoid_: Unanswered, open (open is a status class)

**Never answered**:
History is complete and contains no qualifying reply.

**Unknown**:
History is not fully loaded, so a metric cannot be decided yet; never shown as Never answered.
_Avoid_: Empty, none

## Views

**Ticket view**:
A named, local saved selection of tickets with its filter, sort, columns, density and presentation. Presets are seeded from status classes; the operator can add their own.
_Avoid_: Smart folder (email-only saved search), Freshdesk view (never imported), filter rule (email auto-actions)

**Presentation**:
How a ticket view shows its tickets: list or board. Both show exactly the same tickets.

**Board**:
The presentation with one column per status; moving a card changes the ticket's status in Freshdesk.
_Avoid_: Kanban (fine in prose, not as a separate concept)

**Coverage**:
Whether Velo's local copy holds every ticket a view asks for; partial or stale coverage is always shown.

## Sending and remote writes

**Ticket composer modes**:
Reply to customer and Internal note, kept visibly separate so a note never reaches the customer.

**Ticket draft**:
The unsent text for one ticket in one composer mode, kept across restarts, offline and after a failed send.
_Avoid_: AI draft (that is generated text)

**Remote write**:
Any change Velo makes in Freshdesk or ClickUp. Remote writes need a connection and are never queued offline.
_Avoid_: Sync (sync is reading)

**Operation journal**:
Velo's record of every send and multi-step remote write, so an outcome is always confirmed, failed or unconfirmed, never guessed.
_Avoid_: Offline queue (that is the email-only retry queue)

**Unconfirmed**:
A remote write whose outcome is not known after a timeout; it is resolved by reconciliation, never by sending again.

**Reconciliation**:
Checking the tenant to learn whether an unconfirmed write actually happened.

**Staleness check**:
The re-check of a ticket just before sending that warns when a colleague replied or reassigned it meanwhile.

**Scheduled reply**:
A ticket reply set to send later, optionally followed by a status change once the send is confirmed; it sends only while Velo runs.
_Avoid_: Scheduled email (email only)

**Held**:
The state of a scheduled reply that did not send because the ticket changed before it fell due; its draft is kept for review, resend or cancel.

## ClickUp

**Task**:
A ClickUp task. Unqualified "task" always means this.
_Avoid_: ClickUp ticket, issue

**Velo to-do**:
An item on Velo's own local task list, unrelated to ClickUp.
_Avoid_: Task, local task

**Link**:
Velo's local relationship between a ticket or an email thread and a task. Links are many-to-many; unlinking never touches the task.
_Avoid_: Association, relation

**Backlink**:
A pointer Velo writes into the remote systems when it links a ticket: the ticket URL in the task description, the ticket-ID custom field, and a Freshdesk internal note pointing at the task. Email links have no backlinks.
_Avoid_: Using "link" for these remote pointers

**Ticket-ID field**:
The ClickUp custom field the operator created and selected to hold the ticket ID.

**Related tasks**:
The panel on a ticket or email thread listing its linked tasks.

**Follow-up cue**:
The "follow up with customer" hint shown when a linked task is done; it never changes the ticket.
_Avoid_: Follow-up reminder (the email feature that nudges when nobody replied)

## AI

**AI gateway**:
The single path through which any content leaves Velo for an AI provider.
_Avoid_: AI service, proxy

**Approved provider**:
The AI provider the operator has approved for ticket, task and email content; only the Claude API. Other providers are refused for this content.

**Allowlisted field**:
A field the gateway may send by default: subject, public message text, status and priority. Email categorisation and smart labels also send the sender's domain (never the address or name).

**Sensitive data**:
Secrets, payment data and contact data found by Velo's local check before an AI request; names and companies are not sensitive.

**Secret**:
A password, API key or token; removed and never restored.

**Placeholder**:
A stand-in such as [EMAIL_1] or [CARD_1] that replaces payment or contact data on the way out and is restored locally in the result.

**Send preview**:
The exact outbound content of an AI request, shown before sending; required on first use and whenever a request carries a new data kind.

**New data kind**:
A source field never sent to AI before (such as ClickUp comments) or a sensitive-data type never flagged before (such as the first card number).

**AI audit log**:
The local record of every AI request: when, which feature, which provider and model, and what was flagged.

**AI draft**:
Editable text the AI proposes for the operator; it never sends and never overwrites the operator's edits without a replace-or-insert choice.

**Ticket summary**:
A Velo-only AI overview of a ticket; never written into Freshdesk.
