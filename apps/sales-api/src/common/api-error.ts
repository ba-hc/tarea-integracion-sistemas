import { HttpException } from '@nestjs/common';

export class ApiError extends HttpException {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super({ code, message }, status);
    this.code = code;
    this.details = details;
  }
}