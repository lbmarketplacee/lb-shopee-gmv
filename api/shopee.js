// Intermediário seguro LB — integração Shopee Open Platform (GMV)
// Variáveis de ambiente necessárias na Vercel:
//   SHOPEE_PARTNER_ID       -> ID do parceiro (visível, não é segredo)
//   SHOPEE_PARTNER_KEY      -> Chave secreta do parceiro (sensível!)
//   SHOPEE_AMBIENTE         -> "sandbox" ou "producao"
//   QUOTAGUARD_URL          -> URL completa do proxy (com usuário/senha) do QuotaGuard

import crypto from 'crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const HOSTS = {
  sandbox: 'https://partner.test-stable.shopeemobile.com',
  producao: 'https://partner.shopeemobile.com'
};

function gerarAssinatura(path, timestamp, partnerId, partnerKey, accessToken='', shopId=''){
  const baseString = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

// Faz a chamada HTTP passando SEMPRE pelo proxy do QuotaGuard (IP fixo)
async function chamarShopee(path, params = {}, metodo = 'GET') {
  const partnerId = (process.env.SHOPEE_PARTNER_ID || '').trim();
  const partnerKey = (process.env.SHOPEE_PARTNER_KEY || '').trim();
  const ambiente = (process.env.SHOPEE_AMBIENTE || 'sandbox').trim();
  const quotaguardUrl = (process.env.QUOTAGUARD_URL || '').trim();
  const host = HOSTS[ambiente];

  if (!partnerId || !partnerKey) throw new Error('Credenciais da Shopee não configuradas na Vercel.');
  if (!quotaguardUrl) throw new Error('QUOTAGUARD_URL não configurada na Vercel.');

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = gerarAssinatura(path, timestamp, partnerId, partnerKey, params.access_token || '', params.shop_id || '');

  const url = new URL(host + path);
  url.searchParams.set('partner_id', partnerId);
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('sign', sign);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v); });

  // Roteia a chamada pelo proxy do QuotaGuard (IP fixo exigido pela Shopee)
  const dispatcher = new ProxyAgent(quotaguardUrl);
  const resp = await undiciFetch(url.toString(), { method: metodo, dispatcher });
  const data = await resp.json();
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { acao } = req.method === 'GET' ? req.query : req.body;

    // 1) Gerar o link de autorização (pra cliente aprovar o acesso da loja dele)
    if (acao === 'gerar_link_autorizacao') {
      const partnerId = (process.env.SHOPEE_PARTNER_ID || '').trim();
      const partnerKey = (process.env.SHOPEE_PARTNER_KEY || '').trim();
      const ambiente = (process.env.SHOPEE_AMBIENTE || 'sandbox').trim();
      const redirectUrl = req.query.redirect || req.body.redirect;
      const path = '/api/v2/shop/auth_partner';
      const timestamp = Math.floor(Date.now() / 1000);
      const sign = gerarAssinatura(path, timestamp, partnerId, partnerKey);
      const link = `${HOSTS[ambiente]}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUrl)}`;
      return res.status(200).json({ ok: true, link });
    }

    // 2) Trocar o "code" (recebido após o cliente autorizar) por um access_token
    if (acao === 'trocar_codigo_por_token') {
      const { code, shop_id } = req.method === 'GET' ? req.query : req.body;
      const partnerId = (process.env.SHOPEE_PARTNER_ID || '').trim();
      const partnerKey = (process.env.SHOPEE_PARTNER_KEY || '').trim();
      const ambiente = (process.env.SHOPEE_AMBIENTE || 'sandbox').trim();
      const path = '/api/v2/auth/token/get';
      const timestamp = Math.floor(Date.now() / 1000);
      const sign = gerarAssinatura(path, timestamp, partnerId, partnerKey);
      const quotaguardUrl = process.env.QUOTAGUARD_URL;
      const dispatcher = new ProxyAgent(quotaguardUrl);
      const url = `${HOSTS[ambiente]}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;
      const resp = await undiciFetch(url, {
        method: 'POST',
        dispatcher,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, shop_id: Number(shop_id), partner_id: Number(partnerId) })
      });
      const data = await resp.json();
      return res.status(200).json({ ok: true, ...data });
    }

    // 3) Buscar GMV (soma de pedidos) de uma loja num período
    if (acao === 'buscar_gmv') {
      const { access_token, shop_id, data_inicio, data_fim } = req.method === 'GET' ? req.query : req.body;
      const timeFrom = Math.floor(new Date(data_inicio).getTime() / 1000);
      const timeTo = Math.floor(new Date(data_fim).getTime() / 1000);

      let gmvTotal = 0, totalPedidos = 0, cursor = '';
      let paginas = 0;
      do {
        const resultado = await chamarShopee('/api/v2/order/get_order_list', {
          access_token, shop_id,
          time_range_field: 'create_time',
          time_from: timeFrom, time_to: timeTo,
          page_size: 100, cursor,
          order_status: 'COMPLETED' // só pedidos concluídos entram no GMV
        });
        const lista = resultado?.response?.order_list || [];
        totalPedidos += lista.length;
        // Nota: get_order_list não traz o valor — precisaria de get_order_detail pra cada pedido.
        // Isso é tratado numa segunda chamada em lote (ver função buscarValoresPedidos).
        cursor = resultado?.response?.next_cursor || '';
        paginas++;
        if (paginas > 20) break; // segurança contra loop infinito
      } while (cursor);

      return res.status(200).json({ ok: true, totalPedidos, aviso: 'Contagem de pedidos ok — soma de valores (GMV) requer segunda etapa com get_order_detail.' });
    }

    // Diagnóstico: mostra o TAMANHO das credenciais (nunca o valor), pra detectar espaço/quebra de linha acidental
    if (acao === 'diagnostico') {
      const pid = process.env.SHOPEE_PARTNER_ID || '';
      const pkey = process.env.SHOPEE_PARTNER_KEY || '';
      const qg = process.env.QUOTAGUARD_URL || '';
      return res.status(200).json({
        ok: true,
        partner_id_valor: pid,
        partner_id_tamanho: pid.length,
        partner_key_tamanho: pkey.length,
        partner_key_comeca_com: pkey.slice(0, 4),
        partner_key_termina_com: pkey.slice(-4),
        quotaguard_configurado: !!qg,
        ambiente: process.env.SHOPEE_AMBIENTE || 'sandbox'
      });
    }

    return res.status(400).json({ erro: 'Ação não reconhecida.' });
  } catch (e) {
    return res.status(500).json({ erro: 'Erro: ' + (e.message || 'desconhecido') });
  }
}
