import Link from "next/link";
import { DumplingMark } from "@/components/brand";

export const metadata = { title: "Pricing — Mem·Sum" };

// The numbers here are the numbers the database enforces: a kernel-side test
// pins this page to the pilot_limits() migration, so pricing can never claim
// looser limits than the graph applies.

export default function PricingPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-16">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <DumplingMark size={30} />
          <h1 className="text-2xl font-semibold tracking-tight">Pricing</h1>
        </div>
        <p className="text-lg opacity-80">Free while Mem·Sum is in beta. One plan, no card, no meter running.</p>
        <Link className="text-sm underline opacity-70" href="/">
          ← Back to Mem·Sum
        </Link>
      </div>

      <section className="flex flex-col gap-4 rounded-xl border border-black/15 p-6 dark:border-white/20">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-xl font-semibold">Free beta</h2>
          <span className="rounded-full bg-accent-gold/25 px-2.5 py-0.5 text-sm font-medium">$0</span>
          <span className="text-sm opacity-60">invitation-only</span>
        </div>
        <p className="opacity-80">
          Everything the product does: sums for just you or for up to five people, every member through their
          own AI assistant or chatbot, opt-in text pings, and open-format export of everything, always.
        </p>
        <div>
          <h3 className="font-semibold">Beta limits</h3>
          <p className="mt-1 text-sm opacity-60">
            Generous for real use, bounded against runaway agents. The same numbers are enforced by the
            database and shown on your account page.
          </p>
          <ul className="mt-2 flex flex-col gap-1 opacity-80">
            <li>10 sums created per account, 2–5 people in each.</li>
            <li>Per sum, per day: 200 updates, 500 messages, 50 reminders.</li>
            <li>500 pages per sum, 256 KB per page.</li>
          </ul>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">After the beta</h2>
        <p className="opacity-80">
          Paid plans will exist someday; their shape isn&apos;t settled and we won&apos;t pretend otherwise.
          What we can promise now: you&apos;ll hear well in advance, nothing changes without notice, and the
          export button means you are never stuck here. That&apos;s the point of it.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Run it yourself</h2>
        <p className="opacity-80">
          The software is free: Mem·Sum&apos;s kernel is open source under Apache-2.0, and we
          genuinely encourage you to run your own for your own people. What the hosted version charges for —
          someday — is the work: hosting, backups, uptime, support, and SMS compliance (your own toll-free
          number and carrier approval, if you want texts). Same code, same open format either way; sums you run
          and sums we host can trade pages through the same export bundles.{" "}
          <Link className="underline" href="/open">
            More on the open kernel
          </Link>
          .
        </p>
      </section>

      <p className="text-sm opacity-60">
        <Link className="underline" href="/tools">
          What your AI can do
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
