import Link from "next/link";
import { DumplingMark } from "@/components/brand";

export const metadata = { title: "The beta — Mem·Sum" };

// The numbers here are the numbers the database enforces: a kernel-side test
// pins this page to the pilot_limits() migration, so this page can never
// claim looser limits than the graph applies. The same test pins the framing:
// this page describes a beta and never talks about money — no plans, no
// prices, no someday. (Decided 2026-07-19; /pricing permanently redirects
// here.)

export default function BetaPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-16">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <DumplingMark size={30} />
          <h1 className="text-2xl font-semibold tracking-tight">The beta</h1>
        </div>
        <p className="text-lg opacity-80">
          Mem·Sum is in beta — invitation-only, the whole product, honestly bounded.
        </p>
        <Link className="text-sm underline opacity-70" href="/">
          ← Back to Mem·Sum
        </Link>
      </div>

      <section className="flex flex-col gap-4 rounded-xl border border-black/15 p-6 dark:border-white/20">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-xl font-semibold">What the beta includes</h2>
          <span className="rounded-full bg-accent-gold/25 px-2.5 py-0.5 text-sm font-medium">invitation-only</span>
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
        <h2 className="text-xl font-semibold">Beta terms, plainly</h2>
        <p className="opacity-80">
          A beta changes; you&apos;ll hear before anything meaningful does. Your material is yours: export is
          self-serve and complete, deletion is real, and the export button means you are never stuck here.
          That&apos;s the point of it. The fine print lives in the{" "}
          <Link className="underline" href="/terms">
            terms
          </Link>{" "}
          and the{" "}
          <Link className="underline" href="/privacy">
            privacy page
          </Link>
          , written in the same plain language.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Why free?</h2>
        <p className="opacity-80">
          Because this beta is a UX playground. Mem·Sum is built and run by{" "}
          <a className="underline" href="https://aftertheapp.com/" rel="noopener" target="_blank">
            Dave Gilbert
          </a>
          , a product developer and user-experience researcher, and what he wants from it is what a beta is
          actually for: real people and their own assistants, sharing memory for real things, and the lessons
          that only come from watching that honestly. If you want to give Dave feedback — how he can improve
          it, or just what you think of it — reach out through his site,{" "}
          <a className="underline" href="https://aftertheapp.com/" rel="noopener" target="_blank">
            aftertheapp.com
          </a>
          .
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Run it yourself</h2>
        <p className="opacity-80">
          The software is free: Mem·Sum&apos;s kernel is open source under Apache-2.0, and we
          genuinely encourage you to run your own for your own people. The hosted service is the same code
          operated for you — hosting, backups, uptime, and SMS compliance (your own toll-free number and
          carrier approval, if you want texts) are the work it does on your behalf. Same code, same open
          format either way; sums you run and sums we host can trade pages through the same export
          bundles.{" "}
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
