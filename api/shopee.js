// Intermediário seguro LB — integração Shopee Open Platform (GMV + Marketing)
// Variáveis de ambiente na Vercel:
//   App GMV (Order Management):
//     SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY
//   App Marketing (cupons/ofertas relâmpago):
//     SHOPEE_MKT_PARTNER_ID, SHOPEE_MKT_PARTNER_KEY
//   Comuns:
//     SHOPEE_AMBIENTE (sandbox|producao), QUOTAGUARD_URL

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

// app: 'gmv' (padrão) ou 'mkt' — escolhe qual par de credenciais usar
function getConfig(app = 'gmv'){
  const prefixo = app === 'mkt' ? 'SHOPEE_MKT_' : 'SHOPEE_';
  return {
    app,
    partnerId: limpar(process.env[`${prefixo}PARTNER_ID`]),
    partnerKey: limpar(process.env[`${prefixo}PARTNER_KEY`]),
    ambiente: limpar(process.env.SHOPEE_AMBIENTE) || 'sandbox',
    quotaguardUrl: limpar(process.env.QUOTAGUARD_URL)
  };
}

// Faz a chamada HTTP passando SEMPRE pelo proxy do QuotaGuard (IP fixo)
async function chamarShopee(path, params = {}, metodo = 'GET', body = null, app = 'gmv'){
  const { partnerId, partnerKey, ambiente, quotaguardUrl } = getConfig(app);
  const host = HOSTS[ambiente];
  if (!partnerId || !partnerKey) throw new Error(`Credenciais da Shopee (${app}) não configuradas.`);
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
    // Qual app usar nesta chamada: o front manda "app" = 'gmv' ou 'mkt'.
    // Se não mandar nada, cai no 'gmv' (mantém compatibilidade com o que já existe).
    const appEscolhido = (params.app === 'mkt') ? 'mkt' : 'gmv';
    const { partnerId, partnerKey, ambiente, quotaguardUrl } = getConfig(appEscolhido);

    // 0) Diagnóstico — nunca expõe a chave, só confirma tamanho/formato
    if (acao === 'diagnostico') {
      const gmv = getConfig('gmv');
      const mkt = getConfig('mkt');
      return res.status(200).json({
        ok: true,
        ambiente,
        quotaguard_configurado: !!quotaguardUrl,
        gmv: { partner_id_valor: gmv.partnerId, partner_id_tamanho: gmv.partnerId.length, partner_key_tamanho: gmv.partnerKey.length },
        mkt: { partner_id_valor: mkt.partnerId, partner_id_tamanho: mkt.partnerId.length, partner_key_tamanho: mkt.partnerKey.length }
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

      let todosOrderSn = [];
      let primeiraRespostaBruta = null;
      for (const [timeFrom, timeTo] of janelas) {
        // Diagnóstico (só na primeira janela, pra não gastar chamada à toa)
        if (!primeiraRespostaBruta) {
          primeiraRespostaBruta = await chamarShopee('/api/v2/order/get_order_list', {
            access_token, shop_id,
            time_range_field: 'create_time',
            time_from: timeFrom, time_to: timeTo,
            page_size: 20, cursor: ''
          }, 'GET', null, 'gmv');
        }
        // Busca de verdade, só os concluídos, paginando dentro dessa janela de 15 dias
        let cursor = '', paginas = 0;
        do {
          const resultado = await chamarShopee('/api/v2/order/get_order_list', {
            access_token, shop_id,
            time_range_field: 'create_time',
            time_from: timeFrom, time_to: timeTo,
            page_size: 100, cursor,
            order_status: 'COMPLETED'
          }, 'GET', null, 'gmv');
          const lista = resultado?.response?.order_list || [];
          todosOrderSn.push(...lista.map(o => o.order_sn));
          cursor = resultado?.response?.next_cursor || '';
          paginas++;
          if (paginas > 30) break;
        } while (cursor);
        debug.janelas.push({ timeFrom, timeTo });
      }
      debug.respostaListaBruta = primeiraRespostaBruta;

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
        }, 'GET', null, 'gmv');
        ultimoDetalheResposta = detalhe;
        const pedidos = detalhe?.response?.order_list || [];
        pedidos.forEach(p => { gmvTotal += Number(p.total_amount) || 0; });
      }
      debug.ultimoDetalheResposta = ultimoDetalheResposta;

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
        usage_quantity: Number(quantidade || 5000)
      };
      const resultado = await chamarShopee('/api/v2/voucher/add_voucher', { access_token, shop_id }, 'POST', corpo, 'mkt');
      return res.status(200).json({ ok: true, ...resultado });
    }

    return res.status(400).json({ erro: 'Ação não reconhecida.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Erro: ' + (e.message || 'desconhecido') });
  }
}
