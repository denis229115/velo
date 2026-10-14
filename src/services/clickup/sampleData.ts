import type { ClickUpList } from "./metadata";

/**
 * Stand-in lists shown until a workspace is connected. Every place that shows
 * them marks them Sample; they are never presented as the operator's lists.
 */
export const SAMPLE_LISTS: ClickUpList[] = [
  {
    listId: "sample-list-1",
    name: "Sample list one",
    spaceName: "Sample space",
    folderName: null,
    position: 0,
    statuses: [
      { name: "sample to do", type: "open", color: null, position: 0 },
      { name: "sample in progress", type: "custom", color: null, position: 1 },
      { name: "sample done", type: "closed", color: null, position: 2 },
    ],
  },
  {
    listId: "sample-list-2",
    name: "Sample list two",
    spaceName: "Sample space",
    folderName: "Sample folder",
    position: 1,
    statuses: [
      { name: "sample open", type: "open", color: null, position: 0 },
      { name: "sample closed", type: "closed", color: null, position: 1 },
    ],
  },
];
