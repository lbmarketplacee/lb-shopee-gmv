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
  const prefixo = app === 'mkt' ? 'SHOPEE_MKT_' : app === 'ads' ? 'SHOPEE_ADS_' : 'SHOPEE_';
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

// Lê o(s) desconto(s) em andamento e devolve até "limite" produtos com preço promocional já calculado.
async function descItensParaOfertaRelampago(chamar, ctx, { discountId, percentual, qtdPorProduto, limite }) {
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
  const itens = [];
  const vistos = new Set();
  const erros = [];
  for (const id of ids) {
    const lido = await descLerDesconto(chamar, ctx, id);
    if (!lido.ok) { erros.push(lido.erro); continue; }
    if (discountId) {
      if (lido.meta.end_time && lido.meta.end_time <= agora) return { ok: false, erro: 'O desconto fixo marcado já terminou. Duplique/renove ele antes de criar a oferta relâmpago.' };
      if (lido.meta.start_time && lido.meta.start_time > agora) return { ok: false, erro: 'O desconto fixo marcado ainda não começou. A oferta relâmpago só usa desconto em andamento.' };
    }
    for (const it of lido.itens) {
      if (itens.length >= limite) break;
      if (vistos.has(it.item_id)) continue;
      vistos.add(it.item_id);
      const modelos = (it.model_list || [])
        .map((m) => ({ model_id: m.model_id, preco: m.model_promotion_price ?? m.discount_price }))
        .filter((m) => m.preco > 0);
      if (modelos.length) {
        itens.push({ item_id: it.item_id, modelos: modelos.map((m) => ({ model_id: m.model_id, input_promo_price: ofrArredondar(m.preco * fator), stock: qtdPorProduto })) });
      } else if (!(it.model_list || []).length && it.item_promotion_price > 0) {
        itens.push({ item_id: it.item_id, simples: { input_promo_price: ofrArredondar(it.item_promotion_price * fator), stock: qtdPorProduto } });
      }
    }
    if (itens.length >= limite) break;
  }
  if (!itens.length) {
    return { ok: false, erro: erros.length ? `Não consegui ler o desconto: ${erros[0]}` : 'Não consegui ler o preço promocional de nenhum produto do desconto.' };
  }
  return { ok: true, itens };
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

// Cada horário recebe um grupo diferente de produtos (roda pelo catálogo do desconto), sem repetir entre horários.
function ofrFatia(itens, indice, limite) {
  if (itens.length <= limite) return itens;
  const ini = (indice * limite) % itens.length;
  const fatia = [];
  for (let k = 0; k < limite; k++) fatia.push(itens[(ini + k) % itens.length]);
  return fatia;
}

// Cria uma oferta relâmpago em CADA horário livre que a Shopee liberou (até maxHorarios).
// Horário que a loja já tem é pulado; se nenhum produto entrar num horário, a oferta vazia é apagada;
// depois de 2 horários seguidos sem sucesso, para (evita insistir num erro que se repete).
async function descCriarOfertasRelampago(chamar, ctx, opcoes = {}) {
  const percentual = opcoes.percentual ?? 5;
  const qtd = opcoes.qtdPorProduto ?? 5;
  const limite = Math.min(opcoes.limite ?? 20, 20);
  const maxHorarios = Math.max(1, Math.min(opcoes.maxHorarios ?? 14, 30));
  const base = { access_token: ctx.accessToken, shop_id: ctx.shopId };

  const origem = await descItensParaOfertaRelampago(chamar, ctx, { discountId: opcoes.discountId, percentual, qtdPorProduto: qtd, limite: Infinity });
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

    const fatia = ofrFatia(origem.itens, deslocamento + criadas.length + puladas.length, limite);
    const adicionar = (f) => chamar('/api/v2/shop_flash_sale/add_shop_flash_sale_items', base, 'POST',
      { flash_sale_id: flashSaleId, items: ofrMontarItens(fatia, qtd, f) });
    const listaFalhas = (r) => { const l = r?.response?.failed_items ?? r?.response?.failed_list ?? []; return Array.isArray(l) ? l : []; };

    let adicao = await adicionar(formato);
    if (fatia.some((i) => i.simples) && (adicao?.error || listaFalhas(adicao).length >= fatia.length)) {
      const outro = formato === 'item' ? 'models' : 'item';
      const adicao2 = await adicionar(outro);
      const ok2 = !adicao2?.error && listaFalhas(adicao2).length < fatia.length;
      if (ok2) { adicao = adicao2; formato = outro; }
    }
    const falhas = listaFalhas(adicao);
    const adicionados = adicao?.error ? 0 : Math.max(fatia.length - falhas.length, 0);
    falhas.forEach((f) => falhasItens.push(f));

    if (adicionados === 0) {
      let apagada = false;
      try { const d = await chamar('/api/v2/shop_flash_sale/delete_shop_flash_sale', base, 'POST', { flash_sale_id: flashSaleId }); apagada = !d?.error; } catch (e) { /* avisa abaixo */ }
      puladas.push({ timeslotId: slot.timeslot_id, inicio: inicioTxt, motivo: `A Shopee não aceitou nenhum produto${adicao?.error ? ` (${adicao.error}: ${adicao.message || ''})` : ''}. ${apagada ? 'Oferta vazia apagada.' : `ATENÇÃO: oferta vazia ${flashSaleId} ficou na Shopee — apague na mão.`}` });
      if (++semSucessoSeguidos >= 2) break;
      continue;
    }
    semSucessoSeguidos = 0;
    criadas.push({ flashSaleId, timeslotId: slot.timeslot_id, inicio: inicioTxt, fim: descFormatarDataLocalBR(slot.end_time), totalProdutos: adicionados, falhas: falhas.slice(0, 3) });
  }

  const totalProdutos = criadas.reduce((s, o) => s + o.totalProdutos, 0);
  const resumo = { criadas, puladas, totalOfertas: criadas.length, totalProdutos, horariosEncontrados: horarios.slots.length,
    jaExistiam: horarios.slots.length - livres.length, formatoUsado: formato, falhas: falhasItens.slice(0, 5),
    flashSaleId: criadas[0]?.flashSaleId, timeslotId: criadas[0]?.timeslotId };
  if (!criadas.length) {
    return { ok: false, ...resumo, erro: `Nenhuma oferta foi criada. ${puladas.slice(0, 2).map((p) => `${p.inicio}: ${p.motivo}`).join(' | ')}` };
  }
  return { ok: true, ...resumo };
}

// =================== FIM — DESCONTO FIXO (lógica compartilhada) ===================

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
    const appEscolhido = (params.app === 'mkt' || params.app === 'ads') ? params.app : 'gmv';
    const { partnerId, partnerKey, ambiente } = getConfig(appEscolhido);

    // 0) Diagnóstico — nunca expõe a chave, só confirma tamanho/formato
    if (acao === 'diagnostico') {
      const gmv = getConfig('gmv');
      const mkt = getConfig('mkt');
      const ads = getConfig('ads');
      return res.status(200).json({
        ok: true,
        ambiente,
        proxy_usado: false,
        gmv: { partner_id_valor: gmv.partnerId, partner_id_tamanho: gmv.partnerId.length, partner_key_tamanho: gmv.partnerKey.length },
        mkt: { partner_id_valor: mkt.partnerId, partner_id_tamanho: mkt.partnerId.length, partner_key_tamanho: mkt.partnerKey.length },
        ads: { partner_id_valor: ads.partnerId, partner_id_tamanho: ads.partnerId.length, partner_key_tamanho: ads.partnerKey.length }
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
      }, 'GET', null, 'mkt');
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
      const resultado = await chamarShopee('/api/v2/voucher/add_voucher', { access_token, shop_id }, 'POST', corpo, 'mkt');
      return res.status(200).json({ ok: true, ...resultado });
    }

    // 8) Criar Ofertas Relâmpago — UMA em cada horário livre que a Shopee liberou (até "max_horarios").
    //    Produtos e preço vêm do DESCONTO FIXO da loja (app Marketing); o app GMV não tem permissão de produto.
    //    Até "limite_produtos" produtos por oferta, "qtd_por_produto" unidades cada, "percentual"% sobre o preço com desconto.
    if (acao === 'criar_oferta_relampago') {
      const { access_token, shop_id, discount_id } = params;
      const chamar = (path, q, metodo = 'GET', body = null) => chamarShopee(path, q, metodo, body, 'mkt');
      const r = await descCriarOfertasRelampago(chamar, { accessToken: access_token, shopId: shop_id }, {
        discountId: discount_id || undefined,
        percentual: Number(params.percentual || 5),
        qtdPorProduto: Number(params.qtd_por_produto || 5),
        limite: Number(params.limite_produtos || 20),
        maxHorarios: Number(params.max_horarios || 14)
      });
      console.log('[OFERTA RELÂMPAGO]', shop_id, r.ok ? `${r.totalOfertas} oferta(s) criada(s), ${r.totalProdutos} produto(s)` : r.erro);
      if (!r.ok) return res.status(200).json({ ok: false, erro: r.erro, detalhe: r });
      return res.status(200).json({ ok: true, total_ofertas: r.totalOfertas, total_produtos: r.totalProdutos, flash_sale_id: r.flashSaleId,
        criadas: r.criadas, puladas: r.puladas, ja_existiam: r.jaExistiam, falhas: r.falhas });
    }

    // 10) Listar os descontos da loja (app Marketing) — pra equipe escolher qual é o "desconto fixo"
    if (acao === 'listar_descontos') {
      const { access_token, shop_id } = params;
      const chamar = (path, q, metodo = 'GET', body = null) => chamarShopee(path, q, metodo, body, 'mkt');
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
      const chamar = (path, q, metodo = 'GET', body = null) => chamarShopee(path, q, metodo, body, 'mkt');
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
