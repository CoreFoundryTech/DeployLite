import Link from "next/link";
import type { ReactNode } from "react";
import { LogoutButton } from "@/app/auth-controls";
import { getAuthApiBaseUrl } from "@/lib/auth-boundary";

type AppShellProps = {
  email: string;
  children: ReactNode;
};

type NavItem = { href: string; label: string };

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/projects", label: "Projects" },
  { href: "/deployments", label: "Deployments" }
];

export function AppShell({ email, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="font-semibold tracking-tight">
              DeployLite
            </Link>
            <nav aria-label="Primary" className="flex items-center gap-4 text-sm text-muted-foreground">
              {navItems.map((item) => (
                <Link key={item.href} href={item.href} className="hover:text-foreground">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{email}</span>
            <LogoutButton apiBaseUrl={getAuthApiBaseUrl()} />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
