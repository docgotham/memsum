import Link from "next/link";

export const metadata = { title: "Terms of Service — Mem·Sum" };

export default function TermsPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="text-sm opacity-60">Effective July 8, 2026 · Mem·Sum beta</p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">What Mem·Sum is</h2>
        <p className="opacity-90">
          Mem·Sum is a shared memory workspace for small groups — two to five people, called a sum. You and the
          other members read and write it through AI assistants you connect, or through this dashboard. The
          service stores what you and your agents commit; it performs no inference of its own.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Your account and your agents</h2>
        <p className="opacity-90">
          Accounts are created by invitation during the beta. You are responsible for your sign-in credentials
          and for any connector tokens you issue — a connector token can read and write every sum you belong
          to, so treat it like a password and revoke it if it may be exposed. An AI client you connect acts on
          your behalf: what it commits through your account is your contribution.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">The shared record</h2>
        <p className="opacity-90">
          A sum belongs to its members jointly. Anything you contribute — messages, pages, edits, sources —
          becomes part of every member&apos;s copy of that shared record, and every member of the sum can see
          it. Contribute only what you are willing to share with the whole sum, and only material you have the
          right to share.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Leaving and deletion</h2>
        <p className="opacity-90">
          You can leave a sum at any time: your access ends immediately and your seat becomes re-invitable, but
          your past contributions remain part of the shared record, attributed to your name there. Deleting
          your account does the same for every sum you belong to, deletes any sum where you are the only member
          who has joined, and permanently removes your personal account data. A sum&apos;s owner cannot leave
          or delete their account while another member has joined that sum — the other members must leave
          first. Deletion cannot be undone.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Text messages</h2>
        <p className="opacity-90">
          SMS notifications are strictly opt-in, per sum, to a phone number you verify yourself. Message
          frequency varies with activity in your sums. Message and data rates may apply. Reply STOP to stop and
          START to resume; you can also turn notifications off per sum on the dashboard. SMS delivery is not
          guaranteed and carriers may filter messages.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Acceptable use</h2>
        <p className="opacity-90">
          Use Mem·Sum only for lawful purposes. Do not use it to harass anyone, to send spam, to store or
          distribute content you have no right to, or to probe or disrupt the service. We may suspend accounts
          that do.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Beta terms</h2>
        <p className="opacity-90">
          Mem·Sum is a beta. It is provided as-is, without warranties, and availability is not guaranteed. Keep
          copies of anything you cannot afford to lose; you can request an export of your data at any time.
          Features and these terms may change — material changes will be posted here with a new effective date,
          and continued use after a change is acceptance. To the extent permitted by law, our liability is
          limited to the amount you paid for the service, which during the free beta is zero.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Contact</h2>
        <p className="opacity-90">Questions about these terms: docgotham@gmail.com.</p>
      </section>

      <p className="text-sm opacity-60">
        <Link className="underline" href="/privacy">
          Privacy Policy
        </Link>{" "}
        ·{" "}
        <Link className="underline" href="/">
          ← Back to Mem·Sum
        </Link>
      </p>
    </main>
  );
}
