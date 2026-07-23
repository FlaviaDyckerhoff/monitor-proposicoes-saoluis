const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'MA - São Luís';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';


const CASA = 'CMSAOLUIS';
const BASE = 'https://www.cmsaoluis.ma.gov.br';
const ARQUIVO_ESTADO = 'estado.json';
const MAX_PAGES_PER_TYPE = Number(process.env.MAX_PAGES_PER_TYPE || 5);

const TIPOS = [
  { slug: 'projeto-de-lei-ordinaria', nome: 'Projeto de Lei Ordinária' },
  { slug: 'projeto-de-resolucao', nome: 'Projeto de Resolução' },
  { slug: 'projeto-de-decreto-legislativo', nome: 'Projeto de Decreto Legislativo' },
  { slug: 'indicacao', nome: 'Indicação' },
  { slug: 'requerimento', nome: 'Requerimento' },
  { slug: 'mocao', nome: 'Moção' },
  { slug: 'projeto-de-emenda-a-lei-organica', nome: 'Projeto de Emenda à Lei Orgânica' },
  { slug: 'prestacao-de-contas-do-executivo', nome: 'Prestação de Contas do Executivo' },
];

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  return { proposicoes_vistas: [], ultimos_por_tipo_ano: {}, ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function decodeHtml(texto) {
  return String(texto || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ccedil;/g, 'ç')
    .replace(/&atilde;/g, 'ã')
    .replace(/&otilde;/g, 'õ');
}

function limparHtml(texto) {
  return decodeHtml(texto).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(texto) {
  return String(texto ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function buscarUrl(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120', Accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.text();
}

function valorDl(bloco, rotulo) {
  const re = new RegExp('<dt>\\s*' + rotulo + ':?\\s*<\\/dt>\\s*<dd>([\\s\\S]*?)<\\/dd>', 'i');
  const match = bloco.match(re);
  return match ? limparHtml(match[1]) : '';
}

function normalizarIdentificacao(identificacao, titulo) {
  const texto = identificacao || titulo || '';
  const match = texto.match(/([A-Z]{2,6})[-\s]*(\d+)\/(\d{4})/i);
  if (match) return { sigla: match[1].toUpperCase(), numero: String(Number(match[2])), ano: match[3] };
  const tituloMatch = texto.match(/(.+?)\s+(\d+)\/(\d{4})/);
  if (tituloMatch) return { sigla: tituloMatch[1].trim(), numero: String(Number(tituloMatch[2])), ano: tituloMatch[3] };
  return { sigla: texto, numero: '-', ano: '-' };
}

function extrairProposicoes(html, tipo) {
  const itens = [];
  const blocos = html.split(/<div class="panel panel-primary rg-border-radius-none rg-index-item">/i).slice(1);
  for (const bruto of blocos) {
    const bloco = bruto.split(/<\/div>\s*<\/div>\s*<\/div>/i)[0] || bruto;
    const titulo = limparHtml((bruto.match(/<h3 class="panel-title">([\s\S]*?)<\/h3>/i) || [])[1] || '');
    const identificacao = valorDl(bruto, 'Identificação');
    const norm = normalizarIdentificacao(identificacao, titulo);
    const link = (bruto.match(/href="([^"]*\/atividade-legislativa\/proposicoes\/materia\/(\d+))"/i) || []);
    if (!link[1]) continue;
    const id = String(link[2]);
    itens.push({
      id,
      tipo: tipo.nome,
      sigla: norm.sigla,
      numero: norm.numero,
      ano: norm.ano,
      identificacao: identificacao || (norm.sigla + '-' + norm.numero + '/' + norm.ano),
      titulo,
      ementa: valorDl(bruto, 'Ementa\/Assunto'),
      autor: valorDl(bruto, 'Autoria'),
      situacao: valorDl(bruto, 'Situação'),
      link: link[1],
    });
  }
  return itens;
}

async function buscarTipo(tipo, idsVistos) {
  const todas = [];
  const vistosRodada = new Set();
  for (let pagina = 1; pagina <= MAX_PAGES_PER_TYPE; pagina++) {
    const url = BASE + '/atividade-legislativa/proposicoes/' + tipo.slug + (pagina === 1 ? '' : '/' + pagina);
    const html = await buscarUrl(url);
    const itens = extrairProposicoes(html, tipo);
    console.log(tipo.slug + ' página ' + pagina + ': ' + itens.length + ' proposições');
    if (!itens.length) break;
    let paginaTemVisto = false;
    for (const item of itens) {
      if (idsVistos.has(item.id)) paginaTemVisto = true;
      if (!vistosRodada.has(item.id)) {
        vistosRodada.add(item.id);
        todas.push(item);
      }
    }
    if (paginaTemVisto && process.env.SEED_ONLY !== '1') break;
  }
  return todas;
}

async function buscarProposicoes(idsVistos = new Set()) {
  const todas = [];
  for (const tipo of TIPOS) {
    const itens = await buscarTipo(tipo, idsVistos);
    todas.push(...itens);
  }
  const porId = new Map();
  for (const item of todas) porId.set(item.id, item);
  return [...porId.values()].sort((a, b) => Number(b.id) - Number(a.id));
}

function numeroInteiro(p) {
  const n = Number(String(p.numero || '').replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function chaveTipoAno(p) {
  return (p.sigla || p.tipo || 'OUTROS') + '|' + (p.ano || '-');
}

function calcularUltimosPorTipoAno(proposicoes) {
  const ultimos = {};
  for (const p of proposicoes) {
    const numero = numeroInteiro(p);
    if (!numero || !p.ano || p.ano === '-') continue;
    const chave = chaveTipoAno(p);
    ultimos[chave] = Math.max(ultimos[chave] || 0, numero);
  }
  return ultimos;
}

function detectarSaltos(proposicoes, estado) {
  const anteriores = estado.ultimos_por_tipo_ano || {};
  const atuais = calcularUltimosPorTipoAno(proposicoes);
  const presentes = {};
  for (const p of proposicoes) {
    const numero = numeroInteiro(p);
    if (!numero) continue;
    const chave = chaveTipoAno(p);
    if (!presentes[chave]) presentes[chave] = new Set();
    presentes[chave].add(numero);
  }
  const alertas = [];
  for (const [chave, atual] of Object.entries(atuais)) {
    const anterior = Number(anteriores[chave] || 0);
    if (!anterior || atual <= anterior + 1) continue;
    const faltantes = [];
    for (let n = anterior + 1; n < atual; n++) {
      if (!presentes[chave]?.has(n)) faltantes.push(n);
    }
    if (faltantes.length) {
      const [tipo, ano] = chave.split('|');
      alertas.push({ tipo, ano, anterior, atual, faltantes });
    }
  }
  return { alertas, atuais };
}

function renderAlertasSaltos(alertas) {
  if (!alertas.length) return '';
  const itens = alertas.map(a => '<li><strong>' + escapeHtml(a.tipo) + ' ' + escapeHtml(a.ano) + '</strong>: último visto ' + a.anterior + ', maior atual ' + a.atual + '. Possível(is) ausente(s): ' + escapeHtml(a.faltantes.join(', ')) + '</li>').join('');
  return '<div style="background:#fff4e5;border:1px solid #f59e0b;color:#7c2d12;padding:12px 14px;margin:12px 0;border-radius:4px"><strong>Alerta de sequência:</strong><ul style="margin:8px 0 0 18px;padding:0">' + itens + '</ul></div>';
}

function prioridadeTipoEmail(tipo) {
  const t = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function numeroProposicaoEmail(p) {
  const n = Number(String(p?.numero || '').replace(/\D/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function compararProposicoesEmail(a, b) {
  const tipoA = a?.sigla || a?.tipo || '';
  const tipoB = b?.sigla || b?.tipo || '';
  const prioridadeA = prioridadeTipoEmail(tipoA);
  const prioridadeB = prioridadeTipoEmail(tipoB);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  const tipoCmp = String(tipoA).localeCompare(String(tipoB), 'pt-BR');
  if (tipoCmp !== 0) return tipoCmp;
  return numeroProposicaoEmail(a) - numeroProposicaoEmail(b);
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra', 'BRT'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function radar03Identificacao(p) {
  return String(p?.identificacao ?? p?.proposicao ?? p?.rotulo ?? p?.titulo ?? '').trim();
}

function radar03Tipo(p) {
  const direto = String(p?.tipo ?? p?.sigla ?? '').trim();
  if (direto) return direto;
  const m = radar03Identificacao(p).match(/^([A-Za-zÀ-ÿ0-9.-]+(?:\s+[A-Za-zÀ-ÿ0-9.-]+){0,2})\s+\d/i);
  return m ? m[1].trim() : '';
}

function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (numero) {
    if (numero.includes('/') || !ano) return numero;
    return numero + '/' + ano;
  }
  const m = radar03Identificacao(p).match(/(S\/N|\d+\s*\/\s*\d{2,4}|\/\d{2,4}|\d+)/i);
  return m ? m[1].replace(/\s+/g, '') : '';
}

function radar03BlocoEmail(novas) {
  const seen = new Set();
  return (novas || []).map(p => {
    const tipo = radar03Tipo(p);
    const numero = radar03Numero(p);
    if (!tipo || !numero) return '';
    const row = `${tipo} ${numero}`;
    const key = row.toUpperCase();
    if (seen.has(key)) return '';
    seen.add(key);
    return row;
  }).filter(Boolean).join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PL': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || p?.natureza || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const atual = porTipo.get(tipo);
    if (!atual || partes.numeroInt > atual.numeroInt) {
      porTipo.set(tipo, {
        tipo,
        numeroInt: partes.numeroInt,
        numero: partes.numero,
        ano: partes.ano || String(p?.ano || p?.ano_proposicao || ''),
        ementa: String(p?.ementa || p?.resumo || p?.assunto || '').trim(),
        link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
        clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      });
    }
  });
  return Array.from(porTipo.values());
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      let item = casa.items.find(i => String(i?.tipo || '').toUpperCase() === rec.tipo);
      if (!item) {
        item = { tipo: rec.tipo, base: 0, mon: rec.numeroInt };
        casa.items.push(item);
      }
      const base = Number.parseInt(String(item.base || item.mon || 0), 10) || 0;
      item.tipo = rec.tipo;
      item.mon = rec.numeroInt;
      item.delta = Math.abs(rec.numeroInt - base);
      item.sentido = rec.numeroInt === base ? 'bate com o controle' : 'fonte/sistema acima';
      item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
      item.ementa = rec.ementa || item.ementa || '';
      item.link = rec.link || item.link || '';
      item.clienteSugestao = rec.clienteSugestao || item.clienteSugestao || '';
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({ casa: CASA_RADAR03, bloco: radar03BlocoEmail(novas), fonte: radar03PrimeiraFonte(novas) });
  return `${RADAR03_URL}?${params.toString()}`;
}

function radar03Escape(valor) {
  return String(valor ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return '';
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(novas, alertas = []) {
  anotarClientesCitados(novas);
  const novasOrdenadas = [...novas].sort(compararProposicoesEmail);

  if (process.env.DRY_RUN_EMAIL === '1') {
    console.log('[DRY_RUN_EMAIL] ' + novas.length + ' proposições novas.');
    novasOrdenadas.slice(0, 20).forEach(p => console.log(p.identificacao + ' - id ' + p.id + ' - ' + p.autor + ' - ' + p.link));
    alertas.forEach(a => console.log('[ALERTA_SEQUENCIA] ' + a.tipo + '/' + a.ano + ': ' + a.anterior + ' -> ' + a.atual + '; faltantes: ' + a.faltantes.join(', ')));
    return;
  }
  const linhas = novasOrdenadas.map(p => '<tr><td style="padding:8px;border-bottom:1px solid #eee"><a href="' + escapeHtml(p.link) + '"><strong>' + escapeHtml(p.identificacao) + '</strong></a><br><span style="font-size:11px;color:#667085">ID ' + escapeHtml(p.id) + ' | ' + escapeHtml(p.tipo) + '</span></td><td style="padding:8px;border-bottom:1px solid #eee">' + escapeHtml(p.autor || '-') + '</td><td style="padding:8px;border-bottom:1px solid #eee">' + escapeHtml(p.situacao || '-') + '</td><td style="padding:8px;border-bottom:1px solid #eee">' + renderizarEmentaCliente(p) + '</td></tr>').join('');
  const subject = '🏛️ São Luís: ' + novas.length + ' nova(s) proposição(ões)' + (alertas.length ? ' | alerta sequência' : '') + ' — ' + new Date().toLocaleDateString('pt-BR');
  const html = renderRadar03EmailButton(novas) + '<div style="font-family:Arial,sans-serif;max-width:980px"><h2>São Luís — ' + novas.length + ' nova(s) proposição(ões)</h2>' + renderAlertasSaltos(alertas) + '<p>Lista normalizada por ID interno da matéria, para contornar a ordenação ruim do site.</p><table style="border-collapse:collapse;width:100%">' + linhas + '</table><p><a href="' + BASE + '/atividade-legislativa/proposicoes">Fonte oficial</a></p></div>';

  if (process.env.USE_GMAIL_API === '1') {
    const tmp = path.join(os.tmpdir(), 'saoluis-email-' + Date.now() + '.html');
    fs.writeFileSync(tmp, html);
    const script = [
      'import sys',
      "sys.path.insert(0, '/root/.openclaw/workspace/agents/shared')",
      'from notificacoes import enviar_email',
      'subject = sys.argv[1]',
      'html_path = sys.argv[2]',
      'destinos = [d.strip() for d in sys.argv[3].split(",") if d.strip()]',
      "body = open(html_path, encoding='utf-8').read()",
      'ok = enviar_email(subject, body, destinatarios=destinos)',
      'raise SystemExit(0 if ok else 1)',
    ].join('\n');
    const result = spawnSync('python3', ['-c', script, subject, tmp, process.env.EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br'], { encoding: 'utf8' });
    fs.rmSync(tmp, { force: true });
    if (result.status !== 0) {
      throw new Error('Falha no envio via Gmail API: ' + (result.stderr || result.stdout || 'sem detalhe'));
    }
    console.log('Email enviado via Gmail API com ' + novas.length + ' proposições novas.');
    return;
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_REMETENTE, pass: process.env.EMAIL_SENHA } });
  await transporter.sendMail({
    from: '"Monitor ' + CASA + '" <' + process.env.EMAIL_REMETENTE + '>',
    to: process.env.EMAIL_DESTINO,
    subject,
    html,
  });
}

(async () => {
  console.log('Iniciando Monitor Proposições São Luís...');
  const estado = carregarEstado();
  const ids = new Set((estado.proposicoes_vistas || []).map(String));
  const proposicoes = await buscarProposicoes(ids);
  const novas = proposicoes.filter(p => !ids.has(p.id));
  const { alertas, atuais } = detectarSaltos(proposicoes, estado);
  console.log('Total: ' + proposicoes.length + ' | Novas: ' + novas.length);
  if (process.env.DRY_RUN_EMAIL === '1') {
    await sincronizarRadar03(novas);
    await enviarEmail(novas, alertas);
    console.log('DRY_RUN_EMAIL=1 — estado preservado sem alterações.');
    return;
  }
  if (process.env.SEED_ONLY === '1') {
    proposicoes.forEach(p => ids.add(p.id));
    estado.proposicoes_vistas = Array.from(ids);
    estado.ultimos_por_tipo_ano = { ...(estado.ultimos_por_tipo_ano || {}), ...atuais };
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
    console.log('SEED_ONLY=1 — estado semeado sem envio.');
    return;
  }
  if (novas.length || alertas.length) {
    await enviarEmail(novas, alertas);
    novas.forEach(p => ids.add(p.id));
    estado.proposicoes_vistas = Array.from(ids);
  }
  estado.ultimos_por_tipo_ano = { ...(estado.ultimos_por_tipo_ano || {}), ...atuais };
  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
