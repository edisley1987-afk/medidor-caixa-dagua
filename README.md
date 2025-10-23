<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Painel - Reservatórios (Realtime)</title>
<link href="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.min.css" rel="stylesheet">
<style>
  body{font-family:Inter,Arial,Helvetica,sans-serif;margin:14px;color:#222}
  h1{margin:0 0 8px;font-size:20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
  .card{padding:12px;border-radius:8px;background:#fff;border:1px solid #e6e6e6;box-shadow:0 1px 3px rgba(0,0,0,.04)}
  .bar{height:18px;background:#eee;border-radius:10px;overflow:hidden}
  .bar > i{display:block;height:100%;background:linear-gradient(90deg,#4caf50,#8bc34a);width:0%}
  .meta{font-size:13px;color:#555;margin-top:6px}
  .small{font-size:12px;color:#777}
  #topcontrols{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .warn{background:#fff3cd;border:1px solid #ffe8a1;padding:10px;border-radius:6px;color:#8a6d00}
  .err{background:#ffd6d6;border:1px solid #ffb2b2;padding:10px;border-radius:6px;color:#8a0000}
  button{padding:8px 10px;border:0;border-radius:6px;background:#1976d2;color:#fff;cursor:pointer}
  input,select{padding:6px;border:1px solid #ccc;border-radius:6px}
  #chartWrap{margin-top:14px}
  footer{margin-top:18px;font-size:12px;color:#666}
</style>
</head>
<body>
<h1>Painel em tempo real — Reservatórios</h1>

<div id="topcontrols">
  <label class="small">Endpoint (Hookdeck / Webhook): <input id="hookUrl" style="width:420px" /></label>
  <button id="saveUrl">Salvar URL</button>
  <label class="small">Intervalo poll (s): <input id="intervalSec" type="number" value="10" style="width:70px" /></label>
  <button id="start">Iniciar</button>
  <button id="stop" disabled>Parar</button>
</div>

<div id="statusArea"></div>

<div class="grid" id="cards"></div>

<div id="chartWrap" class="card">
  <h3>Gráfico — Últimas 24 horas (dados locais armazenados no navegador)</h3>
  <canvas id="historyChart" height="160"></canvas>
  <p class="small">O gráfico armazena pontos localmente enquanto a página estiver aberta. Para persistência, conecte esse painel a um backend ou banco.</p>
</div>

<footer>Obs: se o navegador bloquear o fetch por CORS aparecerá instrução para habilitar via Hookdeck (forward com CORS) ou usar um proxy simples. </footer>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
/*
  Painel realtime que:
  - puxa JSON do Hookdeck/webhook
  - espera formato com "seq" e "data": [ { time, unit, value, dev_id, ref } , ... ]
  - mapeia dev_id/ref para os reservatórios configurados abaixo
  - converte leitura -> percentual (com ranges editáveis)
  - calcula volume = percentual * capacidade
  - mantém histórico em memória (últimas 24h) e desenha gráfico (Chart.js)
*/

/* ---------- CONFIG INICIAL (edite se quiser) ---------- */
/* Tentativa de normalizar a URL que você enviou:
   se a string enviada pelo usuário não estiver bem formada,
   tentei montar uma forma válida; ainda assim, revise no campo. */
const HOOK_URL_GUESSED = 'https://webhook.site/6f587dee-896b-4597-aef4-e87aaf3a95d2';

/* sensores / reservatórios (capacidade em litros e faixa de calibração sensor)
   calibration: valueMin and valueMax são os valores sensor que correspondem a 0% e 100%
   ajuste se tiver calibração exata */
const RESERVATORIOS = {
  'Reservatorio_Elevador': { display:'Elevador', capacity:20000, height:1.45, valueMin:0.003, valueMax:0.009 },
  'Reservatorio_Osmose':   { display:'Osmose', capacity:200,   height:1.00, valueMin:0.003, valueMax:0.009 },
  'Reservatorio_CME':      { display:'CME',    capacity:1000,  height:0.45, valueMin:0.003, valueMax:0.009 },
  'Reservatorio_Abrandada':{ display:'Abrandada', capacity:9000, height:0.60, valueMin:0.003, valueMax:0.009 },
  // pressões (apenas exibidas numericamente)
  'Pressao_Saida':         { display:'Pressão Saída', isPressure:true },
  'Pressao_Retorno':       { display:'Pressão Retorno', isPressure:true }
};

/* ---------- FIM CONFIG ---------- */

let pollTimer = null;
let pollInterval = 10000;
let hookUrl = HOOK_URL_GUESSED;
document.getElementById('hookUrl').value = hookUrl;
document.getElementById('intervalSec').value = pollInterval/1000;

const statusArea = document.getElementById('statusArea');
const cardsEl = document.getElementById('cards');

function showStatus(msg,cls){ statusArea.innerHTML = '<div class="'+(cls||'')+'">'+msg+'</div>'; }

function createCards(){
  cardsEl.innerHTML = '';
  for(const key of Object.keys(RESERVATORIOS)){
    const r = RESERVATORIOS[key];
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'card-'+key;
    card.innerHTML = '<h3>'+r.display+'</h3>'
      + '<div class="bar"><i id="bar-'+key+'" style="width:0%"></i></div>'
      + '<div class="meta"><span id="pct-'+key+'">—</span> • <span id="vol-'+key+'">—</span> • <span id="altura-'+key+'">—</span></div>'
      + (r.isPressure ? '<div class="small">Leitura pressão: <span id="press-'+key+'">—</span></div>' : '')
      + '';
    cardsEl.appendChild(card);
  }
}
createCards();

/* histórico em memória: map label -> [{ts, pct, volume}] */
const history = {};
for(const k of Object.keys(RESERVATORIOS)) history[k]=[];

/* Chart.js setup */
const ctx = document.getElementById('historyChart').getContext('2d');
const chartConfig = {
  type: 'line',
  data: { labels: [], datasets: [] },
  options: {
    responsive:true,
    scales: {
      x: { type:'time', time:{unit:'hour', tooltipFormat:'DD/MM HH:mm'}, title:{display:true,text:'Hora'} },
      y: { beginAtZero:true, title:{display:true,text:'% / Litros (secundário)'} }
    },
    plugins:{legend:{display:true}}
  }
};
const historyChart = new Chart(ctx, chartConfig);

/* util: calcular percentual a partir de leitura e faixa */
function percentFromValue(v,min,max){
  if (typeof v !== 'number' || !isFinite(v)) return 0;
  if (max===min) return 0;
  let p = ((v - min) / (max - min)) * 100;
  if (isNaN(p)) return 0;
  return Math.max(0, Math.min(100, +p.toFixed(1)));
}

/* quando chegar dados */
function handlePayload(json){
  // json expected: { seq:..., data: [ {time, unit, value, dev_id, ref}, ... ] }
  if (!json || !Array.isArray(json.data)) {
    showStatus('Formato inválido recebido (esperado campo data[]).','warn');
    return;
  }

  const now = Date.now();
  // process each item; choose mapping by ref lowercased
  json.data.forEach(item=>{
    const ref = (item.ref||'').toString();
    const refKey = mapRefToKey(ref, item.dev_id);
    if (!refKey) return;
    const cfg = RESERVATORIOS[refKey];
    if (!cfg) return;

    const raw = parseFloat(item.value);
    if (cfg.isPressure){
      document.getElementById('press-'+refKey).innerText = raw;
      // store small history
      history[refKey].push({ts: item.time? tsFromMicro(item.time): now, pct:null, volume:raw});
    } else {
      // convert raw -> percent using calibration from cfg.valueMin/valueMax
      const pct = percentFromValue(raw, cfg.valueMin, cfg.valueMax);
      const volume = +( (pct/100) * cfg.capacity ).toFixed(2);
      const alturaM = +( (pct/100) * cfg.height ).toFixed(3);
      // update card
      const bar = document.getElementById('bar-'+refKey);
      if (bar) {
        bar.style.width = pct + '%';
        // color zones
        if (pct>=80) bar.style.background='linear-gradient(90deg,#2196f3,#4caf50)';
        else if (pct>=50) bar.style.background='linear-gradient(90deg,#ffb74d,#fdd835)';
        else bar.style.background='linear-gradient(90deg,#ff7043,#f44336)';
      }
      const pctEl = document.getElementById('pct-'+refKey); if(pctEl) pctEl.innerText = pct+'%';
      const volEl = document.getElementById('vol-'+refKey); if(volEl) volEl.innerText = volume+' L';
      const altEl = document.getElementById('altura-'+refKey); if(altEl) altEl.innerText = alturaM+' m';

      // save history point (timestamp in ms)
      history[refKey].push({ts: item.time? tsFromMicro(item.time): now, pct:pct, volume:volume});
      // prune older than 24h
      const limit = Date.now() - (24*60*60*1000);
      history[refKey] = history[refKey].filter(pt => pt.ts >= limit);
    }
  });

  refreshChart();
}

/* map ref/dev_id to keys in RESERVATORIOS */
function mapRefToKey(refLower, devId){
  const r = refLower.toLowerCase();
  if (r.includes('elevador')) return 'Reservatorio_Elevador';
  if (r.includes('osmose')) return 'Reservatorio_Osmose';
  if (r.includes('cme')) return 'Reservatorio_CME';
  if (r.includes('abrandada') || r.includes('agua_ab')) return 'Reservatorio_Abrandada';
  if (r.includes('pressao_saida') || r.includes('presao_saida') || r.includes('pressão_saida')) return 'Pressao_Saida';
  if (r.includes('pressao_retorno') || r.includes('presao_retorno')) return 'Pressao_Retorno';
  // fallback: try devId mapping
  if (devId) {
    const id = devId.toLowerCase();
    if (id.includes('d29b')) return 'Reservatorio_Elevador';
    if (id.includes('d296')) return 'Reservatorio_Osmose';
    if (id.includes('fc62')) return 'Reservatorio_CME';
    if (id.includes('fc60')) return 'Reservatorio_Abrandada';
  }
  return null;
}

function tsFromMicro(micro){
  // sua fonte usa valores compridos; se for microssegundos, converte a ms
  // heurística: se > 1e12 assume microssegundos
  const n = Number(micro);
  if (n > 1e12) return Math.floor(n/1000);
  return n;
}

/* Chart rendering: uma série por reservatório (percentual) */
function refreshChart(){
  // build labels (union of timestamps sorted)
  const keys = Object.keys(RESERVATORIOS).filter(k => !RESERVATORIOS[k].isPressure);
  // gather times from first series
  let times = [];
  keys.forEach(k=> history[k].forEach(pt=> times.push(pt.ts)));
  times = Array.from(new Set(times)).sort((a,b)=>a-b);
  // limit last 24h
  const limit = Date.now() - (24*60*60*1000);
  times = times.filter(t=>t>=limit);

  // build datasets
  const datasets = keys.map((k, idx) => {
    const color = ['#1976d2','#43a047','#ffb300','#9c27b0'][idx%4];
    // map times to values
    const data = times.map(t=>{
      const arr = history[k].filter(p => p.ts <= t);
      const last = arr.length? arr[arr.length-1] : null;
      return last? last.pct : null;
    });
    return { label: RESERVATORIOS[k].display, data: data, borderColor: color, backgroundColor: color, spanGaps:true, tension:0.2, parsing:false, pointRadius:0};
  });

  historyChart.data.labels = times.map(t=> new Date(t));
  historyChart.data.datasets = datasets;
  historyChart.update();
}

/* Fetch loop */
async function pollOnce(){
  try {
    showStatus('Buscando dados...');
    // tentativa direta:
    const res = await fetch(hookUrl);
    if (!res.ok) {
      showStatus('Resposta não OK: '+res.status,'err');
      return;
    }
    // tentar parsear como JSON
    const txt = await res.text();
    let json;
    try{ json = JSON.parse(txt); } catch(e){
      // às vezes webhook.site retorna HTML da view; procurar por JSON dentro
      const maybe = extractJsonFromText(txt);
      if (maybe) json = maybe; else {
        showStatus('Resposta não é JSON (possível CORS/HTML). Veja instruções abaixo.','err');
        return;
      }
    }
    // handle payload
    handlePayload(json);
    showStatus('Última atualização: '+(new Date()).toLocaleTimeString());
  } catch(err){
    console.error('fetch error',err);
    // possivel CORS
    showStatus('Erro ao buscar (verifique CORS / URL). Detalhe: '+err.message,'err');
    showCorsHelp();
  }
}

function extractJsonFromText(txt){
  // tenta extrair o primeiro objeto JSON grande do HTML/texto
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start>=0 && end>start){
    try{
      const s = txt.substring(start, end+1);
      return JSON.parse(s);
    }catch(e){}
  }
  return null;
}

/* UI controls */
document.getElementById('saveUrl').addEventListener('click', ()=>{
  hookUrl = document.getElementById('hookUrl').value.trim();
  localStorage.setItem('hookUrl', hookUrl);
  showStatus('URL salva. Clique Iniciar.');
});
document.getElementById('start').addEventListener('click', ()=>{
  const val = document.getElementById('intervalSec').value;
  const sec = parseInt(val,10);
  pollInterval = (isNaN(sec) || sec<1) ? 10000 : sec*1000;
  document.getElementById('intervalSec').value = pollInterval/1000;
  // take value from input if user changed url
  hookUrl = document.getElementById('hookUrl').value.trim() || hookUrl;
  document.getElementById('start').disabled = true;
  document.getElementById('stop').disabled = false;
  pollOnce();
  pollTimer = setInterval(pollOnce, pollInterval);
});
document.getElementById('stop').addEventListener('click', ()=>{
  clearInterval(pollTimer); pollTimer = null;
  document.getElementById('start').disabled = false;
  document.getElementById('stop').disabled = true;
  showStatus('Parado');
});

/* load saved url */
const saved = localStorage.getItem('hookUrl');
if (saved) { document.getElementById('hookUrl').value = saved; hookUrl = saved; }

/* show CORS help text */
function showCorsHelp(){
  const el = document.getElementById('statusArea');
  el.innerHTML += '<div class="warn" style="margin-top:8px">Se o navegador bloquear por CORS, use uma destas opções:<ul><li>1) No Hookdeck, crie uma <b>Destination</b> que reenvie (forward) para este arquivo com CORS habilitado.</li><li>2) Use um pequeno proxy (ex.: deploy de <code>fetch</code> proxy no Vercel/Render) e aponte HOOK para esse proxy.</li><li>3) Se possível, gere na origem um endpoint que permita <code>Access-Control-Allow-Origin: *</code>.</li></ul></div>';
}

/* init empty dataset */
refreshChart();

</script>
</body>
</html>

