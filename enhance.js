/* =========================================================
   NexMoney — enhance.js
   Lightweight, dependency-free progressive enhancement:
   scroll reveals, count-up stats, sticky-header state,
   hero-video handling, and a scroll-progress bar.
   Loaded in <head> (non-deferred) so the .js class lands
   before first paint — no flash of hidden content.
   ========================================================= */
(function () {
  var doc = document;
  var root = doc.documentElement;
  root.classList.add('js'); // enables reveal styling without FOUC

  var reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ready(fn) {
    if (doc.readyState !== 'loading') fn();
    else doc.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    /* ---- 1. Scroll-reveal ----------------------------------- */
    var revealSel = [
      '.reveal', '.hero-content > *', '.hero-card', '.stat-item',
      '.section-header', '.service-card', '.calc-intro', '.calc-card',
      '.why-item', '.testi-carousel', '.process-step', '.mortgage-card',
      '.accred-item', '.contact-info', '.contact-form', '.about-img',
      '.faq-item', '.lenders-head'
    ].join(',');

    var els = [].slice.call(doc.querySelectorAll(revealSel));
    els.forEach(function (el) { el.classList.add('reveal'); });

    if (reduce || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          // stagger by position among revealable siblings
          var sibs = [].slice.call(el.parentNode.children)
            .filter(function (c) { return c.classList.contains('reveal'); });
          var i = sibs.indexOf(el);
          el.style.transitionDelay = (Math.min(i, 6) * 80) + 'ms';
          el.classList.add('in');
          io.unobserve(el);
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      els.forEach(function (el) { io.observe(el); });
    }

    /* ---- 2. Count-up numbers -------------------------------- */
    // Animates the leading integer of things like "10+", "100s", "5★".
    // Non-numeric values (e.g. "FCA") are left untouched.
    var counters = [].slice.call(
      doc.querySelectorAll('.stat-item strong, .about-img .big-stat, [data-count]')
    );

    function animateCount(el) {
      var raw = el.getAttribute('data-count') || el.textContent;
      var m = raw.match(/^(\D*)([\d,]+)(.*)$/);
      if (!m) return; // nothing numeric to animate
      var prefix = m[1], suffix = m[3];
      var target = parseInt(m[2].replace(/,/g, ''), 10);
      if (!target || target > 1000000) return;
      var dur = 1100, start = null;

      function frame(ts) {
        if (start === null) start = ts;
        var p = Math.min((ts - start) / dur, 1);
        var eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
        var val = Math.round(eased * target);
        el.textContent = prefix + val.toLocaleString() + suffix;
        if (p < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }

    if (reduce || !('IntersectionObserver' in window)) {
      // leave numbers as authored
    } else {
      var cio = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          animateCount(entry.target);
          cio.unobserve(entry.target);
        });
      }, { threshold: 0.6 });
      counters.forEach(function (el) { cio.observe(el); });
    }

    /* ---- 3. Sticky-header compact state + progress bar ------ */
    var header = doc.querySelector('header');
    var bar = doc.createElement('div');
    bar.className = 'scroll-progress';
    doc.body.appendChild(bar);

    var ticking = false;
    function onScroll() {
      var y = window.pageYOffset || root.scrollTop;
      if (header) header.classList.toggle('scrolled', y > 12);
      var h = root.scrollHeight - root.clientHeight;
      bar.style.width = (h > 0 ? (y / h) * 100 : 0) + '%';
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { requestAnimationFrame(onScroll); ticking = true; }
    }, { passive: true });
    onScroll();

    /* ---- 4. Floating "call us" button (fades in on scroll) -- */
    var fab = doc.createElement('a');
    fab.href = 'tel:01202802677';
    fab.className = 'fab-call';
    fab.setAttribute('aria-label', 'Call NexMoney on 01202 802 677');
    fab.innerHTML =
      '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" ' +
      'viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 ' +
      '01-8.63-3.07A19.5 19.5 0 014.11 11.9a19.79 19.79 0 01-3.07-8.67A2 2 0 013 ' +
      '1.08h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.09 8.91a16 ' +
      '16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 ' +
      '16.92z"/></svg><span>Call us free</span>';
    doc.body.appendChild(fab);
    function toggleFab() {
      fab.classList.toggle('show', (window.pageYOffset || root.scrollTop) > 600);
    }
    window.addEventListener('scroll', toggleFab, { passive: true });
    toggleFab();

    /* ---- 5. Subtle 3D tilt on the hero card (pointer only) -- */
    var card = doc.querySelector('.hero-card');
    var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (card && fine && !reduce) {
      card.style.transformStyle = 'preserve-3d';
      card.style.transition = 'transform 0.15s ease';
      var raf = null;
      card.addEventListener('mouseenter', function () {
        card.style.animation = 'none';   // stop the float so tilt isn't overridden
      });
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function () {
          card.style.transform =
            'perspective(900px) rotateX(' + (-py * 5).toFixed(2) + 'deg) rotateY(' +
            (px * 6).toFixed(2) + 'deg) translateY(-4px)';
        });
      });
      card.addEventListener('mouseleave', function () {
        if (raf) cancelAnimationFrame(raf);
        card.style.transform = '';
        card.style.animation = '';       // resume the gentle float
      });
    }

    /* ---- 5b. Hero video: parallax + play only when visible -- */
    var vid = doc.querySelector('.hero-media video');
    if (vid) {
      if (reduce) {
        vid.removeAttribute('autoplay');
        vid.pause();
      } else {
        // pause offscreen to save battery
        if ('IntersectionObserver' in window) {
          new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
              if (entry.isIntersecting) { vid.play().catch(function () {}); }
              else vid.pause();
            });
          }, { threshold: 0.05 }).observe(vid);
        }
        // gentle parallax drift as you scroll past the hero
        var vTicking = false;
        window.addEventListener('scroll', function () {
          if (vTicking) return;
          vTicking = true;
          requestAnimationFrame(function () {
            var y = window.pageYOffset || root.scrollTop;
            if (y < window.innerHeight * 1.2) {
              vid.style.transform = 'translateY(' + (y * 0.25).toFixed(1) + 'px) scale(1.08)';
            }
            vTicking = false;
          });
        }, { passive: true });
        vid.style.transform = 'scale(1.08)';
      }
    }

    /* ---- 6. Testimonials carousel (auto-rotating) ---------- */
    var track = doc.getElementById('testiTrack');
    if (track) {
      var slides = [].slice.call(track.children);
      var dotsWrap = doc.getElementById('testiDots');
      var prevBtn = doc.getElementById('testiPrev');
      var nextBtn = doc.getElementById('testiNext');
      var page = 0, pages = 1, timer = null;

      function visibleCount() {
        var w = window.innerWidth;
        return w >= 900 ? 3 : (w >= 600 ? 2 : 1);
      }
      function render() {
        track.style.transform = 'translateX(-' + (page * 100) + '%)';
        if (dotsWrap) {
          [].slice.call(dotsWrap.children).forEach(function (d, i) {
            d.classList.toggle('active', i === page);
          });
        }
      }
      function go(p) { page = (p + pages) % pages; render(); }
      function build() {
        var visible = visibleCount();
        slides.forEach(function (s) { s.style.flexBasis = (100 / visible) + '%'; });
        pages = Math.ceil(slides.length / visible);
        if (page > pages - 1) page = pages - 1;
        if (dotsWrap) {
          dotsWrap.innerHTML = '';
          for (var i = 0; i < pages; i++) {
            var b = doc.createElement('button');
            b.type = 'button';
            b.className = 'testi-dot';
            b.setAttribute('aria-label', 'Go to review group ' + (i + 1));
            (function (idx) { b.addEventListener('click', function () { go(idx); restart(); }); })(i);
            dotsWrap.appendChild(b);
          }
        }
        render();
      }
      function startAuto() { if (reduce) return; stopAuto(); timer = setInterval(function () { go(page + 1); }, 5500); }
      function stopAuto() { if (timer) { clearInterval(timer); timer = null; } }
      function restart() { startAuto(); }

      if (nextBtn) nextBtn.addEventListener('click', function () { go(page + 1); restart(); });
      if (prevBtn) prevBtn.addEventListener('click', function () { go(page - 1); restart(); });

      var carousel = track.parentNode;
      while (carousel && carousel.className.indexOf('testi-carousel') === -1) carousel = carousel.parentNode;
      if (carousel) {
        carousel.addEventListener('mouseenter', stopAuto);
        carousel.addEventListener('mouseleave', startAuto);
      }

      var rt;
      window.addEventListener('resize', function () {
        clearTimeout(rt); rt = setTimeout(build, 150);
      });

      build();
      startAuto();
    }
  });
})();
