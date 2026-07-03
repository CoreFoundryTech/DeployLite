import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="shell stack">
      <section className="banner stack" aria-labelledby="login-title">
        <span className="pill">Scaffold-only auth</span>
        <h1 id="login-title">DeployLite admin shell</h1>
        <p className="muted">This login screen marks the protected boundary for the scaffold. It does not implement production authentication.</p>
        <Link className="button" href="/dashboard">Open mock dashboard</Link>
      </section>
    </main>
  );
}
