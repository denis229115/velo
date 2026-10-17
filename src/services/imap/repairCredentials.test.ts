import { vi, describe, it, expect, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ account: vi.fn(), tokens: vi.fn(), execute: vi.fn(), test: vi.fn(), invalidate: vi.fn(), oauth: vi.fn() }));
vi.mock("../db/accounts", () => ({ getAccount: mocks.account, updateAccountAllTokens: mocks.tokens }));
vi.mock("../db/connection", () => ({ getDb: async () => ({ execute: mocks.execute }) }));
vi.mock("@/utils/crypto", () => ({ encryptValue: async (value: string) => `encrypted:${value}` }));
vi.mock("../email/providerFactory", () => ({ invalidateProviderConfig: mocks.invalidate }));
vi.mock("./tauriCommands", () => ({ imapTestConnection: mocks.test }));
vi.mock("../oauth/oauthFlow", () => ({ startProviderOAuthFlow: mocks.oauth }));
import { repairImapCredentials } from "./repairCredentials";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.account.mockResolvedValue({ id: "imap-a", provider: "imap", email: "a@example.com", imap_host: "imap.example.com", auth_method: "password" });
});
describe("IMAP credential repair", () => {
  it("tests and encrypts the replacement password on the original account", async () => {
    await repairImapCredentials("imap-a", "new secret");
    expect(mocks.test).toHaveBeenCalledWith(expect.objectContaining({ host: "imap.example.com", username: "a@example.com", password: "new secret", auth_method: "password" }));
    expect(mocks.execute).toHaveBeenCalledWith(expect.stringContaining("UPDATE accounts SET imap_password"), ["encrypted:new secret", "imap-a"]);
    expect(mocks.invalidate).toHaveBeenCalledWith("imap-a");
    expect(mocks.oauth).not.toHaveBeenCalled();
  });
  it("keeps the saved credential if authentication is refused", async () => {
    mocks.test.mockRejectedValue(new Error("login failed"));
    await expect(repairImapCredentials("imap-a", "bad")).rejects.toThrow("login failed");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("uses the saved OAuth provider and refuses a different mailbox", async () => {
    mocks.account.mockResolvedValue({ provider: "imap", auth_method: "oauth2", oauth_provider: "microsoft", oauth_client_id: "client", email: "a@example.com" });
    mocks.oauth.mockResolvedValue({ tokens: { access_token: "token", expires_in: 3600 }, userInfo: { email: "b@example.com" } });
    await expect(repairImapCredentials("imap-a")).rejects.toThrow("same mailbox");
    expect(mocks.oauth).toHaveBeenCalledWith(expect.objectContaining({ id: "microsoft" }), "client", undefined);
    expect(mocks.tokens).not.toHaveBeenCalled();
  });
});
