import type {
  DispatchData,
  DispatchResult,
  PaymentData,
  PaymentResult,
  SourceAvailability,
} from '../sources/types.js';

export type SourceView<T> =
  | { readonly availability: 'available'; readonly data: T }
  | { readonly availability: Exclude<SourceAvailability, 'available'> };

export interface SummaryBody {
  readonly orderId: string;
  readonly partial: boolean;
  readonly payment: SourceView<PaymentData>;
  readonly dispatch: SourceView<DispatchData>;
}

export interface SummaryErrorDetails {
  readonly sources: {
    readonly payment: SourceAvailability;
    readonly dispatch: SourceAvailability;
  };
}

export interface SummaryError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: SummaryErrorDetails;
}

export type SummaryOutcome =
  | { readonly kind: 'success'; readonly body: SummaryBody }
  | { readonly kind: 'error'; readonly error: SummaryError };

function view<T>(result: { availability: 'available'; data: T } | { availability: Exclude<SourceAvailability, 'available'> }): SourceView<T> {
  return result.availability === 'available'
    ? { availability: 'available', data: result.data }
    : { availability: result.availability };
}

export function summarize(
  orderId: string,
  payment: PaymentResult,
  dispatch: DispatchResult,
): SummaryOutcome {
  const paymentView = view(payment);
  const dispatchView = view(dispatch);

  if (payment.availability === 'available' || dispatch.availability === 'available') {
    return {
      kind: 'success',
      body: {
        orderId,
        partial: !(payment.availability === 'available' && dispatch.availability === 'available'),
        payment: paymentView,
        dispatch: dispatchView,
      },
    };
  }

  const details: SummaryErrorDetails = {
    sources: {
      payment: payment.availability,
      dispatch: dispatch.availability,
    },
  };

  if (payment.availability === 'timeout' || dispatch.availability === 'timeout') {
    return {
      kind: 'error',
      error: {
        status: 504,
        code: 'UPSTREAM_TIMEOUT',
        message: 'One or more summary sources did not respond before the deadline',
        details,
      },
    };
  }

  if (payment.availability === 'unavailable' || dispatch.availability === 'unavailable') {
    return {
      kind: 'error',
      error: {
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'One or more summary sources are unavailable',
        details,
      },
    };
  }

  return {
    kind: 'error',
    error: {
      status: 404,
      code: 'SUMMARY_NOT_FOUND',
      message: 'No summary sources found for this order',
    },
  };
}
