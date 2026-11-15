(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const object = document.getElementById('hero-object');
  let visible = true;
  if (object && 'IntersectionObserver' in window) {
    new IntersectionObserver(entries => { visible = entries[0].isIntersecting; document.body.classList.toggle('object-idle', !visible); }, {threshold:.05}).observe(object);
  }
  if (object) {
    window.addEventListener('pointermove', event => {
      if (reduced.matches || !visible) return;
      const x = (event.clientX / innerWidth - .5) * 22;
      const y = (event.clientY / innerHeight - .5) * 16;
      object.style.setProperty('--move-x', `${x}px`);
      object.style.setProperty('--move-y', `${y}px`);
      object.style.setProperty('--tilt', `${x / 12}deg`);
    }, {passive:true});
    window.addEventListener('scroll', () => {
      if (reduced.matches || !visible) return;
      object.style.setProperty('--move-y', `${Math.min(45, scrollY * .08)}px`);
    }, {passive:true});
  }
  let seconds = 599;
  const timer = document.querySelector('.check-count');
  const checked = document.querySelector('.check-time');
  const last = document.querySelectorAll('.last-check');
  const value = document.querySelector('.tick-value');
  const countdown = document.getElementById('countdown');
  let pending = 42 * 60 + 18;
  const pad = value => String(value).padStart(2, '0');
  setInterval(() => {
    if (document.hidden) return;
    if (timer) { seconds = seconds > 0 ? seconds - 1 : 599; timer.textContent = `Valid for ${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`; }
    if (checked) checked.textContent = `Checked ${599 - seconds}s ago`;
    if (value) value.textContent = (12.40 + (599 - seconds) * .001).toFixed(2);
    if (countdown) { pending = Math.max(0, pending - 1); countdown.textContent = `00:${pad(Math.floor(pending / 60))}:${pad(pending % 60)}`; }
    last.forEach(el => { el.textContent = `${Math.floor((599 - seconds) / 60)} min ago`; });
  }, 1000);
  document.querySelectorAll('.lookup').forEach(button => button.addEventListener('click', () => {
    const input = button.parentElement.querySelector('input');
    if (!input.value.trim()) { input.focus(); return; }
    seconds = 599;
    if (checked) checked.textContent = 'Checked just now';
    const widget = button.closest('.check-widget');
    const known = input.value.trim().toLowerCase() === '0x7b42…9ae1';
    widget.querySelector('.check-status strong').textContent = known ? 'Active policy' : 'No session found';
    widget.querySelector('.check-status span:last-child').textContent = known ? 'Endpoints live' : 'Address checked';
    widget.querySelector('.check-grid').hidden = !known;
    widget.querySelector('.check-signed span:first-child').textContent = known ? 'Signed check ready' : 'Signed answer ready';
    button.textContent = 'Checked';
    setTimeout(() => { button.textContent = 'Check'; }, 1200);
  }));
  document.querySelectorAll('.wallet').forEach(button => button.addEventListener('click', () => {
    button.textContent = 'Connect wallet';
    button.blur();
  }));
  if (new URLSearchParams(location.search).has('qa')) {
    const report = document.createElement('output');
    report.id = 'qa-report';
    report.textContent = JSON.stringify({viewport:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth});
    document.body.append(report);
  }
})();
