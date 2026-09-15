/** Shared shell for the legal pages: one column, generous measure, plain type. */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <h1 className="text-3xl font-extrabold text-fg">{title}</h1>
      <p className="mt-2 text-sm text-muted">آخر تحديث: {updated}</p>
      <div className="mt-10 space-y-8">{children}</div>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-fg">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted">{children}</div>
    </section>
  );
}
