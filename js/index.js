/* R95 · D1: index.html's inline <script> moved here verbatim — script-src no longer allows 'unsafe-inline'. */
/* exported switchCalc -- called by enhance.js's data-act kit (index.html's calc tabs) */
  // Calculator switcher
  function switchCalc(tab, btn) {
    document.getElementById('calc-borrow').style.display = tab === 'borrow' ? 'block' : 'none';
    document.getElementById('calc-repay').style.display  = tab === 'repay'  ? 'block' : 'none';
    document.querySelectorAll('.calc-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
  }

  // Small helpers for the live result animation
  function pop(el) {
    if (!el) return;
    el.classList.remove('pop');
    void el.offsetWidth;        // restart the keyframe
    el.classList.add('pop');
  }
  function setBar(id, pct) {
    const bar = document.getElementById(id);
    if (bar) bar.style.width = Math.max(4, Math.min(100, pct)) + '%';
  }

  // Borrowing calculator
  function calcBorrow() {
    const i1 = Math.max(0, parseFloat(document.getElementById('income1').value) || 0);
    const i2 = Math.max(0, parseFloat(document.getElementById('income2').value) || 0);
    const total = i1 + i2;
    const lo = Math.round(total * 4 / 1000) * 1000;
    const hi = Math.round(total * 5.5 / 1000) * 1000;
    const out = document.getElementById('borrowResult');
    out.textContent = '£' + lo.toLocaleString() + ' – £' + hi.toLocaleString();
    setBar('borrowBar', (hi / 600000) * 100);   // bar fills toward a ~£600k scale
    pop(out);
  }

  // Repayment calculator
  function calcRepay() {
    const P = Math.max(0, Math.min(1e9, parseFloat(document.getElementById('loanAmt').value) || 0));
    const r = Math.max(0, Math.min(100, parseFloat(document.getElementById('interestRate').value) || 0)) / 100 / 12;
    const n = Math.max(1, Math.min(50, parseFloat(document.getElementById('termYears').value) || 25)) * 12;
    const out = document.getElementById('repayResult');
    let mo;
    if (r === 0) {
      mo = P / n;
    } else {
      mo = P * r * Math.pow(1+r, n) / (Math.pow(1+r, n) - 1);
    }
    if (!isFinite(mo) || mo < 0) {
      out.textContent = '—';
      document.getElementById('repayTotal').textContent = 'Enter realistic figures to see repayments';
      setBar('repayBar', 0);
      pop(out);
      return;
    }
    out.textContent = '£' + Math.round(mo).toLocaleString() + '/mo';
    document.getElementById('repayTotal').textContent =
      (r === 0 ? 'Total repaid: £' : 'Total repaid over term: £') + Math.round(mo * n).toLocaleString();
    setBar('repayBar', (mo / 2500) * 100);   // bar fills toward a ~£2,500/mo scale
    pop(out);
  }

  // Initial render so results match the pre-filled values
  calcBorrow();
  calcRepay();

  // Pause/play control for the hero background video (WCAG 2.2.2)
  (function () {
    const vid = document.querySelector('.hero-media video');
    const btn = document.getElementById('heroVideoToggle');
    if (!vid || !btn) return;
    // Video is already hidden for users with reduced-motion set; hide the control too
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      btn.style.display = 'none';
      return;
    }
    const pauseIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
    const playIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7 4 21 12 7 20 7 4"/></svg>';
    btn.addEventListener('click', function () {
      if (vid.paused) {
        vid.play();
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', 'Pause background video');
        btn.innerHTML = pauseIcon;
      } else {
        vid.pause();
        btn.setAttribute('aria-pressed', 'true');
        btn.setAttribute('aria-label', 'Play background video');
        btn.innerHTML = playIcon;
      }
    });
  })();
