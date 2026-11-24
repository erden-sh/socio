// Applies the saved theme before the first paint, so a dark page never
// flashes light. Loaded as a file (the CSP allows no inline scripts); keep
// it in step with ThemeProvider in packages/client/src/shell/theme.tsx (same storage key,
// the class on <html>, color-scheme).
(function () {
    var theme = 'system';
    try {
        theme = localStorage.getItem('theme') || 'system';
    } catch (error) {
        // Storage blocked: follow the system.
    }
    if (theme !== 'light' && theme !== 'dark')
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.style.colorScheme = theme;
})();
