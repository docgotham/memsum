import Link from "next/link";
import { ConnectorTokens } from "../connect/tokens";
import { OAuthGrants } from "./grants";

export const metadata = { title: "Connected apps — Mem·Sum" };

export default function ConnectionsPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium uppercase tracking-wide opacity-60">Account access</p>
        <h1 className="text-2xl font-semibold tracking-tight">Connected apps</h1>
        <p className="opacity-80">
          Everything that can act as you here, in one place: chatbot clients connected by OAuth, and
          the connector tokens you have issued. Revoking one immediately invalidates that
          client&apos;s sessions and refresh tokens. It does not delete your account, your sums, or
          anything in them — reconnecting just requires your consent again.
        </p>
      </div>

      <OAuthGrants />

      <ConnectorTokens />

      <p className="text-sm opacity-60">
        Looking to connect something new? The setup guides live on{" "}
        <Link className="underline" href="/connect">
          Connect your AI
        </Link>
        .
      </p>
    </main>
  );
}
