/**
 * Smoke test ponta-a-ponta. Sobe o app em memória (inject, sem rede real) e
 * exercita o caminho feliz do checkout com o gateway mock:
 *
 *   health → catalog → cupom → checkout (pix) → status → simula webhook → pago
 *   + um checkout de cartão e um de boleto (que fica pendente)
 *
 * Roda com: npm run smoke
 */
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function main(): Promise<void> {
  // Config previsível pro teste: dev routes ligadas, boleto fica pendente.
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    PAYMENT_PROVIDER: 'mock',
    ENABLE_DEV_ROUTES: 'true',
    MOCK_AUTO_APPROVE_CARD: 'true',
    MOCK_AUTO_APPROVE_PIX: 'false',
    MOCK_AUTO_APPROVE_BOLETO: 'false',
    LOG_LEVEL: 'silent',
  });
  const app = await buildApp(env);

  try {
    // 1) health
    {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(res.statusCode, 200, 'health 200');
      ok('GET /api/health responde 200');
    }

    // 2) catálogo
    {
      const res = await app.inject({ method: 'GET', url: '/api/catalog' });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { packs: Array<{ id: string; priceFormatted: string }> };
      assert.ok(Array.isArray(body.packs) && body.packs.length >= 4, 'catálogo tem packs');
      assert.ok(
        body.packs.some((p) => p.id === 'design'),
        'pack design presente',
      );
      ok(`GET /api/catalog lista ${body.packs.length} packs`);
    }

    // 3) validação de cupom (CULTO10 = 10% sobre o design R$197)
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/coupons/validate',
        payload: { packId: 'design', code: 'culto10' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        valid: boolean;
        pricing: { subtotalCents: number; discountCents: number; totalCents: number };
      };
      assert.equal(body.valid, true, 'cupom válido');
      assert.equal(body.pricing.subtotalCents, 19700, 'subtotal 19700');
      assert.equal(body.pricing.discountCents, 1970, 'desconto 10%');
      assert.equal(body.pricing.totalCents, 17730, 'total com desconto');
      ok('POST /api/coupons/validate aplica CULTO10 (10%) corretamente');
    }

    // 4) checkout Pix — cria pedido pendente com copia-e-cola
    let pixOrderId = '';
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/checkout/sessions',
        payload: {
          packId: 'motion',
          paymentMethod: 'pix',
          customer: { email: 'cliente@exemplo.com', cpf: '529.982.247-25', name: 'Fulano de Tal', phone: '(11) 98888-7777' },
        },
      });
      assert.equal(res.statusCode, 201, 'checkout 201');
      const body = res.json() as {
        order: { id: string; status: string; pricing: { totalCents: number } };
        payment: { method: string; pix?: { copyPaste: string } };
        returnUrl: string;
      };
      pixOrderId = body.order.id;
      assert.ok(pixOrderId.startsWith('ord_'), 'id de pedido com prefixo');
      assert.equal(body.order.pricing.totalCents, 24700, 'motion = R$247');
      assert.equal(body.payment.method, 'pix');
      assert.ok(body.payment.pix?.copyPaste, 'pix copia-e-cola presente');
      assert.ok(body.returnUrl.includes('/compra/retorno'), 'returnUrl aponta pro front');
      ok('POST /api/checkout/sessions (pix) cria pedido pendente com QR');
    }

    // 5) status antes do pagamento
    {
      const res = await app.inject({ method: 'GET', url: `/api/checkout/sessions/${pixOrderId}` });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { order: { status: string } };
      assert.ok(['pending', 'processing'].includes(body.order.status), 'ainda não pago');
      ok(`GET /api/checkout/sessions/:id reflete status "${body.order.status}"`);
    }

    // 6) simula o webhook do gateway confirmando o Pix
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dev/simulate-webhook',
        payload: { orderId: pixOrderId, status: 'paid' },
      });
      assert.equal(res.statusCode, 200, 'simulate 200');
      const body = res.json() as { applied: boolean; status?: string };
      assert.equal(body.applied, true, 'webhook aplicado');
      assert.equal(body.status, 'paid', 'pedido virou paid');
      ok('POST /api/dev/simulate-webhook confirma o pagamento via HMAC');
    }

    // 7) status depois do webhook — pago e idempotente
    {
      const res = await app.inject({ method: 'GET', url: `/api/checkout/sessions/${pixOrderId}` });
      const body = res.json() as { order: { status: string; paidAt: string | null } };
      assert.equal(body.order.status, 'paid', 'status final pago');
      assert.ok(body.order.paidAt, 'paidAt preenchido');
      ok('pedido fica "paid" com paidAt após o webhook');

      // reenvio do mesmo webhook não deve quebrar nem mudar nada (idempotência)
      const again = await app.inject({
        method: 'POST',
        url: '/api/dev/simulate-webhook',
        payload: { orderId: pixOrderId, status: 'paid' },
      });
      const againBody = again.json() as { applied: boolean };
      assert.equal(againBody.applied, false, 'reentrega não reaplica');
      ok('reentrega do webhook é idempotente (applied=false)');
    }

    // 8) cartão aprovado na hora
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/checkout/sessions',
        payload: {
          packId: 'design',
          paymentMethod: 'card',
          installments: 3,
          cardToken: 'tok_teste_visa',
          customer: { email: 'card@exemplo.com', cpf: '529.982.247-25', name: 'Fulano', phone: '(11) 98888-7777' },
        },
      });
      assert.equal(res.statusCode, 201);
      const body = res.json() as { order: { status: string; installments: number } };
      assert.equal(body.order.status, 'paid', 'cartão aprovado na hora');
      assert.equal(body.order.installments, 3, 'parcelas preservadas');
      ok('POST /api/checkout/sessions (card) aprova e guarda parcelas');
    }

    // 9) boleto fica pendente
    {
      const res = await app.inject({
        method: 'POST',
        url: '/api/checkout/sessions',
        payload: {
          packId: 'bundle',
          paymentMethod: 'boleto',
          customer: { email: 'boleto@exemplo.com', cpf: '529.982.247-25', name: 'Fulano de Tal', phone: '(11) 98888-7777' },
        },
      });
      assert.equal(res.statusCode, 201);
      const body = res.json() as {
        order: { status: string };
        payment: { boleto?: { line: string } };
      };
      assert.equal(body.order.status, 'pending', 'boleto pendente');
      assert.ok(body.payment.boleto?.line, 'linha digitável presente');
      ok('POST /api/checkout/sessions (boleto) fica pendente com linha digitável');
    }

    // 10) erros: pack inexistente e CPF inválido
    {
      const notFound = await app.inject({
        method: 'POST',
        url: '/api/checkout/sessions',
        payload: {
          packId: 'nao-existe',
          paymentMethod: 'pix',
          customer: { email: 'x@y.com', cpf: '529.982.247-25', name: 'Fulano de Tal', phone: '(11) 98888-7777' },
        },
      });
      assert.equal(notFound.statusCode, 404, 'pack inexistente = 404');

      const badCpf = await app.inject({
        method: 'POST',
        url: '/api/checkout/sessions',
        payload: {
          packId: 'design',
          paymentMethod: 'pix',
          customer: { email: 'x@y.com', cpf: '111.111.111-11', name: 'Fulano de Tal', phone: '(11) 98888-7777' },
        },
      });
      assert.equal(badCpf.statusCode, 422, 'CPF inválido = 422');
      ok('erros tratados: 404 (pack) e 422 (CPF inválido)');
    }

    console.log(`\n✅ smoke OK — ${passed} verificações passaram`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('\n❌ smoke FALHOU\n', err);
  process.exit(1);
});
