const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

async function enviarEmail(novas, alertas = []) {
  if (process.env.DRY_RUN_EMAIL === '1') {
    console.log('[DRY_RUN_EMAIL] ' + novas.length + ' proposições novas.');
    novas.slice(0, 20).forEach(p => console.log(p.identificacao + ' - id ' + p.id + ' - ' + p.autor + ' - ' + p.link));
    alertas.forEach(a => console.log('[ALERTA_SEQUENCIA] ' + a.tipo + '/' + a.ano + ': ' + a.anterior + ' -> ' + a.atual + '; faltantes: ' + a.faltantes.join(', ')));
    return;
  }
  const linhas = novas.map(p => '<tr><td style="padding:8px;border-bottom:1px solid #eee"><a href="' + escapeHtml(p.link) + '"><strong>' + escapeHtml(p.identificacao) + '</strong></a><br><span style="font-size:11px;color:#667085">ID ' + escapeHtml(p.id) + ' | ' + escapeHtml(p.tipo) + '</span></td><td style="padding:8px;border-bottom:1px solid #eee">' + escapeHtml(p.autor || '-') + '</td><td style="padding:8px;border-bottom:1px solid #eee">' + escapeHtml(p.situacao || '-') + '</td><td style="padding:8px;border-bottom:1px solid #eee">' + escapeHtml(p.ementa || '-') + '</td></tr>').join('');
  const subject = '🏛️ São Luís: ' + novas.length + ' nova(s) proposição(ões)' + (alertas.length ? ' | alerta sequência' : '') + ' — ' + new Date().toLocaleDateString('pt-BR');
  const html = '<div style="font-family:Arial,sans-serif;max-width:980px"><h2>São Luís — ' + novas.length + ' nova(s) proposição(ões)</h2>' + renderAlertasSaltos(alertas) + '<p>Lista normalizada por ID interno da matéria, para contornar a ordenação ruim do site.</p><table style="border-collapse:collapse;width:100%">' + linhas + '</table><p><a href="' + BASE + '/atividade-legislativa/proposicoes">Fonte oficial</a></p></div>';

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
