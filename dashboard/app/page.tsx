"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DumplingMark } from "@/components/brand";
import { WaitlistForm } from "@/components/waitlist-form";
import { supabaseBrowser } from "@/lib/supabase";

export default function HomePage() {
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabaseBrowser()
      .auth.getSession()
      .then(({ data }) => {
        setEmail(data.session?.user.email ?? null);
        setReady(true);
      });
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-14 px-6 py-16">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl font-semibold tracking-tight">Shared memory for the people who matter.</h1>
          <p className="text-lg opacity-80">
            Mem·Sum gives you one real memory — private to just you, or shared by up to five people: partners, a
            family, a small working crew — each of you through your own AI assistant or chatbot. Agents read
            selectively, draft privately, and publish updates everyone in the sum can see. The server keeps the
            record and has no opinions.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            className="rounded-lg bg-accent px-4 py-2 font-medium text-accent-contrast transition-colors hover:bg-accent-deep hover:text-accent-tint"
            href="/connect"
          >
            Connect your AI
          </Link>
          {ready && email ? (
            <Link
              className="rounded-lg border border-black/20 px-4 py-2 font-medium dark:border-white/25"
              href="/sums"
            >
              Your sums
            </Link>
          ) : ready ? (
            <Link
              className="rounded-lg border border-black/20 px-4 py-2 font-medium dark:border-white/25"
              href="/login"
            >
              Sign in
            </Link>
          ) : null}
        </div>
        {ready && email ? (
          <p className="text-sm opacity-70">
            Signed in as {email} ·{" "}
            <Link className="underline" href="/account">
              Your account
            </Link>
          </p>
        ) : (
          <section
            className="flex flex-col gap-3 rounded-xl border border-black/15 p-5 dark:border-white/20"
            id="waitlist"
          >
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Link
                className="rounded-full bg-accent-gold/25 px-2.5 py-0.5 font-medium text-foreground transition-colors hover:bg-accent-gold/40"
                href="/beta"
              >
                In beta
              </Link>
              <span className="opacity-60">
                Invitation-only for now — if someone shared a sum with you, open the invite link they sent.
              </span>
            </p>
            <p className="opacity-80">
              No invite yet? Leave your email and we&apos;ll send one as the beta widens. That address and the
              date you joined are all we keep.
            </p>
            <WaitlistForm />
          </section>
        )}
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">How it works</h2>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-black/15 p-4 dark:border-white/20">
            <h3 className="font-semibold">Start a sum</h3>
            <p className="mt-1 opacity-80">
              A sum is one workspace for one endeavor — and the first one can be just you: the house paperwork,
              the pet&apos;s vet history, the trip folder, a one-person business. Or it&apos;s a wedding shoot, a
              brand, a party your friends are throwing. Name it what you call it, keep it private, or invite up
              to four others with links you hand them yourself.
            </p>
          </div>
          <div className="rounded-xl border border-black/15 p-4 dark:border-white/20">
            <h3 className="font-semibold">Everyone brings their own AI</h3>
            <p className="mt-1 opacity-80">
              Claude for one of you, ChatGPT for another — each assistant answers to its own person, and the sum
              is where their work meets. Your shared memory doesn&apos;t live inside any one AI company; everyone
              reaches it through the assistant or chatbot they already trust.
            </p>
          </div>
          <div className="rounded-xl border border-black/15 p-4 dark:border-white/20">
            <h3 className="font-semibold">Small portions, kept</h3>
            <p className="mt-1 opacity-80">
              Say &ldquo;+sum remember that Mom hates red-eyes&rdquo; in your own chat, and it lands in the
              shared record — attributed, versioned, visible to everyone in the sum. Nobody gets a text unless
              you ask for one.
            </p>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">The first person who matters is you</h2>
        <p className="opacity-80">
          The memory your assistant has today is a summary it keeps somewhere you can&apos;t see, inside one
          company. A private sum is the opposite: exact pages your AI reads and writes on your behalf, kept
          with provenance, exportable as plain markdown any time. Start with just yourself — and when something
          in it deserves company, invite people in or copy pages into a shared sum. Nothing becomes shared by
          accident; privacy here is just arithmetic: a sum of one.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Built so you can leave</h2>
        <ul className="flex flex-col gap-2 opacity-80">
          <li>
            Export everything, any time — every sum downloads as an open-format bundle of plain markdown, from
            the sum&apos;s own page.
          </li>
          <li>No training on your content. No ads. No selling data.</li>
          <li>The server performs no inference — reading and judgment happen in the AI clients you choose.</li>
          <li>Texts are strictly opt-in, per sum, to a number you verify. Reply STOP any time.</li>
          <li>Leaving is clean: your access ends, and the shared record stays with the people it belongs to.</li>
        </ul>
        <p className="text-sm opacity-60">
          The rest is written down in plain language:{" "}
          <Link className="underline" href="/tools">
            What your AI can do
          </Link>{" "}
          ·{" "}
          <Link className="underline" href="/open">
            Open source
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
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">There is no Mem·Sum app</h2>
        <p className="opacity-80">
          Your AI is the app. Mem·Sum works inside the assistants you already use — Claude, ChatGPT,
          Perplexity, and anything else that speaks the open connector standard — on the desktop, on the web,
          and on your phone through the chatbot app you already have. Nothing new to download, and no second
          subscription so a notes app can think: your assistant does the reading and writing, and the sum
          keeps the record. Connect as many assistants as you like to the same memory — one at your desk,
          another in your pocket, all writing to the same pages.
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded-xl bg-accent-tint p-5">
        <div className="flex items-center gap-3">
          <DumplingMark size={28} />
          <h2 className="text-xl font-semibold">Why &ldquo;Mem·Sum&rdquo;?</h2>
        </div>
        <p className="opacity-80">
          Memory, kept in sums. And yes — like the meal: small shared dishes, a table of people you chose, and a
          little card in the middle quietly keeping track of what the table has shared. That card is the product.
        </p>
      </section>
    </main>
  );
}
