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
│     └─ gateways/  mock-gateway.ts · pradapay-gateway.ts (integrado à API real)
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

## Integrando a PradaPay

O adapter (`src/domain/payments/gateways/pradapay-gateway.ts`) já está escrito contra o **contrato real** da API (doc oficial em `web.pradapay.com/developers`). Para ligar:

1. **No `.env`** (veja `.env.example`):
   ```env
   PAYMENT_PROVIDER=pradapay
   PRADAPAY_API_KEY=sua_chave
   PRADAPAY_BASE_URL=https://api.pradapay.com
   PRADAPAY_ENABLE_CARD=false
   # API_PUBLIC_URL precisa ser o domínio público desta API — é o que vira o postback.
   API_PUBLIC_URL=https://api.seudominio.com.br
   ```
   (Sem `PRADAPAY_API_KEY`, o boot falha de propósito.)

2. **Cadastre o postback** na PradaPay como `https://SEU_DOMINIO/api/webhooks/pradapay`. O `API_PUBLIC_URL` é usado pra montar essa URL automaticamente na criação da cobrança.

3. Pronto. `CheckoutService`, `WebhookService`, rotas e front continuam idênticos.

### Particularidades da PradaPay (já tratadas no adapter)

A API dela foge de algumas convenções de mercado — o adapter absorve tudo isso, mas vale saber:

- **`api-key` vai NO CORPO** (campo `"api-key"` do JSON), não em header `Authorization`.
- **Endpoint único** `POST /v1/gateway/` pra todos os métodos. O método é escolhido pelo campo `forma_pagamento` (`cartao` / `boleto`); **Pix omite o campo** (é o default).
- **`amount` em REAIS decimais** (ex.: `197.00`), não centavos. Internamente tudo é centavo inteiro; o adapter converte na borda (`centsToAmount`).
- **`client.userPhone` é OBRIGATÓRIO** (além de `name`, `document`=CPF e `email`). Por isso o checkout agora coleta telefone — `customer.phone`. Se vier vazio, o adapter falha cedo com mensagem clara.
- **Webhook sem assinatura.** A PradaPay não assina o postback. Confiar no corpo seria inseguro (qualquer um poderia forjar um "pago"). Então, ao receber o postback, o adapter **ignora o status do corpo e RE-CONSULTA** o status oficial em `POST /v1/webhook/ { idtransaction }` — essa resposta é a fonte da verdade. (É por isso que `parseWebhook` é assíncrono na porta.)
- **Status:** `PAID_OUT`→`paid`, `WAITING_FOR_APPROVAL`→`pending`, `DECLINED`→`failed`; cartão usa `retorno_cartao` (`PAID`). Mapeado em `normalizeStatus`.
- **Respostas:** Pix devolve `paymentCode` (copia-e-cola) + `paymentCodeBase64` (PNG do QR em base64, sem prefixo — o adapter transforma em `data:` URL) + `idTransaction`. Boleto devolve `barcode` + `pdf_url`. Cartão devolve `paymentUrl` (redirect) + `retorno_cartao`. Falha de negócio vem como `status:"error"` no corpo (às vezes com HTTP 200) — o adapter confere o campo, não só o código.

Há um teste de contrato que roda **sem rede nem credenciais** (intercepta o `fetch` e devolve as respostas exatas da doc):

```bash
npm run smoke:pradapay
```

Ele valida o request montado (api-key no corpo, amount em reais, Pix sem `forma_pagamento`, telefone obrigatório), o mapeamento das respostas, e — o ponto sensível — que o webhook confirma por re-consulta e **ignora um corpo forjado**.

### PCI-DSS (cartão)

O fluxo recomendado é **Pix**. A PradaPay **não tem tokenização** de cartão: o PAN/CVV trafegam crus na requisição. Isso joga o servidor pra dentro do escopo PCI-DSS — então o cartão fica **desligado por padrão** e só liga com `PRADAPAY_ENABLE_CARD=true`, de forma consciente. Com o flag desligado, qualquer tentativa de cobrança no cartão é bloqueada no adapter.

> A porta ainda expõe `cardToken` (para gateways que tokenizam, como o mock). A PradaPay usa o caminho `cardRaw` — só aceito sob o flag acima.

---

## Próximos passos sugeridos (fora do escopo deste checkout)

- **Split de pagamento:** a PradaPay suporta divisão por usuário (campo de split na cobrança). Não foi implementado — depende de cadastrar os IDs de recebedor na conta PradaPay; quando precisar, é um campo a mais no corpo do `createCharge`.

- **Persistência real:** trocar `InMemoryOrderRepository` por Postgres/Prisma — é só um novo adapter da porta `OrderRepository`.
- **Entitlement/biblioteca:** implementar o `onOrderPaid` (`src/application/payments/on-order-paid.ts`) pra liberar o pack do usuário e disparar e-mail/recibo quando o pedido vira `paid`. Hoje ele só loga.
- **Download protegido:** servir os arquivos via URL assinada com validade curta, liberada só pra quem tem o pack pago (o README do front já aponta isso).
