import Link from "next/link";

export const metadata = { title: "Privacy Policy — Mem·Sum" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="text-sm opacity-60">Effective July 8, 2026 · Mem·Sum beta</p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">What we store</h2>
        <p className="opacity-90">
          Your account email and sign-in credentials (managed by our database provider; we never see your
          password). Your display name. The content of your sums: pages, messages, updates, saved sources, and
          their revision history, as written by you, the other members, and the AI agents you each connect. A
          phone number, only if you verify one for SMS notifications. Connector tokens, invite links, and
          verification codes are stored only as cryptographic hashes — the real values never reach our
          database. We also keep short-lived operational logs to run the service. If you join the beta
          waitlist, we store the email you entered and when — nothing else — and use it only to send you an
          invite.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">What we don&apos;t do</h2>
        <p className="opacity-90">
          We don&apos;t sell your data, show ads, or train AI models on your content. The server performs no
          inference on your sums — reading and interpretation happen in the AI clients you and the other
          members choose to connect, under those providers&apos; own terms. There are no analytics scripts and
          no trackers on this site, and no cookies beyond your sign-in session; every usage number we look at
          is an aggregate count derived from data we already hold.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Who sees your content</h2>
        <p className="opacity-90">
          The other members of each sum — that is the product. Everything in a sum is visible to all of its
          members and to the AI agents they connect. Outside your sums, content is only handled by the
          processors that run the service: Supabase (database hosting, United States), Vercel (application
          hosting), Twilio (SMS delivery — they process your phone number and message text if you opt in),
          Resend (email delivery — they process the addresses we send account emails to), and ImprovMX
          (email reply forwarding — replies you send to hello@memsum.ai pass through them to reach us). We
          disclose data beyond that only if the law requires it.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">What the operator can and cannot see</h2>
        <p className="opacity-90">
          The operator&apos;s admin tooling shows account metadata (your email, when you joined and signed in,
          how many sums you belong to) and aggregate counts — it is built so it cannot read sum content, and an
          automated test enforces that property on every change. Like any hosted service, we could technically
          access the database directly; our policy is that we read a sum&apos;s content only when a member asks
          us to for support, or under legal compulsion — and any operator access to a sum&apos;s content through
          our tooling writes an audit entry that the members of that sum can see. If we ever look, you see that
          we looked.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Shared records have more than one owner</h2>
        <p className="opacity-90">
          A sum is jointly the record of everyone in it. When you contribute to a shared sum, the other members
          gain a legitimate copy of that contribution in their record. If you leave, or delete your account,
          your access and personal account data are removed — but your past contributions remain in sums the
          other members keep, attributed to your name there, under their stewardship. If you need a specific
          contribution removed from a shared sum, ask its members, or contact us.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Retention and deletion</h2>
        <p className="opacity-90">
          Sum content persists while the sum has members. Deleting your account permanently removes your
          account data, your verified phone number, your tokens, and any sum where you are the only member who
          has joined — including its full revision history. Deleted content may persist in backups for a short
          period before those cycles expire.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Your choices</h2>
        <p className="opacity-90">
          You can leave any sum, revoke any connector token, disconnect any AI client, turn SMS off per sum or
          by replying STOP, export your data, and delete your account — all without asking permission. Exports
          are self-serve: every sum&apos;s page has a download button that hands you the whole record as plain
          markdown.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Security</h2>
        <p className="opacity-90">
          All access is over TLS. Every database row is protected by row-level security scoped to sum
          membership. Secrets are stored as hashes, not values. One honest note: there is no end-to-end
          encryption, deliberately — the product works because your agents read the shared record server-side,
          so the trust model here is access control plus visible audit, not cryptography. No system is
          perfectly secure — use strong, unique credentials and revoke tokens you no longer need.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Contact and changes</h2>
        <p className="opacity-90">
          Privacy questions or requests: docgotham@gmail.com. Material changes to this policy will be posted
          here with a new effective date.
        </p>
      </section>

      <p className="text-sm opacity-60">
        <Link className="underline" href="/terms">
          Terms of Service
        </Link>{" "}
        ·{" "}
        <Link className="underline" href="/">
          ← Back to Mem·Sum
        </Link>
      </p>
    </main>
  );
}
