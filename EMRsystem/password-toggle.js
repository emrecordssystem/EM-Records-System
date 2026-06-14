(function () {
  function setupPasswordToggle(input) {
    if (!input || input.dataset.passwordToggleReady === 'true') return;

    const wrapper = document.createElement('div');
    wrapper.className = 'password-field';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'password-toggle';
    button.setAttribute('aria-label', 'Show password');
    button.setAttribute('title', 'Show password');
    button.textContent = '👁';
    wrapper.appendChild(button);

    button.addEventListener('click', () => {
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      button.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
      button.setAttribute('title', isHidden ? 'Hide password' : 'Show password');
      button.textContent = isHidden ? '🙈' : '👁';
      input.focus();
    });

    input.dataset.passwordToggleReady = 'true';
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('input[type="password"][data-password-toggle]').forEach(setupPasswordToggle);
  });
})();
