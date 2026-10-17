import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";
import { AuthExpiredBanner } from "./AuthExpiredBanner";
import { useAccountStore } from "@/stores/accountStore";
import { clearAuthExpired, reportAuthExpired } from "@/services/authNotice";
const mocks = vi.hoisted(() => ({ gmail: vi.fn(), getAccount: vi.fn(), repair: vi.fn() }));
vi.mock("@/services/gmail/tokenManager", () => ({ reauthorizeAccount: mocks.gmail }));
vi.mock("@/services/db/accounts", () => ({ getAccount: mocks.getAccount }));
vi.mock("@/services/imap/repairCredentials", () => ({ repairImapCredentials: mocks.repair }));
beforeEach(() => {
  vi.resetAllMocks(); clearAuthExpired();
  mocks.repair.mockResolvedValue(undefined);
  useAccountStore.setState({ accounts: [{ id: "imap-a", email: "a@example.com", provider: "imap", displayName: null, avatarUrl: null, isActive: true }], activeAccountId: "another-account" });
  reportAuthExpired("imap-a");
});
it("repairs the failed IMAP account even when a different account is active", async () => {
  mocks.getAccount.mockResolvedValue({ auth_method: "password" });
  render(<AuthExpiredBanner />);
  fireEvent.click(screen.getByRole("button", { name: "Repair credentials" }));
  const input = await screen.findByLabelText("Mailbox password or app password");
  fireEvent.change(input, { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  await waitFor(() => expect(mocks.repair).toHaveBeenCalledWith("imap-a", "secret"));
  expect(mocks.gmail).not.toHaveBeenCalled();
});
it("starts IMAP's configured OAuth repair without asking for a password", async () => {
  mocks.getAccount.mockResolvedValue({ auth_method: "oauth2" });
  render(<AuthExpiredBanner />);
  fireEvent.click(screen.getByRole("button", { name: "Repair credentials" }));
  await waitFor(() => expect(mocks.repair).toHaveBeenCalledWith("imap-a"));
  expect(mocks.gmail).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Mailbox password or app password")).not.toBeInTheDocument();
});
