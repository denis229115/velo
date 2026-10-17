import { useState, useSyncExternalStore } from "react";
import { useAccountStore } from "@/stores/accountStore";
import { reauthorizeAccount } from "@/services/gmail/tokenManager";
import { clearAuthExpired, getAuthExpired, subscribeAuthExpired } from "@/services/authNotice";

/** Shown when a mailbox rejects the saved sign-in. Signing in again clears it. */
export function AuthExpiredBanner() {
  const accountId = useSyncExternalStore(subscribeAuthExpired, getAuthExpired, () => null);
  const accounts = useAccountStore((s) => s.accounts);
  const [busy, setBusy] = useState(false);
  const account = accounts.find((item) => item.id === accountId);
  if (!accountId) return null;

  return (
    <div role="alert" className="flex items-center justify-between gap-3 border-b border-separator bg-surface-subtle px-3 py-2 text-row text-text-primary">
      <span>{account?.email ?? "An account"} needs to sign in again.</span>
      <button
        type="button"
        disabled={!account || busy}
        className="shrink-0 font-medium text-accent disabled:opacity-50"
        onClick={() => {
          if (!account) return;
          setBusy(true);
          void reauthorizeAccount(account.id, account.email)
            .then(() => clearAuthExpired())
            .catch(() => setBusy(false));
        }}
      >
        Sign in again
      </button>
    </div>
  );
}
