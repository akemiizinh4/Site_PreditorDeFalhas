/* Dashboard — Preditor de Falhas na Rede (Grupo 7)
   Mede a rede de verdade, monta as 21 variáveis do projeto e roda a árvore
   de decisão treinada, exportada para JSON. Nada aqui é inventado: as fórmulas
   são as mesmas documentadas no metadados.json da entrega. */

(function () {
  "use strict";

  var SENTINELA = -1;
  // Para a apresentação dá para encurtar a fase de aprendizado pela URL:
  // dashboard.html?aprendizado=8&intervalo=1500
  var par = new URLSearchParams(location.search);
  var CICLOS_APRENDIZADO = Math.max(5, Math.min(60, parseInt(par.get("aprendizado"), 10) || 20));
  var INTERVALO_MS = Math.max(800, Math.min(15000, parseInt(par.get("intervalo"), 10) || 3000));
  var PACOTES = 3;                 // três sondagens por ciclo, como o ping do projeto
  var TIMEOUT_MS = 2000;
  var MAX_HIST = 40;

  var ALVOS = [
    { id: "site", nome: "Servidor do site", url: "dados/sonda.txt", externo: false },
    { id: "externo", nome: "Alvo externo", url: "https://www.gstatic.com/generate_204", externo: true }
  ];

  var arvore = null, baseline = [], rodando = false, relogio = null, ciclo = 0;
  var eventoPendente = null;
  var estado = {};   // por alvo

  ALVOS.forEach(function (a) {
    estado[a.id] = { alvo: a, medicoes: [], base: null, indisponivel: false, falhasSeguidas: 0 };
  });

  var $ = function (s) { return document.querySelector(s); };
  var el = function (t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };

  /* ---------------- carregar os dados do projeto ---------------- */

  function lerCsv(texto) {
    var linhas = texto.trim().split("\n");
    var cab = linhas[0].split(",");
    return linhas.slice(1).map(function (l) {
      var p = l.split(","), o = {};
      cab.forEach(function (c, i) { o[c] = p[i]; });
      return o;
    });
  }

  Promise.all([
    fetch("dados/arvore.json").then(function (r) { return r.json(); }),
    fetch("dados/baseline.csv").then(function (r) { return r.text(); })
  ]).then(function (res) {
    arvore = res[0];
    baseline = lerCsv(res[1]);
    montarDispositivos();
    montarFluxos();
    $("#btn-iniciar").disabled = false;
  }).catch(function (e) {
    $("#fase-titulo").textContent = "Não consegui carregar os dados do modelo";
    $("#fase-texto").textContent = "Verifique se as pastas dados/ e js/ foram enviadas junto com a página. (" + e + ")";
  });

  /* ---------------- a árvore treinada ---------------- */

  function prever(vetor) {
    var no = arvore.raiz;
    while (!no.folha) {
      no = (vetor[no.var] <= no.corte) ? no.esq : no.dir;
    }
    var probs = {};
    arvore.classes.forEach(function (c, i) { probs[c] = no.proba[i]; });
    return { classe: no.classe, probs: probs };
  }

  /* ---------------- medir a rede ---------------- */

  function sondar(alvo) {
    var inicio = performance.now();
    var ctrl = new AbortController();
    var corta = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    var url = alvo.url + (alvo.url.indexOf("?") >= 0 ? "&" : "?") + "cb=" + Math.random();
    return fetch(url, {
      cache: "no-store",
      mode: alvo.externo ? "no-cors" : "same-origin",
      signal: ctrl.signal
    }).then(function () {
      clearTimeout(corta);
      return performance.now() - inicio;
    }).catch(function () {
      clearTimeout(corta);
      return null;
    });
  }

  /* Os eventos são calculados em cima do baseline do próprio alvo, para que
     demonstrem RISCO e FALHA de forma confiável, qualquer que seja o estado
     real da rede no momento da apresentação. */
  function aplicarEvento(rtts, e, base) {
    if (!e) return { rtts: rtts, simulado: false };
    var validos = rtts.filter(function (r) { return r !== null; });
    var medio = validos.length ? validos.reduce(function (a, b) { return a + b; }, 0) / validos.length : 50;

    if (e === "latencia") {
      // acima do P99 do alvo => FALHA pela regra de rótulo do projeto
      var alvoRtt = base ? base.p99 * 1.6 : medio * 3;
      rtts = [0, 1, 2].map(function () { return alvoRtt * (0.97 + Math.random() * 0.06); });
    }
    if (e === "jitter") {
      // jitter acima do P95 do alvo, com a latência média perto do normal => RISCO
      var centro = base ? base.mediana : medio;
      var d = (base ? base.p95_jitter : Math.max(medio * 0.05, 1)) * 4.9;
      rtts = [Math.max(0.1, centro - d), centro, centro + d];
    }
    if (e === "perda") { rtts = rtts.slice(); rtts[1] = null; }   // 1 de 3 => RISCO
    if (e === "queda") rtts = [null, null, null];                  // 3 de 3 => FALHA
    return { rtts: rtts, simulado: true, tipo: e };
  }

  /* ---------------- etapa 1: medidas básicas ---------------- */

  function basicas(rtts) {
    var validos = rtts.filter(function (r) { return r !== null; });
    var perda = (rtts.length - validos.length) / rtts.length * 100;
    if (!validos.length) {
      return { perda_pct: perda, rtt_avg: null, rtt_min: null, rtt_max: null, jitter: null, rtt_ausente: 1 };
    }
    var soma = validos.reduce(function (a, b) { return a + b; }, 0);
    var media = soma / validos.length;
    var jitter = 0;
    if (validos.length > 1) {
      var v = validos.reduce(function (a, r) { return a + (r - media) * (r - media); }, 0) / validos.length;
      jitter = Math.sqrt(v);   // desvio-padrão populacional, ddof=0, como no projeto
    }
    return {
      perda_pct: perda, rtt_avg: media, rtt_min: Math.min.apply(null, validos),
      rtt_max: Math.max.apply(null, validos), jitter: jitter, rtt_ausente: 0
    };
  }

  /* ---------------- baseline provisório do alvo ---------------- */

  function percentil(arr, p) {
    if (!arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var i = (a.length - 1) * p;
    var b = Math.floor(i), t = Math.ceil(i);
    return b === t ? a[b] : a[b] + (a[t] - a[b]) * (i - b);
  }

  function calcularBase(medicoes) {
    var rtts = medicoes.map(function (m) { return m.b.rtt_avg; }).filter(function (r) { return r !== null; });
    var jits = medicoes.map(function (m) { return m.b.jitter; }).filter(function (j) { return j !== null; });
    if (rtts.length < 5) return null;
    return {
      mediana: percentil(rtts, 0.5), p95: percentil(rtts, 0.95), p99: percentil(rtts, 0.99),
      p95_jitter: percentil(jits, 0.95) || 0.0001, n: rtts.length
    };
  }

  /* ---------------- etapas 3 a 6: as 21 variáveis ---------------- */

  function razao(valor, denom) {
    if (valor === null || denom === null || !denom || !isFinite(denom)) return SENTINELA;
    var r = valor / denom;
    return isFinite(r) ? r : SENTINELA;
  }

  function montarVetor(medicoes, base) {
    var i = medicoes.length - 1, atual = medicoes[i].b, v = {};
    v.perda_pct = atual.perda_pct;
    v.rtt_ausente = atual.rtt_ausente;
    v.razao_rtt_p95 = razao(atual.rtt_avg, base.p95);
    v.razao_rtt_p99 = razao(atual.rtt_avg, base.p99);
    v.razao_jitter_p95 = razao(atual.jitter, base.p95_jitter);
    v.amplitude_rtt_rel = atual.rtt_avg ? razao(atual.rtt_max - atual.rtt_min, atual.rtt_avg) : SENTINELA;
    // o navegador não expõe o TTL: as duas variáveis que dependem dele recebem a sentinela
    v.delta_ttl_clip = SENTINELA;
    v.ttl_reset = 0;

    [3, 6, 12].forEach(function (n) {
      var jan = medicoes.slice(Math.max(0, i - n + 1), i + 1);
      var perdas = jan.map(function (m) { return m.b.perda_pct; });
      v["perda_media_w" + n] = perdas.reduce(function (a, b) { return a + b; }, 0) / perdas.length;
      var r95 = jan.map(function (m) { return razao(m.b.rtt_avg, base.p95); }).filter(function (x) { return x !== SENTINELA; });
      var j95 = jan.map(function (m) { return razao(m.b.jitter, base.p95_jitter); }).filter(function (x) { return x !== SENTINELA; });
      v["rtt_p95_max_w" + n] = r95.length ? Math.max.apply(null, r95) : SENTINELA;
      v["jitter_p95_max_w" + n] = j95.length ? Math.max.apply(null, j95) : SENTINELA;
      v["n_rtt_acima_p95_w" + n] = r95.filter(function (x) { return x > 1; }).length;
    });

    var seguidas = 0;
    for (var k = i; k >= 0; k--) { if (medicoes[k].b.perda_pct > 0) seguidas++; else break; }
    v.perdas_consecutivas = seguidas;
    return v;
  }

  /* ---------------- regra de rótulo do projeto: estado AGORA ---------------- */

  function estadoAgora(b, base) {
    if (b.perda_pct >= 66.6) return "FALHA";
    if (b.rtt_avg !== null && base && b.rtt_avg > base.p99) return "FALHA";
    if (b.perda_pct >= 33.3) return "RISCO";
    if (b.rtt_avg !== null && base && b.rtt_avg > base.p95) return "RISCO";
    if (b.jitter !== null && base && b.jitter > base.p95_jitter) return "RISCO";
    return "OK";
  }

  /* ---------------- ciclo ---------------- */

  function umCiclo() {
    ciclo++;
    // O evento vale por alguns ciclos seguidos, como uma falha real duraria:
    // é isso que enche as janelas de 3, 6 e 12 medições e faz a árvore reagir.
    var eventoDoCiclo = null;
    if (eventoPendente && eventoPendente.restantes > 0) {
      eventoDoCiclo = eventoPendente.tipo;
      eventoPendente.restantes--;
      if (eventoPendente.restantes === 0) eventoPendente = null;
    }

    ALVOS.forEach(function (alvo) {
      var st = estado[alvo.id];
      if (st.indisponivel) return;
      var sondas = [];
      for (var i = 0; i < PACOTES; i++) sondas.push(sondar(alvo));
      Promise.all(sondas).then(function (rtts) {
        var ev = aplicarEvento(rtts, eventoDoCiclo, st.base);
        var b = basicas(ev.rtts);

        if (b.rtt_ausente === 1 && !ev.simulado) {
          st.falhasSeguidas++;
          if (st.falhasSeguidas >= 3 && st.medicoes.length < CICLOS_APRENDIZADO) {
            st.indisponivel = true;
            desenharDispositivos();
            return;
          }
        } else if (!ev.simulado) {
          st.falhasSeguidas = 0;
        }

        var reg = { t: new Date(), b: b, simulado: ev.simulado, tipo: ev.tipo || null,
                    agora: null, previsao: null, probs: null, vetor: null };
        st.medicoes.push(reg);
        if (st.medicoes.length > 200) st.medicoes.shift();

        if (st.medicoes.length >= CICLOS_APRENDIZADO) {
          if (!st.base) st.base = calcularBase(st.medicoes.slice(0, CICLOS_APRENDIZADO));
          if (st.base) {
            reg.agora = estadoAgora(b, st.base);
            var vetor = montarVetor(st.medicoes, st.base);
            var p = prever(vetor);
            reg.previsao = p.classe; reg.probs = p.probs; reg.vetor = vetor;
          }
        }
        desenharTudo();
      });
    });

    if (eventoDoCiclo) {
      var faltam = eventoPendente ? eventoPendente.restantes : 0;
      $("#sim-estado").innerHTML = "Injetando <b>" + eventoDoCiclo + "</b>" +
        (faltam ? " — mais " + faltam + " ciclo" + (faltam > 1 ? "s" : "") + "." : " — último ciclo do evento.") +
        " Toda medição marcada com <b>SIM</b> é simulada; as demais são medições reais.";
    }
    atualizarFase();
  }

  function atualizarFase() {
    var cx = $("#fase"), tit = $("#fase-titulo"), txt = $("#fase-texto");
    cx.className = "aviso";
    if (!rodando) {
      tit.textContent = "Parado";
      txt.textContent = "Clique em “Iniciar monitoramento”. Os primeiros " + CICLOS_APRENDIZADO + " ciclos servem para o sistema aprender o normal de cada alvo; só depois ele começa a classificar.";
      return;
    }
    var n = Math.max.apply(null, ALVOS.map(function (a) { return estado[a.id].medicoes.length; }));
    if (n < CICLOS_APRENDIZADO) {
      cx.className = "aviso aprendendo";
      tit.textContent = "Aprendendo o normal — ciclo " + n + " de " + CICLOS_APRENDIZADO;
      txt.textContent = "Ainda não dá para classificar: o modelo compara cada medição com o P95 e o P99 do próprio caminho, e esses valores só existem depois de observar o alvo por um tempo.";
    } else {
      cx.className = "aviso rodando";
      tit.textContent = "Classificando ao vivo";
      txt.textContent = "Baseline provisório calculado. Cada nova medição passa pela árvore de decisão treinada no projeto, que prevê a classe da próxima.";
      document.querySelectorAll("[data-sim]").forEach(function (b) { b.disabled = false; });
    }
  }

  /* ---------------- desenho ---------------- */

  function montarDispositivos() {
    var c = $("#dispositivos");
    c.innerHTML = "";
    ALVOS.forEach(function (a) {
      var d = el("div", "dispositivo");
      d.id = "disp-" + a.id;
      c.appendChild(d);
    });
    desenharDispositivos();
  }

  function fmt(x, casas) { return x === null || x === undefined ? "—" : x.toFixed(casas === undefined ? 1 : casas); }

  function desenharDispositivos() {
    ALVOS.forEach(function (a) {
      var st = estado[a.id], d = document.getElementById("disp-" + a.id);
      if (!d) return;
      var ult = st.medicoes[st.medicoes.length - 1];
      var cls = ult && ult.agora ? ult.agora : null;
      d.className = "dispositivo" + (cls ? " estado-" + cls : "") + (st.indisponivel ? " indisponivel" : "");

      var html = '<div class="disp-topo"><span class="disp-nome">' + a.nome + "</span>";
      html += '<span class="selo ' + (cls || "neutro") + '">' + (st.indisponivel ? "INDISPONÍVEL" : (cls || "—")) + "</span></div>";
      html += '<div class="disp-alvo">' + a.url + "</div>";

      if (st.indisponivel) {
        html += '<p class="disp-base">Este alvo não respondeu às primeiras sondagens, então foi desligado para não gerar um FALHA que não é real. Costuma acontecer quando a página está aberta num ambiente que bloqueia requisições a outros domínios.</p>';
        d.innerHTML = html;
        return;
      }

      html += '<div class="disp-grade">';
      html += '<div class="disp-item"><span class="k">Latência</span><span class="v">' + (ult ? fmt(ult.b.rtt_avg) + " ms" : "—") + "</span></div>";
      html += '<div class="disp-item"><span class="k">Perda</span><span class="v">' + (ult ? fmt(ult.b.perda_pct, 0) + "%" : "—") + "</span></div>";
      html += '<div class="disp-item"><span class="k">Jitter</span><span class="v">' + (ult ? fmt(ult.b.jitter, 2) + " ms" : "—") + "</span></div>";
      html += "</div>";

      if (st.base) {
        html += '<div class="disp-previsao"><span class="titulo">Previsão para a próxima medição</span><div class="barras-prob">';
        ["OK", "RISCO", "FALHA"].forEach(function (k) {
          var p = ult && ult.probs ? ult.probs[k] : 0;
          html += '<div class="prob ' + k + '"><span>' + k + '</span><div class="trilho"><div class="pf" style="width:' +
                  (p * 100).toFixed(1) + '%"></div></div><span class="val">' + (p * 100).toFixed(0) + "%</span></div>";
        });
        html += "</div>";
        html += '<p class="disp-base">Baseline provisório deste alvo, com ' + st.base.n + ' medições: mediana <code>' +
                fmt(st.base.mediana) + " ms</code>, P95 <code>" + fmt(st.base.p95) + " ms</code>, P99 <code>" +
                fmt(st.base.p99) + " ms</code>. Não é o baseline de sete dias usado no projeto.</p></div>";
      } else {
        html += '<p class="disp-base">Observando para montar o baseline deste alvo: ' + st.medicoes.length + " de " + CICLOS_APRENDIZADO + " ciclos.</p>";
      }
      d.innerHTML = html;
    });
  }

  var COR = { OK: "#2BE38B", RISCO: "#FFB224", FALHA: "#FF007A" };

  function desenharHistorico() {
    var svg = $("#historico"), L = 860, A = 220;
    var ativos = ALVOS.filter(function (a) { return !estado[a.id].indisponivel; });
    var partes = [];
    var alturaFaixa = ativos.length ? (A - 30) / ativos.length : A;

    ativos.forEach(function (a, idx) {
      var st = estado[a.id];
      var med = st.medicoes.slice(-MAX_HIST);
      var topo = idx * alturaFaixa + 18;
      var hUtil = alturaFaixa - 34;
      partes.push('<text x="0" y="' + (topo - 5) + '" font-family="JetBrains Mono, monospace" font-size="10" fill="#92A4C4">' + a.nome + "</text>");
      partes.push('<line x1="0" y1="' + (topo + hUtil) + '" x2="' + L + '" y2="' + (topo + hUtil) + '" stroke="#94ADD6" stroke-opacity="0.16"/>');
      if (!med.length) return;
      var rtts = med.map(function (m) { return m.b.rtt_avg || 0; });
      var maxv = Math.max.apply(null, rtts) || 1;
      var larg = L / MAX_HIST, w = Math.max(4, larg - 3);
      med.forEach(function (m, i) {
        var h = m.b.rtt_avg === null ? hUtil : Math.max(2, (m.b.rtt_avg / maxv) * hUtil);
        var cor = m.b.rtt_avg === null ? COR.FALHA : (COR[m.agora] || "#5A6B84");
        var x = i * larg;
        partes.push('<rect x="' + x.toFixed(1) + '" y="' + (topo + hUtil - h).toFixed(1) + '" width="' + w.toFixed(1) +
          '" height="' + h.toFixed(1) + '" rx="2" fill="' + cor + '" fill-opacity="' + (m.simulado ? 0.35 : 0.9) + '"' +
          (m.simulado ? ' stroke="' + cor + '" stroke-dasharray="2 2"' : "") + "></rect>");
        if (m.simulado) {
          partes.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (topo + hUtil - h - 4).toFixed(1) +
            '" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="7" fill="' + cor + '">SIM</text>');
        }
      });
      partes.push('<text x="' + L + '" y="' + (topo - 5) + '" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="9" fill="#92A4C4">máx ' + maxv.toFixed(0) + " ms</text>");
    });

    svg.innerHTML = partes.join("");
    var total = ALVOS.reduce(function (s, a) { return s + estado[a.id].medicoes.length; }, 0);
    $("#hist-nota").textContent = total ? "Altura da barra = latência da medição. Cor = estado no momento da medição. Barra tracejada com SIM = evento simulado." : "Sem medições ainda.";
  }

  function desenharRegistro() {
    var tb = $("#registro tbody");
    var linhas = [];
    ALVOS.forEach(function (a) {
      estado[a.id].medicoes.forEach(function (m, i) { linhas.push({ a: a, m: m, i: i + 1 }); });
    });
    linhas.sort(function (x, y) { return y.m.t - x.m.t; });
    linhas = linhas.slice(0, 25);
    tb.innerHTML = linhas.map(function (r) {
      var m = r.m;
      var conf = m.probs && m.previsao ? (m.probs[m.previsao] * 100).toFixed(0) + "%" : "—";
      var rz = m.vetor && m.vetor.razao_rtt_p95 !== SENTINELA ? m.vetor.razao_rtt_p95.toFixed(3) : "—";
      var lat = m.b.rtt_avg === null ? "sem resposta" : m.b.rtt_avg.toFixed(1) + " ms";
      return "<tr>" +
        "<td>" + r.i + "</td>" +
        "<td>" + r.a.nome + "</td>" +
        "<td>" + m.t.toLocaleTimeString("pt-BR") + "</td>" +
        '<td class="n">' + lat + "</td>" +
        '<td class="n">' + m.b.perda_pct.toFixed(0) + "%</td>" +
        '<td class="n">' + rz + "</td>" +
        '<td><span class="cls ' + (m.agora || "") + '">' + (m.agora || "—") + "</span></td>" +
        '<td><span class="cls ' + (m.previsao || "") + '">' + (m.previsao || "—") + "</span></td>" +
        '<td class="n">' + conf + "</td>" +
        "<td>" + (m.simulado ? '<span class="tag-sim">SIM ' + (m.tipo || "") + "</span>" : '<span class="tag-real">real</span>') + "</td>" +
        "</tr>";
    }).join("");
  }

  function desenharTudo() { desenharDispositivos(); desenharHistorico(); desenharRegistro(); }

  /* ---------------- aba dos fluxos ---------------- */

  function montarFluxos() {
    var p95 = baseline.map(function (f) { return parseFloat(f.p95_rtt_A); }).filter(isFinite).sort(function (a, b) { return a - b; });
    var nv = baseline.filter(function (f) { return (f.conjunto_no_projeto || "").indexOf("nao_visto") === 0; }).length;
    $("#resumo-fluxos").innerHTML =
      cartao(baseline.length, "caminhos com baseline congelado") +
      cartao(p95[0].toFixed(1) + " ms", "o menor P95 entre os caminhos") +
      cartao(p95[p95.length - 1].toFixed(1) + " ms", "o maior P95 entre os caminhos") +
      cartao(Math.round(p95[p95.length - 1] / p95[0]) + "×", "de diferença entre os dois extremos");

    var L = 860, A = 260, mt = 16, mb = 34, ml = 44;
    var ord = baseline.slice().sort(function (a, b) { return parseFloat(a.p95_rtt_A) - parseFloat(b.p95_rtt_A); });
    var minv = Math.max(0.1, p95[0]), maxv = p95[p95.length - 1];
    var lmin = Math.log10(minv), lmax = Math.log10(maxv);
    var escala = function (v) { return A - mb - ((Math.log10(Math.max(v, minv)) - lmin) / (lmax - lmin)) * (A - mt - mb); };
    var larg = (L - ml) / ord.length;
    var g = [];
    [1, 10, 100, 1000].forEach(function (t) {
      if (t < minv * 0.9 || t > maxv * 1.1) return;
      var y = escala(t);
      g.push('<line x1="' + ml + '" y1="' + y.toFixed(1) + '" x2="' + L + '" y2="' + y.toFixed(1) + '" stroke="#94ADD6" stroke-opacity="0.14"/>');
      g.push('<text x="' + (ml - 7) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="9" fill="#92A4C4">' + t + " ms</text>");
    });
    ord.forEach(function (f, i) {
      var v = parseFloat(f.p95_rtt_A), y = escala(v);
      var novo = (f.conjunto_no_projeto || "").indexOf("nao_visto") === 0;
      g.push('<rect x="' + (ml + i * larg).toFixed(2) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1.4, larg - 0.8).toFixed(2) +
        '" height="' + (A - mb - y).toFixed(1) + '" fill="' + (novo ? "#A663F2" : "#00F5FF") + '" fill-opacity="' + (novo ? 0.95 : 0.55) + '"></rect>');
    });
    g.push('<text x="' + ml + '" y="' + (A - 10) + '" font-family="JetBrains Mono, monospace" font-size="9" fill="#92A4C4">caminhos ordenados pelo P95 →</text>');
    g.push('<text x="' + L + '" y="' + (A - 10) + '" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="9" fill="#A663F2">roxo = fora do treino (' + nv + ")</text>");
    $("#grafico-fluxos").innerHTML = g.join("");

    desenharTabelaFluxos("");
    $("#busca").addEventListener("input", function (e) { desenharTabelaFluxos(e.target.value.trim()); });
  }

  function cartao(v, l) {
    return '<div class="cartao-num"><span class="v gradiente">' + v + '</span><span class="l">' + l + "</span></div>";
  }

  function desenharTabelaFluxos(filtro) {
    var fs = baseline.filter(function (f) { return !filtro || f.id_fluxo.indexOf(filtro) >= 0; });
    $("#tabela-fluxos tbody").innerHTML = fs.slice(0, 200).map(function (f) {
      var novo = (f.conjunto_no_projeto || "").indexOf("nao_visto") === 0;
      return "<tr><td>" + f.id_fluxo + (novo ? ' <span class="marca-nv">fora do treino</span>' : "") + "</td>" +
        '<td class="n">' + parseFloat(f.mediana_rtt_A).toFixed(1) + "</td>" +
        '<td class="n">' + parseFloat(f.p95_rtt_A).toFixed(1) + "</td>" +
        '<td class="n">' + parseFloat(f.p99_rtt_A).toFixed(1) + "</td>" +
        '<td class="n">' + parseFloat(f.p95_jitter_A).toFixed(2) + "</td>" +
        '<td class="n">' + parseFloat(f.ttl_baseline).toFixed(0) + "</td>" +
        "<td>" + (novo ? "não visto" : "modelagem") + "</td></tr>";
    }).join("");
    $("#nota-tabela").textContent = fs.length + " de " + baseline.length + " caminhos. Latências em milissegundos, calculadas entre 21 e 28/09/2026.";
  }

  /* ---------------- controles ---------------- */

  $("#btn-iniciar").disabled = true;
  $("#btn-iniciar").addEventListener("click", function () {
    if (rodando) return;
    rodando = true;
    this.disabled = true;
    $("#btn-parar").disabled = false;
    umCiclo();
    relogio = setInterval(umCiclo, INTERVALO_MS);
    atualizarFase();
  });

  $("#btn-parar").addEventListener("click", function () {
    rodando = false;
    clearInterval(relogio);
    this.disabled = true;
    $("#btn-iniciar").disabled = false;
    atualizarFase();
  });

  document.querySelectorAll("[data-sim]").forEach(function (b) {
    b.addEventListener("click", function () {
      eventoPendente = { tipo: b.getAttribute("data-sim"), restantes: 4 };
      $("#sim-estado").innerHTML = "Evento armado: será injetado nos <b>próximos 4 ciclos</b>, para encher as janelas de 3, 6 e 12 medições e fazer a árvore reagir.";
    });
  });

  var abas = { "t-vivo": "p-vivo", "t-fluxos": "p-fluxos" };
  Object.keys(abas).forEach(function (t) {
    document.getElementById(t).addEventListener("click", function () {
      Object.keys(abas).forEach(function (o) {
        var btn = document.getElementById(o), pan = document.getElementById(abas[o]);
        var ativo = o === t;
        btn.classList.toggle("ativa", ativo);
        btn.setAttribute("aria-selected", ativo ? "true" : "false");
        pan.hidden = !ativo;
      });
    });
  });
})();
