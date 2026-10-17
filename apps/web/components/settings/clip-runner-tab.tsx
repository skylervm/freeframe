"use client";

import * as React from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { copyToClipboard } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/stores/auth-store";
import { SAVE_COMMAND } from "./clip-runner-save-command";

const TOKENS_KEY = "/clip-runner-tokens";
const MAX_LIFETIME_DAYS = 365;
interface ClipRunnerToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

interface CreatedClipRunnerToken {
  id: string;
  name: string;
  created_at: string;
  expires_at: string;
  token: string;
}

// UTC calendar dates, so "date + 23:59:59Z" stays inside the server's 366-day cap in every timezone.
function utcDatePlusDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "Never";
}

export function ClipRunnerTab() {
  const { isSuperAdmin } = useAuthStore();
  const { data: tokens, mutate } = useSWR<ClipRunnerToken[]>(
    isSuperAdmin ? TOKENS_KEY : null,
    () => api.get<ClipRunnerToken[]>(TOKENS_KEY),
  );
  const maxDate = React.useMemo(() => utcDatePlusDays(MAX_LIFETIME_DAYS), []);
  const minDate = React.useMemo(() => utcDatePlusDays(1), []);
  const [name, setName] = React.useState("Mac clip runner");
  const [expiresOn, setExpiresOn] = React.useState(maxDate);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState("");
  // The new secret lives only here: never in SWR, storage, the URL, or a log.
  const [createdToken, setCreatedToken] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  if (!isSuperAdmin) return null;

  const expiryValid = Boolean(expiresOn) && expiresOn >= minDate && expiresOn <= maxDate;

  const dismiss = () => {
    setCreatedToken(null);
    setCopied(false);
  };

  const createToken = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!expiryValid) return;
    setCreating(true);
    setError("");
    try {
      const created = await api.post<CreatedClipRunnerToken>(TOKENS_KEY, {
        name: name.trim(),
        expires_at: `${expiresOn}T23:59:59Z`,
      });
      setCopied(false);
      setCreatedToken(created.token);
      // Revalidate the list from the server; never seed the cache with the response.
      await mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create token");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: ClipRunnerToken) => {
    if (!window.confirm(`Revoke ${token.name}? The Mac clip runner will stop rendering until it has a new token.`)) return;
    setError("");
    try {
      await api.delete(`${TOKENS_KEY}/${token.id}`);
      await mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke token");
    }
  };

  const copy = async () => {
    if (createdToken && (await copyToClipboard(createdToken))) setCopied(true);
  };

  return (
    <section className="space-y-5 max-w-2xl">
      <div>
        <h2 className="text-sm font-semibold text-text-primary">Clip runner</h2>
        <p className="mt-1 text-sm text-text-secondary">
          One token for the Mac that renders clips. It can only list, claim and finish clip render jobs, and only in
          projects where you are an owner or editor.
        </p>
      </div>

      {createdToken && (
        <div role="region" aria-label="New clip runner token" className="rounded-lg border border-accent bg-bg-secondary p-4 space-y-3">
          <p className="text-sm font-medium text-text-primary">Save this token now. It is shown only once.</p>
          <code data-testid="clip-runner-secret" className="block break-all rounded-md bg-bg-tertiary p-3 font-mono text-xs text-text-primary">
            {createdToken}
          </code>
          <ol className="list-decimal pl-5 text-sm text-text-secondary space-y-1">
            <li>Press Copy to copy the token.</li>
            <li>
              On the Mac, open Terminal and run this one line:{" "}
              <code className="font-mono text-xs text-text-primary">{SAVE_COMMAND}</code>
            </li>
            <li>Never paste the token into a chat, a ticket, or an email.</li>
          </ol>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button size="sm" onClick={dismiss}>
              Done
            </Button>
          </div>
        </div>
      )}

      <form onSubmit={createToken} className="flex flex-wrap items-end gap-2">
        <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Token name" maxLength={255} />
        <Input
          type="date"
          value={expiresOn}
          min={minDate}
          max={maxDate}
          onChange={(event) => setExpiresOn(event.target.value)}
          aria-label="Token expiry"
        />
        <Button type="submit" size="sm" disabled={creating || !name.trim() || !expiryValid}>
          {creating ? "Creating…" : "Create token"}
        </Button>
      </form>
      {error && <p className="text-sm text-status-error">{error}</p>}

      {tokens?.length ? (
        <div className="rounded-lg border border-border divide-y divide-border">
          {tokens.map((token) => (
            <div key={token.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{token.name}</p>
                <p className="text-xs text-text-tertiary">
                  Created {formatDate(token.created_at)} · Last used {formatDate(token.last_used_at)} ·{" "}
                  {token.revoked_at ? "Revoked" : `Expires ${formatDate(token.expires_at)}`}
                </p>
              </div>
              {!token.revoked_at && (
                <Button variant="ghost" size="sm" onClick={() => revoke(token)} className="text-status-error hover:text-status-error">
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-tertiary">No clip runner tokens yet.</p>
      )}
    </section>
  );
}
