/**
 * 业务错误：统一格式 { code, message }（设计文档 §5 错误约定）。
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
