import Link from 'next/link';
import { getSpendReport } from '@vhalcha/database';
import { hasPermission } from '@vhalcha/auth';
import { AccessDenied } from '../../../components/access-denied';
import { BudgetForm } from '../../../components/forms';
import { percent, periodRange, usd } from '../../../lib/format';
import { getServices, requirePageAccess } from '../../../server/services';

export const metadata = { title: 'Spend' };

export default async function SpendPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const access = await requirePageAccess('spend:read');
  if (!access) return null;
  if ('denied' in access) return <AccessDenied />;
  const session = access;
  const params = await searchParams;
  const range = periodRange(params.period, params.from, params.to);
  const report = await getSpendReport(getServices().db, session.claims.oid, range.start, range.end);
  const editable = hasPermission(session.role, 'budgets:write');
  return (
    <>
      <h1 className="page-title">Spend</h1>
      <nav className="row-actions">
        {['24h', '7d', '30d', '90d'].map((period) => (
          <Link key={period} href={`/spend?period=${period}`}>{period}</Link>
        ))}
      </nav>
      <form className="inline-form" action="/spend" method="get">
        <input type="hidden" name="period" value="custom" />
        <label>From<input type="date" name="from" /></label>
        <label>To<input type="date" name="to" /></label>
        <button className="secondary" type="submit">Apply custom range</button>
      </form>
      <section className="grid-4">
        <article className="metric"><span>Current spend</span><strong>{usd(report.currentSpend)}</strong></article>
        <article className="metric"><span>Budget</span><strong>{usd(report.budgetTotal)}</strong></article>
        <article className="metric"><span>Budget utilisation</span><strong>{percent(report.utilisation)}</strong></article>
        <article className="metric"><span>Forecast</span><strong>{usd(report.forecast)}</strong></article>
        <article className="metric"><span>Avg cost/request</span><strong>{usd(report.averageCost)}</strong></article>
      </section>
      <p className="muted">Forecast is a linear 30-day run rate from spend in the selected period. It is not a predictive model.</p>
      <section className="grid-3">
        <Breakdown title="By AI System" rows={report.bySystem.map((row) => [row.name, usd(row.spend)])} />
        <Breakdown title="By Provider" rows={report.byProvider.map((row) => [row.provider, usd(row.spend)])} />
        <Breakdown title="By Model" rows={report.byModel.map((row) => [row.model, usd(row.spend)])} />
      </section>
      <section className="panel">
        <h2>Budgets</h2>
        {report.budgets.length === 0 ? <p>No budgets configured.</p> : report.budgets.map((budget) => (
          <article key={budget.id}>
            <p>{budget.name} · {budget.period} · {budget.action}</p>
            {editable ? (
              <BudgetForm
                budgetId={budget.id}
                amount={String(budget.amountUsd)}
                threshold={budget.warningThresholdPercent}
                action={budget.action}
              />
            ) : (
              <p>{usd(Number(budget.amountUsd))} · warning {budget.warningThresholdPercent}%</p>
            )}
          </article>
        ))}
      </section>
    </>
  );
}

function Breakdown({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <article className="panel">
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="empty">No spend in this period.</p> : (
        <ul>{rows.map(([label, value]) => <li key={label}>{label}: {value}</li>)}</ul>
      )}
    </article>
  );
}
