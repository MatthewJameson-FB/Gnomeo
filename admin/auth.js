(() => {
  const logout = async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
    } catch {
      // Best-effort logout; redirect still clears the protected flow.
    }
    window.location.href = '/admin/login.html';
  };

  document.querySelectorAll('[data-admin-logout]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      logout();
    });
  });
})();