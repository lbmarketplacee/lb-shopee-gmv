// Atualização automática semanal de GMV — roda sozinha via Vercel Cron Job
// Busca todos os clientes conectados à Shopee no Firestore, renova token se preciso,
// calcula o GMV do mês calendário atual (dia 1º até hoje) de cada um, e salva de volta no Firestore.
//
// Desde 22/09/2026 o whitelist de IP foi desativado nos 3 apps da Shopee, então as
// chamadas saem direto (sem proxy fixo/Fixie).

import crypto from 'crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const HOSTS = {
  sandbox: 'https://openplatform.sandbox.test-stable.shopee.sg',
  producao: 'https://partner.shopeemobile.com'
};

function limpar(v){ return (v || '').trim(); }

function gerarAssinatura(path, timestamp, partnerId, partnerKey, accessToken='', shopId=''){
  const baseString = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

function getConfig(app = 'gmv'){
  const prefixo = app === 'mkt' ? 'SHOPEE_MKT_' : app === 'produto' ? 'SHOPEE_PRODUTO_' : 'SHOPEE_';
  return {
    partnerId: limpar(process.env[`${prefixo}PARTNER_ID`]),
    partnerKey: limpar(process.env[`${prefixo}PARTNER_KEY`]),
    ambiente: limpar(process.env.SHOPEE_AMBIENTE) || 'sandbox'
  };
}

async function chamarShopee(path, params = {}, metodo = 'GET', body = null, app = 'gmv'){
  const { partnerId, partnerKey, ambiente } = getConfig(app);
  const host = HOSTS[ambiente];
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = gerarAssinatura(path, timestamp, partnerId, partnerKey, params.access_token || '', params.shop_id || '');
  const url = new URL(host + path);
  url.searchParams.set('partner_id', partnerId);
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('sign', sign);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v); });
  const opts = { method: metodo };
  if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const resp = await fetch(url.toString(), opts);
  CONTADOR_CHAMADAS_SHOPEE++; // conta toda chamada real à Shopee (GMV, token, Marketing/desconto — tudo passa por aqui)
  return await resp.json();
}
let CONTADOR_CHAMADAS_SHOPEE = 0;

// Inicializa o Firebase Admin (reaproveita a mesma chave de serviço já usada no lb-cadastro-api)
function getDb(){
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

async function garantirTokenValido(db, cliente){
  const agora = Date.now();
  const expiraEmRaw = cliente.shopeeTokenExpiraEm;
  const expiraEm = expiraEmRaw?.toMillis ? expiraEmRaw.toMillis() : expiraEmRaw;
  if (expiraEm && agora < expiraEm - 5 * 60 * 1000) {
    return cliente.shopeeAccessToken;
  }
  const resultado = await chamarShopee('/api/v2/auth/access_token/get', {}, 'POST', {
    refresh_token: cliente.shopeeRefreshToken,
    shop_id: Number(cliente.shopeeShopId),
    partner_id: Number(getConfig('gmv').partnerId)
  }, 'gmv');
  if (!resultado?.access_token) throw new Error('Não foi possível renovar token: ' + JSON.stringify(resultado));
  const novaExpiraEm = Date.now() + (resultado.expire_in * 1000);
  await db.collection('clientes').doc(cliente.id).update({
    shopeeAccessToken: resultado.access_token,
    shopeeRefreshToken: resultado.refresh_token,
    shopeeTokenExpiraEm: novaExpiraEm
  });
  return resultado.access_token;
}

async function garantirTokenValidoMkt(db, cliente){
  const agora = Date.now();
  const expiraEmRaw = cliente.shopeeMktTokenExpiraEm;
  const expiraEm = expiraEmRaw?.toMillis ? expiraEmRaw.toMillis() : expiraEmRaw;
  if (expiraEm && agora < expiraEm - 5 * 60 * 1000) {
    return cliente.shopeeMktAccessToken;
  }
  const resultado = await chamarShopee('/api/v2/auth/access_token/get', {}, 'POST', {
    refresh_token: cliente.shopeeMktRefreshToken,
    shop_id: Number(cliente.shopeeMktShopId),
    partner_id: Number(getConfig('mkt').partnerId)
  }, 'mkt');
  if (!resultado?.access_token) throw new Error('Não foi possível renovar token Marketing: ' + JSON.stringify(resultado));
  const novaExpiraEm = Date.now() + (resultado.expire_in * 1000);
  await db.collection('clientes').doc(cliente.id).update({
    shopeeMktAccessToken: resultado.access_token,
    shopeeMktRefreshToken: resultado.refresh_token,
    shopeeMktTokenExpiraEm: novaExpiraEm
  });
  return resultado.access_token;
}

// Igual garantirTokenValidoMkt, mas pro app Produto (opcional — usado só pra filtrar estoque na oferta relâmpago).
// Devolve null se o cliente nunca conectou esse app, em vez de dar erro (a oferta segue sem o filtro nesse caso).
async function garantirTokenValidoProduto(db, cliente){
  if (!cliente.shopeeProdutoShopId || !cliente.shopeeProdutoRefreshToken) return null;
  const agora = Date.now();
  const expiraEmRaw = cliente.shopeeProdutoTokenExpiraEm;
  const expiraEm = expiraEmRaw?.toMillis ? expiraEmRaw.toMillis() : expiraEmRaw;
  if (expiraEm && agora < expiraEm - 5 * 60 * 1000) {
    return cliente.shopeeProdutoAccessToken;
  }
  const resultado = await chamarShopee('/api/v2/auth/access_token/get', {}, 'POST', {
    refresh_token: cliente.shopeeProdutoRefreshToken,
    shop_id: Number(cliente.shopeeProdutoShopId),
    partner_id: Number(getConfig('produto').partnerId)
  }, 'produto');
  if (!resultado?.access_token) throw new Error('Não foi possível renovar token Produto: ' + JSON.stringify(resultado));
  const novaExpiraEm = Date.now() + (resultado.expire_in * 1000);
  await db.collection('clientes').doc(cliente.id).update({
    shopeeProdutoAccessToken: resultado.access_token,
    shopeeProdutoRefreshToken: resultado.refresh_token,
    shopeeProdutoTokenExpiraEm: novaExpiraEm
  });
  return resultado.access_token;
}

// Igual garantirTokenValidoProduto, mas pro app ERP. Devolve null se o cliente não migrou pro ERP ainda.
async function garantirTokenValidoErp(db, cliente){
  if (!cliente.shopeeErpShopId || !cliente.shopeeErpRefreshToken) return null;
  const agora = Date.now();
  const expiraEmRaw = cliente.shopeeErpTokenExpiraEm;
  const expiraEm = expiraEmRaw?.toMillis ? expiraEmRaw.toMillis() : expiraEmRaw;
  if (expiraEm && agora < expiraEm - 5 * 60 * 1000) {
    return cliente.shopeeErpAccessToken;
  }
  const resultado = await chamarShopee('/api/v2/auth/access_token/get', {}, 'POST', {
    refresh_token: cliente.shopeeErpRefreshToken,
    shop_id: Number(cliente.shopeeErpShopId),
    partner_id: Number(getConfig('erp').partnerId)
  }, 'erp');
  if (!resultado?.access_token) throw new Error('Não foi possível renovar token ERP: ' + JSON.stringify(resultado));
  const novaExpiraEm = Date.now() + (resultado.expire_in * 1000);
  await db.collection('clientes').doc(cliente.id).update({
    shopeeErpAccessToken: resultado.access_token,
    shopeeErpRefreshToken: resultado.refresh_token,
    shopeeErpTokenExpiraEm: novaExpiraEm
  });
  return resultado.access_token;
}

// MODO FINANCEIRO (?modo=financeiro): roda 1x por dia, só em clientes já migrados pro ERP (é a única
// conexão com permissão de Financeiro). Lê o extrato, compara a semana atual com a anterior, e registra
// um alerta (mesma coleção da aba Erros) quando a receita cair 40% ou mais — aviso cedo, não é cobrança.
async function rodarAlertasFinanceiros(db, res){
  const INICIO = Date.now();
  const ORCAMENTO_MS = 30000;
  const snapshot = await db.collection('clientes').where('shopeeErpShopId', '!=', null).get();
  const clientes = snapshot.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.shopeeErpShopId && c.ativo !== false);
  let verificados = 0, comQuedaForte = 0, aguardando = 0;
  const resultados = [];
  for (const cliente of clientes) {
    if (Date.now() - INICIO > ORCAMENTO_MS) { aguardando++; continue; }
    try {
      const token = await garantirTokenValidoErp(db, cliente);
      const chamarErp = (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token: token, shop_id: cliente.shopeeErpShopId }, metodo, body, 'erp');
      const extrato = await finBuscarExtrato(chamarErp, {}, { limite: 200 });
      if (!extrato.ok) { resultados.push({ cliente: cliente.nome, erro: extrato.erro }); verificados++; continue; }
      const resumo = finResumoSaude(extrato.transacoes);
      await db.collection('clientes').doc(cliente.id).update({
        financeiroUltimaVerificacao: Date.now(),
        financeiroSaldoAtual: resumo.saldoAtual,
        financeiroVariacaoSemanal: resumo.variacaoPercentual
      });
      if (resumo.quedaForte) {
        comQuedaForte++;
        await db.collection('shopeeErrosOferta').add({
          cliente: cliente.nome, acao: 'Queda de receita (Financeiro)',
          mensagem: `Receita da semana caiu ${resumo.variacaoPercentual}% em relação à semana anterior (de ${resumo.entradasSemanaAnterior} pra ${resumo.entradas7d}).`,
          quando: new Date()
        });
      }
      resultados.push({ cliente: cliente.nome, saldoAtual: resumo.saldoAtual, variacaoPercentual: resumo.variacaoPercentual, quedaForte: resumo.quedaForte });
    } catch (e) {
      console.error(`[FINANCEIRO CRON] ERRO — ${cliente.nome}: ${e.message}`);
      resultados.push({ cliente: cliente.nome, erro: e.message });
    }
    verificados++;
  }
  console.log(`[FINANCEIRO CRON] verificados: ${verificados} | quedas fortes: ${comQuedaForte} | ficaram pra amanhã: ${aguardando}`);
  return res.status(200).json({ ok: true, modo: 'financeiro', totalClientes: clientes.length, verificados, comQuedaForte, aguardando, resultados });
}

const DEZ_MINUTOS = 10 * 60;
const JANELA_ANTECEDENCIA = 8 * 24 * 60 * 60; // olha pra frente até 8 dias (cron roda 1x por semana)

// ===================== DESCONTO FIXO — lógica compartilhada (API v2.discount) =====================
// Lê, lista e DUPLICA descontos de uma loja pela API da Shopee. Usado pelo botão do sistema (shopee.js)
// e pela renovação automática (atualizar-gmv-cron.js). "chamar" é a função de chamada à Shopee já
// configurada com o app Marketing: chamar(path, params, metodo, body).
const DESC_CINCO_MESES = 150 * 24 * 60 * 60;   // duração do desconto novo (5 meses, regra da LB)
const DESC_MARGEM_INICIO = 65 * 60;            // início mínimo no futuro (a Shopee não aceita início no passado)
const DESC_DEZ_MINUTOS = 10 * 60;
const DESC_LOTE_ITENS = 50;                    // produtos por chamada de add_discount_item

// Normaliza nome: minúsculo, sem acento, traços parecidos viram "-", espaços colapsados.
function descNormalizarNome(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, ' ').trim();
}

// Data no formato do campo datetime-local do sistema (YYYY-MM-DDTHH:mm), sempre no horário de Brasília.
function descFormatarDataLocalBR(unix) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(unix * 1000));
  const g = (t) => partes.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

// Lista todos os descontos da loja (nome, período, status).
async function descListar(chamar, ctx) {
  const vistos = new Map();
  for (let pagina = 1; pagina <= 5; pagina++) {
    const r = await chamar('/api/v2/discount/get_discount_list', {
      access_token: ctx.accessToken, shop_id: ctx.shopId, discount_status: 'all', page_no: pagina, page_size: 100
    }, 'GET', null);
    if (r?.error) {
      if (pagina === 1) return { ok: false, erro: `${r.error}: ${r.message || ''}`.trim() };
      break;
    }
    const lista = r?.response?.discount_list || [];
    let novos = 0;
    lista.forEach((d) => { if (!vistos.has(d.discount_id)) { vistos.set(d.discount_id, d); novos++; } });
    if (!r?.response?.more || novos === 0) break;
  }
  return { ok: true, descontos: [...vistos.values()] };
}

// Lê UM desconto: dados + todos os produtos (paginando). soMeta=true lê só a primeira página.
async function descLerDesconto(chamar, ctx, discountId, opcoes = {}) {
  const POR_PAGINA = 100;
  const itens = new Map();
  let meta = null;
  let offset = 0;
  for (let pagina = 0; pagina < 30; pagina++) {
    const r = await chamar('/api/v2/discount/get_discount', {
      access_token: ctx.accessToken, shop_id: ctx.shopId, discount_id: discountId,
      pagination_offset: offset, pagination_entries_per_page: POR_PAGINA
    }, 'GET', null);
    if (r?.error || !r?.response) {
      if (pagina === 0) return { ok: false, erro: `${r?.error || 'sem resposta'} ${r?.message || ''}`.trim() };
      break;
    }
    const resp = r.response;
    if (!meta) {
      meta = { discount_id: resp.discount_id ?? discountId, discount_name: resp.discount_name,
               start_time: resp.start_time, end_time: resp.end_time, status: resp.status };
    }
    let novos = 0;
    (resp.item_list || []).forEach((it) => { if (!itens.has(it.item_id)) { itens.set(it.item_id, it); novos++; } });
    if (opcoes.soMeta || !resp.more || novos === 0) break;
    offset += POR_PAGINA;
  }
  return { ok: true, meta, itens: [...itens.values()] };
}

// Converte os produtos lidos de um desconto no formato que o add_discount_item espera.
function descMontarItensParaCopia(itensRaw) {
  const itens = [];
  const semPreco = [];
  itensRaw.forEach((it) => {
    const limite = it.purchase_limit || 0;
    const modelos = (it.model_list || [])
      .map((m) => ({ model_id: m.model_id, model_promotion_price: m.model_promotion_price ?? m.discount_price }))
      .filter((m) => m.model_promotion_price !== undefined && m.model_promotion_price !== null);
    if (modelos.length) {
      itens.push({ item_id: it.item_id, purchase_limit: limite, model_list: modelos });
    } else if (!(it.model_list || []).length && it.item_promotion_price !== undefined && it.item_promotion_price !== null) {
      itens.push({ item_id: it.item_id, purchase_limit: limite, item_promotion_price: it.item_promotion_price });
    } else {
      semPreco.push(it.item_id);
    }
  });
  return { itens, semPreco };
}

// Procura uma renovação que JÁ EXISTE (mesmo nome, termina depois) — ex.: alguém duplicou na mão no Seller Center.
function descAcharSucessor(descontos, meta) {
  const nome = descNormalizarNome(meta.discount_name);
  return descontos
    .filter((d) => String(d.discount_id) !== String(meta.discount_id)
      && descNormalizarNome(d.discount_name) === nome && d.end_time > meta.end_time)
    .sort((a, b) => b.end_time - a.end_time)[0] || null;
}

// DUPLICA um desconto: mesmo nome, mesmos produtos e preços, 5 meses.
// Começa 10 min depois que o original acaba — ou daqui a ~1h se o original já venceu.
// Se nenhum produto entrar, apaga o desconto vazio (rollback) pra não deixar a loja sem desconto.
async function descDuplicar(chamar, ctx, discountId, opcoes = {}) {
  const agora = opcoes.agora ?? Math.floor(Date.now() / 1000);
  const lido = await descLerDesconto(chamar, ctx, discountId);
  if (!lido.ok) return { ok: false, erro: `Não foi possível ler o desconto: ${lido.erro}` };
  const { meta, itens } = lido;
  if (!itens.length) return { ok: false, erro: 'Esse desconto não tem produtos pra copiar.' };

  const { itens: paraCopiar, semPreco } = descMontarItensParaCopia(itens);
  if (!paraCopiar.length) {
    return { ok: false, erro: 'Não consegui ler os preços promocionais dos produtos desse desconto.', debugPrimeiroItem: itens[0] };
  }

  const novoInicio = Math.max(meta.end_time + DESC_DEZ_MINUTOS, agora + DESC_MARGEM_INICIO);
  const novoFim = novoInicio + (opcoes.duracao ?? DESC_CINCO_MESES);

  const criacao = await chamar('/api/v2/discount/add_discount', { access_token: ctx.accessToken, shop_id: ctx.shopId },
    'POST', { discount_name: meta.discount_name, start_time: novoInicio, end_time: novoFim });
  const novoId = criacao?.response?.discount_id;
  if (!novoId) {
    return { ok: false, erro: `Não foi possível criar o desconto novo: ${criacao?.error || ''} ${criacao?.message || ''}`.trim(), debugCriacao: criacao };
  }

  let adicionados = 0;
  const falhas = [];
  for (let i = 0; i < paraCopiar.length; i += DESC_LOTE_ITENS) {
    const lote = paraCopiar.slice(i, i + DESC_LOTE_ITENS);
    let r;
    try {
      r = await chamar('/api/v2/discount/add_discount_item', { access_token: ctx.accessToken, shop_id: ctx.shopId },
        'POST', { discount_id: novoId, item_list: lote });
    } catch (e) { falhas.push({ erro: 'chamada', mensagem: e.message }); continue; }
    if (r?.error) { falhas.push({ erro: r.error, mensagem: r.message }); continue; }
    const listaErros = r?.response?.error_list || [];
    listaErros.forEach((e) => falhas.push(e));
    adicionados += lote.length - new Set(listaErros.map((e) => e.item_id)).size;
  }

  if (adicionados === 0) {
    let apagado = false;
    try {
      const d = await chamar('/api/v2/discount/delete_discount', { access_token: ctx.accessToken, shop_id: ctx.shopId },
        'POST', { discount_id: novoId });
      apagado = !d?.error;
    } catch (e) { /* segue: já vamos avisar que precisa apagar na mão */ }
    return {
      ok: false, rollback: apagado, falhas: falhas.slice(0, 5),
      erro: `Nenhum produto foi adicionado ao desconto novo. ${apagado ? 'O desconto vazio foi apagado automaticamente.' : `ATENÇÃO: o desconto vazio (id ${novoId}) ficou na Shopee — apague na mão.`}`
    };
  }

  return {
    ok: true, novoDiscountId: novoId, nome: meta.discount_name, novoInicio, novoFim,
    totalProdutos: adicionados, totalOrigem: itens.length, semPreco, falhas: falhas.slice(0, 5),
    duracaoDias: Math.round((novoFim - novoInicio) / 86400)
  };
}

// ===================== OFERTA RELÂMPAGO — montada a partir do DESCONTO FIXO (app Marketing) =====================
// O app GMV não tem permissão na API de produto (error_api_permission), então os produtos e o preço com
// desconto vêm do próprio desconto da loja (v2.discount.*, que o app Marketing acessa). É em cima desse
// preço que a oferta calcula o percentual.
const OFR_MARGEM_INICIO = 120; // a Shopee recusa início no passado: a busca de horário começa ~2 min à frente
const OFR_ERRO_ESTOQUE = 1400101726; // "This item cannot be added as there is insufficient stock."
const OFR_MIN_PROMO_STOCK = 20; // confirmado via v2.shop_flash_sale.get_item_criteria (categoria "All")

// Busca o ESTOQUE REAL (total_available_stock, não o seller_stock — já pode estar reservado por outra
// promoção ativa) via o app Produto. Produto com variação usa get_model_list (1 item por chamada, é
// como a Shopee expõe); produto sem variação usa get_item_base_info (até 50 item_id por chamada).
// Devolve um Map "item_id:model_id" -> estoque disponível (model_id "0" pra produto sem variação).
async function ofrBuscarEstoqueReal(chamarProduto, itensComModelo, itensSemModelo) {
  const estoque = new Map();
  for (const it of itensComModelo) {
    try {
      const r = await chamarProduto('/api/v2/product/get_model_list', { item_id: it.item_id }, 'GET', null);
      (r?.response?.model || []).forEach((m) => {
        const v = m?.stock_info_v2?.summary_info?.total_available_stock;
        estoque.set(`${it.item_id}:${m.model_id}`, typeof v === 'number' ? v : 0);
      });
    } catch (e) { /* item some da seleção se não conseguir ler o estoque dele — mais seguro que assumir OK */ }
  }
  for (let i = 0; i < itensSemModelo.length; i += 50) {
    const lote = itensSemModelo.slice(i, i + 50);
    try {
      const r = await chamarProduto('/api/v2/product/get_item_base_info', { item_id_list: lote.map((x) => x.item_id).join(',') }, 'GET', null);
      (r?.response?.item_list || []).forEach((item) => {
        const v = item?.stock_info_v2?.summary_info?.total_available_stock;
        estoque.set(`${item.item_id}:0`, typeof v === 'number' ? v : 0);
      });
    } catch (e) { /* idem */ }
  }
  return estoque;
}

function ofrArredondar(v) { return Math.round(v * 100) / 100; }

// A Shopee recusa a chamada quando a LOJA não atende às regras da Oferta Relâmpago da Loja (não é problema de permissão do app).
function ofrErroAmigavel(resp, contexto) {
  if (/not_meet_shop_criteria/.test(String(resp?.error || ''))) {
    return {
      naoElegivel: true,
      erro: 'A Shopee recusou: essa loja ainda não atende aos requisitos da Oferta Relâmpago da Loja (regra da própria Shopee sobre a loja, não do sistema). Confira no Seller Center dessa loja, em Central de Marketing > Oferta Relâmpago da Loja, se ela consegue criar uma oferta por lá.'
    };
  }
  return { erro: `${contexto}: ${resp?.error || ''} ${resp?.message || ''}`.trim() };
}

// A Shopee informa as recusas POR VARIAÇÃO (item_id + model_id). Produto simples vem sem model_id (chave "id:0").
function ofrChave(f) { return `${f.item_id}:${f.model_id || 0}`; }
function ofrEhEstoque(f) { return f.err_code === OFR_ERRO_ESTOQUE || /insufficient stock/i.test(String(f.err_msg || f.fail_message || '')); }

// Quantos PRODUTOS entraram de fato: produto com variações vale se ao menos UMA variação entrou.
function ofrContarAceitos(fatia, chavesFalhas) {
  let aceitos = 0;
  for (const it of fatia) {
    if (chavesFalhas.has(`${it.item_id}:0`)) continue; // produto inteiro recusado
    if (it.modelos) { if (it.modelos.some((m) => !chavesFalhas.has(`${it.item_id}:${m.model_id}`))) aceitos++; }
    else aceitos++;
  }
  return aceitos;
}

// Resume os motivos das recusas em texto curto: "estoque insuficiente (34)".
function ofrResumirMotivos(falhas) {
  const cont = new Map();
  falhas.forEach((f) => {
    const msg = String(f.err_msg || f.fail_message || f.message || 'motivo não informado');
    const rotulo = ofrEhEstoque(f) ? 'estoque abaixo do mínimo exigido pela Shopee pra oferta relâmpago (normalmente 20 un.)' : msg.replace(/^This item cannot be added as /i, '').slice(0, 80);
    cont.set(rotulo, (cont.get(rotulo) || 0) + 1);
  });
  return [...cont.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([m, n]) => `${m} (${n})`).join('; ');
}

// Lê o(s) desconto(s) em andamento e devolve os produtos com preço promocional já calculado.
// Usa o estoque real que o desconto informa (quando informa) pra nunca pedir mais unidades do que existem.
async function descItensParaOfertaRelampago(chamar, ctx, { discountId, percentual, qtdPorProduto, limite, chamarProduto }) {
  const agora = Math.floor(Date.now() / 1000);
  let ids = [];
  if (discountId) {
    ids = [discountId];
  } else {
    const todos = await descListar(chamar, ctx);
    if (!todos.ok) return { ok: false, erro: `Não foi possível listar os descontos da loja: ${todos.erro}` };
    ids = todos.descontos.filter((d) => d.start_time <= agora && d.end_time > agora).map((d) => d.discount_id);
  }
  if (!ids.length) {
    return { ok: false, erro: 'Essa loja não tem nenhum desconto em andamento. A oferta relâmpago é montada em cima do preço do desconto fixo — crie ou marque o desconto fixo primeiro.' };
  }

  const fator = 1 - percentual / 100;
  // Preço vem do desconto; ESTOQUE vem do app Produto quando conectado (os campos do desconto não trazem
  // estoque de verdade — já confirmamos isso ao vivo). Monta candidatos primeiro, filtra por estoque depois.
  const candidatos = [];
  const vistos = new Set();
  const erros = [];
  let amostra = null;
  for (const id of ids) {
    const lido = await descLerDesconto(chamar, ctx, id);
    if (!lido.ok) { erros.push(lido.erro); continue; }
    if (discountId) {
      if (lido.meta.end_time && lido.meta.end_time <= agora) return { ok: false, erro: 'O desconto fixo marcado já terminou. Duplique/renove ele antes de criar a oferta relâmpago.' };
      if (lido.meta.start_time && lido.meta.start_time > agora) return { ok: false, erro: 'O desconto fixo marcado ainda não começou. A oferta relâmpago só usa desconto em andamento.' };
    }
    if (!amostra && lido.itens[0]) amostra = JSON.stringify(lido.itens[0]).slice(0, 700);
    for (const it of lido.itens) {
      if (vistos.has(it.item_id)) continue;
      vistos.add(it.item_id);
      const modelos = (it.model_list || [])
        .map((m) => ({ model_id: m.model_id, preco: m.model_promotion_price ?? m.discount_price }))
        .filter((m) => m.preco > 0);
      if (modelos.length) {
        candidatos.push({ item_id: it.item_id, modelos });
      } else if (!(it.model_list || []).length && it.item_promotion_price > 0) {
        candidatos.push({ item_id: it.item_id, simples: { preco: it.item_promotion_price } });
      }
    }
  }
  if (!candidatos.length) {
    return { ok: false, erro: erros.length ? `Não consegui ler o desconto: ${erros[0]}` : 'Não consegui ler o preço promocional de nenhum produto do desconto.' };
  }

  // Sem app Produto conectado: segue sem filtrar por estoque (comportamento antigo — tenta e deixa a
  // Shopee recusar na hora de adicionar). Com o app conectado, filtra ANTES de tentar.
  let estoquePorChave = null;
  if (chamarProduto) {
    const comModelo = candidatos.filter((c) => c.modelos);
    const semModelo = candidatos.filter((c) => c.simples);
    estoquePorChave = await ofrBuscarEstoqueReal(chamarProduto, comModelo, semModelo);
  }

  const itens = [];
  for (const c of candidatos) {
    if (itens.length >= limite) break;
    if (c.modelos) {
      const usaveis = c.modelos
        .map((m) => ({ ...m, estoque: estoquePorChave ? (estoquePorChave.get(`${c.item_id}:${m.model_id}`) ?? 0) : null }))
        .filter((m) => m.estoque === null || m.estoque >= OFR_MIN_PROMO_STOCK);
      if (!usaveis.length) continue;
      itens.push({ item_id: c.item_id, modelos: usaveis.map((m) => ({ model_id: m.model_id,
        input_promo_price: ofrArredondar(m.preco * fator), stock: m.estoque === null ? qtdPorProduto : Math.min(qtdPorProduto, m.estoque) })) });
    } else {
      const estoque = estoquePorChave ? (estoquePorChave.get(`${c.item_id}:0`) ?? 0) : null;
      if (estoque !== null && estoque < OFR_MIN_PROMO_STOCK) continue;
      itens.push({ item_id: c.item_id, simples: { input_promo_price: ofrArredondar(c.simples.preco * fator),
        stock: estoque === null ? qtdPorProduto : Math.min(qtdPorProduto, estoque) } });
    }
  }
  if (!itens.length) {
    return { ok: false, erro: estoquePorChave ? 'Nenhum produto do desconto tem estoque suficiente pra oferta relâmpago (mínimo de 20 unidades, exigido pela Shopee).' : 'Não consegui ler o preço promocional de nenhum produto do desconto.' };
  }
  return { ok: true, itens, estoqueConhecido: !!estoquePorChave, amostra };
}

// Produto simples: tenta o formato "item_input_promo_price/item_stock"; se a Shopee recusar, o formato "models" (model_id 0).
function ofrMontarItens(itens, qtd, formatoSimples) {
  return itens.map((it) => {
    if (it.modelos) return { item_id: it.item_id, purchase_limit: qtd, models: it.modelos };
    if (formatoSimples === 'item') {
      return { item_id: it.item_id, purchase_limit: qtd, item_input_promo_price: it.simples.input_promo_price, item_stock: it.simples.stock };
    }
    return { item_id: it.item_id, purchase_limit: qtd, models: [{ model_id: 0, ...it.simples }] };
  });
}

// Todos os horários que a Shopee liberou, em janelas de 7 dias (até ~28 dias à frente).
const OFR_JANELA_DIAS = 7;
const OFR_MAX_JANELAS = 4;
async function descListarHorariosOferta(chamar, ctx, desde) {
  const base = { access_token: ctx.accessToken, shop_id: ctx.shopId };
  const slots = new Map();
  for (let j = 0; j < OFR_MAX_JANELAS; j++) {
    const ini = desde + j * OFR_JANELA_DIAS * 86400;
    const r = await chamar('/api/v2/shop_flash_sale/get_time_slot_id', { ...base, start_time: ini, end_time: ini + OFR_JANELA_DIAS * 86400 }, 'GET', null);
    if (r?.error) { if (j === 0) return { ok: false, resp: r }; break; } // erro em janela distante: fica com o que já achou
    (Array.isArray(r?.response) ? r.response : []).forEach((s) => { if (s.timeslot_id && !slots.has(s.timeslot_id)) slots.set(s.timeslot_id, s); });
  }
  return { ok: true, slots: [...slots.values()].sort((x, y) => x.start_time - y.start_time) };
}

// Ofertas relâmpago que a loja JÁ TEM (agendadas e em andamento), pra não repetir horário.
async function descOfertasExistentes(chamar, ctx) {
  const base = { access_token: ctx.accessToken, shop_id: ctx.shopId };
  const lista = [];
  let algumaOk = false;
  for (const type of [1, 2]) {
    try {
      const r = await chamar('/api/v2/shop_flash_sale/get_shop_flash_sale_list', { ...base, type, offset: 0, limit: 100 }, 'GET', null);
      if (!r?.error) { algumaOk = true; (r?.response?.flash_sale_list || []).forEach((f) => lista.push(f)); }
    } catch (e) { /* tenta o outro tipo */ }
  }
  return { lista, confiavel: algumaOk };
}

// Cada horário recebe um grupo diferente de produtos (roda pelo catálogo do desconto), sem repetir entre horários
// e PULANDO quem já foi recusado por estoque em algum horário anterior desta mesma execução — aprende na hora,
// já que não dá pra saber o estoque real de antemão (API de produto não autorizada pro app Marketing/GMV).
function ofrFatia(itens, indice, limite, excluir) {
  const disponiveis = excluir && excluir.size ? itens.filter((it) => !excluir.has(it.item_id)) : itens;
  if (!disponiveis.length) return [];
  if (disponiveis.length <= limite) return disponiveis;
  const ini = (indice * limite) % disponiveis.length;
  const fatia = [];
  for (let k = 0; k < limite; k++) fatia.push(disponiveis[(ini + k) % disponiveis.length]);
  return fatia;
}

// Consulta as ofertas relâmpago que a loja JÁ TEM na Shopee agora (agendadas + em andamento), sem criar nada.
// Usado pelo botão "Sincronizar", pra saber o que já existe antes de tentar criar de novo.
async function descSincronizarOfertas(chamar, ctx) {
  const existentes = await descOfertasExistentes(chamar, ctx);
  const agora = Math.floor(Date.now() / 1000);
  const lista = existentes.lista
    .map((f) => ({
      flashSaleId: f.flash_sale_id, timeslotId: f.timeslot_id,
      inicio: f.start_time ? descFormatarDataLocalBR(f.start_time) : null,
      fim: f.end_time ? descFormatarDataLocalBR(f.end_time) : null,
      status: f.status ?? (f.start_time <= agora && f.end_time > agora ? 'ongoing' : (f.start_time > agora ? 'upcoming' : 'ended'))
    }))
    .sort((a, b) => (a.timeslotId || 0) - (b.timeslotId || 0));
  return { ok: true, confiavel: existentes.confiavel, total: lista.length, ofertas: lista };
}

// Cria uma oferta relâmpago em CADA horário livre que a Shopee liberou (até maxHorarios).
// Horário que a loja já tem é pulado; se NENHUM produto entrar num horário, a oferta vazia é apagada;
// depois de 2 horários seguidos sem sucesso, para (evita insistir num erro que se repete).
async function descCriarOfertasRelampago(chamar, ctx, opcoes = {}) {
  const percentual = opcoes.percentual ?? 5;
  const qtd = opcoes.qtdPorProduto ?? 5;
  const limite = Math.min(opcoes.limite ?? 20, 20);
  const maxHorarios = Math.max(1, Math.min(opcoes.maxHorarios ?? 14, 30));
  const base = { access_token: ctx.accessToken, shop_id: ctx.shopId };

  const origem = await descItensParaOfertaRelampago(chamar, ctx, { discountId: opcoes.discountId, percentual, qtdPorProduto: qtd, limite: Infinity, chamarProduto: opcoes.chamarProduto });
  if (!origem.ok) return { ok: false, erro: origem.erro };

  const desde = Math.floor(Date.now() / 1000) + OFR_MARGEM_INICIO;
  const horarios = await descListarHorariosOferta(chamar, ctx, desde);
  if (!horarios.ok) return { ok: false, ...ofrErroAmigavel(horarios.resp, 'Não foi possível buscar os horários'), debugHorarios: horarios.resp };
  if (!horarios.slots.length) {
    return { ok: false, semHorario: true, erro: 'A Shopee ainda não liberou nenhum horário de oferta relâmpago pros próximos dias.' };
  }

  const existentes = await descOfertasExistentes(chamar, ctx);
  const ocupado = (s) => existentes.lista.some((f) => (f.timeslot_id && f.timeslot_id === s.timeslot_id)
    || (f.start_time && f.end_time && f.start_time < s.end_time && f.end_time > s.start_time));
  const livres = horarios.slots.filter((s) => !ocupado(s));
  if (!livres.length) {
    return { ok: false, semHorario: true, jaTemTodas: true, erro: 'A loja já tem oferta relâmpago em todos os horários que a Shopee liberou.', horariosEncontrados: horarios.slots.length };
  }

  const criadas = [];
  const puladas = [];
  const falhasItens = [];
  let formato = 'item';
  let semSucessoSeguidos = 0;
  const deslocamento = existentes.lista.length; // ofertas que a loja já tem empurram a rotação de produtos
  const listaFalhas = (r) => { const l = r?.response?.failed_items ?? r?.response?.failed_list ?? []; return Array.isArray(l) ? l : []; };
  const semEstoqueNestaExecucao = new Set(); // aprendido durante a execução: não tenta de novo nos próximos horários

  for (const slot of livres.slice(0, maxHorarios)) {
    const inicioTxt = descFormatarDataLocalBR(slot.start_time);
    const criacao = await chamar('/api/v2/shop_flash_sale/create_shop_flash_sale', base, 'POST', { timeslot_id: slot.timeslot_id });
    const flashSaleId = criacao?.response?.flash_sale_id;
    if (!flashSaleId) {
      const e = ofrErroAmigavel(criacao, 'Não foi possível criar a oferta');
      if (e.naoElegivel && !criadas.length) return { ok: false, ...e, debugCriacao: criacao };
      puladas.push({ timeslotId: slot.timeslot_id, inicio: inicioTxt, motivo: e.erro });
      if (++semSucessoSeguidos >= 2) break;
      continue;
    }

    const fatia = ofrFatia(origem.itens, deslocamento + criadas.length + puladas.length, limite, semEstoqueNestaExecucao);
    if (!fatia.length) { puladas.push({ timeslotId: slot.timeslot_id, inicio: inicioTxt, motivo: 'Todos os produtos do desconto já foram testados e recusados por estoque nesta execução.' }); if (++semSucessoSeguidos >= 2) break; continue; }
    const adicionar = (lista, q, f) => chamar('/api/v2/shop_flash_sale/add_shop_flash_sale_items', base, 'POST',
      { flash_sale_id: flashSaleId, items: ofrMontarItens(lista, q, f) });
    const aceitosDe = (r, chaves) => (r?.error ? 0 : ofrContarAceitos(fatia, chaves));

    let adicao = await adicionar(fatia, qtd, formato);
    let chaves = new Set(listaFalhas(adicao).map(ofrChave));
    if (fatia.some((i) => i.simples) && aceitosDe(adicao, chaves) === 0) {
      const outro = formato === 'item' ? 'models' : 'item';
      const adicao2 = await adicionar(fatia, qtd, outro);
      const chaves2 = new Set(listaFalhas(adicao2).map(ofrChave));
      if (aceitosDe(adicao2, chaves2) > 0) { adicao = adicao2; chaves = chaves2; formato = outro; }
    }

    const falhasSlot = (adicao?.error ? [] : listaFalhas(adicao)).filter((f) => chaves.has(ofrChave(f)));
    falhasSlot.forEach((f) => { falhasItens.push(f); if (ofrEhEstoque(f)) semEstoqueNestaExecucao.add(f.item_id); });
    const adicionados = aceitosDe(adicao, chaves);

    if (adicionados === 0) {
      let apagada = false;
      try { const d = await chamar('/api/v2/shop_flash_sale/delete_shop_flash_sale', base, 'POST', { flash_sale_id: flashSaleId }); apagada = !d?.error; } catch (e) { /* avisa abaixo */ }
      const porque = adicao?.error ? ` (${adicao.error}: ${adicao.message || ''})` : (falhasSlot.length ? ` — ${ofrResumirMotivos(falhasSlot)}` : '');
      puladas.push({ timeslotId: slot.timeslot_id, inicio: inicioTxt, motivo: `A Shopee não aceitou nenhum produto${porque}. ${apagada ? 'Oferta vazia apagada.' : `ATENÇÃO: oferta vazia ${flashSaleId} ficou na Shopee — apague na mão.`}` });
      if (++semSucessoSeguidos >= 2) break;
      continue;
    }
    semSucessoSeguidos = 0;
    criadas.push({ flashSaleId, timeslotId: slot.timeslot_id, inicio: inicioTxt, fim: descFormatarDataLocalBR(slot.end_time), totalProdutos: adicionados, produtosRecusados: fatia.length - adicionados, falhas: falhasSlot.slice(0, 3) });
  }

  const totalProdutos = criadas.reduce((s, o) => s + o.totalProdutos, 0);
  const resumo = { criadas, puladas, totalOfertas: criadas.length, totalProdutos, horariosEncontrados: horarios.slots.length,
    jaExistiam: horarios.slots.length - livres.length, formatoUsado: formato, falhas: falhasItens.slice(0, 5), motivos: ofrResumirMotivos(falhasItens),
    estoqueConhecido: origem.estoqueConhecido, amostraItemDesconto: origem.amostra, produtosDescartadosPorEstoque: semEstoqueNestaExecucao.size,
    flashSaleId: criadas[0]?.flashSaleId, timeslotId: criadas[0]?.timeslotId };
  if (!criadas.length) {
    return { ok: false, ...resumo, erro: `Nenhuma oferta foi criada. ${puladas.slice(0, 2).map((p) => `${p.inicio}: ${p.motivo}`).join(' | ')}` };
  }
  return { ok: true, ...resumo };
}

// =================== FIM — DESCONTO FIXO (lógica compartilhada) ===================

// Renova o desconto fixo de UM cliente, a partir do desconto que a equipe MARCOU no sistema
// (campo shopeeDescontoFixoId, aba Shopee > Descontos). Não adivinha por nome: sem desconto marcado, pula e registra.
async function renovarDescontoFixo(accessToken, shopId, db, cliente){
  const ctx = { accessToken, shopId };
  const chamar = (path, params, metodo = 'GET', body = null) => chamarShopee(path, params, metodo, body, 'mkt');
  const refId = cliente.shopeeDescontoFixoId;
  if (!refId) return { renovado: false, motivo: 'Sem desconto fixo marcado no sistema (Shopee > Descontos). Pulado.' };

  const lido = await descLerDesconto(chamar, ctx, refId, { soMeta: true });
  if (!lido.ok) return { renovado: false, motivo: `Desconto marcado não encontrado na Shopee (${lido.erro}). Marque de novo no sistema.` };
  const meta = lido.meta;
  const agora = Math.floor(Date.now() / 1000);

  // Mantém o quadro de datas do sistema igual à realidade da Shopee.
  const atualizacao = {};
  const dataReal = descFormatarDataLocalBR(meta.end_time);
  if (cliente.descontoFixoFim !== dataReal) atualizacao.descontoFixoFim = dataReal;
  if (meta.discount_name && cliente.shopeeDescontoFixoNome !== meta.discount_name) atualizacao.shopeeDescontoFixoNome = meta.discount_name;
  const salvar = async () => { if (Object.keys(atualizacao).length) await db.collection('clientes').doc(cliente.id).update(atualizacao); };

  if (meta.end_time - agora > JANELA_ANTECEDENCIA) {
    await salvar();
    return { renovado: false, motivo: 'Ainda não está perto de vencer.', vigenteAte: meta.end_time };
  }

  // Alguém já renovou na mão (ex.: botão Duplicar do Seller Center)? Adota como referência em vez de duplicar de novo.
  const todos = await descListar(chamar, ctx);
  if (todos.ok) {
    const sucessor = descAcharSucessor(todos.descontos, meta);
    if (sucessor) {
      atualizacao.shopeeDescontoFixoId = String(sucessor.discount_id);
      atualizacao.shopeeDescontoFixoNome = sucessor.discount_name;
      atualizacao.descontoFixoFim = descFormatarDataLocalBR(sucessor.end_time);
      await salvar();
      return { renovado: false, motivo: 'Já existia uma renovação — adotada como o novo desconto fixo.', novoDiscountId: sucessor.discount_id };
    }
  }

  const r = await descDuplicar(chamar, ctx, refId, { agora });
  if (!r.ok) {
    await salvar();
    return { renovado: false, motivo: r.erro, detalhe: r };
  }

  await db.collection('clientes').doc(cliente.id).update({
    shopeeDescontoFixoId: String(r.novoDiscountId),
    shopeeDescontoFixoNome: r.nome,
    descontoFixoFim: descFormatarDataLocalBR(r.novoFim),
    descontoAutoUltimaRenovacao: new Date(),
    descontoAutoProximoVencimento: r.novoFim * 1000,
    descontoAutoTotalProdutos: r.totalProdutos
  });
  return { renovado: true, novoDiscountId: r.novoDiscountId, novoInicio: r.novoInicio, novoFim: r.novoFim,
           totalProdutos: r.totalProdutos, totalOrigem: r.totalOrigem, falhas: r.falhas };
}

// Gera um código de até 5 caracteres (A-Z, 0-9) a partir do nome do cliente + um sufixo
// que muda a cada renovação (mês/ano), pra nunca repetir código entre uma renovação e outra.
function gerarCodigoCupom(nomeCliente, dataReferencia){
  const base = (nomeCliente || 'LB')
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tira acento
    .replace(/[^A-Z0-9]/g, '');
  const sufixo = (dataReferencia.getMonth() + 1).toString(36).toUpperCase() + (dataReferencia.getFullYear() % 10);
  return (base.slice(0, 5 - sufixo.length) + sufixo).slice(0, 5) || 'LB' + sufixo;
}

const NOME_CUPOM_FIXO = 'cupom fixo - lb marketplace';

// Cria (ou recria) o cupom fixo — função interna, usada tanto pra criar do zero quanto pra renovar.
async function criarCupomFixo(accessToken, shopId, db, clienteId, nomeCliente, inicioUnix){
  const TRES_MESES_SEGUNDOS = 90 * 24 * 60 * 60; // limite máximo da própria Shopee
  const fimUnix = inicioUnix + TRES_MESES_SEGUNDOS;
  const codigo = gerarCodigoCupom(nomeCliente, new Date(inicioUnix * 1000));

  const corpo = {
    voucher_name: 'Cupom Fixo - LB Marketplace',
    voucher_code: codigo,
    start_time: inicioUnix,
    end_time: fimUnix,
    voucher_type: 1,      // cupom de loja inteira
    reward_type: 2,       // percentual
    percentage: 3,
    max_price: 999999,    // sem limite de desconto máximo
    min_basket_price: 15, // R$15,00 mínimo de compra
    usage_quantity: 5000,
    display_channel_list: [1],
    display_start_time: inicioUnix
  };

  const criacao = await chamarShopee('/api/v2/voucher/add_voucher', { access_token: accessToken, shop_id: shopId }, 'POST', corpo, 'mkt');
  const voucherId = criacao?.response?.voucher_id;
  if (!voucherId) {
    return { renovado: false, motivo: `Não foi possível criar o cupom: ${criacao?.error || ''} ${criacao?.message || ''}` };
  }

  // Atualiza o mesmo campo que o fluxo manual usa — é ele que alimenta o card "Cupons Vencendo 7d" do Dashboard
  if (db && clienteId) {
    const dataFim = new Date(fimUnix * 1000);
    await db.collection('clientes').doc(clienteId).update({
      cupomFim: dataFim.toISOString().slice(0, 16),
      cupomAutoUltimaRenovacao: new Date(),
      cupomAutoCodigo: codigo
    });
  }

  return { renovado: true, novoVoucherId: voucherId, novoCodigo: codigo, novoInicio: inicioUnix, novoFim: fimUnix };
}

// Garante que o CUPOM fixo LB Marketplace está sempre ativo (voucher, diferente do desconto por item acima).
// Checa DIRETO na Shopee (não depende de nada salvo no nosso banco) — se não achar nenhum, cria do zero
// (cliente novo, cupom apagado manualmente, etc). Se achar e estiver perto de vencer, renova.
// Regras da empresa: 3% de desconto, mínimo de compra R$15, sem limite de desconto máximo,
// 5.000 cupons, validade de 3 meses (90 dias — o máximo que a Shopee permite), mostra pra todo mundo na loja.
async function renovarCupomFixo(accessToken, shopId, db, clienteId, nomeCliente){
  const listaVouchers = await chamarShopee('/api/v2/voucher/get_voucher_list', {
    access_token: accessToken, shop_id: shopId, status: 'all', page_size: 100
  }, 'GET', null, 'mkt');
  const vouchers = listaVouchers?.response?.voucher_list || listaVouchers?.response?.vouchers || [];
  const comEsseNome = vouchers.filter(v => (v.voucher_name || '').toLowerCase().includes(NOME_CUPOM_FIXO));

  const agora = Math.floor(Date.now() / 1000);

  // Nenhum cupom com esse nome — cliente novo ou cupom sumiu. Cria já, começando agora.
  if (!comEsseNome.length) {
    const resultado = await criarCupomFixo(accessToken, shopId, db, clienteId, nomeCliente, agora + DEZ_MINUTOS);
    return { ...resultado, criadoDoZero: true };
  }

  const maisRecente = comEsseNome.reduce((a, b) => (a.end_time > b.end_time ? a : b));

  if (maisRecente.end_time - agora > JANELA_ANTECEDENCIA) {
    return { renovado: false, motivo: 'Ainda não está perto de vencer.', vigenteAte: maisRecente.end_time };
  }

  const jaTemProximo = comEsseNome.some(v => v.voucher_id !== maisRecente.voucher_id && v.start_time >= maisRecente.end_time);
  if (jaTemProximo) {
    return { renovado: false, motivo: 'Já existe uma renovação agendada.' };
  }

  return await criarCupomFixo(accessToken, shopId, db, clienteId, nomeCliente, maisRecente.end_time + DEZ_MINUTOS);
}

// Garante que a loja tem oferta relâmpago em TODOS os horários que a Shopee liberou. Horário que a loja
// já tem é pulado, então rodar todo dia não duplica nada. Produtos e preço vêm do desconto fixo (app Marketing).
async function garantirOfertasRelampago(db, accessTokenMkt, shopIdMkt, cliente){
  const chamar = (path, params, metodo = 'GET', body = null) => chamarShopee(path, params, metodo, body, 'mkt');
  // App Produto é opcional — se o cliente ainda não conectou, segue sem o filtro de estoque. Erro ao
  // renovar o token do Produto não pode derrubar a oferta inteira, por isso o try/catch aqui.
  let chamarProduto;
  try {
    const tokenProduto = await garantirTokenValidoProduto(db, cliente);
    if (tokenProduto) {
      chamarProduto = (path, q, metodo = 'GET', body = null) =>
        chamarShopee(path, { ...q, access_token: tokenProduto, shop_id: cliente.shopeeProdutoShopId }, metodo, body, 'produto');
    }
  } catch (e) { console.error('[OFERTAS CRON] token Produto falhou, seguindo sem filtro de estoque:', e.message); }
  // maxHorarios baixo de propósito aqui: o robô roda TODO dia e nunca recria horário já preenchido,
  // então o resto vai sendo completado nos próximos dias sem risco de estourar o tempo da função (60s,
  // com vários clientes na mesma execução). O botão manual (shopee.js) não tem esse limite.
  const r = await descCriarOfertasRelampago(chamar, { accessToken: accessTokenMkt, shopId: shopIdMkt }, {
    discountId: cliente.shopeeDescontoFixoId || undefined, percentual: 5, qtdPorProduto: 5, limite: 20, maxHorarios: 4, chamarProduto
  });
  if (!r.ok) return { criado: false, motivo: r.erro, semHorario: !!r.semHorario, jaTemTodas: !!r.jaTemTodas, naoElegivel: !!r.naoElegivel };
  return { criado: true, totalOfertas: r.totalOfertas, totalProdutos: r.totalProdutos, puladas: r.puladas.length, motivo: `${r.totalOfertas} oferta(s) criada(s) (${r.totalProdutos} produto(s))${r.puladas.length ? `, ${r.puladas.length} horário(s) pulado(s)` : ''}${r.motivos ? ` | recusas: ${r.motivos}` : ''}` };
}

// MODO DIÁRIO DE OFERTAS (?modo=ofertas): passa por TODO cliente com Marketing conectado — não depende do app GMV —,
// começando pelo verificado há mais tempo. Tem limite de tempo (a função da Vercel para em 60s): quem não der tempo
// hoje fica no começo da fila de amanhã. Loja que a Shopee marcou como não elegível só é revisada de novo em 7 dias.
// Grava no banco pra aparecer na aba Erros do sistema, mesmo sem ninguém com a tela aberta na hora.
async function registrarErroOferta(db, clienteNome, acao, mensagem){
  try {
    await db.collection('shopeeErrosOferta').add({
      cliente: clienteNome, acao, mensagem: String(mensagem).slice(0, 300), quando: new Date()
    });
  } catch (e) { console.error('[OFERTAS CRON] não salvou erro no painel:', e.message); }
}

async function rodarOfertasRelampago(db, res){
  const INICIO = Date.now();
  const ORCAMENTO_MS = 30000; // folga maior até o limite de 60s da função — um cliente sozinho pode demorar
  const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
  const snapshot = await db.collection('clientes').where('shopeeMktShopId', '!=', null).get();
  const clientes = snapshot.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.shopeeMktShopId && c.ativo !== false)
    .sort((a, b) => (a.ofertaRelampagoUltimaVerificacao || 0) - (b.ofertaRelampagoUltimaVerificacao || 0));
  const resultados = [];
  let verificados = 0, ofertasCriadas = 0, aguardando = 0;
  for (const cliente of clientes) {
    if (Date.now() - INICIO > ORCAMENTO_MS) { aguardando++; continue; }
    if ((cliente.ofertaRelampagoNaoElegivelAte || 0) > Date.now()) {
      resultados.push({ cliente: cliente.nome, pulado: 'Loja não elegível pra oferta relâmpago (Shopee) — revisão em até 7 dias.' });
      continue;
    }
    const atualizacao = { ofertaRelampagoUltimaVerificacao: Date.now() };
    try {
      const accessTokenMkt = await garantirTokenValidoMkt(db, cliente);
      const r = await garantirOfertasRelampago(db, accessTokenMkt, cliente.shopeeMktShopId, cliente);
      atualizacao.ofertaRelampagoAutoUltimoResultado = String(r.motivo || '').slice(0, 220);
      if (r.criado) { atualizacao.ofertaRelampagoAutoUltimaCriacao = new Date(); ofertasCriadas += r.totalOfertas; }
      else {
        const acao = r.naoElegivel ? 'Loja não elegível' : (r.semHorario ? 'Sem horário liberado' : 'Não criou');
        await registrarErroOferta(db, cliente.nome, acao, r.motivo || 'Sem detalhe.');
      }
      if (r.naoElegivel) atualizacao.ofertaRelampagoNaoElegivelAte = Date.now() + SETE_DIAS_MS;
      else if (cliente.ofertaRelampagoNaoElegivelAte) atualizacao.ofertaRelampagoNaoElegivelAte = null;
      console.log(`[OFERTAS CRON] ${cliente.nome}: ${r.criado ? 'CRIOU' : 'não criou'} — ${r.motivo || ''}`);
      resultados.push({ cliente: cliente.nome, ...r });
    } catch (e) {
      atualizacao.ofertaRelampagoAutoUltimoResultado = `Erro: ${e.message}`.slice(0, 220);
      await registrarErroOferta(db, cliente.nome, 'Erro', e.message);
      console.error(`[OFERTAS CRON] ERRO — ${cliente.nome}: ${e.message}`);
      resultados.push({ cliente: cliente.nome, erro: e.message });
    }
    verificados++;
    try { await db.collection('clientes').doc(cliente.id).update(atualizacao); } catch (e) { console.error('[OFERTAS CRON] não salvou estado:', e.message); }
  }
  console.log(`[OFERTAS CRON] verificados: ${verificados} | ofertas criadas: ${ofertasCriadas} | ficaram pra amanhã: ${aguardando} | chamadas Shopee: ${CONTADOR_CHAMADAS_SHOPEE}`);
  return res.status(200).json({ ok: true, modo: 'ofertas', totalClientes: clientes.length, verificados, ofertasCriadas, aguardando, resultados });
}
// Busca pedidos no período pedido e retorna o GMV JÁ SEPARADO POR DIA (create_time),
// pra dar pra salvar cada dia individualmente no Firestore (gmvDiario).
async function buscarGmvPorDia(accessToken, shopId, dataInicio, dataFim){
  const timeFromTotal = Math.floor(new Date(dataInicio + 'T00:00:00Z').getTime() / 1000);
  const timeToTotal = Math.floor(new Date(dataFim + 'T23:59:59Z').getTime() / 1000);
  const QUINZE_DIAS = 15 * 24 * 60 * 60;
  const janelas = [];
  let inicioJanela = timeFromTotal;
  while (inicioJanela < timeToTotal) {
    const fimJanela = Math.min(inicioJanela + QUINZE_DIAS - 1, timeToTotal);
    janelas.push([inicioJanela, fimJanela]);
    inicioJanela = fimJanela + 1;
  }
  // Mesma regra de exclusão de sempre — não mudou.
  const STATUS_EXCLUIR = ['CANCELLED', 'UNPAID', 'INVOICE_PENDING'];
  let todosOrderSn = [];
  for (const [timeFrom, timeTo] of janelas) {
    let cursor = '', paginas = 0;
    do {
      const resultado = await chamarShopee('/api/v2/order/get_order_list', {
        access_token: accessToken, shop_id: shopId,
        time_range_field: 'create_time',
        time_from: timeFrom, time_to: timeTo,
        page_size: 100, cursor
      }, 'GET', null, 'gmv');
      const lista = resultado?.response?.order_list || [];
      lista.forEach(o => { if (!STATUS_EXCLUIR.includes(o.order_status)) todosOrderSn.push(o.order_sn); });
      cursor = resultado?.response?.next_cursor || '';
      paginas++;
      if (paginas > 30) break;
    } while (cursor);
  }

  const porDia = {}; // { 'AAAA-MM-DD': { valor, totalPedidos } }
  // Pré-preenche TODOS os dias do período pedido com zero — garante que um dia que
  // tinha GMV antes e agora não tem mais pedidos válidos (cancelados, etc.) seja
  // sobrescrito com 0 no Firestore, em vez de manter o valor antigo (stale).
  {
    let cursorDia = new Date(dataInicio + 'T00:00:00Z');
    const fimDia = new Date(dataFim + 'T00:00:00Z');
    while (cursorDia <= fimDia) {
      porDia[cursorDia.toISOString().split('T')[0]] = { valor: 0, totalPedidos: 0 };
      cursorDia = new Date(cursorDia.getTime() + 24 * 60 * 60 * 1000);
    }
  }
  if (!todosOrderSn.length) return { porDia, totalPedidos: 0 };

  // Pede também o create_time no detalhe, pra saber em qual dia cada pedido entra.
  for (let i = 0; i < todosOrderSn.length; i += 50) {
    const lote = todosOrderSn.slice(i, i + 50);
    const detalhe = await chamarShopee('/api/v2/order/get_order_detail', {
      access_token: accessToken, shop_id: shopId,
      order_sn_list: lote.join(','),
      response_optional_fields: 'total_amount,create_time'
    }, 'GET', null, 'gmv');
    const pedidos = detalhe?.response?.order_list || [];
    pedidos.forEach(p => {
      const dia = new Date((p.create_time || 0) * 1000).toISOString().split('T')[0];
      if (!porDia[dia]) porDia[dia] = { valor: 0, totalPedidos: 0 };
      porDia[dia].valor += Number(p.total_amount) || 0;
      porDia[dia].totalPedidos += 1;
    });
  }
  return { porDia, totalPedidos: todosOrderSn.length };
}

function fmtDia(d){ return d.toISOString().split('T')[0]; }

// Verifica se o cliente já tem histórico diário salvo (decide PRIMEIRA_CARGA x INCREMENTAL)
async function temHistoricoDiario(db, clienteId){
  const snap = await db.collection('clientes').doc(clienteId).collection('gmvDiario').limit(1).get();
  return !snap.empty;
}

// Grava/sobrescreve os dias calculados nessa execução (só os dias que vieram no "porDia")
async function salvarDiasNoFirestore(db, clienteId, porDia){
  const dias = Object.entries(porDia);
  if (!dias.length) return;
  const batch = db.batch();
  dias.forEach(([dia, dados]) => {
    const ref = db.collection('clientes').doc(clienteId).collection('gmvDiario').doc(dia);
    batch.set(ref, { valor: dados.valor, totalPedidos: dados.totalPedidos, atualizadoEm: new Date() });
  });
  await batch.commit();
}

// Soma os dias já salvos do mês calendário atual — sem chamar a Shopee.
async function somarMesAtual(db, clienteId, hoje){
  const snap = await db.collection('clientes').doc(clienteId).collection('gmvDiario').get();
  // Mês calendário de verdade: do dia 1º do mês atual até hoje (não mais 30 dias corridos)
  const limiteInicio = fmtDia(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  const hojeStr = fmtDia(hoje);
  let gmv = 0, totalPedidos = 0;
  snap.docs.forEach(d => {
    if (d.id >= limiteInicio && d.id <= hojeStr) {
      const data = d.data();
      gmv += Number(data.valor) || 0;
      totalPedidos += Number(data.totalPedidos) || 0;
    }
  });
  return { gmv, totalPedidos };
}

// ---- Lock pra impedir duas execuções simultâneas do cron ----
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

async function adquirirLock(db){
  const ref = db.collection('configuracoes').doc('cronGmvLock');
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data();
    const iniciadoEmMs = data.iniciadoEm?.toMillis ? data.iniciadoEm.toMillis() : (data.iniciadoEm ? new Date(data.iniciadoEm).getTime() : 0);
    if (data.emExecucao && (Date.now() - iniciadoEmMs) < LOCK_TIMEOUT_MS) {
      return false; // trava ativa e recente — outra execução já está rodando, aborta
    }
    // trava existe mas está "abandonada" (mais de 10min) — assume a execução mesmo assim
  }
  await ref.set({ emExecucao: true, iniciadoEm: new Date() });
  return true;
}

async function liberarLock(db){
  await db.collection('configuracoes').doc('cronGmvLock').set({ emExecucao: false, iniciadoEm: new Date() });
}

// ===================== FINANCEIRO — "Caixa da Loja" (API v2.payment, só no app ERP) =====================
// Campos confirmados AO VIVO em 02/10/2026 (AQUARIOS, pedido real): transaction_id, status, wallet_type,
// transaction_type, amount, current_balance, create_time (unix), order_sn, transaction_fee, description,
// buyer_name, transaction_tab_type, money_flow ('MONEY_IN'/'MONEY_OUT'), more (paginação).

// Busca o extrato completo (pagina até acabar ou até o limite). Mais recente primeiro (ordem nativa da Shopee).
async function finBuscarExtrato(chamarErp, ctx, opcoes = {}) {
  const limite = opcoes.limite ?? 200;
  const transacoes = [];
  let pagina = 1;
  for (let i = 0; i < 20; i++) { // trava de segurança: no máx. 20 páginas por chamada
    const r = await chamarErp('/api/v2/payment/get_wallet_transaction_list',
      { page_no: pagina, page_size: Math.min(100, limite - transacoes.length) }, 'GET', null);
    if (r?.error) return { ok: false, erro: `${r.error}: ${r.message || ''}`.trim() };
    const lote = r?.response?.transaction_list || [];
    transacoes.push(...lote);
    if (!r?.response?.more || transacoes.length >= limite || !lote.length) break;
    pagina++;
  }
  return { ok: true, transacoes, saldoAtual: transacoes[0]?.current_balance ?? null };
}

// Resumo de saúde financeira: saldo atual, entradas/saídas nos últimos N dias, e a variação
// comparando a semana atual com a anterior (pra detectar queda de saldo cedo).
function finResumoSaude(transacoes, agoraUnix = Math.floor(Date.now() / 1000)) {
  const DIA = 86400;
  const somaPeriodo = (ini, fim, campo) => transacoes
    .filter((t) => t.create_time >= ini && t.create_time < fim)
    .reduce((s, t) => s + (campo === 'in' ? (t.money_flow === 'MONEY_IN' ? t.amount : 0) : (t.money_flow === 'MONEY_OUT' ? t.amount : 0)), 0);

  const entradas7d = somaPeriodo(agoraUnix - 7 * DIA, agoraUnix, 'in');
  const saidas7d = somaPeriodo(agoraUnix - 7 * DIA, agoraUnix, 'out');
  const entradasSemanaAnterior = somaPeriodo(agoraUnix - 14 * DIA, agoraUnix - 7 * DIA, 'in');

  let variacaoPercentual = null;
  if (entradasSemanaAnterior > 0) {
    variacaoPercentual = Math.round(((entradas7d - entradasSemanaAnterior) / entradasSemanaAnterior) * 1000) / 10;
  }

  return {
    saldoAtual: transacoes[0]?.current_balance ?? null,
    entradas7d: Math.round(entradas7d * 100) / 100,
    saidas7d: Math.round(saidas7d * 100) / 100,
    entradasSemanaAnterior: Math.round(entradasSemanaAnterior * 100) / 100,
    variacaoPercentual,
    quedaForte: variacaoPercentual !== null && variacaoPercentual <= -40, // queda de 40%+ na receita semanal
    totalTransacoes: transacoes.length
  };
}

// Formata uma transação pra exibir na tela (data em pt-BR, tipo em português).
const FIN_TIPO_LABEL = { MONEY_IN: 'Entrada', MONEY_OUT: 'Saída' };
function finFormatarTransacao(t) {
  return {
    id: t.transaction_id,
    data: new Date(t.create_time * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    tipo: FIN_TIPO_LABEL[t.money_flow] || t.money_flow,
    valor: t.amount,
    saldoApos: t.current_balance,
    pedido: t.order_sn || null,
    descricao: t.description || t.transaction_type,
    status: t.status
  };
}
// =================== FIM — FINANCEIRO ===================

export default async function handler(req, res) {
  // Proteção: só aceita chamadas com o segredo do cron (evita qualquer um disparar isso manualmente pela internet)
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }

  const db = getDb();

  if (req.query?.modo === 'ofertas') {
    CONTADOR_CHAMADAS_SHOPEE = 0;
    try { return await rodarOfertasRelampago(db, res); }
    catch (e) { console.error('[OFERTAS CRON] falha geral:', e); return res.status(500).json({ ok: false, erro: e.message }); }
  }

  if (req.query?.modo === 'financeiro') {
    CONTADOR_CHAMADAS_SHOPEE = 0;
    try { return await rodarAlertasFinanceiros(db, res); }
    catch (e) { console.error('[FINANCEIRO CRON] falha geral:', e); return res.status(500).json({ ok: false, erro: e.message }); }
  }

  const lockOk = await adquirirLock(db);
  if (!lockOk) {
    console.log('[GMV CRON] Abortado — já existe uma execução em andamento (lock ativo há menos de 10min).');
    return res.status(200).json({ ok: false, erro: 'Já existe uma execução em andamento (lock ativo).' });
  }

  try {
    CONTADOR_CHAMADAS_SHOPEE = 0;
    const hoje = new Date();
    const hojeStr = fmtDia(hoje);
    const MARGEM_DIAS = 7;
    const inicioMargem = fmtDia(new Date(hoje.getTime() - (MARGEM_DIAS - 1) * 24 * 60 * 60 * 1000));
    const inicioHistoricoCompleto = fmtDia(new Date(hoje.getFullYear(), hoje.getMonth(), 1)); // dia 1º do mês atual

    const snapshot = await db.collection('clientes').where('shopeeShopId', '!=', null).get();
    const resultados = [];
    let totalErros = 0;

    for (const docSnap of snapshot.docs) {
      const cliente = { id: docSnap.id, ...docSnap.data() };
      if (!cliente.shopeeShopId) continue;

      try {
        const temHistorico = await temHistoricoDiario(db, cliente.id);
        const modo = temHistorico ? 'INCREMENTAL' : 'PRIMEIRA_CARGA';
        const periodoInicio = temHistorico ? inicioMargem : inicioHistoricoCompleto;

        const accessToken = await garantirTokenValido(db, cliente);

        // Busca e calcula ANTES de gravar qualquer coisa — se der erro aqui, nada é sobrescrito.
        const { porDia, totalPedidos } = await buscarGmvPorDia(accessToken, cliente.shopeeShopId, periodoInicio, hojeStr);

        await salvarDiasNoFirestore(db, cliente.id, porDia);
        const { gmv: gmvFinal, totalPedidos: totalPedidosFinal } = await somarMesAtual(db, cliente.id, hoje);

        // Únicos campos que o frontend lê — continuam exatamente com o mesmo nome/formato de sempre.
        await db.collection('clientes').doc(cliente.id).update({
          gmvShopeeAutomatico: gmvFinal,
          gmvShopeeAtualizadoEm: new Date()
        });

        const gmvPeriodo = Object.values(porDia).reduce((s, d) => s + d.valor, 0);
        console.log(
          `[GMV CRON] CLIENTE: ${cliente.nome} | MODO: ${modo} | PERIODO: ${periodoInicio} a ${hojeStr} | ` +
          `PEDIDOS ENCONTRADOS: ${totalPedidos} | GMV CALCULADO (periodo): ${gmvPeriodo.toFixed(2)} | ` +
          `GMV FINAL MÊS ATUAL: ${gmvFinal.toFixed(2)}`
        );

        resultados.push({ cliente: cliente.nome, modo, ok: true, gmv: gmvFinal, totalPedidos: totalPedidosFinal });
      } catch (e) {
        totalErros++;
        console.error(`[GMV CRON] ERRO — CLIENTE: ${cliente.nome} | ${e.message}`);
        resultados.push({ cliente: cliente.nome, erro: e.message, ok: false });
        // Não apaga gmvDiario, não zera gmvShopeeAutomatico — o último valor válido continua no ar.
      }

      // Marketing / desconto fixo e cupom fixo — mesmo bloco, mesma credencial
      if (cliente.shopeeMktShopId) {
        try {
          const accessTokenMkt = await garantirTokenValidoMkt(db, cliente);
          const resultadoDesconto = await renovarDescontoFixo(accessTokenMkt, cliente.shopeeMktShopId, db, cliente);
          console.log(`[DESCONTO FIXO] ${cliente.nome}: ${resultadoDesconto.renovado ? 'RENOVADO' : 'não renovado'} — ${resultadoDesconto.motivo || (resultadoDesconto.totalProdutos + ' produto(s) copiado(s)')}`);
          resultados.push({ cliente: cliente.nome, tipo: 'desconto_fixo', ...resultadoDesconto, ok: true });
          try {
            const resultadoCupom = await renovarCupomFixo(accessTokenMkt, cliente.shopeeMktShopId, db, cliente.id, cliente.nome);
            resultados.push({ cliente: cliente.nome, tipo: 'cupom_fixo', ...resultadoCupom, ok: true });
          } catch (eCupom) {
            resultados.push({ cliente: cliente.nome, tipo: 'cupom_fixo', erro: eCupom.message, ok: false });
          }
        } catch (e) {
          resultados.push({ cliente: cliente.nome, tipo: 'desconto_fixo', erro: e.message, ok: false });
        }
      }
    }

    console.log(`[GMV CRON] TOTAL CLIENTES: ${snapshot.docs.length} | TOTAL CHAMADAS SHOPEE: ${CONTADOR_CHAMADAS_SHOPEE} | TOTAL ERROS: ${totalErros}`);

    return res.status(200).json({
      ok: true,
      executadoEm: new Date().toISOString(),
      totalClientes: snapshot.docs.length,
      totalChamadasShopee: CONTADOR_CHAMADAS_SHOPEE,
      totalErros,
      resultados
    });
  } finally {
    // Libera SEMPRE — sucesso ou erro — pra nunca travar o cron permanentemente.
    await liberarLock(db);
  }
}
