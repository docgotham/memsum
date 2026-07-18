"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DumplingMark } from "@/components/brand";

export function SiteFooter() {
  const pathname = usePathname();
  // The companion is a bare instrument panel — no site footer, in a browser
  // tab or installed as a standalone app.
  if (pathname?.startsWith("/companion")) return null;
  return (
    <footer className="mt-auto border-t border-black/10 dark:border-white/15">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-8 text-sm">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="inline-flex items-center gap-2 font-brand font-bold">
            <DumplingMark size={18} />
            Mem·Sum
          </span>
          <nav className="flex flex-wrap gap-x-4 gap-y-1 opacity-70">
            <Link className="transition-opacity hover:opacity-70" href="/tools">
              Tools
            </Link>
            <Link className="transition-opacity hover:opacity-70" href="/pricing">
              Pricing
            </Link>
            <Link className="transition-opacity hover:opacity-70" href="/open">
              Open source
            </Link>
            <Link className="transition-opacity hover:opacity-70" href="/connect">
              Connect
            </Link>
            <Link className="transition-opacity hover:opacity-70" href="/account">
              Account
            </Link>
            <Link className="transition-opacity hover:opacity-70" href="/terms">
              Terms
            </Link>
            <Link className="transition-opacity hover:opacity-70" href="/privacy">
              Privacy
            </Link>
          </nav>
        </div>
        <p className="opacity-60">
          Shared memory for the people who matter. Free beta — invitation-only, with a{" "}
          <Link className="underline" href="/#waitlist">
            waitlist
          </Link>
          .
        </p>
        <p className="opacity-50">
          © 2026 Mem·Sum · Built so you can leave: every sum exports as plain markdown, any time.
        </p>
      </div>
    </footer>
  );
}
