import Link from "next/link";
import { DumplingMark } from "@/components/brand";

export const metadata = { title: "What your AI can do — Mem·Sum" };

// The catalog mirrors the kernel's real tool registry and its MCP safety
// annotations; a kernel-side test pins every tool name on this page to the
// live list so the two can never drift.

const READ_CHIP = (
  <span className="rounded-full border border-black/20 px-2 py-0.5 text-xs font-medium dark:border-white/25">
    Read-only
  </span>
);
const WRITE_CHIP = (
  <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-foreground">
    Writes to the sum
  </span>
);
const TEXT_CHIP = (
  <span className="rounded-full bg-accent-gold/25 px-2 py-0.5 text-xs font-medium text-foreground">
    May send a text
  </span>
);

const READERS: Array<{ tool: string; title: string; blurb: string }> = [
  {
    tool: "get_dmsum_home",
    title: "Get oriented",
    blurb: "Which sums you belong to, who is in each, and the exact handles to use."
  },
  {
    tool: "get_dmsum_instructions",
    title: "Read the house rules",
    blurb: "The operating contract every assistant follows here — how to read before writing, when a text is allowed, how to relay a rejection."
  },
  {
    tool: "list_relationship_contexts",
    title: "List your sums",
    blurb: "Your sums and their members, in one listing."
  },
  {
    tool: "get_relationship_context",
    title: "Look at one sum",
    blurb: "The members and details of a single sum."
  },
  {
    tool: "resolve_contact",
    title: "Resolve a handle",
    blurb: "Turns an @handle into the right person in the right sum, instead of guessing."
  },
  {
    tool: "read_page",
    title: "Read a page",
    blurb: "One page of the shared record, with its links."
  },
  {
    tool: "list_pages",
    title: "List pages",
    blurb: "The shared record's table of contents."
  },
  {
    tool: "search_pages",
    title: "Search pages",
    blurb: "Finds pages by the words in them."
  },
  {
    tool: "list_activity",
    title: "Review activity",
    blurb: "What happened in a time window: what changed, what was sent, whether a text went out."
  }
];

const WRITERS: Array<{ tool: string; title: string; blurb: string; sms: boolean }> = [
  {
    tool: "create_relationship_context",
    title: "Start a sum",
    blurb: "Creates a new sum with you as its owner. Nothing is shared until you invite someone.",
    sms: false
  },
  {
    tool: "commit_interaction",
    title: "Record your words",
    blurb: "Keeps what you said, verbatim, in the sum's ledger — and can relay a direct message to another member as a one-way text.",
    sms: true
  },
  {
    tool: "commit_update_batch",
    title: "Publish an update",
    blurb: "Writes page and preference changes as one all-or-nothing batch, and can ping members you name. Stale drafts are rejected, never merged over newer work.",
    sms: true
  },
  {
    tool: "create_reminder",
    title: "Schedule a reminder",
    blurb: "A reminder text you explicitly asked for, delivered at the time you chose.",
    sms: true
  }
];

export default function ToolsPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-16">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <DumplingMark size={30} />
          <h1 className="text-2xl font-semibold tracking-tight">What your AI can do here</h1>
        </div>
        <p className="opacity-80">
          An assistant connected to Mem·Sum gets exactly thirteen tools — nine that read, four that write. Every
          one is listed below with its safety label, the same labels the assistants themselves are shown.
        </p>
        <Link className="text-sm underline opacity-70" href="/">
          ← Back to Mem·Sum
        </Link>
      </div>

      <section className="flex flex-col gap-3 rounded-xl bg-accent-tint p-5">
        <h2 className="font-semibold">The guarantees behind every label</h2>
        <ul className="flex flex-col gap-1 text-sm opacity-80">
          <li>No tool deletes a sum, a page&apos;s history, or anyone&apos;s account. Deletion lives on this dashboard, behind your own sign-in.</li>
          <li>No tool reaches beyond the sums you belong to — isolation is enforced by the database, not by good manners.</li>
          <li>Texts go only to members who verified their number and opted in, only when explicitly asked, and every message says who it&apos;s from. Reply STOP any time.</li>
          <li>Writes are atomic and version-checked: an assistant working from a stale view is rejected and must reread, never overwrite.</li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Reading</h2>
        <ul className="flex flex-col gap-2">
          {READERS.map((item) => (
            <li className="rounded-xl border border-black/15 p-4 dark:border-white/20" key={item.tool}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{item.title}</h3>
                {READ_CHIP}
              </div>
              <p className="mt-1 text-sm opacity-80">{item.blurb}</p>
              <code className="mt-1 block text-xs opacity-50">{item.tool}</code>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Writing</h2>
        <ul className="flex flex-col gap-2">
          {WRITERS.map((item) => (
            <li className="rounded-xl border border-black/15 p-4 dark:border-white/20" key={item.tool}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{item.title}</h3>
                {WRITE_CHIP}
                {item.sms ? TEXT_CHIP : null}
              </div>
              <p className="mt-1 text-sm opacity-80">{item.blurb}</p>
              <code className="mt-1 block text-xs opacity-50">{item.tool}</code>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-sm opacity-60">
        Ready to connect?{" "}
        <Link className="underline" href="/connect">
          Set up your assistant
        </Link>{" "}
        ·{" "}
        <Link className="underline" href="/terms">
          Terms
        </Link>{" "}
        ·{" "}
        <Link className="underline" href="/privacy">
          Privacy
        </Link>
      </p>
    </main>
  );
}
