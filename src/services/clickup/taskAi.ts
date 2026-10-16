/** Local source selection shared by task proposals and reply drafts. */
import { getMessagesForThread } from "@/services/db/messages";
import { currentCredentials } from "@/services/freshdesk/connection";
import { getTicketHistory, refreshTicketHistory } from "@/services/freshdesk/ticketHistory";
import { getTicketList } from "@/services/freshdesk/ticketSync";
import type { TaskAiSource } from "@/services/freshdesk/ticketAi";
import type { LinkedItem } from "./links";

export async function loadTaskAiSource(item: LinkedItem): Promise<TaskAiSource> {
  if (item.kind === "email") {
    return { messages: await getMessagesForThread(item.accountId, item.threadId) };
  }
  let history = await getTicketHistory(item.ticketId);
  if (!history || history.isSample) throw new Error("Open a connected ticket to ask AI.");
  if (history.history !== "complete") {
    const current = await currentCredentials();
    if (!current) throw new Error("Connect Freshdesk to load the ticket's public messages.");
    await refreshTicketHistory(current.tenantId, current.credentials, item.ticketId);
    history = await getTicketHistory(item.ticketId);
  }
  const ticket = (await getTicketList()).tickets.find((t) => t.id === item.ticketId);
  if (!ticket || !history?.entries.length) throw new Error("Load the ticket's public messages before asking AI.");
  return {
    ticketId: ticket.id,
    subject: ticket.subject,
    status: ticket.status.label,
    priority: ticket.priority?.label ?? null,
    entries: history.entries,
  };
}
