/* R95 · D1: contact.html's inline <script> moved here verbatim — script-src no longer allows 'unsafe-inline'. */
/* exported submitForm -- called by enhance.js's data-act kit (contact.html's form) */
async function submitForm(e) {
  e.preventDefault();
  const btn = document.querySelector('#enquiryForm [type="submit"]');
  const errorBox = document.getElementById('formError');
  if (errorBox) errorBox.style.display = 'none';
  const btnText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  const val = (id) => (document.getElementById(id) || { value: '' }).value || '';
  const payload = {
    name: (val('fname') + ' ' + val('lname')).trim(),
    email: val('email'),
    phone: val('phone'),
    enquiry_type: val('enquiryType'),
    property_value: val('propertyValue'),
    message: val('message'),
    page: location.pathname,
    website: val('website') // honeypot
  };
  try {
    const res = await fetch('https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1/new-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('new-lead responded ' + res.status);
    document.getElementById('enquiryForm').style.display = 'none';
    document.getElementById('formSuccess').style.display = 'block';
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = btnText; }
    if (errorBox) { errorBox.style.display = 'block'; errorBox.scrollIntoView({ block: 'nearest' }); }
  }
}

(function () {
  var t = new URLSearchParams(location.search).get('type');
  if (!t) return;
  var s = document.getElementById('enquiryType');
  if (!s) return;
  for (var i = 0; i < s.options.length; i++) {
    if (s.options[i].value === t) { s.value = t; break; }
  }
})();
