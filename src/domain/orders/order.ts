import type { PaymentMethod, PaymentStatus } from '../payments/payment.types.js';
import { isTerminal } from '../payments/payment.types.js';

/**
 * Pedido. Junta o que o cliente comprou, o preço FECHADO no servidor e o
 * vínculo com a cobrança no gateway. O status segue uma máquina de estados
 * simples e idempotente: aplicar "paid" duas vezes é no-op, e estado terminal
 * não regride (um webhook atrasado de "pending" não desfaz um "paid").
 */

export interface OrderCustomer {
  name?: string | undefined;
  email: string;
  taxId: string; // CPF (dígitos)
}

export interface OrderProps {
  id: string;
  packId: string;
  packTitle: string;
  method: PaymentMethod;
  customer: OrderCustomer;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponCode: string | null;
  installments: number;
  status: PaymentStatus;
  gatewayName: string;
  gatewayId: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
}

export class Order {
  private props: OrderProps;

  constructor(props: OrderProps) {
    this.props = props;
  }

  get id(): string {
    return this.props.id;
  }
  get status(): PaymentStatus {
    return this.props.status;
  }
  get gatewayId(): string | null {
    return this.props.gatewayId;
  }
  get totalCents(): number {
    return this.props.totalCents;
  }

  /** Snapshot imutável (pra serializar/persistir). */
  snapshot(): Readonly<OrderProps> {
    return { ...this.props };
  }

  linkGateway(gatewayId: string): void {
    this.props.gatewayId = gatewayId;
    this.touch();
  }

  /**
   * Transição de status idempotente e protegida.
   * Retorna true se algo mudou de fato (útil pra disparar efeitos só uma vez).
   */
  applyStatus(next: PaymentStatus): boolean {
    const current = this.props.status;
    if (current === next) return false;

    // Não regride a partir de estado terminal (webhook fora de ordem).
    if (isTerminal(current)) return false;

    this.props.status = next;
    if (next === 'paid' && !this.props.paidAt) {
      this.props.paidAt = new Date().toISOString();
    }
    this.touch();
    return true;
  }

  private touch(): void {
    this.props.updatedAt = new Date().toISOString();
  }
}
