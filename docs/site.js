// Theme: follows the system until the header button picks one, then remembers it.
// Loaded in <head> so a saved theme applies before the first paint.
(function () {
  var KEY = "realingo-theme", root = document.documentElement, saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  window.isDark = function () {
    return root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  };
  document.addEventListener("click", function (e) {
    if (!e.target.closest("#theme")) return;
    root.dataset.theme = window.isDark() ? "light" : "dark";
    try { localStorage.setItem(KEY, root.dataset.theme); } catch (e) {}
  });
})();
