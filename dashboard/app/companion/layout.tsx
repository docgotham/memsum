import type { Metadata, Viewport } from "next";

// Scoped to the /companion route only: the web manifest turns the companion
// into an installable standalone app (display: standalone → Chrome offers
// "Install", then runs it chrome-free, no address bar), mirroring the Suminar
// companion. The manifest's scope is /companion, so installing from anywhere
// on the site installs the companion, not the whole dashboard. The site
// header and footer are suppressed on this route (see site-header/footer) so
// the window — popped out or installed — is pure instrument panel.
export const metadata: Metadata = {
  title: "Mem·Sum Companion",
  manifest: "/companion.webmanifest",
  appleWebApp: { capable: true, title: "Companion", statusBarStyle: "default" },
  icons: { apple: "/companion-icon-192.png" }
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" }
  ]
};

export default function CompanionLayout({ children }: { children: React.ReactNode }) {
  return children;
}
