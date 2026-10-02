// Intermediário seguro LB — integração Shopee Open Platform (GMV + Marketing)
// Variáveis de ambiente na Vercel:
//   App GMV (Order Management):
//     SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY
//   App Marketing (cupons/ofertas relâmpago):
//     SHOPEE_MKT_PARTNER_ID, SHOPEE_MKT_PARTNER_KEY
//   Comuns:
//     SHOPEE_AMBIENTE (sandbox|producao)
//
// Desde 22/09/2026 o whitelist de IP foi desativado nos 3 apps da Shopee (Ads, Marketing, GMV),
// então as chamadas não passam mais por proxy fixo (Fixie) — saem direto da Vercel.

import crypto from 'crypto';
import https from 'node:https';

const HOSTS = {
  sandbox: 'https://openplatform.sandbox.test-stable.shopee.sg',
  producao: 'https://partner.shopeemobile.com' // confirmado funcionando em 04/08/2026
};

function limpar(v){ return (v || '').trim(); }

function gerarAssinatura(path, timestamp, partnerId, partnerKey, accessToken='', shopId=''){
  const baseString = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

// app: 'gmv' (padrão) ou 'mkt' — escolhe qual par de credenciais usar
function getConfig(app = 'gmv'){
  const prefixo = app === 'mkt' ? 'SHOPEE_MKT_' : app === 'ads' ? 'SHOPEE_ADS_' : app === 'produto' ? 'SHOPEE_PRODUTO_' : app === 'erp' ? 'SHOPEE_ERP_' : 'SHOPEE_';
  return {
    app,
    partnerId: limpar(process.env[`${prefixo}PARTNER_ID`]),
    partnerKey: limpar(process.env[`${prefixo}PARTNER_KEY`]),
    ambiente: limpar(process.env.SHOPEE_AMBIENTE) || 'sandbox'
  };
}

// Faz a chamada HTTP direto pra Shopee, sem proxy (o whitelist de IP foi desativado nos 3 apps)
function chamarShopee(path, params = {}, metodo = 'GET', body = null, app = 'gmv'){
  return new Promise((resolve, reject) => {
    const { partnerId, partnerKey, ambiente } = getConfig(app);
    const host = HOSTS[ambiente];
    if (!partnerId || !partnerKey) return reject(new Error(`Credenciais da Shopee (${app}) não configuradas.`));

    const timestamp = Math.floor(Date.now() / 1000);
    const sign = gerarAssinatura(path, timestamp, partnerId, partnerKey, params.access_token || '', params.shop_id || '');

    const url = new URL(host + path);
    url.searchParams.set('partner_id', partnerId);
    url.searchParams.set('timestamp', timestamp);
    url.searchParams.set('sign', sign);
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v); });

    const corpo = body ? JSON.stringify(body) : null;
    const opts = {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) } : {}
    };

    const req = https.request(url, opts, (resp) => {
      let dados = '';
      resp.on('data', (chunk) => { dados += chunk; });
      resp.on('end', () => {
        try { resolve(JSON.parse(dados)); }
        catch (e) { reject(new Error('Resposta inválida da Shopee: ' + dados.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (corpo) req.write(corpo);
    req.end();
  });
}

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

// ===================== LOGÍSTICA — "Central de Envios" (API v2.logistics, só no app ERP) =====================
// Campos confirmados AO VIVO em 02/10/2026 (AQUARIOS, pedido real 260921J62FHT1C):
// response.logistics_status (status geral do pedido), response.tracking_info[] com
// {update_time (unix), description (texto já em pt-BR, vem pronto da Shopee), logistics_status, return_code}.

const LOG_STATUS_LABEL = {
  LOGISTICS_DELIVERY_DONE: 'Entregue',
  LOGISTICS_REQUEST_CREATED: 'Etiqueta gerada',
  LOGISTICS_PICKUP_DONE: 'Coletado',
  LOGISTICS_DELIVERY_FAILED: 'Falha na entrega',
  LOGISTICS_PICKUP_FAILED: 'Falha na coleta'
};

// Busca o rastreio completo de um pedido, já formatado (mais recente primeiro — é a ordem nativa da Shopee).
async function logBuscarRastreio(chamarErp, ctx, orderSn) {
  const r = await chamarErp('/api/v2/logistics/get_tracking_info', { order_sn: orderSn }, 'GET', null);
  if (r?.error) return { ok: false, erro: `${r.error}: ${r.message || ''}`.trim() };
  const resp = r?.response || {};
  const eventos = (resp.tracking_info || []).map((e) => ({
    quando: new Date(e.update_time * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    descricao: e.description,
    status: e.logistics_status
  }));
  return {
    ok: true,
    orderSn,
    statusGeral: resp.logistics_status,
    statusLabel: LOG_STATUS_LABEL[resp.logistics_status] || resp.logistics_status,
    entregue: resp.logistics_status === 'LOGISTICS_DELIVERY_DONE',
    ultimaAtualizacao: eventos[0] || null,
    eventos
  };
}

// Busca rastreio de VÁRIOS pedidos de uma vez (sequencial — a API não tem endpoint em lote pra isso).
// Devolve um resumo por pedido, sem travar se um falhar (ex: pedido cancelado antes de ter rastreio).
async function logBuscarRastreioEmLote(chamarErp, ctx, orderSns, limite = 20) {
  const resultados = [];
  for (const sn of orderSns.slice(0, limite)) {
    try {
      const r = await logBuscarRastreio(chamarErp, ctx, sn);
      resultados.push(r.ok ? { orderSn: sn, ok: true, statusLabel: r.statusLabel, entregue: r.entregue, ultimaAtualizacao: r.ultimaAtualizacao } : { orderSn: sn, ok: false, erro: r.erro });
    } catch (e) {
      resultados.push({ orderSn: sn, ok: false, erro: e.message });
    }
  }
  return resultados;
}
// =================== FIM — LOGÍSTICA ===================

// ===================== PRODUTO — "Gestão de Catálogo" (API v2.product, app ERP ou Produto) =====================
// update_price/update_stock/unlist_item são endpoints padrão e estáveis da Shopee (v2), ao contrário do
// shop_flash_sale/discount que já nos pegou de surpresa — mesmo assim, toda ação de PREÇO sempre passa
// por uma simulação primeiro (preview), nunca aplica direto, pra pegar qualquer diferença de formato cedo.

function prodArredondar(v) { return Math.round(v * 100) / 100; }

// Lê o preço e estoque atuais de um produto (com ou sem variação), pra montar a simulação.
async function prodLerProduto(chamarErp, ctx, itemId) {
  const base = await chamarErp('/api/v2/product/get_item_base_info', { item_id_list: String(itemId) }, 'GET', null);
  if (base?.error) return { ok: false, erro: `${base.error}: ${base.message || ''}`.trim() };
  const item = base?.response?.item_list?.[0];
  if (!item) return { ok: false, erro: 'Produto não encontrado.' };

  if (!item.has_model) {
    return {
      ok: true, itemId, temVariacao: false,
      precoAtual: item.price_info?.[0]?.current_price ?? null,
      estoqueAtual: item.stock_info_v2?.summary_info?.total_available_stock ?? null
    };
  }
  const modelos = await chamarErp('/api/v2/product/get_model_list', { item_id: itemId }, 'GET', null);
  if (modelos?.error) return { ok: false, erro: `${modelos.error}: ${modelos.message || ''}`.trim() };
  return {
    ok: true, itemId, temVariacao: true,
    modelos: (modelos?.response?.model || []).map((m) => ({
      modelId: m.model_id, nome: m.model_name,
      precoAtual: m.price_info?.[0]?.current_price ?? null,
      estoqueAtual: m.stock_info_v2?.summary_info?.total_available_stock ?? null
    }))
  };
}

// Monta a SIMULAÇÃO do reajuste (não aplica nada ainda) — pra mostrar na tela antes de confirmar.
async function prodSimularReajustePreco(chamarErp, ctx, itemIds, percentual) {
  const fator = 1 + percentual / 100;
  const itens = [];
  const erros = [];
  for (const itemId of itemIds) {
    const lido = await prodLerProduto(chamarErp, ctx, itemId);
    if (!lido.ok) { erros.push({ itemId, erro: lido.erro }); continue; }
    if (lido.temVariacao) {
      itens.push({
        itemId, temVariacao: true,
        modelos: lido.modelos.filter((m) => m.precoAtual > 0).map((m) => ({
          modelId: m.modelId, nome: m.nome, precoAtual: m.precoAtual, precoNovo: prodArredondar(m.precoAtual * fator)
        }))
      });
    } else if (lido.precoAtual > 0) {
      itens.push({ itemId, temVariacao: false, precoAtual: lido.precoAtual, precoNovo: prodArredondar(lido.precoAtual * fator) });
    } else {
      erros.push({ itemId, erro: 'Sem preço legível pra simular.' });
    }
  }
  return { ok: true, percentual, totalProdutos: itens.length, totalComErro: erros.length, itens, erros };
}

// Aplica de verdade o reajuste já simulado (recebe o resultado de prodSimularReajustePreco).
// Produto por produto — um falhar não trava os outros.
async function prodAplicarReajustePreco(chamarErp, ctx, simulacao) {
  const aplicados = [];
  const falhas = [];
  for (const it of simulacao.itens) {
    const body = it.temVariacao
      ? { item_id: it.itemId, price_list: it.modelos.map((m) => ({ model_id: m.modelId, original_price: m.precoNovo })) }
      : { item_id: it.itemId, price_list: [{ original_price: it.precoNovo }] };
    try {
      const r = await chamarErp('/api/v2/product/update_price', {}, 'POST', body);
      if (r?.error) falhas.push({ itemId: it.itemId, erro: `${r.error}: ${r.message || ''}`.trim() });
      else aplicados.push(it.itemId);
    } catch (e) { falhas.push({ itemId: it.itemId, erro: e.message }); }
  }
  return { ok: true, totalAplicados: aplicados.length, totalFalhas: falhas.length, aplicados, falhas };
}

// Ajusta o estoque de UM produto/variação (uso direto, sem passar pelo fluxo de simulação em massa).
async function prodAjustarEstoque(chamarErp, ctx, itemId, modelId, novoEstoque) {
  const body = modelId
    ? { item_id: itemId, stock_list: [{ model_id: modelId, seller_stock: [{ stock: novoEstoque }] }] }
    : { item_id: itemId, stock_list: [{ seller_stock: [{ stock: novoEstoque }] }] };
  const r = await chamarErp('/api/v2/product/update_stock', {}, 'POST', body);
  if (r?.error) return { ok: false, erro: `${r.error}: ${r.message || ''}`.trim() };
  return { ok: true };
}

// Pausa (unlist) ou republica (list) um produto — usado pro auto-pause quando o estoque zera.
async function prodMudarVisibilidade(chamarErp, ctx, itemId, visivel) {
  const r = await chamarErp('/api/v2/product/unlist_item', {}, 'POST', { item_list: [{ item_id: itemId, unlist: !visivel }] });
  if (r?.error) return { ok: false, erro: `${r.error}: ${r.message || ''}`.trim() };
  const falhouNaLista = r?.response?.failure_list?.find((f) => f.item_id === itemId);
  if (falhouNaLista) return { ok: false, erro: falhouNaLista.failed_reason || 'A Shopee recusou.' };
  return { ok: true };
}

// Varre os produtos de uma loja e pausa automaticamente quem zerou o estoque (não mexe em quem já estava pausado por outro motivo).
async function prodAutoPausarSemEstoque(chamarErp, ctx, limite = 50) {
  const lista = await chamarErp('/api/v2/product/get_item_list', { offset: 0, page_size: limite, item_status: 'NORMAL' }, 'GET', null);
  if (lista?.error) return { ok: false, erro: `${lista.error}: ${lista.message || ''}`.trim() };
  const itens = lista?.response?.item || [];
  const pausados = [];
  const erros = [];
  for (const it of itens) {
    const lido = await prodLerProduto(chamarErp, ctx, it.item_id);
    if (!lido.ok) { erros.push({ itemId: it.item_id, erro: lido.erro }); continue; }
    const semEstoque = lido.temVariacao
      ? lido.modelos.length > 0 && lido.modelos.every((m) => (m.estoqueAtual ?? 0) <= 0)
      : (lido.estoqueAtual ?? 1) <= 0;
    if (!semEstoque) continue;
    const r = await prodMudarVisibilidade(chamarErp, ctx, it.item_id, false);
    if (r.ok) pausados.push(it.item_id); else erros.push({ itemId: it.item_id, erro: r.erro });
  }
  return { ok: true, totalVerificados: itens.length, totalPausados: pausados.length, pausados, erros };
}
// =================== FIM — PRODUTO ===================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const params = req.method === 'GET' ? req.query : req.body;
    const { acao } = params;
    // Qual app usar nesta chamada: o front manda "app" = 'gmv' ou 'mkt'.
    // Se não mandar nada, cai no 'gmv' (mantém compatibilidade com o que já existe).
    const appEscolhido = (params.app === 'mkt' || params.app === 'ads' || params.app === 'produto' || params.app === 'erp') ? params.app : 'gmv';
    const { partnerId, partnerKey, ambiente } = getConfig(appEscolhido);

    // -1) Rodar o robô diário de Oferta Relâmpago agora mesmo (botão "Rodar robô agora" do sistema).
    //     Chama o cron internamente, servidor-a-servidor — o CRON_SECRET nunca chega no navegador.
    if (acao === 'rodar_robo_ofertas') {
      const secret = process.env.CRON_SECRET;
      if (!secret) return res.status(200).json({ ok: false, erro: 'CRON_SECRET não configurado neste projeto.' });
      const host = req.headers?.['x-forwarded-host'] || req.headers?.host || process.env.VERCEL_URL;
      try {
        const r = await fetch(`https://${host}/api/atualizar-gmv-cron?modo=ofertas`, {
          headers: { Authorization: `Bearer ${secret}` }
        });
        const data = await r.json();
        return res.status(200).json(data);
      } catch (e) {
        return res.status(200).json({ ok: false, erro: `Não foi possível chamar o robô: ${e.message}` });
      }
    }

    // 0) Diagnóstico — nunca expõe a chave, só confirma tamanho/formato
    if (acao === 'diagnostico') {
      const gmv = getConfig('gmv');
      const mkt = getConfig('mkt');
      const ads = getConfig('ads');
      const erp = getConfig('erp');
      return res.status(200).json({
        ok: true,
        ambiente,
        proxy_usado: false,
        gmv: { partner_id_valor: gmv.partnerId, partner_id_tamanho: gmv.partnerId.length, partner_key_tamanho: gmv.partnerKey.length },
        mkt: { partner_id_valor: mkt.partnerId, partner_id_tamanho: mkt.partnerId.length, partner_key_tamanho: mkt.partnerKey.length },
        ads: { partner_id_valor: ads.partnerId, partner_id_tamanho: ads.partnerId.length, partner_key_tamanho: ads.partnerKey.length },
        erp: { partner_id_valor: erp.partnerId, partner_id_tamanho: erp.partnerId.length, partner_key_tamanho: erp.partnerKey.length }
      });
    }

    // 1) Gerar o link de autorização (pra cliente aprovar o acesso da loja dele)
    //    Agora recebe "app": 'gmv' ou 'mkt' pra saber qual app está sendo autorizado
    if (acao === 'gerar_link_autorizacao') {
      const redirectUrl = params.redirect;
      const path = '/api/v2/shop/auth_partner';
      const timestamp = Math.floor(Date.now() / 1000);
      const sign = gerarAssinatura(path, timestamp, partnerId, partnerKey);
      const link = `${HOSTS[ambiente]}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUrl)}`;
      return res.status(200).json({ ok: true, app: appEscolhido, link });
    }

    // 2) Trocar o "code" por um access_token
    if (acao === 'trocar_codigo_por_token') {
      const { code, shop_id } = params;
      const path = '/api/v2/auth/token/get';
      const resultado = await chamarShopee(path, {}, 'POST', { code, shop_id: Number(shop_id), partner_id: Number(partnerId) }, appEscolhido);
      return res.status(200).json({ ok: true, app: appEscolhido, ...resultado });
    }

    // 3) Renovar o access_token usando o refresh_token (access dura só 4h, refresh dura 30 dias)
    if (acao === 'renovar_token') {
      const { refresh_token, shop_id } = params;
      const path = '/api/v2/auth/access_token/get';
      const resultado = await chamarShopee(path, {}, 'POST', { refresh_token, shop_id: Number(shop_id), partner_id: Number(partnerId) }, appEscolhido);
      return res.status(200).json({ ok: true, app: appEscolhido, ...resultado });
    }

    // 4) Buscar o GMV de uma loja num período — soma o valor de todos os pedidos concluídos
    //    (sempre usa credenciais do app GMV, independente do que vier em "app")
    if (acao === 'buscar_gmv') {
      const { access_token, shop_id, data_inicio, data_fim } = params;
      const timeFromTotal = Math.floor(new Date(data_inicio).getTime() / 1000);
      const timeToTotal = Math.floor(new Date(data_fim).getTime() / 1000);
      const debug = { timeFromTotal, timeToTotal, janelas: [] };

      // A Shopee limita get_order_list a no máximo 15 dias por chamada.
      // Então dividimos o período pedido em pedaços de até 15 dias cada.
      const QUINZE_DIAS = 15 * 24 * 60 * 60;
      const janelas = [];
      let inicioJanela = timeFromTotal;
      while (inicioJanela < timeToTotal) {
        const fimJanela = Math.min(inicioJanela + QUINZE_DIAS - 1, timeToTotal);
        janelas.push([inicioJanela, fimJanela]);
        inicioJanela = fimJanela + 1;
      }

      // Busca as janelas de 15 dias EM PARALELO (cada janela é independente) — antes rodava
      // uma depois da outra, o que estourava o tempo máximo da função em lojas com muitos pedidos.
      const STATUS_EXCLUIR = ['CANCELLED', 'UNPAID', 'INVOICE_PENDING'];
      const resultadosJanelas = await Promise.all(janelas.map(async ([timeFrom, timeTo]) => {
        const idsDaJanela = [];
        let cursor = '', paginas = 0;
        do {
          const resultado = await chamarShopee('/api/v2/order/get_order_list', {
            access_token, shop_id,
            time_range_field: 'create_time',
            time_from: timeFrom, time_to: timeTo,
            page_size: 100, cursor
          }, 'GET', null, 'gmv');
          const lista = resultado?.response?.order_list || [];
          lista.forEach(o => { if (!STATUS_EXCLUIR.includes(o.order_status)) idsDaJanela.push(o.order_sn); });
          cursor = resultado?.response?.next_cursor || '';
          paginas++;
          if (paginas > 30) break;
        } while (cursor);
        debug.janelas.push({ timeFrom, timeTo, pedidosNaJanela: idsDaJanela.length });
        return idsDaJanela;
      }));
      let todosOrderSn = resultadosJanelas.flat();

      if (!todosOrderSn.length) {
        return res.status(200).json({ ok: true, gmv: 0, totalPedidos: 0, debug });
      }

      // Monta todos os lotes de 50 pedidos e busca TODOS EM PARALELO (em vez de um de cada vez),
      // pra lojas com muitos pedidos não estourarem o tempo máximo da função.
      let gmvTotal = 0;
      let ultimoDetalheResposta = null;
      const lotes = [];
      for (let i = 0; i < todosOrderSn.length; i += 50) lotes.push(todosOrderSn.slice(i, i + 50));

      const LIMITE_PARALELO = 15; // no máximo 15 chamadas ao mesmo tempo, pra não sobrecarregar
      for (let i = 0; i < lotes.length; i += LIMITE_PARALELO) {
        const grupo = lotes.slice(i, i + LIMITE_PARALELO);
        const respostas = await Promise.all(grupo.map(lote => chamarShopee('/api/v2/order/get_order_detail', {
          access_token, shop_id,
          order_sn_list: lote.join(','),
          response_optional_fields: 'total_amount'
        }, 'GET', null, 'gmv')));
        respostas.forEach(detalhe => {
          ultimoDetalheResposta = detalhe;
          const pedidos = detalhe?.response?.order_list || [];
          pedidos.forEach(p => { gmvTotal += Number(p.total_amount) || 0; });
        });
      }
      debug.ultimoDetalheResposta = ultimoDetalheResposta;
      debug.totalLotes = lotes.length;

      return res.status(200).json({ ok: true, gmv: gmvTotal, totalPedidos: todosOrderSn.length, debug });
    }

    // 5) Saúde da Loja — nota geral, penalidades, pedidos atrasados (app GMV)
    if (acao === 'saude_loja') {
      const { access_token, shop_id } = params;
      const [performance, penalidade] = await Promise.all([
        chamarShopee('/api/v2/account_health/get_shop_performance', { access_token, shop_id }, 'GET', null, 'gmv'),
        chamarShopee('/api/v2/account_health/get_penalty', { access_token, shop_id }, 'GET', null, 'gmv')
      ]);
      return res.status(200).json({ ok: true, performance, penalidade });
    }

    // 6) Listar cupons já criados na loja (agora sempre app Marketing)
    if (acao === 'listar_cupons') {
      const { access_token, shop_id, status } = params;
      const resultado = await chamarShopee('/api/v2/voucher/get_voucher_list', {
        access_token, shop_id, status: status || 'all', page_size: 100
      }, 'GET', null, appEscolhido);
      return res.status(200).json({ ok: true, ...resultado });
    }

    // 7) Criar cupom novo na loja (agora sempre app Marketing)
    if (acao === 'criar_cupom') {
      const { access_token, shop_id, nome, codigo, percentual, valor_minimo, desconto_maximo, quantidade, dias_validade } = params;
      const agora = Math.floor(Date.now() / 1000);
      const diasFinal = Math.min(Number(dias_validade || 90), 90); // Shopee exige no máximo 90 dias (3 meses)
      const fim = agora + (diasFinal * 86400);
      const corpo = {
        voucher_name: nome,
        voucher_code: codigo,
        start_time: agora,
        end_time: fim,
        voucher_type: 1, // cupom de loja inteira
        reward_type: 2, // percentual
        percentage: Number(percentual),
        max_price: Number(desconto_maximo || 999999),
        min_basket_price: Number(valor_minimo || 0),
        usage_quantity: Number(quantidade || 5000),
        display_channel_list: [1], // 1 = mostrar pra todo mundo na loja (público, sem precisar do código)
        display_start_time: agora
      };
      const resultado = await chamarShopee('/api/v2/voucher/add_voucher', { access_token, shop_id }, 'POST', corpo, appEscolhido);
      return res.status(200).json({ ok: true, ...resultado });
    }

    // 8) Criar Ofertas Relâmpago — UMA em cada horário livre que a Shopee liberou (até "max_horarios").
    //    Produtos e preço vêm do DESCONTO FIXO da loja (app Marketing); o app GMV não tem permissão de produto.
    //    Até "limite_produtos" produtos por oferta, "qtd_por_produto" unidades cada, "percentual"% sobre o preço com desconto.
    if (acao === 'criar_oferta_relampago') {
      const { access_token, shop_id, discount_id, produto_access_token, produto_shop_id } = params;
      const chamar = (path, q, metodo = 'GET', body = null) => chamarShopee(path, q, metodo, body, appEscolhido);
      // Estoque pro filtro: se o cliente já migrou pro app ERP, o MESMO token de cima já tem permissão
      // de Produto — não precisa pedir um token separado. Se ainda está no Marketing antigo, usa o
      // produto_access_token separado (app Produto à parte). Sem nenhum dos dois, segue sem filtrar.
      const chamarProduto = appEscolhido === 'erp'
        ? (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token, shop_id }, metodo, body, 'erp')
        : (produto_access_token && produto_shop_id)
          ? (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token: produto_access_token, shop_id: produto_shop_id }, metodo, body, 'produto')
          : undefined;
      const r = await descCriarOfertasRelampago(chamar, { accessToken: access_token, shopId: shop_id }, {
        discountId: discount_id || undefined,
        percentual: Number(params.percentual || 5),
        qtdPorProduto: Number(params.qtd_por_produto || 5),
        limite: Number(params.limite_produtos || 20),
        maxHorarios: Number(params.max_horarios || 14),
        chamarProduto
      });
      console.log('[OFERTA RELÂMPAGO]', shop_id, r.ok ? `${r.totalOfertas} oferta(s) criada(s), ${r.totalProdutos} produto(s)` : r.erro);
      if (!r.ok) return res.status(200).json({ ok: false, erro: r.erro, detalhe: r });
      return res.status(200).json({ ok: true, total_ofertas: r.totalOfertas, total_produtos: r.totalProdutos, flash_sale_id: r.flashSaleId,
        criadas: r.criadas, puladas: r.puladas, ja_existiam: r.jaExistiam, falhas: r.falhas, motivos: r.motivos,
        estoque_conhecido: r.estoqueConhecido, amostra_item_desconto: r.amostraItemDesconto, produtos_descartados_por_estoque: r.produtosDescartadosPorEstoque });
    }

    // 8.5) Excluir uma Oferta Relâmpago específica (botão do sistema, não automático).
    if (acao === 'excluir_oferta') {
      const { access_token, shop_id, flash_sale_id } = params;
      if (!flash_sale_id) return res.status(200).json({ ok: false, erro: 'Faltou informar qual oferta excluir.' });
      const chamar = (path, q, metodo = 'GET', body = null) => chamarShopee(path, q, metodo, body, appEscolhido);
      const r = await chamar('/api/v2/shop_flash_sale/delete_shop_flash_sale',
        { access_token, shop_id }, 'POST', { flash_sale_id: Number(flash_sale_id) });
      console.log('[EXCLUIR OFERTA]', shop_id, flash_sale_id, r?.error ? r.error : 'ok');
      if (r?.error) return res.status(200).json({ ok: false, erro: `${r.error}: ${r.message || ''}`.trim() });
      return res.status(200).json({ ok: true });
    }

    // ============ FINANCEIRO — "Caixa da Loja" (precisa do app ERP) ============
    if (acao === 'buscar_extrato_financeiro') {
      const { access_token, shop_id } = params;
      const chamarErp = (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token, shop_id }, metodo, body, appEscolhido);
      const r = await finBuscarExtrato(chamarErp, {}, { limite: Number(params.limite || 200) });
      if (!r.ok) return res.status(200).json({ ok: false, erro: r.erro });
      const resumo = finResumoSaude(r.transacoes);
      return res.status(200).json({
        ok: true, saldoAtual: r.saldoAtual, resumo,
        transacoes: r.transacoes.slice(0, 50).map(finFormatarTransacao)
      });
    }

    // ============ LOGÍSTICA — "Central de Envios" (precisa do app ERP) ============
    if (acao === 'buscar_rastreio') {
      const { access_token, shop_id, order_sn } = params;
      if (!order_sn) return res.status(200).json({ ok: false, erro: 'Faltou informar o pedido (order_sn).' });
      const chamarErp = (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token, shop_id }, metodo, body, appEscolhido);
      const r = await logBuscarRastreio(chamarErp, {}, order_sn);
      return res.status(200).json(r.ok ? { ok: true, ...r } : { ok: false, erro: r.erro });
    }

    if (acao === 'buscar_rastreio_lote') {
      const { access_token, shop_id } = params;
      const orderSns = String(params.order_sns || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!orderSns.length) return res.status(200).json({ ok: false, erro: 'Faltou informar os pedidos (order_sns, separados por vírgula).' });
      const chamarErp = (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token, shop_id }, metodo, body, appEscolhido);
      const resultados = await logBuscarRastreioEmLote(chamarErp, {}, orderSns, 20);
      return res.status(200).json({ ok: true, resultados });
    }

    if (acao === 'buscar_pedidos_recentes') {
      const { access_token, shop_id } = params;
      const chamar = (path, q, metodo = 'GET', body = null) => chamarShopee(path, q, metodo, body, appEscolhido);
      const agora = Math.floor(Date.now() / 1000);
      const dias = Math.min(Number(params.dias || 14), 15);
      const r = await chamar('/api/v2/order/get_order_list', { access_token, shop_id, time_range_field: 'create_time', time_from: agora - dias * 86400, time_to: agora, page_size: 30 }, 'GET', null);
      if (r?.error) return res.status(200).json({ ok: false, erro: `${r.error}: ${r.message || ''}`.trim() });
      const pedidos = (r?.response?.order_list || []).map((p) => ({ orderSn: p.order_sn, status: p.order_status }));
      return res.status(200).json({ ok: true, pedidos });
    }

    // ============ PRODUTO — "Gestão de Catálogo" (precisa do app ERP ou Produto) ============
    if (acao === 'simular_reajuste_preco') {
      const { access_token, shop_id } = params;
      const itemIds = String(params.item_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
      const percentual = Number(params.percentual);
      if (!itemIds.length || !Number.isFinite(percentual)) return res.status(200).json({ ok: false, erro: 'Faltou informar os produtos (item_ids) e o percentual.' });
      const chamarErp = (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token, shop_id }, metodo, body, appEscolhido);
      const r = await prodSimularReajustePreco(chamarErp, {}, itemIds, percentual);
      return res.status(200).json(r);
    }

    if (acao === 'aplicar_reajuste_preco') {
      const { access_token, shop_id } = params;
      let simulacao;
      try { simulacao = JSON.parse(params.simulacao || '{}'); } catch (e) { return res.status(200).json({ ok: false, erro: 'Simulação inválida — rode simular_reajuste_preco de novo e use o resultado sem alterar.' }); }
      if (!simulacao.itens?.length) return res.status(200).json({ ok: false, erro: 'Simulação vazia — nada pra aplicar.' });
      const chamarErp = (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token, shop_id }, metodo, body, appEscolhido);
      const r = await prodAplicarReajustePreco(chamarErp, {}, simulacao);
      console.log('[REAJUSTE PREÇO]', shop_id, `${r.totalAplicados} aplicado(s), ${r.totalFalhas} falha(s)`);
      return res.status(200).json(r);
    }

    if (acao === 'ajustar_estoque') {
      const { access_token, shop_id, item_id, model_id, novo_estoque } = params;
      if (!item_id || novo_estoque === undefined) return res.status(200).json({ ok: false, erro: 'Faltou item_id ou novo_estoque.' });
      const chamarErp = (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token, shop_id }, metodo, body, appEscolhido);
      const r = await prodAjustarEstoque(chamarErp, {}, Number(item_id), model_id ? Number(model_id) : null, Number(novo_estoque));
      return res.status(200).json(r);
    }

    if (acao === 'mudar_visibilidade_produto') {
      const { access_token, shop_id, item_id, visivel } = params;
      if (!item_id) return res.status(200).json({ ok: false, erro: 'Faltou item_id.' });
      const chamarErp = (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token, shop_id }, metodo, body, appEscolhido);
      const r = await prodMudarVisibilidade(chamarErp, {}, Number(item_id), visivel === 'true');
      return res.status(200).json(r);
    }

    if (acao === 'auto_pausar_sem_estoque') {
      const { access_token, shop_id } = params;
      const chamarErp = (path, q, metodo = 'GET', body = null) => chamarShopee(path, { ...q, access_token, shop_id }, metodo, body, appEscolhido);
      const r = await prodAutoPausarSemEstoque(chamarErp, {}, Number(params.limite || 50));
      console.log('[AUTO-PAUSA PRODUTO]', shop_id, r.ok ? `${r.totalPausados} pausado(s) de ${r.totalVerificados}` : r.erro);
      return res.status(200).json(r);
    }

    // 9) Sincronizar Ofertas Relâmpago — só CONSULTA o que a loja já tem na Shopee agora, não cria nada.
    if (acao === 'sincronizar_ofertas') {
      const { access_token, shop_id } = params;
      const chamar = (path, q, metodo = 'GET', body = null) => chamarShopee(path, q, metodo, body, appEscolhido);
      const r = await descSincronizarOfertas(chamar, { accessToken: access_token, shopId: shop_id });
      return res.status(200).json({ ok: true, confiavel: r.confiavel, total: r.total, ofertas: r.ofertas });
    }

    // 10) Listar os descontos da loja (app Marketing) — pra equipe escolher qual é o "desconto fixo"
    if (acao === 'listar_descontos') {
      const { access_token, shop_id } = params;
      const chamar = (path, q, metodo = 'GET', body = null) => chamarShopee(path, q, metodo, body, appEscolhido);
      const lista = await descListar(chamar, { accessToken: access_token, shopId: shop_id });
      if (!lista.ok) return res.status(200).json({ ok: false, erro: lista.erro });
      const descontos = lista.descontos
        .map(d => ({ discount_id: String(d.discount_id), discount_name: d.discount_name, start_time: d.start_time, end_time: d.end_time, status: d.status }))
        .sort((a, b) => b.end_time - a.end_time);
      return res.status(200).json({ ok: true, descontos });
    }

    // 11) Duplicar um desconto (mesmo nome, mesmos produtos e preços, 5 meses) — botão "Duplicar" do sistema
    if (acao === 'duplicar_desconto') {
      const { access_token, shop_id, discount_id } = params;
      if (!discount_id) return res.status(200).json({ ok: false, erro: 'Faltou informar qual desconto duplicar.' });
      const chamar = (path, q, metodo = 'GET', body = null) => chamarShopee(path, q, metodo, body, appEscolhido);
      const r = await descDuplicar(chamar, { accessToken: access_token, shopId: shop_id }, discount_id);
      console.log('[DUPLICAR DESCONTO]', shop_id, discount_id, r.ok ? `ok -> ${r.novoDiscountId} (${r.totalProdutos}/${r.totalOrigem})` : r.erro);
      if (!r.ok) return res.status(200).json({ ok: false, erro: r.erro, detalhe: r });
      return res.status(200).json({ ...r, ok: true, novoDiscountId: String(r.novoDiscountId), novoFimLocal: descFormatarDataLocalBR(r.novoFim) });
    }

    // 9) Saldo do Shopee Ads (app Ads)
    if (acao === 'saldo_ads') {
      const { access_token, shop_id } = params;
      const resultado = await chamarShopee('/api/v2/ads/get_total_balance', {
        access_token, shop_id
      }, 'GET', null, 'ads');
      if (resultado?.error) {
        return res.status(200).json({ ok: false, erro: `${resultado.error}: ${resultado.message || ''}`, debug: resultado });
      }
      return res.status(200).json({ ok: true, saldo: resultado?.response?.total_balance ?? 0, debug: resultado });
    }

    return res.status(400).json({ erro: 'Ação não reconhecida.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Erro: ' + (e.message || 'desconhecido') });
  }
}
