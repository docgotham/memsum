"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lockup } from "@/components/brand";
import { supabaseBrowser } from "@/lib/supabase";

// The shared top bar: every page carries the lockup home-link and the same
// short nav, so no page is an island. Session state only decides the last
// slot — Your sums for members, Sign in for everyone else.

export function SiteHeader() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    const supabase = supabaseBrowser();
    supabase.auth.getSession().then(({ data }) => setSignedIn(Boolean(data.session)));
    // The header lives in the persistent layout, so it must track session
    // changes live — invitees sign in client-side on /welcome without any
    // full navigation to remount us (found by the stranger test 2026-07-11).
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) =>
      setSignedIn(Boolean(session))
    );
    return () => subscription.subscription.unsubscribe();
  }, []);

  return (
    <header className="border-b border-black/10 dark:border-white/15">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3">
        <Link className="mr-auto" href="/">
          <Lockup className="text-lg" markSize={22} />
        </Link>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <Link className="opacity-70 transition-opacity hover:opacity-100" href="/tools">
            Tools
          </Link>
          <Link className="opacity-70 transition-opacity hover:opacity-100" href="/pricing">
            Pricing
          </Link>
          <Link className="opacity-70 transition-opacity hover:opacity-100" href="/connect">
            Connect
          </Link>
          {signedIn === null ? null : signedIn ? (
            <Link
              className="rounded-lg bg-accent px-3 py-1 font-medium text-accent-contrast transition-colors hover:bg-accent-deep hover:text-accent-tint"
              href="/sums"
            >
              Your sums
            </Link>
          ) : (
            <Link
              className="rounded-lg border border-black/20 px-3 py-1 font-medium dark:border-white/25"
              href="/login"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
