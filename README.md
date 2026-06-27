# CULTO — Checkout API

Backend do **fluxo de checkout** da loja CULTO. Feito em **Fastify + TypeScript** (estrito), com o gateway de pagamento **plugável**: hoje roda um gateway _mock_ que espelha o checkout simulado do front; amanhã, trocando uma variável de ambiente, passa a falar com a **PradaPay** — sem mexer em nenhuma regra de negócio.

> Escopo: só o checkout (catálogo, cupom, criação de cobrança, status e webhook). Auth de usuário, biblioteca/entitlement e download protegido ficam de fora — mas há um gancho pronto pra plugar isso (`onOrderPaid`).

---

## Por que assim (decisões que importam)

- **Dinheiro em centavos inteiros.** Nada de `float` pra dinheiro. O front manda `priceValue` em reais, mas aqui tudo é `priceCents`. Some classe inteira de bug de arredondamento.
- **Preço recalculado no servidor.** O front atual confia no `priceValue` que vem do próprio cliente — dá pra forjar `0` no DevTools e "comprar" de graça. Aqui o **catálogo é a fonte da verdade** (`src/domain/catalog/catalog.ts`): o valor cobrado é sempre recalculado a partir do `packId` + cupom. O preço que o cliente manda é ignorado.
- **Ports & Adapters (hexagonal).** O app depende de uma _interface_ `PaymentGateway`, não de um provedor. Trocar mock ↔ PradaPay é trocar o adapter no _composition root_ (`src/container.ts`), guiado por env.
- **Webhook com assinatura HMAC + idempotência.** O caminho de webhook é real já no mock (assina e confere HMAC). Reentrega do gateway é segura: a máquina de estados do pedido não regride de um estado terminal e não dispara efeito duas vezes.
- **Config validada no boot.** `zod` valida o `.env` no start; se faltar credencial da PradaPay quando o provider é `pradapay`, o processo morre com mensagem clara em vez de quebrar em produção.

---

## Arquitetura

```
src/
├─ config/        env.ts ............. validação do .env (zod), no boot
├─ shared/        money/errors/id ... centavos, erros tipados, ids (ord_…)
├─ domain/        regra de negócio pura, sem Fastify
│  ├─ catalog/    packs + preços (fonte da verdade) e serviço
│  ├─ coupons/    cupons + cálculo de desconto (PricingBreakdown)
│  ├─ orders/     entidade Order + máquina de estados + repositório (porta)
│  └─ payments/   payment-gateway.ts (PORTA) + gateways/ (ADAPTERS)
│     └─ gateways/  mock-gateway.ts (hoje) · pradapay-gateway.ts (stub)
├─ application/   orquestra o domínio (casos de uso)
│  ├─ checkout/   CheckoutService (cria pedido + cobrança)
│  └─ payments/   WebhookService + onOrderPaid (gancho de entitlement)
├─ http/          borda HTTP (Fastify)
│  ├─ plugins/    raw-body (p/ HMAC) · error-handler
│  ├─ schemas/    validação de entrada (zod): CPF, e-mail, cartão…
│  └─ routes/     public · coupon · checkout · webhook · dev
├─ container.ts   composition root — ÚNICO lugar que escolhe implementações
├─ app.ts         monta o Fastify (plugins + container + rotas)
└─ server.ts      sobe o servidor + shutdown gracioso
```

A regra de ouro: **`domain/` e `application/` não conhecem Fastify nem a PradaPay**. Eles falam com interfaces. A borda (`http/`) e o `container.ts` é que ligam os fios.

---

## Rodando

Requer Node ≥ 20.

```bash
npm install
cp .env.example .env      # ajuste se quiser; os defaults já funcionam
npm run dev               # sobe em http://localhost:3333 com log bonito
```

Outros scripts:

```bash
npm run typecheck   # tsc --noEmit (estrito)
npm run build       # compila pra dist/
npm start           # roda o build (dist/server.js)
npm run smoke       # teste ponta-a-ponta em memória (não precisa subir nada)
```

O `npm run smoke` exercita o caminho completo: health → catálogo → cupom → checkout Pix (pendente) → status → **webhook assinado** → pago → idempotência → cartão (aprovado) → boleto (pendente) → erros (404/422).

---

## Endpoints

| Método | Rota | O quê |
|---|---|---|
| `GET`  | `/api/health` | status + provider ativo |
| `GET`  | `/api/catalog` | lista de packs com preço (do servidor) |
| `GET`  | `/api/catalog/:id` | um pack |
| `POST` | `/api/coupons/validate` | valida cupom e devolve preço recalculado |
| `POST` | `/api/checkout/sessions` | cria pedido + cobrança no gateway (**201**) |
| `GET`  | `/api/checkout/sessions/:id` | estado do pedido (retorno + polling do Pix) |
| `POST` | `/api/webhooks/:provider` | callback do gateway (assinatura validada) |
| `POST` | `/api/dev/simulate-webhook` | **só em dev/mock** — simula a confirmação |

### Exemplos

Criar um checkout Pix:

```bash
curl -X POST http://localhost:3333/api/checkout/sessions \
  -H 'content-type: application/json' \
  -d '{
    "packId": "motion",
    "paymentMethod": "pix",
    "customer": { "email": "cliente@exemplo.com", "cpf": "529.982.247-25" }
  }'
```

Resposta (resumida): `order` (id `ord_…`, status, `pricing` em centavos), `payment.pix.copyPaste` (BR Code) e `returnUrl` apontando pro front (`/compra/retorno?order=…`).

Simular a confirmação (em dev, equivalente ao "simular compra" do DevPanel):

```bash
curl -X POST http://localhost:3333/api/dev/simulate-webhook \
  -H 'content-type: application/json' \
  -d '{ "orderId": "ord_xxx", "status": "paid" }'
```

Cupons aceitos (iguais ao front): `CULTO10` (10%), `PRIMEIRA` (15%), `CRIADOR` (R$50). Case-insensitive.

---

## Integrando a PradaPay (quando chegar a hora)

Toda a fiação já existe. O passo a passo:

1. **No `.env`:**
   ```env
   PAYMENT_PROVIDER=pradapay
   PRADAPAY_API_KEY=sua_chave
   PRADAPAY_WEBHOOK_SECRET=seu_segredo
   PRADAPAY_BASE_URL=https://api.pradapay.com
   ```
   (Se faltar chave ou segredo, o boot falha de propósito.)

2. **Confira o adapter** `src/domain/payments/gateways/pradapay-gateway.ts`. Ele já está escrito no padrão de mercado (REST + webhook + API key, como Efí/Pagar.me/PixToPay), mas a doc oficial da PradaPay fica atrás de login — então os pontos onde os **nomes de campo** podem divergir estão marcados com `// ←★ AJUSTAR`. São basicamente:
   - rota e corpo do `createCharge` (`/v1/transactions`, nomes `amount`/`payment_method`/`external_reference`/`postback_url`/`customer.document`);
   - o header e o esquema da **assinatura do webhook** (`x-signature` + HMAC-SHA256 do corpo cru);
   - o mapa de **status** do vocabulário da PradaPay pro nosso (`normalizeStatus`).

   Confirme cada um contra a doc real e ajuste. **Nada fora desse arquivo precisa mudar.**

3. **Cadastre a URL de webhook** na PradaPay como `https://SEU_DOMINIO/api/webhooks/pradapay` (o `API_PUBLIC_URL` do `.env` é usado pra montar isso automaticamente na criação da cobrança).

4. Pronto. `CheckoutService`, `WebhookService`, rotas e front continuam idênticos.

### PCI-DSS (cartão)

Este backend **nunca** recebe número de cartão/CVV crus. Para cartão, o fluxo correto é o **cliente tokenizar** com o SDK do gateway e mandar só o `cardToken` — que é o que o `CreateChargeInput` espera. O mock aceita um token de mentira só pra demonstrar; com a PradaPay, use a tokenização dela. Assim o PAN nunca toca o seu servidor e o escopo de PCI fica mínimo.

---

## Próximos passos sugeridos (fora do escopo deste checkout)

- **Persistência real:** trocar `InMemoryOrderRepository` por Postgres/Prisma — é só um novo adapter da porta `OrderRepository`.
- **Entitlement/biblioteca:** implementar o `onOrderPaid` (`src/application/payments/on-order-paid.ts`) pra liberar o pack do usuário e disparar e-mail/recibo quando o pedido vira `paid`. Hoje ele só loga.
- **Download protegido:** servir os arquivos via URL assinada com validade curta, liberada só pra quem tem o pack pago (o README do front já aponta isso).
