const ADMIN_PASSWORD = 'gnomeo-admin';
const STORAGE_KEY = 'gnomeo-admin-unlocked';

(() => {
  const gate = document.getElementById('gate');
  const gateForm = document.getElementById('gateForm');
  const gateInput = document.getElementById('gateInput');
  const gateError = document.getElementById('gateError');
  const app = document.getElementById('app');

  if (!gate || !gateForm || !gateInput || !gateError || !app) return;

  const unlock = () => {
    document.body.classList.remove('locked');
    gate.classList.add('hidden');
    app.classList.remove('hidden');
    sessionStorage.setItem(STORAGE_KEY, '1');
    gateError.textContent = '';
  };

  if (sessionStorage.getItem(STORAGE_KEY) === '1') unlock();

  gateForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (gateInput.value === ADMIN_PASSWORD) {
      unlock();
    } else {
      gateError.textContent = 'Wrong password.';
      gateInput.value = '';
      gateInput.focus();
    }
  });
})();
