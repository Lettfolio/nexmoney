/* R95 · D1: calculators.html's inline <script> moved here verbatim — script-src no longer allows 'unsafe-inline'. */
function fmt(n) { return '£' + Math.round(n).toLocaleString(); }

function calcB() {
  const i1 = Math.max(0, +document.getElementById('b_income1').value || 0);
  const i2 = Math.max(0, +document.getElementById('b_income2').value || 0);
  const total = i1 + i2;
  const lo = Math.round(total * 4 / 1000) * 1000;
  const hi = Math.round(total * 5.5 / 1000) * 1000;
  document.getElementById('b_result').textContent = fmt(lo) + ' – ' + fmt(hi);
}

function calcR() {
  const P = Math.max(0, Math.min(1e9, +document.getElementById('r_loan').value || 0));
  const r = Math.max(0, Math.min(100, +document.getElementById('r_rate').value || 0)) / 100 / 12;
  const rTermRaw = document.getElementById('r_term').value;
  const n = Math.max(1, Math.min(50, rTermRaw === '' ? 25 : (+rTermRaw || 0))) * 12;
  if (r === 0) {
    const mo = P / n;
    document.getElementById('r_result').textContent = fmt(mo) + '/mo';
    document.getElementById('r_total').textContent = 'Total repaid: ' + fmt(mo*n) + ' (interest-free)';
    return;
  }
  const mo = P * r * Math.pow(1+r, n) / (Math.pow(1+r, n) - 1);
  const total = mo * n;
  if (!isFinite(mo) || mo < 0 || !isFinite(total)) {
    document.getElementById('r_result').textContent = '—';
    document.getElementById('r_total').textContent = 'Enter realistic figures to see repayments';
    return;
  }
  document.getElementById('r_result').textContent = fmt(mo) + '/mo';
  document.getElementById('r_total').textContent = 'Total repaid: ' + fmt(total) + ' (includes ' + fmt(total - P) + ' interest)';
}

function calcO() {
  const P     = Math.max(0, +document.getElementById('o_balance').value || 0);
  const rate  = Math.max(0, +document.getElementById('o_rate').value || 0);
  const years = Math.max(0, Math.min(50, +document.getElementById('o_term').value || 0));
  const extra = Math.max(0, +document.getElementById('o_extra').value || 0);
  const r = rate / 100 / 12;
  const n = years * 12;
  if (!P || !r || !n) {
    document.getElementById('o_saving').textContent = '\u2014';
    document.getElementById('o_years').textContent = 'Enter your mortgage details above';
    return;
  }

  // Standard payment
  const stdPmt = P * r * Math.pow(1+r, n) / (Math.pow(1+r, n) - 1);
  const stdTotal = stdPmt * n;

  // With overpayment
  const newPmt = stdPmt + extra;
  // If the payment doesn't cover the interest the loan is never repaid — treat as no saving
  if (newPmt <= P * r) {
    document.getElementById('o_saving').textContent = fmt(0);
    document.getElementById('o_years').textContent = 'Enter an overpayment amount above';
    return;
  }
  // Months to pay off with new payment
  const newN = Math.log(newPmt / (newPmt - P * r)) / Math.log(1 + r);
  const newTotal = newPmt * newN;
  const saving = stdTotal - newTotal;
  const monthsSaved = n - Math.ceil(newN);
  const yrSaved = Math.floor(monthsSaved / 12);
  const moSaved = monthsSaved % 12;

  document.getElementById('o_saving').textContent = fmt(Math.max(0, saving));
  document.getElementById('o_years').textContent = saving > 0
    ? 'Mortgage paid off approx. ' + (yrSaved > 0 ? yrSaved + ' year' + (yrSaved>1?'s':'') : '') + (moSaved > 0 ? ' ' + moSaved + ' month' + (moSaved>1?'s':'') : '') + ' early'
    : 'Enter an overpayment amount above';
}

function calcRI() {
  const val     = Math.max(0, +document.getElementById('ri_value').value || 0);
  const depPct  = Math.min(99, Math.max(1, +document.getElementById('ri_deposit').value || 25));
  const rate    = Math.max(0, +document.getElementById('ri_rate').value || 5.5);
  const loan    = val * (1 - depPct / 100);
  // Typical BTL: monthly interest / 0.8 (125% coverage)
  const monthlyInterest = loan * rate / 100 / 12;
  const required = monthlyInterest / 0.8;
  document.getElementById('ri_result').textContent = fmt(required) + '/mo';
  document.getElementById('ri_sub').textContent = 'Loan: ' + fmt(loan) + ' · Monthly interest: ' + fmt(monthlyInterest) + ' · Based on 125% rental coverage.';
}

calcB(); calcR(); calcO(); calcRI();
