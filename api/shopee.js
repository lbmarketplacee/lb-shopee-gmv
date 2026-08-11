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
        if (!primeiraRespostaBruta) {
          primeiraRespostaBruta = await chamarShopee('/api/v2/order/get_order_list', {
            access_token, shop_id,
            time_range_field: 'create_time',
            time_from: timeFrom, time_to: timeTo,
            page_size: 20, cursor: ''
          }, 'GET', null, 'gmv');
        }
        // Busca TODOS os pedidos do período (sem filtro de status) — GMV conta toda venda válida,
        // não só a 100% "concluída" (que só acontece dias depois, quando o comprador confirma o recebimento).
        // Excluímos manualmente só os que não são venda de verdade: cancelados e não pagos.
        const STATUS_EXCLUIR = ['CANCELLED', 'UNPAID', 'INVOICE_PENDING'];
        let cursor = '', paginas = 0;
        do {
          const resultado = await chamarShopee('/api/v2/order/get_order_list', {
            access_token, shop_id,
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
        debug.janelas.push({ timeFrom, timeTo });
      }
      debug.respostaListaBruta = primeiraRespostaBruta;

      if (!todosOrderSn.length) {
        return res.status(200).json({ ok: true, gmv: 0, totalPedidos: 0, debug });
      }

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
        usage_quantity: Number(quantidade || 5000),
        display_channel_list: [1], // 1 = mostrar pra todo mundo na loja (público, sem precisar do código)
        display_start_time: agora
      };
      const resultado = await chamarShopee('/api/v2/voucher/add_voucher', { access_token, shop_id }, 'POST', corpo, 'mkt');
      return res.status(200).json({ ok: true, ...resultado });
    }

    // 8) Criar Oferta Relâmpago — 100% automática, respeitando as regras da loja
    //    Até "limite_produtos" produtos, "qtd_por_produto" unidades cada, desconto de "percentual"% sobre o preço atual
    if (acao === 'criar_oferta_relampago') {
      const { access_token, shop_id, access_token_gmv, shop_id_gmv } = params;
      const percentual = Number(params.percentual || 5);
      const qtdPorProduto = Number(params.qtd_por_produto || 5);
      const limiteProdutos = Math.min(Number(params.limite_produtos || 20), 20); // Shopee também limita 20 por oferta

      if (!access_token_gmv || !shop_id_gmv) {
        return res.status(200).json({ ok: false, erro: 'Essa loja também precisa estar conectada ao app GMV (a busca de produtos usa essas credenciais). Conecte o GMV primeiro.' });
      }

      // Passo A: buscar os produtos ativos da loja (até o limite) — usa o token do app GMV, que tem acesso a catálogo
      const listaProdutos = await chamarShopee('/api/v2/product/get_item_list', {
        access_token: access_token_gmv, shop_id: shop_id_gmv,
        offset: 0, page_size: limiteProdutos,
        item_status: 'NORMAL'
      }, 'GET', null, 'gmv');
      const itens = listaProdutos?.response?.item || [];
      if (!itens.length) {
        const erroReal = listaProdutos?.error ? `${listaProdutos.error}: ${listaProdutos.message || ''}` : 'Nenhum produto ativo encontrado na loja (ou erro desconhecido).';
        return res.status(200).json({ ok: false, erro: erroReal, debugListaProdutos: listaProdutos });
      }
      const itemIds = itens.map(i => i.item_id);

      // Passo B: buscar preço e info de cada produto (inclui se tem variação/modelo)
      const infoProdutos = await chamarShopee('/api/v2/product/get_item_base_info', {
        access_token: access_token_gmv, shop_id: shop_id_gmv,
        item_id_list: itemIds.join(',')
      }, 'GET', null, 'gmv');
      const detalhes = infoProdutos?.response?.item_list || [];

      // Passo B.2: buscar o DESCONTO FIXO DA LOJA ativo (o preço "de verdade" já reduzido do preço de cadastro).
      // A oferta relâmpago precisa calcular os 5% em cima DESSE preço, não do preço de cadastro cheio.
      const mapaDescontoAtivo = {}; // item_id -> preço já com desconto fixo aplicado
      try {
        const listaDescontos = await chamarShopee('/api/v2/discount/get_discount_list', {
          access_token, shop_id, discount_status: 'ongoing', page_size: 100
        }, 'GET', null, 'mkt');
        const descontos = listaDescontos?.response?.discount_list || [];
        for (const desc of descontos) {
          const detalheDesconto = await chamarShopee('/api/v2/discount/get_discount', {
            access_token, shop_id, discount_id: desc.discount_id
          }, 'GET', null, 'mkt');
          const itensDesconto = detalheDesconto?.response?.item_list || [];
          itensDesconto.forEach(di => {
            const precoComDesconto = di?.model_list?.[0]?.discount_price ?? di?.item_promotion_price;
            if (precoComDesconto) mapaDescontoAtivo[di.item_id] = precoComDesconto;
          });
        }
      } catch (e) { /* se der erro buscando desconto, seguimos com o preço normal como fallback */ }

      // Passo C: montar a lista de itens com preço promocional (produto por produto, modelo por modelo)
      const itensParaOferta = [];
      for (const item of detalhes) {
        // Prioridade: preço do desconto fixo ativo > preço atual do produto (fallback)
        const precoAtual = mapaDescontoAtivo[item.item_id] ?? item?.price_info?.[0]?.current_price;
        if (item.has_model) {
          // Produto com variação (cor/tamanho) — busca o preço de cada modelo separadamente
          const modelos = await chamarShopee('/api/v2/product/get_model_list', {
            access_token: access_token_gmv, shop_id: shop_id_gmv, item_id: item.item_id
          }, 'GET', null, 'gmv');
          const listaModelos = modelos?.response?.model || [];
          const models = listaModelos.map(m => {
            const preco = m?.price_info?.[0]?.current_price || precoAtual || 0;
            return {
              model_id: m.model_id,
              input_promo_price: Math.round((preco * (1 - percentual / 100)) * 100) / 100,
              stock: qtdPorProduto
            };
          }).filter(m => m.input_promo_price > 0);
          if (models.length) itensParaOferta.push({ item_id: item.item_id, purchase_limit: qtdPorProduto, models });
        } else if (precoAtual) {
          // Produto simples, sem variação
          itensParaOferta.push({
            item_id: item.item_id,
            purchase_limit: qtdPorProduto,
            models: [{ model_id: 0, input_promo_price: Math.round((precoAtual * (1 - percentual / 100)) * 100) / 100, stock: qtdPorProduto }]
          });
        }
      }

      if (!itensParaOferta.length) {
        return res.status(200).json({ ok: false, erro: 'Não foi possível calcular preço promocional para nenhum produto.', debugDetalhes: detalhes });
      }

      // Passo D.1: verificar se a loja JÁ TEM oferta relâmpago ativa/agendada — se tiver, a nova
      // precisa começar DEPOIS que a(s) existente(s) terminar(em), pra não dar conflito.
      let agora = Math.floor(Date.now() / 1000);
      try {
        const ofertasExistentes = await chamarShopee('/api/v2/shop_flash_sale/get_shop_flash_sale_list', {
          access_token, shop_id, type: 1, // 1 = agendada/em andamento (upcoming + ongoing)
          offset: 0, limit: 100
        }, 'GET', null, 'mkt');
        const listaExistentes = ofertasExistentes?.response?.flash_sale_list || [];
        listaExistentes.forEach(f => { if (f.end_time && f.end_time > agora) agora = f.end_time + 60; }); // +1min de folga
      } catch (e) { /* se der erro checando, segue a partir de agora mesmo */ }

      // Passo D.2: pegar um horário disponível a partir desse ponto (depois do que já existe)
      const daqui7dias = agora + 7 * 24 * 60 * 60;
      const horarios = await chamarShopee('/api/v2/shop_flash_sale/get_time_slot_id', {
        access_token, shop_id, start_time: agora, end_time: daqui7dias
      }, 'GET', null, 'mkt');
      const proximoSlot = horarios?.response?.[0]?.timeslot_id;
      if (!proximoSlot) {
        return res.status(200).json({ ok: false, erro: 'Nenhum horário disponível encontrado na Shopee pros próximos 7 dias (considerando ofertas já ativas).', debugHorarios: horarios });
      }

      // Passo E: criar a "casca" da oferta relâmpago nesse horário
      const criacao = await chamarShopee('/api/v2/shop_flash_sale/create_shop_flash_sale', {
        access_token, shop_id
      }, 'POST', { timeslot_id: proximoSlot }, 'mkt');
      const flashSaleId = criacao?.response?.flash_sale_id;
      if (!flashSaleId) {
        return res.status(200).json({ ok: false, erro: 'Não foi possível criar a oferta relâmpago.', debugCriacao: criacao });
      }

      // Passo F: adicionar os produtos com o preço promocional
      const adicaoItens = await chamarShopee('/api/v2/shop_flash_sale/add_shop_flash_sale_items', {
        access_token, shop_id
      }, 'POST', { flash_sale_id: flashSaleId, items: itensParaOferta }, 'mkt');

      return res.status(200).json({
        ok: true,
        flash_sale_id: flashSaleId,
        total_produtos: itensParaOferta.length,
        resultado_itens: adicaoItens
      });
    }

    return res.status(400).json({ erro: 'Ação não reconhecida.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Erro: ' + (e.message || 'desconhecido') });
  }
}
