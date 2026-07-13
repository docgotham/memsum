import Link from "next/link";
import { ConnectorTokens } from "./tokens";

export const metadata = { title: "Connect your AI — Mem·Sum" };

const MCP_URL = process.env.NEXT_PUBLIC_MCP_URL ?? "https://sum.memsum.ai/mcp";

export default function ConnectPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Connect your AI</h1>
        <p className="opacity-80">
          Mem·Sum works inside the AI you already use. Add one connector, sign in, and your agent can read and
          write the sums you belong to.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Your connector URL</h2>
        <code className="overflow-x-auto rounded-lg border border-black/20 px-4 py-3 text-sm dark:border-white/25">
          {MCP_URL}
        </code>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Claude</h2>
        <ol className="list-decimal space-y-1 pl-5 opacity-90">
          <li>Open Settings → Connectors → Add custom connector.</li>
          <li>Name it Mem·Sum and paste the connector URL above. Leave the OAuth fields blank.</li>
          <li>Click Connect, then sign in with your Mem·Sum email and password.</li>
          <li>
            In a conversation, start with a read-only question: <em>&ldquo;+sum what do we have so far?&rdquo;</em>
          </li>
        </ol>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">ChatGPT</h2>
        <ol className="list-decimal space-y-1 pl-5 opacity-90">
          <li>Open Settings → Connectors and add a new MCP server.</li>
          <li>Paste the connector URL above and approve the OAuth prompt by signing in.</li>
          <li>
            Ask a read-only question first: <em>&ldquo;+sum what are we tracking right now?&rdquo;</em>
          </li>
        </ol>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Claude Code</h2>
        <ol className="list-decimal space-y-1 pl-5 opacity-90">
          <li>
            In a terminal:{" "}
            <code className="rounded bg-black/5 px-1.5 py-0.5 text-sm dark:bg-white/10">
              claude mcp add --transport http memsum {MCP_URL}
            </code>
          </li>
          <li>The first use opens a sign-in in your browser — approve it and you&apos;re connected.</li>
          <li>
            Prefer a key instead? Create a connector token below and add it as a header:{" "}
            <code className="rounded bg-black/5 px-1.5 py-0.5 text-sm dark:bg-white/10">
              --header &quot;Authorization: Bearer memsum_…&quot;
            </code>
          </li>
        </ol>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Cursor</h2>
        <ol className="list-decimal space-y-1 pl-5 opacity-90">
          <li>Open Settings → MCP (or edit <code className="rounded bg-black/5 px-1.5 py-0.5 text-sm dark:bg-white/10">~/.cursor/mcp.json</code>) and add a server.</li>
          <li>
            Use the connector URL above:{" "}
            <code className="rounded bg-black/5 px-1.5 py-0.5 text-sm dark:bg-white/10">
              {`{"mcpServers":{"memsum":{"url":"${MCP_URL}"}}}`}
            </code>
          </li>
          <li>Approve the sign-in prompt when Cursor first connects.</li>
        </ol>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Perplexity</h2>
        <ol className="list-decimal space-y-1 pl-5 opacity-90">
          <li>Create a connector token below and copy it.</li>
          <li>Add a connector with the URL above, and where it asks for authentication, use a header:</li>
          <li>
            <code className="rounded bg-black/5 px-1.5 py-0.5 text-sm dark:bg-white/10">
              Authorization: Bearer memsum_…
            </code>{" "}
            — then ask something read-only first.
          </li>
        </ol>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Any other MCP client</h2>
        <p className="opacity-90">
          Mem·Sum is a standard remote MCP server (streamable HTTP). Point your client at the connector URL
          above; if it can do OAuth it will walk you through sign-in, and if it can&apos;t, paste a connector
          token from the section below as an <code className="rounded bg-black/5 px-1.5 py-0.5 text-sm dark:bg-white/10">Authorization: Bearer</code>{" "}
          header. Exact menus vary by client and version — the URL and the token are the only two facts you need.
        </p>
      </div>

      <ConnectorTokens />

      <p className="text-sm opacity-60">
        Your AI client receives OAuth tokens, never your password.{" "}
        <Link className="underline" href="/tools">
          See everything your AI can do here
        </Link>
        .
      </p>

      <Link className="text-sm underline opacity-70" href="/">
        ← Back to Mem·Sum
      </Link>
    </main>
  );
}
