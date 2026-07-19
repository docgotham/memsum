import Link from "next/link";

export const metadata = { title: "Open source — Mem·Sum" };

// Set at the public flip (cutover checklist): the dashboard's twin of the
// kernel's MEMSUM_SOURCE_URL. Until it exists, the page says honestly that
// the repository opens with the launch — no dead links, no pretending.
const SOURCE_URL = process.env.NEXT_PUBLIC_SOURCE_URL;

export default function OpenPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-16">
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Open, on purpose.</h1>
        <p className="text-lg opacity-80">
          Mem·Sum&apos;s kernel is open source under Apache-2.0. The code that keeps your
          shared memory — the graph, the isolation, the exports — is software we encourage you to read, run,
          and build on. The hosted service is simply our copy of it, run well.
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">The deal, stated plainly</h2>
        <p className="opacity-80">
          The software is free. What the hosted version charges for — someday, with plenty of notice — is the
          work around it: hosting, backups, uptime, support, and SMS compliance (a verified toll-free number
          and carrier approval, if your group wants texts). If you&apos;d rather do that work yourself, we
          genuinely encourage it. Same code, same format, either way.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Why open matters here</h2>
        <p className="opacity-80">
          A shared memory asks for trust, and trust should be checkable, not just promised. With the kernel
          open, you can read the row-level security that keeps every sum isolated, confirm the server makes no
          model calls — reading and judgment happen in the AI clients you choose — and see that the promises
          on our privacy page describe the code that actually ships. The kernel&apos;s <code>/version</code>{" "}
          endpoint names the exact commit this service is running at any moment.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">Build your own wiki graphs</h2>
        <p className="opacity-80">
          A sum is a shared wiki graph: pages, revisions, messages, and provenance, kept by a thin server with
          no opinions. Run the kernel yourself and you can grow graphs for whatever your people care about —
          a family&apos;s standing knowledge, a crew&apos;s project memory, a club&apos;s institutional
          history — with each person reaching them through the assistant or chatbot they already use.
          Everything speaks the same open bundle format, so pages move cleanly between sums you run and sums
          we host: export from one, land it in the other, no translation and no permission needed.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">The license</h2>
        <p className="opacity-80">
          Apache-2.0: use it, change it, self-host it, build a business on it — no copyleft strings attached,
          with an explicit patent grant. The one reservation is the name: call your instance anything you
          like, just not Mem·Sum, so nobody mistakes whose stewardship they&apos;re trusting.
        </p>
      </section>

      <section className="flex flex-col gap-2 rounded-xl bg-accent-tint p-5">
        <h2 className="text-xl font-semibold">The repository</h2>
        {SOURCE_URL ? (
          <p className="opacity-80">
            The kernel lives at{" "}
            <a className="underline" href={SOURCE_URL} rel="noopener" target="_blank">
              {SOURCE_URL.replace(/^https?:\/\//, "")}
            </a>{" "}
            — issues, questions, and contributions welcome.
          </p>
        ) : (
          <p className="opacity-80">
            The public repository opens with the launch, the same day as the domain — this page will link it.
            The license, the security policy, and the promises above are already written into the code it will
            hold.
          </p>
        )}
      </section>

      <p className="text-sm opacity-60">
        More plain language:{" "}
        <Link className="underline" href="/beta">
          The beta
        </Link>{" "}
        ·{" "}
        <Link className="underline" href="/tools">
          What your AI can do
        </Link>{" "}
        ·{" "}
        <Link className="underline" href="/privacy">
          Privacy
        </Link>
      </p>
    </main>
  );
}
