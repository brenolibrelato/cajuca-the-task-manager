// Script clássico (não-módulo) que roda antes do app:
//  1) aplica o tema escolhido antes de desenhar a página (evita piscar);
//  2) se o app não iniciar (CDN bloqueado, sem rede, navegador antigo), mostra um aviso
//     em vez de deixar a tela em branco. Fica em arquivo próprio porque a CSP não
//     permite scripts inline.
try {
  var th = localStorage.getItem('cajuca.theme');
  if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
} catch (e) { /* sem armazenamento: usa o tema do sistema */ }

setTimeout(function () {
  if (window.__cajucaReady) return;
  var box = document.getElementById('boot-error');
  if (box) box.hidden = false;
}, 8000);
