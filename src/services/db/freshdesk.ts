import { getDb, withTransaction } from "./connection";
import type {
  FieldChoice,
  HelpdeskAgent,
  HelpdeskGroup,
  HelpdeskMetadata,
  TicketFieldDefinition,
} from "@/services/freshdesk/metadata";

export type IntegrationKind = "freshdesk";
export type StatusClass = "open" | "waiting" | "done";

export interface IntegrationAccount {
  kind: IntegrationKind;
  tenantId: string;
  tenantHost: string;
  me: HelpdeskAgent | null;
  connectedAt: number;
  generation: string;
  metadataRefreshedAt: number | null;
}

interface IntegrationAccountRow {
  kind: IntegrationKind;
  tenant_id: string;
  tenant_host: string;
  me_agent_id: string | null;
  me_name: string | null;
  me_email: string | null;
  me_signature: string | null;
  connected_at: number;
  connection_generation: string;
  metadata_refreshed_at: number | null;
}

/** Every table holding data scoped to a Freshdesk tenant. */
const FRESHDESK_TENANT_TABLES = [
  "freshdesk_field_choices",
  "freshdesk_ticket_fields",
  "freshdesk_agents",
  "freshdesk_groups",
  "freshdesk_status_classes",
  "freshdesk_tickets",
  "freshdesk_sync_state",
  "freshdesk_ticket_history",
  "freshdesk_conversations",
  "freshdesk_ticket_views",
  "freshdesk_view_selection",
  "freshdesk_operation_journal",
  "freshdesk_ticket_drafts",
  "freshdesk_scheduled_replies",
] as const;

export async function getIntegrationAccount(kind: IntegrationKind): Promise<IntegrationAccount | null> {
  const db = await getDb();
  const rows = await db.select<IntegrationAccountRow[]>(
    "SELECT * FROM integration_accounts WHERE kind = $1",
    [kind],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    kind: row.kind,
    tenantId: row.tenant_id,
    tenantHost: row.tenant_host,
    me: row.me_agent_id
      ? { agentId: row.me_agent_id, name: row.me_name ?? "", email: row.me_email, signature: row.me_signature }
      : null,
    connectedAt: row.connected_at,
    generation: row.connection_generation,
    metadataRefreshedAt: row.metadata_refreshed_at,
  };
}

export async function saveIntegrationAccount(account: {
  kind: IntegrationKind;
  tenantId: string;
  tenantHost: string;
  me: HelpdeskAgent;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO integration_accounts (kind, tenant_id, tenant_host, me_agent_id, me_name, me_email, me_signature, connected_at, connection_generation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, unixepoch(), $8)
     ON CONFLICT(kind) DO UPDATE SET tenant_id = $2, tenant_host = $3, me_agent_id = $4, me_name = $5,
       me_email = $6, me_signature = $7, connected_at = unixepoch(), metadata_refreshed_at = NULL, connection_generation = $8`,
    [
      account.kind,
      account.tenantId,
      account.tenantHost,
      account.me.agentId,
      account.me.name,
      account.me.email,
      account.me.signature ?? null,
      crypto.randomUUID(),
    ],
  );
}

export async function deleteIntegrationAccount(kind: IntegrationKind): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM integration_accounts WHERE kind = $1", [kind]);
}

/** Removes every Freshdesk-scoped row that does not belong to `keepTenantId`. */
export async function deleteFreshdeskDataExcept(keepTenantId: string): Promise<void> {
  await withTransaction(async (db) => {
    for (const table of FRESHDESK_TENANT_TABLES) {
      await db.execute(`DELETE FROM ${table} WHERE tenant_id != $1`, [keepTenantId]);
    }
    // Files belong to a draft or schedule, rather than carrying a tenant column.
    // Remove files whose owner was just deleted, including any older orphaned files.
    await db.execute(`DELETE FROM freshdesk_reply_attachments WHERE owner NOT IN (
      SELECT 'draft:' || tenant_id || '|' || agent_id || '|' || ticket_id || '|' || mode
        FROM freshdesk_ticket_drafts
      UNION ALL
      SELECT 'scheduled:' || reply_id FROM freshdesk_scheduled_replies
    )`);
  });
}

/**
 * Replaces the tenant's metadata with a fresh read. Status classes live in
 * their own table keyed by status ID, so renames keep them.
 */
export async function replaceHelpdeskMetadata(
  tenantId: string,
  metadata: HelpdeskMetadata,
  expected?: { generation: string; me: HelpdeskAgent },
): Promise<boolean> {
  let applied = false;
  await withTransaction(async (db) => {
    if (expected) {
      const { me, generation } = expected;
      const result = await db.execute(
        `UPDATE integration_accounts SET me_agent_id = $3, me_name = $4, me_email = $5, me_signature = $6
         WHERE kind = 'freshdesk' AND tenant_id = $1 AND connection_generation = $2`,
        [tenantId, generation, me.agentId, me.name, me.email, me.signature ?? null],
      );
      if (result.rowsAffected === 0) return;
    }
    applied = true;
    for (const table of ["freshdesk_field_choices", "freshdesk_ticket_fields", "freshdesk_agents", "freshdesk_groups"]) {
      await db.execute(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    for (const f of metadata.ticketFields) {
      await db.execute(
        `INSERT INTO freshdesk_ticket_fields
           (tenant_id, field_id, name, label, type, is_default, required_for_agents, required_for_closure, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tenantId, f.fieldId, f.name, f.label, f.type, f.isDefault ? 1 : 0, f.requiredForAgents ? 1 : 0,
          f.requiredForClosure ? 1 : 0, f.position],
      );
    }
    for (const c of metadata.choices) {
      await db.execute(
        `INSERT OR REPLACE INTO freshdesk_field_choices (tenant_id, field_name, choice_id, label, customer_label, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, c.fieldName, c.choiceId, c.label, c.customerLabel, c.position],
      );
    }
    for (const a of metadata.agents) {
      await db.execute(
        "INSERT OR REPLACE INTO freshdesk_agents (tenant_id, agent_id, name, email) VALUES ($1, $2, $3, $4)",
        [tenantId, a.agentId, a.name, a.email],
      );
    }
    for (const g of metadata.groups) {
      await db.execute(
        "INSERT OR REPLACE INTO freshdesk_groups (tenant_id, group_id, name) VALUES ($1, $2, $3)",
        [tenantId, g.groupId, g.name],
      );
    }
    await db.execute(
      "UPDATE integration_accounts SET metadata_refreshed_at = unixepoch() WHERE tenant_id = $1",
      [tenantId],
    );
  });
  return applied;
}

export async function getFieldChoices(tenantId: string, fieldName: string): Promise<FieldChoice[]> {
  const db = await getDb();
  const rows = await db.select<
    { field_name: string; choice_id: string; label: string; customer_label: string | null; position: number }[]
  >(
    `SELECT field_name, choice_id, label, customer_label, position FROM freshdesk_field_choices
     WHERE tenant_id = $1 AND field_name = $2 ORDER BY position, choice_id`,
    [tenantId, fieldName],
  );
  return rows.map((r) => ({
    fieldName: r.field_name,
    choiceId: r.choice_id,
    label: r.label,
    customerLabel: r.customer_label,
    position: r.position,
  }));
}

export async function getTicketFields(tenantId: string): Promise<TicketFieldDefinition[]> {
  const db = await getDb();
  const rows = await db.select<
    {
      field_id: string; name: string; label: string; type: string; is_default: number;
      required_for_agents: number; required_for_closure: number; position: number;
    }[]
  >("SELECT * FROM freshdesk_ticket_fields WHERE tenant_id = $1 ORDER BY position, field_id", [tenantId]);
  return rows.map((r) => ({
    fieldId: r.field_id,
    name: r.name,
    label: r.label,
    type: r.type,
    isDefault: r.is_default === 1,
    requiredForAgents: r.required_for_agents === 1,
    requiredForClosure: r.required_for_closure === 1,
    position: r.position,
  }));
}

export async function getAgents(tenantId: string): Promise<HelpdeskAgent[]> {
  const db = await getDb();
  const rows = await db.select<{ agent_id: string; name: string; email: string | null }[]>(
    "SELECT agent_id, name, email FROM freshdesk_agents WHERE tenant_id = $1 ORDER BY name, agent_id",
    [tenantId],
  );
  return rows.map((r) => ({ agentId: r.agent_id, name: r.name, email: r.email }));
}

export async function getGroups(tenantId: string): Promise<HelpdeskGroup[]> {
  const db = await getDb();
  const rows = await db.select<{ group_id: string; name: string }[]>(
    "SELECT group_id, name FROM freshdesk_groups WHERE tenant_id = $1 ORDER BY name, group_id",
    [tenantId],
  );
  return rows.map((r) => ({ groupId: r.group_id, name: r.name }));
}

export async function getStatusClasses(tenantId: string): Promise<Map<string, StatusClass>> {
  const db = await getDb();
  const rows = await db.select<{ status_id: string; status_class: StatusClass }[]>(
    "SELECT status_id, status_class FROM freshdesk_status_classes WHERE tenant_id = $1",
    [tenantId],
  );
  return new Map(rows.map((r) => [r.status_id, r.status_class]));
}

export async function setStatusClass(tenantId: string, statusId: string, statusClass: StatusClass): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO freshdesk_status_classes (tenant_id, status_id, status_class) VALUES ($1, $2, $3)
     ON CONFLICT(tenant_id, status_id) DO UPDATE SET status_class = $3`,
    [tenantId, statusId, statusClass],
  );
}
