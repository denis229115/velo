import { getAccount, updateAccountAllTokens } from "../db/accounts";
import { getDb } from "../db/connection";
import { encryptValue } from "@/utils/crypto";
import { invalidateProviderConfig } from "../email/providerFactory";
import { buildImapConfig } from "./imapConfigBuilder";
import { imapTestConnection } from "./tauriCommands";
import { getOAuthProvider } from "../oauth/providers";
import { startProviderOAuthFlow } from "../oauth/oauthFlow";

/** Repair the existing mailbox; never create a second account or use Gmail OAuth. */
export async function repairImapCredentials(accountId: string, password?: string): Promise<void> {
  const account = await getAccount(accountId);
  if (!account || account.provider !== "imap") throw new Error("IMAP account not found");
  if (account.auth_method === "oauth2") {
    const provider = getOAuthProvider(account.oauth_provider ?? "");
    if (!provider || !account.oauth_client_id) throw new Error("The account's OAuth provider configuration is missing");
    const { tokens, userInfo } = await startProviderOAuthFlow(provider, account.oauth_client_id, account.oauth_client_secret ?? undefined);
    if (userInfo.email.toLowerCase() !== account.email.toLowerCase()) throw new Error("Sign in with the same mailbox to repair this account");
    await updateAccountAllTokens(accountId, tokens.access_token, tokens.refresh_token ?? account.refresh_token ?? "", Math.floor(Date.now() / 1000) + tokens.expires_in);
  } else {
    if (!password) throw new Error("Enter the mailbox password or app password");
    await imapTestConnection(buildImapConfig({ ...account, imap_password: password }));
    const db = await getDb();
    await db.execute("UPDATE accounts SET imap_password = $1, updated_at = unixepoch() WHERE id = $2", [await encryptValue(password), accountId]);
  }
  invalidateProviderConfig(accountId);
}
