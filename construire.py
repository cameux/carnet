#!/usr/bin/env python3
"""Fabrique index.html (l'app autonome) à partir de ~/Downloads/recettes/recettes.html,
la même source que la page claude.ai. Lancer : python3 construire.py"""
import pathlib, re
ICI = pathlib.Path(__file__).parent
src = (pathlib.Path.home() / "Downloads/recettes/recettes.html").read_text(encoding="utf-8")
src = re.sub(r'^<title>.*?</title>\n<meta name="claude:viewport-fit-sides"[^>]*>\n', "", src)
TETE = """<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Carnet de cuisine</title>
<meta name="apple-mobile-web-app-title" content="Carnet">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f0f0f" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="icon" type="image/svg+xml" href="icone.svg">
<link rel="manifest" href="manifest.webmanifest">
<style>
/* équivalent du cadre que claude.ai ajoute autour de la page */
:root { color-scheme: light; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px) }
body { margin: 0; font: 14px/1.4 system-ui, sans-serif }
img { max-width: 100% }
[hidden] { display: none !important }
/* écran de connexion */
.fb-gate { position: fixed; inset: 0; z-index: 100; background: var(--bg, #fff); color: var(--ink, #111); display: grid; place-items: center; padding: 24px max(20px, env(safe-area-inset-right, 0px)) 24px max(20px, env(safe-area-inset-left, 0px)) }
.fb-box { max-width: 360px; width: 100%; display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center }
.fb-logo { color: var(--acc, #d63c1e) } .fb-logo svg { width: 64px; height: 64px }
.fb-box h1 { font-size: 1.6rem; margin: 0 }
.fb-msg, .fb-prog { margin: 0; color: var(--muted, #666) }
.fb-acts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center }
</style>
<script>
  // Interface « claude.use » fournie par firebase.js (module chargé en fin de page)
  window.__IA = "Gemini";
  window.__fb = new Promise(function (r) { window.__fbResolve = r; });
  window.claude = { use: function (n) { return window.__fb.then(function (f) { return f.use(n); }); } };
</script>
</head>
<body>
"""
PIED = """
<script type="module" src="firebase.js"></script>
</body>
</html>
"""
(ICI / "index.html").write_text(TETE + src + PIED, encoding="utf-8")
print("index.html :", len(TETE + src + PIED), "octets")
