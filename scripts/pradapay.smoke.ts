/**
 * Teste do adapter PradaPay SEM rede real nem credenciais.
 *
 * Intercepta o `fetch` global e devolve EXATAMENTE as respostas da doc oficial
 * (web.pradapay.com/developers). Valida duas coisas que importam:
 *
 *   1) o que o adapter ENVIA pra PradaPay (api-key no corpo, amount em reais,
 *      requestNumber, client.userPhone, Pix sem forma_pagamento);
 *   2) o que o adapter ENTENDE da resposta (Pix copia-e-cola + QR base64 ->
 *      data URL, boleto, e — crucial — a confirmação por RE-CONSULTA de status
 *      no webhook, em vez de confiar no corpo do postback).
 *
 * Roda com: npm run smoke:pradapay
 */
import assert from 'node:assert/strict';
import { PradaPayGateway } from '../src/domain/payments/gateways/pradapay-gateway.js';
import type { CreateChargeInput } from '../src/domain/payments/payment-gateway.js';

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
const calls: Captured[] = [];

/** Respostas espelhando a doc oficial da PradaPay. */
function fakePradaPay(url: string, body: Record<string, unknown>): Response {
  // Endpoint de status (usado por getCharge e pela re-consulta do webhook).
  if (url.endsWith('/v1/webhook/')) {
    return json({ status: 'PAID_OUT' });
  }
  // Endpoint único de cobrança.
  if (url.endsWith('/v1/gateway/')) {
    const forma = body['forma_pagamento'];
    if (forma === 'boleto') {
      return json({
        idTransaction: 'CHAR_4CAA3F04-6C6E-4E00-BAFB-8377DDEDBDD3',
        message: 'ok',
        status: 'success',
        flowType: 'redirect',
        barcode: '03399853012970000024227020901016278150000015630',
        pdf_url: 'https://example.com/fc6c8e8e-884a-439f-acfc-7fe42a631172.pdf',
      });
    }
    if (forma === 'cartao') {
      return json({
        idTransaction: 'ORDE_1A0406EF',
        message: 'ok',
        status: 'success',
        flowType: 'redirect',
        paymentUrl: 'https://checkout-adquirente.exemplo/pagamento',
        retorno_cartao: 'PAID',
      });
    }
    // Pix (sem forma_pagamento).
    return json({
      status: 'success',
      message: 'ok',
      flowType: 'qrcode',
      paymentCode: '000201010212267...',
      idTransaction: '52fc5262-4063-4900',
      paymentCodeBase64: 'iVBORw0KGgoAAAANSUhEUg==',
    });
  }
  return json({ status: 'error', message: 'rota inesperada no teste' }, 404);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function main(): Promise<void> {
  // Stub do fetch: captura corpo + devolve resposta da PradaPay.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    return fakePradaPay(url, body);
  }) as typeof fetch;

  try {
    const gateway = new PradaPayGateway({
      apiKey: 'pk_test_123',
      baseUrl: 'https://api.pradapay.com',
      enableCard: true,
    });

    const baseInput = (over: Partial<CreateChargeInput>): CreateChargeInput => ({
      orderId: 'ord_abc123',
      amountCents: 19700,
      method: 'pix',
      customer: { email: 'cliente@exemplo.com', taxId: '52998224725', phone: '11999998888', name: 'Fulano' },
      description: 'CULTO · Design Pack',
      webhookUrl: 'https://api.meusite.com/api/webhooks/pradapay',
      returnUrl: 'https://meusite.com/compra/retorno?order=ord_abc123',
      ...over,
    });

    // 1) Pix: request correto + resposta mapeada
    {
      calls.length = 0;
      const charge = await gateway.createCharge(baseInput({ method: 'pix' }));
      const sent = calls[0]!.body;

      assert.equal(sent['api-key'], 'pk_test_123', 'api-key vai NO CORPO');
      assert.equal(sent['amount'], 197, 'amount em REAIS (19700 centavos -> 197)');
      assert.equal(sent['requestNumber'], 'ord_abc123', 'requestNumber = nosso orderId');
      assert.equal(sent['postback'], 'https://api.meusite.com/api/webhooks/pradapay', 'postback = webhookUrl');
      assert.equal(sent['forma_pagamento'], undefined, 'Pix NÃO envia forma_pagamento');
      const client = sent['client'] as Record<string, unknown>;
      assert.equal(client['userPhone'], '11999998888', 'client.userPhone presente');
      assert.equal(client['document'], '52998224725', 'client.document = CPF dígitos');
      ok('Pix monta o request no formato da PradaPay (api-key/amount/client no corpo)');

      assert.equal(charge.gatewayId, '52fc5262-4063-4900', 'gatewayId = idTransaction');
      assert.equal(charge.status, 'pending', 'Pix recém-criado fica pendente');
      assert.equal(charge.pix?.copyPaste, '000201010212267...', 'copia-e-cola mapeado');
      assert.ok(charge.pix?.qrCodeImage?.startsWith('data:image/png;base64,'), 'QR base64 vira data URL');
      ok('Pix mapeia idTransaction/paymentCode/paymentCodeBase64 corretamente');
    }

    // 2) amount fracionário (com desconto) também vira reais corretos
    {
      calls.length = 0;
      await gateway.createCharge(baseInput({ method: 'pix', amountCents: 17730 }));
      assert.equal(calls[0]!.body['amount'], 177.3, '17730 centavos -> 177.30 reais');
      ok('conversão centavos->reais preserva os 2 decimais (177,30)');
    }

    // 3) Boleto: forma_pagamento + barcode/pdf
    {
      calls.length = 0;
      const charge = await gateway.createCharge(baseInput({ method: 'boleto' }));
      assert.equal(calls[0]!.body['forma_pagamento'], 'boleto', 'boleto envia forma_pagamento=boleto');
      assert.equal(charge.status, 'pending', 'boleto fica pendente');
      assert.ok(charge.boleto?.line.length, 'linha digitável presente');
      assert.equal(charge.boleto?.pdfUrl, 'https://example.com/fc6c8e8e-884a-439f-acfc-7fe42a631172.pdf', 'pdf_url mapeado');
      ok('Boleto mapeia barcode + pdf_url e fica pendente');
    }

    // 4) Cartão (opt-in): retorno_cartao PAID -> paid, com redirectUrl
    {
      calls.length = 0;
      const charge = await gateway.createCharge(
        baseInput({
          method: 'card',
          installments: 3,
          cardRaw: { holder: 'Fulano', number: '4111111111111111', expMonth: '12', expYear: '26', cvv: '123' },
        }),
      );
      const sent = calls[0]!.body;
      assert.equal(sent['forma_pagamento'], 'cartao', 'cartão envia forma_pagamento=cartao');
      assert.equal(sent['parcela'], 3, 'parcela enviada');
      assert.ok(sent['card'], 'objeto card enviado');
      assert.equal(charge.status, 'paid', 'retorno_cartao=PAID -> paid');
      assert.equal(charge.redirectUrl, 'https://checkout-adquirente.exemplo/pagamento', 'paymentUrl -> redirectUrl');
      ok('Cartão (opt-in) envia PAN + parcela e entende retorno_cartao/paymentUrl');
    }

    // 5) getCharge usa o endpoint de status e normaliza PAID_OUT -> paid
    {
      calls.length = 0;
      const charge = await gateway.getCharge('52fc5262-4063-4900');
      assert.equal(calls[0]!.url, 'https://api.pradapay.com/v1/webhook/', 'consulta /v1/webhook/');
      assert.equal(calls[0]!.body['idtransaction'], '52fc5262-4063-4900', 'envia idtransaction');
      assert.equal(charge.status, 'paid', 'PAID_OUT -> paid');
      ok('getCharge consulta o status e normaliza PAID_OUT -> paid');
    }

    // 6) WEBHOOK: confirma por RE-CONSULTA, não pelo corpo do postback
    {
      calls.length = 0;
      // Postback "mentindo" um status que NÃO é o real — deve ser ignorado.
      const rawBody = JSON.stringify({
        event: 'transaction.updated',
        idTransaction: '52fc5262-4063-4900',
        requestNumber: 'ord_abc123',
        status: 'WAITING_FOR_APPROVAL', // o corpo diz pendente...
      });
      const event = await gateway.parseWebhook({ headers: {}, rawBody });

      // ...mas a re-consulta (PAID_OUT) é a fonte da verdade.
      assert.equal(event.status, 'paid', 'status vem da RE-CONSULTA (PAID_OUT), não do corpo');
      assert.equal(event.gatewayId, '52fc5262-4063-4900', 'gatewayId extraído do postback');
      assert.equal(event.orderId, 'ord_abc123', 'orderId (requestNumber) extraído do postback');
      assert.ok(
        calls.some((c) => c.url.endsWith('/v1/webhook/')),
        'houve chamada de re-consulta ao endpoint de status',
      );
      ok('Webhook ignora o corpo forjado e confirma o status re-consultando a API');
    }

    // 7) sem telefone -> falha cedo e clara
    {
      await assert.rejects(
        () =>
          gateway.createCharge(
            baseInput({ method: 'pix', customer: { email: 'x@y.com', taxId: '52998224725' } }),
          ),
        /telefone/i,
        'createCharge sem phone deve falhar mencionando telefone',
      );
      ok('sem telefone, a PradaPay falha cedo com mensagem clara');
    }

    // 8) cartão sem o flag -> bloqueado
    {
      const noCard = new PradaPayGateway({ apiKey: 'pk', baseUrl: 'https://api.pradapay.com' });
      await assert.rejects(
        () =>
          noCard.createCharge(
            baseInput({
              method: 'card',
              cardRaw: { holder: 'F', number: '4111111111111111', expMonth: '12', expYear: '26', cvv: '123' },
            }),
          ),
        /PRADAPAY_ENABLE_CARD/,
        'cartão sem o flag deve ser bloqueado',
      );
      ok('cartão fica bloqueado sem PRADAPAY_ENABLE_CARD (proteção PCI por padrão)');
    }

    console.log(`\n✅ pradapay smoke OK — ${passed} verificações passaram`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((err) => {
  console.error('\n❌ pradapay smoke FALHOU\n', err);
  process.exit(1);
});
