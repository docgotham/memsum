"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lockup } from "@/components/brand";
import { supabaseBrowser } from "@/lib/supabase";

// The shared top bar: every page carries the lockup home-link and the same
// short nav, so no page is an island. Session state only decides the last
// slot — Your sums for members, Sign in for everyone else. The one exception
// is /companion: it is a slender instrument panel (and an installable
// standalone app), so it wears no site chrome.

export function SiteHeader() {
  const pathname = usePathname();
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

  if (pathname?.startsWith("/companion")) return null;

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
          <Link className="opacity-70 transition-opacity hover:opacity-100" href="/beta">
            Beta
          </Link>
          <Link className="opacity-70 transition-opacity hover:opacity-100" href="/connect">
            Connect
          </Link>
          {signedIn === null ? null : signedIn ? (
            <>
              <span className="flex items-center gap-1.5">
                <Link className="opacity-70 transition-opacity hover:opacity-100" href="/companion">
                  Companion
                </Link>
                <button
                  aria-label="Open the Companion as a floating window beside your chat"
                  className="opacity-60 transition-opacity hover:opacity-100"
                  onClick={() => window.open("/companion", "memsum-companion", "width=440,height=900")}
                  title="Pop out as a floating window beside your chat"
                  type="button"
                >
                  <svg
                    aria-hidden="true"
                    fill="none"
                    height="13"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                    viewBox="0 0 14 14"
                    width="13"
                  >
                    <path d="M6 2.8H3.2A1.2 1.2 0 0 0 2 4v6.8A1.2 1.2 0 0 0 3.2 12H10a1.2 1.2 0 0 0 1.2-1.2V8" />
                    <path d="M8.6 2H12v3.4" />
                    <path d="M12 2 6.8 7.2" />
                  </svg>
                </button>
              </span>
              <Link
                className="rounded-lg bg-accent px-3 py-1 font-medium text-accent-contrast transition-colors hover:bg-accent-deep hover:text-accent-tint"
                href="/sums"
              >
                Your sums
              </Link>
            </>
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
