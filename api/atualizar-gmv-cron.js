// Atualização automática semanal de GMV — roda sozinha via Vercel Cron Job
// Busca todos os clientes conectados à Shopee no Firestore, renova token se preciso,
// calcula o GMV dos últimos 30 dias de cada um, e salva de volta no Firestore.
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
  const prefixo = app === 'mkt' ? 'SHOPEE_MKT_' : 'SHOPEE_';
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

// Renova o "desconto fixo - LB MARKETPLACE": cria um desconto NOVO (mesmo nome, 5 meses),
// começando 10 minutos depois que o anterior encerra, copiando os mesmos produtos e preços.
const NOME_DESCONTO_FIXO = 'desconto fixo - lb marketplace';
const DEZ_MINUTOS = 10 * 60;
const CINCO_MESES_SEGUNDOS = 150 * 24 * 60 * 60; // aproximação de 5 meses (30 dias cada)
const JANELA_ANTECEDENCIA = 8 * 24 * 60 * 60; // olha pra frente até 8 dias (cron roda 1x por semana)

async function renovarDescontoFixo(accessToken, shopId, db, clienteId){
  const listaDescontos = await chamarShopee('/api/v2/discount/get_discount_list', {
    access_token: accessToken, shop_id: shopId, discount_status: 'all', page_size: 100
  }, 'GET', null, 'mkt');
  const descontos = listaDescontos?.response?.discount_list || [];
  const comEsseNome = descontos.filter(d => (d.discount_name || '').toLowerCase().includes(NOME_DESCONTO_FIXO));
  if (!comEsseNome.length) return { renovado: false, motivo: 'Nenhum desconto com esse nome encontrado.' };

  // Pega o que tem a data de término MAIS FUTURA entre os com esse nome (o "atual" ou já renovado mais recente)
  const maisRecente = comEsseNome.reduce((a, b) => (a.end_time > b.end_time ? a : b));

  const agora = Math.floor(Date.now() / 1000);
  if (maisRecente.end_time - agora > JANELA_ANTECEDENCIA) {
    return { renovado: false, motivo: 'Ainda não está perto de vencer.', vigenteAte: maisRecente.end_time };
  }

  // Já existe um próximo agendado começando logo depois desse? Então já foi renovado, não duplica.
  const jaTemProximo = comEsseNome.some(d => d.discount_id !== maisRecente.discount_id && d.start_time >= maisRecente.end_time);
  if (jaTemProximo) {
    return { renovado: false, motivo: 'Já existe uma renovação agendada.' };
  }

  // Busca os produtos e preços do desconto atual, pra copiar pro novo
  const detalheAtual = await chamarShopee('/api/v2/discount/get_discount', {
    access_token: accessToken, shop_id: shopId, discount_id: maisRecente.discount_id
  }, 'GET', null, 'mkt');
  const itensAtuais = detalheAtual?.response?.item_list || [];
  if (!itensAtuais.length) return { renovado: false, motivo: 'Desconto encontrado, mas sem produtos pra copiar.' };

  const novoInicio = maisRecente.end_time + DEZ_MINUTOS;
  const novoFim = novoInicio + CINCO_MESES_SEGUNDOS;

  // Cria a "casca" do desconto novo, com o mesmo nome
  const criacao = await chamarShopee('/api/v2/discount/add_discount', {
    access_token: accessToken, shop_id: shopId
  }, 'POST', { discount_name: maisRecente.discount_name, start_time: novoInicio, end_time: novoFim }, 'mkt');
  const novoDiscountId = criacao?.response?.discount_id;
  if (!novoDiscountId) {
    return { renovado: false, motivo: `Não foi possível criar o desconto novo: ${criacao?.error || ''} ${criacao?.message || ''}` };
  }

  // Copia os produtos e preços pro desconto novo
  const itensParaAdicionar = itensAtuais.map(it => ({
    item_id: it.item_id,
    purchase_limit: it.purchase_limit || 0,
    discount_price: it?.model_list?.[0]?.discount_price ?? it.item_promotion_price ?? undefined
  })).filter(it => it.discount_price !== undefined);

  const adicaoItens = await chamarShopee('/api/v2/discount/add_discount_item', {
    access_token: accessToken, shop_id: shopId
  }, 'POST', { discount_id: novoDiscountId, item_list: itensParaAdicionar }, 'mkt');

  // Salva no Firestore quando foi renovado e até quando vale, pra aparecer na aba Descontos
  if (db && clienteId) {
    await db.collection('clientes').doc(clienteId).update({
      descontoAutoUltimaRenovacao: new Date(),
      descontoAutoProximoVencimento: novoFim * 1000,
      descontoAutoTotalProdutos: itensParaAdicionar.length
    });
  }

  return { renovado: true, novoDiscountId, novoInicio, novoFim, totalProdutos: itensParaAdicionar.length, debugAdicaoItens: adicaoItens };
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

// Soma os dias já salvos que caem dentro da janela móvel de 30 dias — sem chamar a Shopee.
async function somarUltimos30Dias(db, clienteId, hoje){
  const snap = await db.collection('clientes').doc(clienteId).collection('gmvDiario').get();
  const limiteInicio = fmtDia(new Date(hoje.getTime() - 29 * 24 * 60 * 60 * 1000));
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

export default async function handler(req, res) {
  // Proteção: só aceita chamadas com o segredo do cron (evita qualquer um disparar isso manualmente pela internet)
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }

  const db = getDb();

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
    const inicioHistoricoCompleto = fmtDia(new Date(hoje.getTime() - 29 * 24 * 60 * 60 * 1000));

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
        const { gmv: gmvFinal, totalPedidos: totalPedidosFinal } = await somarUltimos30Dias(db, cliente.id, hoje);

        // Únicos campos que o frontend lê — continuam exatamente com o mesmo nome/formato de sempre.
        await db.collection('clientes').doc(cliente.id).update({
          gmvShopeeAutomatico: gmvFinal,
          gmvShopeeAtualizadoEm: new Date()
        });

        const gmvPeriodo = Object.values(porDia).reduce((s, d) => s + d.valor, 0);
        console.log(
          `[GMV CRON] CLIENTE: ${cliente.nome} | MODO: ${modo} | PERIODO: ${periodoInicio} a ${hojeStr} | ` +
          `PEDIDOS ENCONTRADOS: ${totalPedidos} | GMV CALCULADO (periodo): ${gmvPeriodo.toFixed(2)} | ` +
          `GMV FINAL 30 DIAS: ${gmvFinal.toFixed(2)}`
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
          const resultadoDesconto = await renovarDescontoFixo(accessTokenMkt, cliente.shopeeMktShopId, db, cliente.id);
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
