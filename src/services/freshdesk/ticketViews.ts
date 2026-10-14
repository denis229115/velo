import { getDb, withReadSnapshot } from "@/services/db/connection";
import { getStatusClasses } from "@/services/db/freshdesk";
import { currentTenantId } from "./connection";
import { DEFAULT_VIEW_ID, presetViews, type TicketView } from "./viewEngine";

export * from "./viewEngine";

/**
 * Saved ticket views: local records per helpdesk. Presets come from the
 * status classification; what the operator changes on a preset (sort,
 * columns, density, presentation, board state) is stored over it. Custom
 * views are stored whole.
 */

interface ViewRow {
  view_id: string;
  kind: "preset" | "custom";
  name: string;
  filter_json: string;
  sort: TicketView["sort"];
  columns_json: string;
  density: TicketView["density"];
  presentation: TicketView["presentation"];
  board_json: string;
}

export type TicketViewInput = Pick<TicketView, "name" | "filter" | "sort" | "columns" | "density" | "presentation"> &
  Partial<Pick<TicketView, "board">>;
export type TicketViewChanges = Partial<TicketViewInput>;

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function fromRow(row: ViewRow, base?: TicketView): TicketView {
  return {
    id: row.view_id,
    kind: row.kind,
    name: base?.name ?? row.name,
    filter: base?.filter ?? parse(row.filter_json, {}),
    sort: row.sort,
    columns: parse(row.columns_json, []),
    density: row.density,
    presentation: row.presentation,
    board: parse(row.board_json, {}),
  };
}

async function readViews(tenantId: string): Promise<{ views: TicketView[]; selectedViewId: string }> {
  const db = await getDb();
  const [classes, rows, selection] = await Promise.all([
    getStatusClasses(tenantId),
    db.select<ViewRow[]>("SELECT * FROM freshdesk_ticket_views WHERE tenant_id = $1 ORDER BY created_at, view_id", [tenantId]),
    db.select<{ view_id: string }[]>("SELECT view_id FROM freshdesk_view_selection WHERE tenant_id = $1", [tenantId]),
  ]);
  const stored = new Map(rows.map((r) => [r.view_id, r]));
  const presets = presetViews([...classes.values()].includes("waiting")).map((p) => {
    const row = stored.get(p.id);
    return row ? fromRow(row, p) : p;
  });
  const views = [...presets, ...rows.filter((r) => r.kind === "custom").map((r) => fromRow(r))];
  const selected = selection[0]?.view_id;
  return { views, selectedViewId: views.some((v) => v.id === selected) ? (selected as string) : DEFAULT_VIEW_ID };
}

/** Every view of the current helpdesk (presets first) and the selected one. */
export function getTicketViews(): Promise<{ views: TicketView[]; selectedViewId: string }> {
  return withReadSnapshot(async () => readViews(await currentTenantId()));
}

async function writeView(tenantId: string, view: TicketView, createdAt: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO freshdesk_ticket_views (tenant_id, view_id, kind, name, filter_json, sort, columns_json, density, presentation, board_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT(tenant_id, view_id) DO UPDATE SET
       name = excluded.name, filter_json = excluded.filter_json, sort = excluded.sort, columns_json = excluded.columns_json,
       density = excluded.density, presentation = excluded.presentation, board_json = excluded.board_json`,
    [
      tenantId, view.id, view.kind, view.name, JSON.stringify(view.filter), view.sort, JSON.stringify(view.columns),
      view.density, view.presentation, JSON.stringify(view.board), createdAt,
    ],
  );
}

export async function createTicketView(input: TicketViewInput): Promise<TicketView> {
  const tenantId = await currentTenantId();
  const view: TicketView = { board: {}, ...input, id: `custom:${crypto.randomUUID()}`, kind: "custom", name: input.name.trim() };
  await writeView(tenantId, view, Date.now());
  return view;
}

/** Changes a view; a preset keeps its name and filter, so only its display settings change. */
export async function updateTicketView(viewId: string, changes: TicketViewChanges): Promise<TicketView | null> {
  const tenantId = await currentTenantId();
  const current = (await readViews(tenantId)).views.find((v) => v.id === viewId);
  if (!current) return null;
  const { name, filter, ...display } = changes;
  const next: TicketView =
    current.kind === "preset"
      ? { ...current, ...display }
      : { ...current, ...display, ...(name !== undefined ? { name: name.trim() } : {}), ...(filter ? { filter } : {}) };
  await writeView(tenantId, next, current.kind === "preset" ? 0 : Date.now());
  return next;
}

/** Deletes a custom view; presets cannot be deleted. */
export async function deleteTicketView(viewId: string): Promise<void> {
  const tenantId = await currentTenantId();
  const db = await getDb();
  await db.execute("DELETE FROM freshdesk_ticket_views WHERE tenant_id = $1 AND view_id = $2 AND kind = 'custom'", [tenantId, viewId]);
  await db.execute("DELETE FROM freshdesk_view_selection WHERE tenant_id = $1 AND view_id = $2", [tenantId, viewId]);
}

export async function selectTicketView(viewId: string): Promise<void> {
  const tenantId = await currentTenantId();
  const db = await getDb();
  await db.execute(
    "INSERT INTO freshdesk_view_selection (tenant_id, view_id) VALUES ($1, $2) ON CONFLICT(tenant_id) DO UPDATE SET view_id = excluded.view_id",
    [tenantId, viewId],
  );
}
