import { useSyncExternalStore, type ReactNode } from 'react'

// ponytail: a 10-line pushState router so the demo has real pages; a real app would use React Router
const subscribe = (cb: () => void) => { addEventListener('popstate', cb); return () => removeEventListener('popstate', cb) }
const usePath = () => useSyncExternalStore(subscribe, () => location.pathname)
function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const go = (e: React.MouseEvent) => { e.preventDefault(); history.pushState(null, '', to); dispatchEvent(new PopStateEvent('popstate')) }
  return <a href={to} className={className} onClick={go}>{children}</a>
}

function Navbar() {
  return (
    <nav className="nav">
      <Link to="/" className="logo"><svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0z" fill="#f38020" /><rect x="9" y="9" width="6" height="6" rx="1" fill="#fff" /></svg>Acme</Link>
      <div className="links"><Link to="/">Overview</Link><Link to="/docs">Docs</Link><Link to="/pricing">Pricing</Link><Link to="/changelog">Changelog</Link></div>
      <button className="btn">Sign up</button>
    </nav>
  )
}
function Hero() {
  return (
    <header className="hero">
      <h1>Ship faster at the edge</h1>
      <p>Deploy serverless code to 300 cities in seconds. No cold starts, no config.</p>
      <div className="row"><button className="btn">Get started</button><button className="btn ghost">Read docs</button></div>
    </header>
  )
}
function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <article className="card">
      <div className="dot" />
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  )
}
function Overview() {
  return <>
    <Hero />
    <section className="grid">
      <FeatureCard title="Workers" body="Run JavaScript at the edge with zero cold starts." />
      <FeatureCard title="KV storage" body="Global, low-latency key-value data for your apps." />
      <FeatureCard title="Images" body="Resize, optimise and serve images from one URL." />
    </section>
  </>
}
function Page({ title, children }: { title: string; children: ReactNode }) {
  return <section className="page"><h1>{title}</h1>{children}</section>
}
const PAGES: Record<string, () => ReactNode> = {
  '/': Overview,
  '/docs': () => <Page title="Docs"><p>Install the CLI, write a worker, deploy it. That's the whole guide.</p></Page>,
  '/pricing': () => <Page title="Pricing"><section className="grid">
    <FeatureCard title="Free" body="100k requests a day, forever." />
    <FeatureCard title="Pro · $5" body="10M requests a month, then $0.30 per million." />
    <FeatureCard title="Team · $25" body="Everything in Pro, plus SSO and audit logs." />
  </section></Page>,
  '/changelog': () => <Page title="Changelog"><ul className="log"><li><b>v1.2</b> Smart placement</li><li><b>v1.1</b> Cron triggers</li><li><b>v1.0</b> Hello, edge</li></ul></Page>,
}

export function App() {
  const Current = PAGES[usePath()] ?? (() => <Page title="Not found"><p>No page here.</p></Page>)
  return (
    <main>
      <Navbar />
      <Current />
      <footer className="foot">© 2026 Acme Inc.</footer>
    </main>
  )
}
