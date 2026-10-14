/**
 * Recorded-shape ClickUp API v2 responses for two fixture workspaces.
 * Shapes follow the documented v2 endpoints (/user, /team, /team/{id}/space,
 * /space/{id}/folder, /space/{id}/list, /list/{id}/field, /task/{id},
 * /team/{id}/task). Names, IDs and people are fixtures, not a real workspace.
 */

export interface FixtureStatus {
  id: string;
  status: string;
  color: string;
  orderindex: number;
  type: "open" | "custom" | "done" | "closed";
}

export interface FixtureList {
  id: string;
  name: string;
  orderindex: number;
  archived: boolean;
  /** Present when the list overrides its space's statuses */
  statuses?: FixtureStatus[];
}

export interface FixtureFolder {
  id: string;
  name: string;
  hidden: boolean;
  lists: FixtureList[];
}

export interface FixtureSpace {
  id: string;
  name: string;
  statuses: FixtureStatus[];
  folders: FixtureFolder[];
  folderlessLists: FixtureList[];
}

export interface FixtureUser {
  id: number;
  username: string;
  email: string;
  color: string;
  initials: string;
  profilePicture: string | null;
}

export interface FixtureField {
  id: string;
  name: string;
  type: string;
  type_config: Record<string, unknown>;
  date_created: string;
  hide_from_guests: boolean;
  required: boolean;
}

export interface FixtureTask {
  id: string;
  custom_id: string | null;
  name: string;
  text_content: string;
  description: string;
  status: FixtureStatus;
  orderindex: string;
  date_created: string;
  date_updated: string;
  date_closed: string | null;
  date_done: string | null;
  archived: boolean;
  creator: Omit<FixtureUser, "initials">;
  assignees: FixtureUser[];
  due_date: string | null;
  start_date: string | null;
  url: string;
  list: { id: string; name: string; access: boolean };
  folder: { id: string; name: string; hidden: boolean; access: boolean };
  space: { id: string };
  team_id: string;
  custom_fields: unknown[];
}

export interface ClickUpFixtureWorkspace {
  id: string;
  name: string;
  members: FixtureUser[];
  spaces: FixtureSpace[];
  fields: Record<string, FixtureField[]>;
  tasks: FixtureTask[];
}

export interface ClickUpFixtureToken {
  user: FixtureUser;
  workspaces: ClickUpFixtureWorkspace[];
}

export const ALPHA_TOKEN = "pk_fixture_alpha_0001";
export const BETA_TOKEN = "pk_fixture_beta_0002";
export const ALPHA_WORKSPACE_ID = "9010000001";
export const BETA_WORKSPACE_ID = "9020000002";

const status = (id: string, name: string, type: FixtureStatus["type"], orderindex: number, color: string): FixtureStatus => ({
  id,
  status: name,
  color,
  orderindex,
  type,
});

export const ALPHA_STATUSES = {
  todo: status("sc_a_1", "fixture to do", "open", 0, "#87909e"),
  doing: status("sc_a_2", "fixture in progress", "custom", 1, "#5f55ee"),
  complete: status("sc_a_3", "fixture complete", "closed", 2, "#008844"),
};

const alphaOperator: FixtureUser = {
  id: 701,
  username: "Fixture Operator",
  email: "operator@fixture.invalid",
  color: "#7b68ee",
  initials: "FO",
  profilePicture: null,
};
const alphaColleague: FixtureUser = {
  id: 702,
  username: "Fixture Colleague",
  email: "colleague@fixture.invalid",
  color: "#ff5722",
  initials: "FC",
  profilePicture: null,
};

const ticketIdField: FixtureField = {
  id: "cf-alpha-ticket",
  name: "Fixture ticket ID",
  type: "short_text",
  type_config: {},
  date_created: "1759000000000",
  hide_from_guests: false,
  required: false,
};
const effortField: FixtureField = {
  id: "cf-alpha-effort",
  name: "Fixture effort",
  type: "number",
  type_config: {},
  date_created: "1759000000000",
  hide_from_guests: false,
  required: false,
};

function task(
  overrides: Partial<FixtureTask> & Pick<FixtureTask, "id" | "name" | "status" | "list" | "team_id">,
): FixtureTask {
  return {
    custom_id: null,
    text_content: "",
    description: "",
    orderindex: "1.0000",
    date_created: "1759900000000",
    date_updated: "1760000000000",
    date_closed: null,
    date_done: null,
    archived: false,
    creator: { id: 701, username: "Fixture Operator", email: "operator@fixture.invalid", color: "#7b68ee", profilePicture: null },
    assignees: [],
    due_date: null,
    start_date: null,
    url: `https://app.clickup.com/t/${overrides.id}`,
    folder: { id: "fo_a_1", name: "Fixture folder", hidden: false, access: true },
    space: { id: "sp_a_1" },
    custom_fields: [],
    ...overrides,
  };
}

const alphaBugsList = { id: "li_a_bugs", name: "Fixture bugs", access: true };
const alphaFollowUpList = { id: "li_a_follow", name: "Fixture follow-ups", access: true };

/** A linked task the tests complete remotely by swapping in `alphaExportBugDone`. */
export const alphaExportBug = task({
  id: "86a0exp01",
  name: "Fixture: export fails for large accounts",
  status: ALPHA_STATUSES.doing,
  assignees: [alphaOperator, alphaColleague],
  due_date: "1761868800000",
  list: alphaBugsList,
  team_id: ALPHA_WORKSPACE_ID,
});

export const alphaExportBugDone: FixtureTask = {
  ...alphaExportBug,
  status: ALPHA_STATUSES.complete,
  date_updated: "1760100000000",
  date_closed: "1760100000000",
  date_done: "1760100000000",
};

export const alphaInvoiceTask = task({
  id: "86a0inv02",
  custom_id: "FIX-42",
  name: "Fixture: resend invoice copy",
  status: ALPHA_STATUSES.todo,
  assignees: [alphaColleague],
  list: alphaFollowUpList,
  team_id: ALPHA_WORKSPACE_ID,
});

/** A task whose remote text tries to look like markup and smuggle control characters. */
export const alphaHostileTask = task({
  id: "86a0hst03",
  name: "<img src=x onerror=alert(1)>‮evil\u0007 name",
  status: { ...ALPHA_STATUSES.todo, color: "red;background:url(javascript:alert(1))" },
  url: "javascript:alert(1)",
  list: alphaBugsList,
  team_id: ALPHA_WORKSPACE_ID,
});

export const alphaWorkspace: ClickUpFixtureWorkspace = {
  id: ALPHA_WORKSPACE_ID,
  name: "Fixture Workspace Alpha",
  members: [alphaOperator, alphaColleague],
  spaces: [
    {
      id: "sp_a_1",
      name: "Fixture space",
      statuses: [ALPHA_STATUSES.todo, ALPHA_STATUSES.doing, ALPHA_STATUSES.complete],
      folders: [
        {
          id: "fo_a_1",
          name: "Fixture folder",
          hidden: false,
          lists: [{ id: alphaBugsList.id, name: alphaBugsList.name, orderindex: 0, archived: false }],
        },
      ],
      folderlessLists: [
        {
          id: alphaFollowUpList.id,
          name: alphaFollowUpList.name,
          orderindex: 1,
          archived: false,
          statuses: [ALPHA_STATUSES.todo, status("sc_a_4", "fixture waiting on vendor", "custom", 1, "#f9d900"), ALPHA_STATUSES.complete],
        },
      ],
    },
  ],
  fields: {
    [alphaBugsList.id]: [ticketIdField, effortField],
    [alphaFollowUpList.id]: [ticketIdField],
  },
  tasks: [alphaExportBug, alphaInvoiceTask, alphaHostileTask],
};

const betaOperator: FixtureUser = {
  id: 801,
  username: "Fixture Beta Operator",
  email: "beta-operator@fixture.invalid",
  color: "#0091ff",
  initials: "FB",
  profilePicture: null,
};

export const betaTask = task({
  id: "86b0bet01",
  name: "Fixture: beta workspace task",
  status: status("sc_b_1", "fixture beta open", "open", 0, "#87909e"),
  list: { id: "li_b_1", name: "Fixture beta list", access: true },
  space: { id: "sp_b_1" },
  team_id: BETA_WORKSPACE_ID,
});

export const betaWorkspace: ClickUpFixtureWorkspace = {
  id: BETA_WORKSPACE_ID,
  name: "Fixture Workspace Beta",
  members: [betaOperator],
  spaces: [
    {
      id: "sp_b_1",
      name: "Fixture beta space",
      statuses: [betaTask.status],
      folders: [],
      folderlessLists: [{ id: "li_b_1", name: "Fixture beta list", orderindex: 0, archived: false }],
    },
  ],
  fields: { li_b_1: [] },
  tasks: [betaTask],
};

export const clickupTokens: Record<string, ClickUpFixtureToken> = {
  [ALPHA_TOKEN]: { user: alphaOperator, workspaces: [alphaWorkspace] },
  [BETA_TOKEN]: { user: betaOperator, workspaces: [betaWorkspace] },
};
