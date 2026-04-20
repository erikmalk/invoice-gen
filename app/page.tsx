export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-24 text-slate-50">
      <div className="w-full max-w-2xl rounded-3xl border border-slate-800 bg-slate-900/80 p-10 shadow-2xl shadow-slate-950/40 backdrop-blur">
        <div className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-300">
          Phase 0 bootstrap
        </div>
        <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
          Invoice Generator — running
        </h1>
        <p className="mt-4 text-lg leading-8 text-slate-300">
          The core app scaffold is live on Next.js 15 with TypeScript, Tailwind,
          ESLint, Drizzle config, and environment validation wired in.
        </p>
        <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-950/70 p-5 text-sm text-slate-400">
          Business logic intentionally not implemented yet. Continue with Phase 1
          after review.
        </div>
      </div>
    </main>
  );
}
