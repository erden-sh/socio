// Resolve the document's scheme before styles paint. Account preferences
// arrive in the SSR attributes. Anonymous pages still use this browser's choice.
(function () {
    var root = document.documentElement;
    var mode = root.dataset.appearanceScope === 'account' ? root.dataset.colorMode : 'system';
    if (root.dataset.appearanceScope !== 'account') {
        try {
            mode = localStorage.getItem('theme') || mode;
        } catch (error) {
            // Storage blocked: follow the system.
        }
    }
    var scheme =
        mode === 'light' || mode === 'dark'
            ? mode
            : window.matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light';
    root.dataset.scheme = scheme;
    root.classList.remove('light', 'dark');
    root.classList.add(scheme);
    root.style.colorScheme = scheme;
})();
