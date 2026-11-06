/* R99 · SEO-A: buy-to-let-rent-calculator.html's calculator. External file because script-src has no 'unsafe-inline';
   wired by enhance.js's data-act delegation (data-act="calcBTL", data-on="input change"). */
function btlFmt(n) { return '£' + Math.round(n).toLocaleString('en-GB'); }
function btlNum(id) { var v = document.getElementById(id).value; return v === '' ? NaN : +v; }

function calcBTL() {
  var value = Math.max(0, btlNum('btl_value') || 0);
  var rent = Math.max(0, btlNum('btl_rent') || 0);
  var loan = Math.max(0, btlNum('btl_loan') || 0);
  var rate = btlNum('btl_rate');
  var ratio = +document.getElementById('btl_ratio').value || 125;
  var out = function (id, t) { document.getElementById(id).textContent = t; };

  out('btl_yield', value > 0 && rent > 0 ? (rent * 12 / value * 100).toFixed(1) + '%' : '—');
  out('btl_yield_sub', value > 0 && loan > 0 ? 'Loan-to-value: ' + (loan / value * 100).toFixed(0) + '%. Gross yield is before letting costs, voids and tax.' : 'Gross yield is before letting costs, voids and tax.');

  if (!(rate > 0) || rate > 25 || !(loan > 0)) {
    out('btl_icr', '—');
    out('btl_needed', '—');
    out('btl_icr_sub', !(loan > 0) ? 'Enter a mortgage amount to test rental cover.' : 'Enter the stress rate you want to test (for example, from a lender’s criteria).');
    return;
  }
  var interest = loan * rate / 100 / 12;
  var achieved = rent > 0 ? rent / interest * 100 : 0;
  var needed = interest * ratio / 100;
  out('btl_icr', rent > 0 ? Math.floor(achieved) + '%' : '—');
  out('btl_needed', btlFmt(needed) + '/mo');
  out('btl_icr_sub', 'Monthly interest at ' + rate + '%: ' + btlFmt(interest) + '. ' +
    (rent > 0 ? (achieved >= ratio ? 'Your rent meets the ' + ratio + '% test at this stress rate.' : 'Your rent is ' + btlFmt(needed - rent) + '/mo short of the ' + ratio + '% test at this stress rate.') : 'Enter the monthly rent to compare.'));
}

calcBTL();
