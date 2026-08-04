// Intermediário seguro LB — integração Shopee Open Platform (GMV)
// Variáveis de ambiente na Vercel:
//   SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_AMBIENTE (sandbox|producao), QUOTAGUARD_URL

import crypto from 'crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const HOSTS = {
  sandbox: 'https://openplatform.sandbox.test-stable.shopee.sg',
  producao: 'https://partner.shopeemobile.com' // confirmado funcionando em 04/08/2026
};

function limpar(v){ return (v || '').trim(); }

function gerarAssinatura(path, timestamp, partnerId, partnerKey, accessToken='', shopId=''){
  const baseString = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

function getConfig(){
  return {
    partnerId: limpar(process.env.SHOPEE_PARTNER_ID),
    partnerKey: limpar(process.env.SHOPEE_PARTNER_KEY),
    ambiente: limpar(process.env.SHOPEE_AMBIENTE) || 'sandbox',
    quotaguardUrl: limpar(process.env.QUOTAGUARD_URL)
  };
}

// Faz a chamada HTTP passando SEMPRE pelo proxy do QuotaGuard (IP fixo)
async function chamarShopee(path, params = {}, metodo = 'GET', body = null){
  const { partnerId, partnerKey, ambiente, quotaguardUrl } = getConfig();
  const host = HOSTS[ambiente];
  if (!partnerId || !partnerKey) throw new Error('Credenciais da Shopee não configuradas.');
  if (!quotaguardUrl) throw new Error('QUOTAGUARD_URL não configurada.');

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const params = req.method === 'GET' ? req.query : req.body;
    const { acao } = params;
    const { partnerId, partnerKey, ambiente, quotaguardUrl } = getConfig();

    // 0) Diagnóstico — nunca expõe a chave, só confirma tamanho/formato
    if (acao === 'diagnostico') {
      return res.status(200).json({
        ok: true,
        partner_id_valor: partnerId,
        partner_id_tamanho: partnerId.length,
        partner_key_tamanho: partnerKey.length,
        quotaguard_configurado: !!quotaguardUrl,
        ambiente
      });
    }

    // 1) Gerar o link de autorização (pra cliente aprovar o acesso da loja dele)
    if (acao === 'gerar_link_autorizacao') {
      const redirectUrl = params.redirect;
      const path = '/api/v2/shop/auth_partner';
      const timestamp = Math.floor(Date.now() / 1000);
      const sign = gerarAssinatura(path, timestamp, partnerId, partnerKey);
      const link = `${HOSTS[ambiente]}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUrl)}`;
      return res.status(200).json({ ok: true, link });
    }

    // 2) Trocar o "code" por um access_token
    if (acao === 'trocar_codigo_por_token') {
      const { code, shop_id } = params;
      const path = '/api/v2/auth/token/get';
      const resultado = await chamarShopee(path, {}, 'POST', { code, shop_id: Number(shop_id), partner_id: Number(partnerId) });
      return res.status(200).json({ ok: true, ...resultado });
    }

    // 3) Renovar o access_token usando o refresh_token (access dura só 4h, refresh dura 30 dias)
    if (acao === 'renovar_token') {
      const { refresh_token, shop_id } = params;
      const path = '/api/v2/auth/access_token/get';
      const resultado = await chamarShopee(path, {}, 'POST', { refresh_token, shop_id: Number(shop_id), partner_id: Number(partnerId) });
      return res.status(200).json({ ok: true, ...resultado });
    }

    // 4) Buscar o GMV de uma loja num período — soma o valor de todos os pedidos concluídos
    if (acao === 'buscar_gmv') {
      const { access_token, shop_id, data_inicio, data_fim } = params;
      const timeFrom = Math.floor(new Date(data_inicio).getTime() / 1000);
      const timeTo = Math.floor(new Date(data_fim).getTime() / 1000);
      const debug = { timeFrom, timeTo, chamadasListaOrdem: [] };

      // Passo A: lista os números de pedido (order_sn) do período, paginando — SEM filtro de status primeiro (diagnóstico)
      let todosOrderSnTodosStatus = [], cursorDiag = '';
      const diagResultado = await chamarShopee('/api/v2/order/get_order_list', {
        access_token, shop_id,
        time_range_field: 'create_time',
        time_from: timeFrom, time_to: timeTo,
        page_size: 20, cursor: ''
      });
      debug.respostaListaBruta = diagResultado; // resposta crua da primeira página, sem filtro de status

      // Passo B: agora sim, busca de verdade só os concluídos
      let todosOrderSn = [], cursor = '', paginas = 0;
      do {
        const resultado = await chamarShopee('/api/v2/order/get_order_list', {
          access_token, shop_id,
          time_range_field: 'create_time',
          time_from: timeFrom, time_to: timeTo,
          page_size: 100, cursor,
          order_status: 'COMPLETED'
        });
        const lista = resultado?.response?.order_list || [];
        todosOrderSn.push(...lista.map(o => o.order_sn));
        cursor = resultado?.response?.next_cursor || '';
        paginas++;
        if (paginas > 30) break; // segurança
      } while (cursor);

      if (!todosOrderSn.length) {
        return res.status(200).json({ ok: true, gmv: 0, totalPedidos: 0, debug });
      }

      // Passo C: busca o VALOR de cada pedido (get_order_detail aceita até 50 por chamada)
      let gmvTotal = 0;
      let ultimoDetalheResposta = null;
      for (let i = 0; i < todosOrderSn.length; i += 50) {
        const lote = todosOrderSn.slice(i, i + 50);
        const detalhe = await chamarShopee('/api/v2/order/get_order_detail', {
          access_token, shop_id,
          order_sn_list: lote.join(','),
          response_optional_fields: 'total_amount'
        });
        ultimoDetalheResposta = detalhe;
        const pedidos = detalhe?.response?.order_list || [];
        pedidos.forEach(p => { gmvTotal += Number(p.total_amount) || 0; });
      }
      debug.ultimoDetalheResposta = ultimoDetalheResposta;

      return res.status(200).json({ ok: true, gmv: gmvTotal, totalPedidos: todosOrderSn.length, debug });
    }

    return res.status(400).json({ erro: 'Ação não reconhecida.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Erro: ' + (e.message || 'desconhecido') });
  }
}
