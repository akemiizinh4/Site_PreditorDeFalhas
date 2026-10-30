(function () {
  var tela = document.getElementById('malha');
  if (!tela || !tela.getContext) return;
  var ctx = tela.getContext('2d');
  var parado = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var nos = [], arestas = [], pulsos = [], L = 0, A = 0, dpr = 1;

  function dimensionar() {
    var caixa = tela.parentElement.getBoundingClientRect();
    L = Math.max(320, caixa.width); A = Math.max(320, caixa.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    tela.width = L * dpr; tela.height = A * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    montar();
  }

  function montar() {
    var quantos = L < 700 ? 18 : 30;
    nos = [];
    for (var i = 0; i < quantos; i++) {
      nos.push({
        x: Math.random() * L, y: Math.random() * A,
        vx: (Math.random() - 0.5) * 0.14, vy: (Math.random() - 0.5) * 0.14,
        r: 1.2 + Math.random() * 1.8
      });
    }
    arestas = []; pulsos = [];
    var limite = L < 700 ? 150 : 200;
    for (var a = 0; a < nos.length; a++) {
      for (var b = a + 1; b < nos.length; b++) {
        var dx = nos[a].x - nos[b].x, dy = nos[a].y - nos[b].y;
        if (dx * dx + dy * dy < limite * limite) arestas.push([a, b]);
      }
    }
    for (var p = 0; p < Math.min(10, arestas.length); p++) {
      pulsos.push({ e: Math.floor(Math.random() * arestas.length), t: Math.random(), v: 0.0022 + Math.random() * 0.0038 });
    }
  }

  function quadro() {
    ctx.clearRect(0, 0, L, A);
    var limite = L < 700 ? 150 : 200;

    for (var i = 0; i < arestas.length; i++) {
      var n1 = nos[arestas[i][0]], n2 = nos[arestas[i][1]];
      var dx = n1.x - n2.x, dy = n1.y - n2.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d > limite) continue;
      ctx.strokeStyle = 'rgba(123, 44, 191,' + (0.3 * (1 - d / limite)).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(n1.x, n1.y); ctx.lineTo(n2.x, n2.y); ctx.stroke();
    }

    for (var j = 0; j < pulsos.length; j++) {
      var pu = pulsos[j], ar = arestas[pu.e];
      if (!ar) continue;
      var q1 = nos[ar[0]], q2 = nos[ar[1]];
      var px = q1.x + (q2.x - q1.x) * pu.t, py = q1.y + (q2.y - q1.y) * pu.t;
      var halo = ctx.createRadialGradient(px, py, 0, px, py, 9);
      halo.addColorStop(0, 'rgba(0, 245, 255, 0.85)');
      halo.addColorStop(1, 'rgba(0, 245, 255, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.fill();
      if (!parado) {
        pu.t += pu.v;
        if (pu.t > 1) { pu.t = 0; pu.e = Math.floor(Math.random() * arestas.length); }
      }
    }

    for (var k = 0; k < nos.length; k++) {
      var n = nos[k];
      ctx.fillStyle = 'rgba(0, 245, 255, 0.5)';
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
      if (!parado) {
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0 || n.x > L) n.vx *= -1;
        if (n.y < 0 || n.y > A) n.vy *= -1;
      }
    }
    if (!parado) requestAnimationFrame(quadro);
  }

  dimensionar();
  quadro();
  var espera;
  window.addEventListener('resize', function () {
    clearTimeout(espera);
    espera = setTimeout(function () { dimensionar(); if (parado) quadro(); }, 180);
  });
})();
