import { loadRecipientZone } from "./recipientZone";
import { getLatestInboundDateHeader } from "./db/messages";
import { getContactByEmail, setContactTimezone } from "./db/contacts";

vi.mock("./db/messages", () => ({ getLatestInboundDateHeader: vi.fn() }));
vi.mock("./db/contacts", () => ({ getContactByEmail: vi.fn(), setContactTimezone: vi.fn(async () => {}) }));

it("uses the mailbox-scoped latest inbound header and caches its offset on the contact", async () => {
  vi.mocked(getContactByEmail).mockResolvedValue({ display_name: "Ada" } as Awaited<ReturnType<typeof getContactByEmail>>);
  vi.mocked(getLatestInboundDateHeader).mockResolvedValue("Sat, 17 Oct 2026 09:00:00 +0530");
  expect(await loadRecipientZone("mailbox", "ada-zone@example.test")).toEqual({ name: "Ada", offsetMinutes: 330 });
  expect(getLatestInboundDateHeader).toHaveBeenCalledWith("mailbox", "ada-zone@example.test");
  expect(setContactTimezone).toHaveBeenCalledWith("ada-zone@example.test", 330);
});

it("falls back to the stored contact offset when no inbound header exists", async () => {
  vi.mocked(getContactByEmail).mockResolvedValue({ display_name: null, timezone_offset_minutes: -240 } as Awaited<ReturnType<typeof getContactByEmail>>);
  vi.mocked(getLatestInboundDateHeader).mockResolvedValue(null);
  expect(await loadRecipientZone(null, "fallback-zone@example.test")).toEqual({ name: "fallback-zone", offsetMinutes: -240 });
});
