// Atualização automática semanal de GMV — roda sozinha via Vercel Cron Job
// Busca todos os clientes conectados à Shopee no Firestore, renova token se preciso,
// calcula o GMV dos últimos 30 dias de cada um, e salva de volta no Firestore.

import crypto from 'crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
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
    ambiente: limpar(process.env.SHOPEE_AMBIENTE) || 'sandbox',
    quotaguardUrl: limpar(process.env.QUOTAGUARD_URL)
  };
}

async function chamarShopee(path, params = {}, metodo = 'GET', body = null, app = 'gmv'){
  const { partnerId, partnerKey, ambiente, quotaguardUrl } = getConfig(app);
  const host = HOSTS[ambiente];
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = gerarAssinatura(path, timestamp, partnerId, partnerKey, params.access_token || '', params.shop_id || '');
  const url = new URL(host + path);
  url.searchParams.set('partner_id', partnerId);
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('sign', sign);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v); });
  const dispatcher = new ProxyAgent(quotaguardUrl);
  const opts = { method: metodo, dispatcher };
  if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  const resp = await undiciFetch(url.toString(), opts);
  return await resp.json();
}

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

async function buscarGmvCliente(accessToken, shopId, dataInicio, dataFim){
  const timeFromTotal = Math.floor(new Date(dataInicio).getTime() / 1000);
  const timeToTotal = Math.floor(new Date(dataFim).getTime() / 1000);
  const QUINZE_DIAS = 15 * 24 * 60 * 60;
  const janelas = [];
  let inicioJanela = timeFromTotal;
  while (inicioJanela < timeToTotal) {
    const fimJanela = Math.min(inicioJanela + QUINZE_DIAS - 1, timeToTotal);
    janelas.push([inicioJanela, fimJanela]);
    inicioJanela = fimJanela + 1;
  }
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
  if (!todosOrderSn.length) return { gmv: 0, totalPedidos: 0 };
  let gmvTotal = 0;
  for (let i = 0; i < todosOrderSn.length; i += 50) {
    const lote = todosOrderSn.slice(i, i + 50);
    const detalhe = await chamarShopee('/api/v2/order/get_order_detail', {
      access_token: accessToken, shop_id: shopId,
      order_sn_list: lote.join(','),
      response_optional_fields: 'total_amount'
    }, 'GET', null, 'gmv');
    const pedidos = detalhe?.response?.order_list || [];
    pedidos.forEach(p => { gmvTotal += Number(p.total_amount) || 0; });
  }
  return { gmv: gmvTotal, totalPedidos: todosOrderSn.length };
}

export default async function handler(req, res) {
  // Proteção: só aceita chamadas com o segredo do cron (evita qualquer um disparar isso manualmente pela internet)
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }

  const db = getDb();
  const hoje = new Date();
  const trintaDiasAtras = new Date(hoje.getTime() - 29 * 24 * 60 * 60 * 1000);
  const dataInicio = trintaDiasAtras.toISOString().split('T')[0];
  const dataFim = hoje.toISOString().split('T')[0];

  const snapshot = await db.collection('clientes').where('shopeeShopId', '!=', null).get();
  const resultados = [];

  for (const docSnap of snapshot.docs) {
    const cliente = { id: docSnap.id, ...docSnap.data() };
    if (!cliente.shopeeShopId) continue;
    try {
      const accessToken = await garantirTokenValido(db, cliente);
      const { gmv, totalPedidos } = await buscarGmvCliente(accessToken, cliente.shopeeShopId, dataInicio, dataFim);
      await db.collection('clientes').doc(cliente.id).update({
        gmvShopeeAutomatico: gmv,
        gmvShopeeAtualizadoEm: new Date()
      });
      resultados.push({ cliente: cliente.nome, gmv, totalPedidos, ok: true });
    } catch (e) {
      resultados.push({ cliente: cliente.nome, erro: e.message, ok: false });
    }
  }

  return res.status(200).json({ ok: true, executadoEm: new Date().toISOString(), resultados });
}
