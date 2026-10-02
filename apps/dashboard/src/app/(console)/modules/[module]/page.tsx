const descriptions: Record<string, string> = {
  knowledge: 'Company knowledge connections are not part of the V1 foundation.',
  guard: 'Data-loss and prompt controls are not part of the V1 foundation.',
  registry: 'A broader model registry is not part of the V1 foundation.',
  trust: 'Trust reporting is not part of the V1 foundation.',
  policies: 'The policy engine beyond budget, rate, and model access is not part of the V1 foundation.',
  reports: 'Scheduled reports are not part of the V1 foundation. Use Gateway, Spend, and Audit for current records.',
};

export default async function UnfinishedModulePage({ params }: { params: Promise<{ module: string }> }) {
  const moduleName = (await params).module;
  return (
    <>
      <h1 className="page-title">{moduleName}</h1>
      <section className="panel">
        <p>{descriptions[moduleName] ?? 'This module is not part of the V1 foundation.'}</p>
        <p>No sample data is shown for this module.</p>
      </section>
    </>
  );
}
