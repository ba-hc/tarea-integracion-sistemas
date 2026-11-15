export type SourceAvailability = 'available' | 'not_found' | 'unavailable' | 'timeout';

export type PaymentStatus = 'CHARGED' | 'DECLINED' | 'REFUNDED' | 'PENDING' | 'REFUND_PENDING';

export type DispatchStatus = 'CREATED' | 'CANCELLED';

export interface PaymentData {
  readonly orderId: string;
  readonly status: PaymentStatus;
}

export interface DispatchItem {
  readonly partId: string;
  readonly quantity: number;
}

export interface DispatchData {
  readonly orderId: string;
  readonly status: DispatchStatus;
  readonly items: readonly DispatchItem[];
}

export type PaymentResult =
  | { readonly availability: 'available'; readonly data: PaymentData }
  | { readonly availability: Exclude<SourceAvailability, 'available'> };

export type DispatchResult =
  | { readonly availability: 'available'; readonly data: DispatchData }
  | { readonly availability: Exclude<SourceAvailability, 'available'> };

export interface PaymentsSource {
  get(orderId: string, traceId: string): Promise<PaymentResult>;
}

export interface DispatchSource {
  get(orderId: string, traceId: string): Promise<DispatchResult>;
}
