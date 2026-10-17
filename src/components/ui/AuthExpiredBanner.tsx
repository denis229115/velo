import { useState, useSyncExternalStore } from "react";
import { useAccountStore } from "@/stores/accountStore";
import { repairImapCredentials } from "@/services/imap/repairCredentials";
import { getAccount } from "@/services/db/accounts";
import { reauthorizeAccount } from "@/services/gmail/tokenManager";
import { clearAuthExpired, getAuthExpired, subscribeAuthExpired } from "@/services/authNotice";

/** Shown when a mailbox rejects its saved credentials. */
export function AuthExpiredBanner() {
  const accountId = useSyncExternalStore(subscribeAuthExpired, getAuthExpired, () => null);
  return accountId ? <AccountAuthRepair key={accountId} accountId={accountId} /> : null;
}

function AccountAuthRepair({ accountId }: { accountId: string }) {
  const account = useAccountStore((state) => state.accounts.find((item) => item.id === accountId));
  const [repair, setRepair] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = () => {
    setPassword("");
    setRepair(false);
    // A second mailbox may have reported an auth error while this one connected.
    if (getAuthExpired() === accountId) clearAuthExpired();
  };

  const reconnect = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      if (account.provider === "imap") {
        const saved = await getAccount(account.id);
        if (!saved) throw new Error("The mailbox was removed");
        if (saved.auth_method === "oauth2") {
          await repairImapCredentials(account.id);
          finish();
        } else setRepair(true);
      } else {
        await reauthorizeAccount(account.id, account.email);
        finish();
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    setBusy(true);
    setError(null);
    try {
      await repairImapCredentials(accountId, password);
      finish();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-separator bg-surface-subtle px-3 py-2 text-row text-text-primary">
      <span>{account?.email ?? "An account"} needs to sign in again.</span>
      {repair && (
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void savePassword(); }}>
          <input
            type="password"
            aria-label="Mailbox password or app password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            className="rounded border border-separator bg-surface-reader px-2 py-1"
          />
          <button type="submit" disabled={busy || !password} className="font-medium text-accent disabled:opacity-50">Save credentials</button>
        </form>
      )}
      {error && <span role="alert">{error}</span>}
      {!repair && (
        <button type="button" disabled={!account || busy} className="shrink-0 font-medium text-accent disabled:opacity-50" onClick={() => void reconnect()}>
          {account?.provider === "imap" ? "Repair credentials" : "Sign in again"}
        </button>
      )}
    </div>
  );
}
